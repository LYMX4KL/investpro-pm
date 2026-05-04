/* ============================================================
 * Late fee auto-assessment
 * ============================================================
 * Endpoint:  POST /.netlify/functions/assess-late-fees
 * Schedule:  '0 13 * * *'  — 1:00 PM UTC daily (~5 AM PT, after the 5th)
 *
 * Per Nevada NRS 118A.210, late fees can be assessed starting on
 * the 6th day after rent is due, capped at 5% of monthly rent.
 *
 * For each payments row with:
 *   type = 'rent', status = 'due', due_date is the 1st of any month,
 *   today >= due_date + 5 days
 *
 * Idempotently insert a late_fee row at 5% of the rent amount,
 * scoped to that lease + that month. Skip if a late_fee already
 * exists for this lease + month.
 *
 * Emails the tenant a notice.
 *
 * Required env vars:
 *   SUPABASE_URL
 *   SUPABASE_SERVICE_ROLE_KEY
 *   RESEND_API_KEY
 *   FROM_EMAIL
 *   URL
 * ============================================================ */

const { createClient } = require('@supabase/supabase-js');

const FROM = process.env.FROM_EMAIL || 'InvestPro Realty <onboarding@resend.dev>';
const SITE_URL = process.env.URL || 'https://investprorealty.net';

exports.handler = async (event) => {
  if (event?.httpMethod === 'OPTIONS') return cors(204, '');

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SERVICE_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const RESEND_KEY   = process.env.RESEND_API_KEY;
  if (!SUPABASE_URL || !SERVICE_KEY) {
    console.error('assess-late-fees: missing Supabase env vars');
    return cors(500, JSON.stringify({ ok: false, error: 'Server not configured' }));
  }

  const admin = createClient(SUPABASE_URL, SERVICE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false }
  });

  const today = new Date();
  const todayISO = today.toISOString().slice(0, 10);
  // 5 days back: anything due on or before this date is past the grace period
  const cutoff = new Date(today);
  cutoff.setDate(cutoff.getDate() - 5);
  const cutoffISO = cutoff.toISOString().slice(0, 10);

  // 1. Pull all rent rows that are unpaid AND past the grace period
  const { data: rents, error } = await admin.from('payments')
    .select('id, lease_id, property_id, tenant_profile_id, amount, due_date, description')
    .eq('type', 'rent')
    .eq('status', 'due')
    .lte('due_date', cutoffISO);
  if (error) {
    console.error('assess-late-fees: pull failed', error);
    return cors(500, JSON.stringify({ ok: false, error: error.message }));
  }

  const created = [];
  const skipped = [];

  for (const r of rents || []) {
    if (!r.lease_id) {
      skipped.push({ id: r.id, reason: 'no-lease' });
      continue;
    }

    // Idempotency: late_fee already exists for this lease + the rent's due_date?
    const { count } = await admin.from('payments')
      .select('id', { count: 'exact', head: true })
      .eq('lease_id', r.lease_id)
      .eq('type', 'late_fee')
      .eq('due_date', r.due_date);
    if (count && count > 0) {
      skipped.push({ id: r.id, reason: 'late-fee-exists' });
      continue;
    }

    // Compute 5% late fee
    const lateFeeAmount = Math.round(Number(r.amount) * 0.05 * 100) / 100;
    if (lateFeeAmount <= 0) {
      skipped.push({ id: r.id, reason: 'zero-rent' });
      continue;
    }

    const { data: insRow, error: insErr } = await admin.from('payments').insert({
      lease_id:          r.lease_id,
      property_id:       r.property_id,
      tenant_profile_id: r.tenant_profile_id,
      amount:            lateFeeAmount,
      type:              'late_fee',
      status:            'due',
      due_date:          r.due_date,                    // share the rent row's due_date for grouping
      payment_method:    null,
      description:       `Late fee — 5% on overdue rent due ${r.due_date}`,
      recorded_by_id:    null,
      recorded_by_name:  'auto: assess-late-fees'
    }).select('id').single();
    if (insErr) {
      console.error('assess-late-fees: insert failed for rent', r.id, insErr);
      skipped.push({ id: r.id, reason: 'insert-failed' });
      continue;
    }
    created.push({ rent_id: r.id, late_fee_id: insRow.id, amount: lateFeeAmount });

    // Email the tenant
    if (RESEND_KEY && r.tenant_profile_id) {
      try {
        const { data: tenant } = await admin.from('profiles')
          .select('email, full_name')
          .eq('id', r.tenant_profile_id)
          .maybeSingle();
        if (tenant?.email) {
          const subject = `[InvestPro] Late fee assessed — $${lateFeeAmount.toFixed(2)}`;
          const html = `
            <div style="font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;max-width:560px;padding:1.5rem;color:#1F2937;">
              <h2 style="font-family:Georgia,serif;color:#991B1B;margin:0 0 .5rem;">⚠ Late Fee Notice</h2>
              <p style="font-size:15px;line-height:1.55;">Hi ${escapeHtml((tenant.full_name || '').split(' ')[0] || 'there')},</p>
              <p style="font-size:15px;line-height:1.55;">Per your lease and Nevada NRS 118A.210, a 5% late fee has been assessed on your overdue rent payment.</p>
              <table style="width:100%;border-collapse:collapse;font-size:14px;margin-top:.75rem;">
                <tr><td style="padding:.4rem .5rem;background:#F7F8FB;font-weight:600;">Original rent due</td><td style="padding:.4rem .5rem;">${r.due_date}</td></tr>
                <tr><td style="padding:.4rem .5rem;background:#F7F8FB;font-weight:600;">Rent amount</td><td style="padding:.4rem .5rem;">$${Number(r.amount).toFixed(2)}</td></tr>
                <tr><td style="padding:.4rem .5rem;background:#F7F8FB;font-weight:600;color:#991B1B;">Late fee (5%)</td><td style="padding:.4rem .5rem;font-weight:700;color:#991B1B;">$${lateFeeAmount.toFixed(2)}</td></tr>
                <tr><td style="padding:.4rem .5rem;background:#F7F8FB;font-weight:600;">Total due now</td><td style="padding:.4rem .5rem;font-weight:700;">$${(Number(r.amount) + lateFeeAmount).toFixed(2)}</td></tr>
              </table>
              <p style="margin-top:1.25rem;">
                <a href="${SITE_URL}/portal/tenant-dashboard.html#pay" style="background:#1F4FC1;color:#fff;text-decoration:none;padding:.6rem 1.25rem;border-radius:4px;font-weight:600;">Pay now →</a>
              </p>
              <p style="margin-top:1rem;font-size:13px;color:#6B7280;">Already paid? Disregard — payment receipt may be in transit. Questions: 702-816-5555.</p>
            </div>
          `;
          await fetch('https://api.resend.com/emails', {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${RESEND_KEY}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ from: FROM, to: [tenant.email], subject, html })
          });
        }
      } catch (err) {
        console.error('assess-late-fees: email send failed for', r.id, err);
      }
    }
  }

  return cors(200, JSON.stringify({
    ok: true,
    today: todayISO,
    cutoff: cutoffISO,
    rent_rows_considered: (rents || []).length,
    late_fees_created: created.length,
    skipped_count: skipped.length,
    created,
    skipped
  }));
};

// Run daily at 1:00 PM UTC
exports.config = { schedule: '0 13 * * *' };

function cors(statusCode, body) {
  return {
    statusCode,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type'
    },
    body
  };
}

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}
