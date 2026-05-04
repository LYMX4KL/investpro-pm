/* InvestPro Realty — Supabase Auth Helper (v2 — full 12-role model)
 * --------------------------------------------------------------------
 * Single shared client + helpers for login, signup, sign-out, password
 * reset, role-based routing, and protecting dashboard pages.
 *
 * SUPPORTED ROLES (must match the user_role enum in db/001_extensions_enums.sql):
 *   Internal:  broker · va · accounting · compliance · leasing · pm_service · admin_onsite
 *   External:  applicant · tenant · owner · agent_listing · agent_showing
 *
 * SETUP:
 *   1) Create or reuse a Supabase project at https://supabase.com
 *   2) Run all migrations in db/ (in numerical order) via SQL Editor
 *   3) Copy your Project URL and anon/public key (Settings → API)
 *   4) Replace the placeholders below
 *   5) Manually create the 6 placeholder staff accounts in Auth → Users
 *      (per db/010_seed_placeholder_users.sql), then run that SQL file.
 *
 * Until SUPABASE_URL/KEY are filled in, the app runs in DEMO_MODE which
 * uses sessionStorage so visitors can click around the portal pages
 * without a real backend.
 */

const SUPABASE_URL      = 'https://prvpjutmukssogxqbsjq.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InBydnBqdXRtdWtzc29neHFic2pxIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzc0NDY5MzYsImV4cCI6MjA5MzAyMjkzNn0.JL05HeaSgodX52kHTwym7NR7AGN5gCSkZlMZxRLYB_Q';

const DEMO_MODE = (
  SUPABASE_URL === 'YOUR_SUPABASE_URL' ||
  SUPABASE_ANON_KEY === 'YOUR_SUPABASE_ANON_KEY'
);

/* Role → home page mapping for redirect after login */
const ROLE_HOME = {
  broker:        '/portal/broker/dashboard.html',
  va:            '/portal/va/dashboard.html',
  accounting:    '/portal/accounting/dashboard.html',
  compliance:    '/portal/compliance/dashboard.html',
  leasing:       '/portal/leasing/dashboard.html',
  pm_service:    '/portal/pm/dashboard.html',
  admin_onsite:  '/portal/admin/dashboard.html',
  agent_listing: '/portal/agent/dashboard.html',
  agent_showing: '/portal/agent/dashboard.html',
  applicant:     '/portal/applicant/dashboard.html',
  tenant:        '/portal/tenant-dashboard.html',
  owner:         '/portal/owner-dashboard.html',
  vendor:        '/portal/vendor/dashboard.html',
};

/* Internal staff roles — share access to most internal data */
const INTERNAL_ROLES = ['broker', 'va', 'accounting', 'compliance', 'leasing', 'pm_service', 'admin_onsite'];
const AGENT_ROLES    = ['agent_listing', 'agent_showing'];

/* ----------------------- Supabase client ----------------------- */
let supa = null;
async function getSupa() {
  if (DEMO_MODE) return null;
  if (supa) return supa;
  const { createClient } = await import('https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm');
  supa = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
  return supa;
}

/* ----------------------- Demo-mode helpers ----------------------- */
const DEMO_KEY = 'investpro_demo_user';
function demoLogin(email, role) {
  const user = { email, role, name: email.split('@')[0], demo: true };
  sessionStorage.setItem(DEMO_KEY, JSON.stringify(user));
  return user;
}
function demoLogout() { sessionStorage.removeItem(DEMO_KEY); }
function demoUser() {
  try { return JSON.parse(sessionStorage.getItem(DEMO_KEY) || 'null'); } catch { return null; }
}

/* ----------------------- Role helpers ----------------------- */
function isInternal(role) { return INTERNAL_ROLES.includes(role); }
function isAgent(role)    { return AGENT_ROLES.includes(role); }
function homeForRole(role) { return ROLE_HOME[role] || '/portal/login.html'; }

/* ----------------------- Public API ----------------------- */
window.investproAuth = {
  isDemoMode: () => DEMO_MODE,
  isInternal,
  isAgent,
  homeForRole,
  ROLE_HOME,

  /** Sign up a new user. role is required; defaults to 'applicant' if omitted. */
  async signUp({ email, password, fullName, role, phone }) {
    role = role || 'applicant';
    if (!ROLE_HOME[role]) return { ok: false, error: `Unknown role "${role}"` };

    if (DEMO_MODE) {
      demoLogin(email, role);
      return { ok: true, demo: true, role };
    }
    const sb = await getSupa();
    const { data, error } = await sb.auth.signUp({
      email, password,
      options: { data: { full_name: fullName, role, phone } }
    });
    if (error) return { ok: false, error: error.message };
    // The DB trigger handle_new_auth_user() auto-creates a profiles row.
    // We upsert here as a belt-and-suspenders guarantee.
    if (data?.user) {
      await sb.from('profiles').upsert({
        id: data.user.id, full_name: fullName, role, email, phone
      });
    }
    return { ok: true, role };
  },

  /** Sign in. Returns { ok, role, redirectTo } so caller can route. */
  async signIn({ email, password }) {
    if (DEMO_MODE) {
      if (!password || password.length < 4)
        return { ok: false, error: 'Demo mode: password must be at least 4 characters.' };
      // Pull role from the page hint (set on each login page) or from email convention
      const role =
        (document.querySelector('[data-default-role]')?.dataset.defaultRole)
        || guessRoleFromEmail(email)
        || 'tenant';
      const u = demoLogin(email, role);
      return { ok: true, role: u.role, demo: true, redirectTo: homeForRole(u.role) };
    }
    const sb = await getSupa();
    const { data, error } = await sb.auth.signInWithPassword({ email, password });
    if (error) return { ok: false, error: error.message };
    let role = data?.user?.user_metadata?.role || 'tenant';
    const { data: prof } = await sb.from('profiles').select('role,full_name').eq('id', data.user.id).single();
    if (prof?.role) role = prof.role;
    return { ok: true, role, name: prof?.full_name, redirectTo: homeForRole(role) };
  },

  /** Sign out and return to the appropriate login page. */
  async signOut() {
    if (DEMO_MODE) demoLogout();
    else { const sb = await getSupa(); await sb.auth.signOut(); }
    location.href = (location.pathname.includes('/portal/') ? '/portal/login.html' : '/portal/login.html');
  },

  /** Send a password-reset email. The link in the email lands on
   *  /portal/reset-password.html, which has a "set new password" form
   *  that calls updateUser() and routes the user to their dashboard. */
  async resetPassword(email) {
    if (DEMO_MODE) return { ok: true, demo: true };
    const sb = await getSupa();
    const { error } = await sb.auth.resetPasswordForEmail(email, {
      redirectTo: location.origin + '/portal/reset-password.html'
    });
    return error ? { ok: false, error: error.message } : { ok: true };
  },

  /** Update the password of the currently signed-in user (used by reset-password.html
   *  after a recovery session is established, OR by any signed-in user from a profile page). */
  async updatePassword(newPassword) {
    if (DEMO_MODE) return { ok: true, demo: true };
    const sb = await getSupa();
    const { error } = await sb.auth.updateUser({ password: newPassword });
    return error ? { ok: false, error: error.message } : { ok: true };
  },

  /** Get the current logged-in user (or null). */
  async currentUser() {
    if (DEMO_MODE) return demoUser();
    const sb = await getSupa();
    const { data } = await sb.auth.getUser();
    if (!data?.user) return null;
    const { data: prof } = await sb.from('profiles')
      .select('full_name, role, phone, sms_opt_in')
      .eq('id', data.user.id).single();
    return {
      id: data.user.id,
      email: data.user.email,
      name: prof?.full_name || data.user.email.split('@')[0],
      role: prof?.role || data.user.user_metadata?.role || 'tenant',
      phone: prof?.phone,
      sms_opt_in: prof?.sms_opt_in
    };
  },

  /** Use on dashboard pages: kick to login if not signed-in or wrong role.
   *  Pass an array of allowed roles, or 'internal' / 'agent' as group shortcuts.
   *  Examples:
   *    requireRole('broker')                        — broker only
   *    requireRole(['va', 'broker'])                — VA or broker
   *    requireRole('internal')                      — any internal staff
   *    requireRole(['internal', 'agent_listing'])   — internal OR a listing agent
   */
  async requireRole(required) {
    const u = await this.currentUser();
    if (!u) { location.href = '/portal/login.html'; return null; }

    let allowed = Array.isArray(required) ? [...required] : [required];
    if (allowed.includes('internal')) allowed = allowed.filter(r => r !== 'internal').concat(INTERNAL_ROLES);
    if (allowed.includes('agent'))    allowed = allowed.filter(r => r !== 'agent').concat(AGENT_ROLES);

    if (allowed.length && !allowed.includes(u.role)) {
      // Wrong role — bounce them to their own home
      location.href = homeForRole(u.role);
      return null;
    }
    injectPortalChrome(u);
    return u;
  },

  /** Convenience: require ANY signed-in user (for shared portal pages). */
  async requireAuth() {
    const u = await this.currentUser();
    if (!u) { location.href = '/portal/login.html'; return null; }
    injectPortalChrome(u);
    return u;
  }
};

/* ----------------------- Auto-injected portal chrome -----------------------
 * Runs after a successful requireRole/requireAuth call. Adds two things to
 * every dashboard automatically (no need to edit each dashboard.html file):
 *   • A "Change Password" link in the header user area
 *   • A floating "Send Feedback" button in the bottom-right corner
 *
 * Both are skipped silently if their parent containers aren't present, so this
 * is safe to call on any page.
 */
function injectPortalChrome(user) {
  // 1) Add a "Manage Permissions" link for broker + compliance (office admin role)
  //    Only injected for these two roles; everyone else skips this block.
  try {
    if (user && (user.role === 'broker' || user.role === 'compliance')) {
      const dashUser = document.querySelector('.dash-user');
      if (dashUser && !document.getElementById('managePermsLink')) {
        // Don't show this link if we're already on the manage-permissions page itself
        if (!location.pathname.endsWith('/manage-permissions.html')) {
          const mpLink = document.createElement('a');
          mpLink.id = 'managePermsLink';
          mpLink.href = '/portal/manage-permissions.html';
          mpLink.className = 'btn btn-outline btn-sm';
          mpLink.style.marginRight = '.4rem';
          mpLink.textContent = '🛡️ Permissions';
          mpLink.title = 'Manage who can see applicant PII';
          dashUser.insertBefore(mpLink, dashUser.firstChild);
        }
      }
    }
  } catch (e) { /* non-fatal */ }

  // 2) Add a "Change Password" link next to the userBadge / Sign-out button
  try {
    const dashUser = document.querySelector('.dash-user');
    if (dashUser && !document.getElementById('changePwLink')) {
      const cpLink = document.createElement('a');
      cpLink.id = 'changePwLink';
      cpLink.href = '/portal/change-password.html';
      cpLink.className = 'btn btn-outline btn-sm';
      cpLink.style.marginRight = '.4rem';
      cpLink.textContent = '🔑 Change Password';
      const signOutBtn = document.getElementById('signOutBtn');
      if (signOutBtn) dashUser.insertBefore(cpLink, signOutBtn);
      else            dashUser.appendChild(cpLink);
    }
  } catch (e) { /* non-fatal */ }

  // 3) Add a floating "Send Feedback" button bottom-right that opens a modal
  //    submitting to the feedback table in Supabase. Replaced the old mailto:
  //    button so all feedback lands in one place, viewable on the broker
  //    Feedback admin page.
  try {
    if (document.getElementById('feedbackFab')) return;
    const fab = document.createElement('button');
    fab.id = 'feedbackFab';
    fab.type = 'button';
    fab.title = 'Send feedback about this page';
    fab.style.cssText = `
      position: fixed; bottom: 18px; right: 18px; z-index: 9998;
      background: #1F4FC1; color: #fff; padding: .7rem 1.1rem;
      border: 0; border-radius: 999px;
      font: 600 .85rem 'Source Sans Pro', Arial, sans-serif;
      letter-spacing: .03em; cursor: pointer;
      box-shadow: 0 6px 16px rgba(0,0,0,.22);
    `;
    fab.textContent = '✉️ Send Feedback';
    fab.addEventListener('click', () => openFeedbackModal(user));
    if (document.body) document.body.appendChild(fab);
    else document.addEventListener('DOMContentLoaded', () => document.body.appendChild(fab));
  } catch (e) { /* non-fatal */ }
}

/* ----------------------- Feedback modal -----------------------
 * In-site replacement for the old mailto button. Submits to the
 * `feedback` table in Supabase. All authenticated users can submit;
 * broker + compliance read everything on /portal/broker/feedback.html.
 */
function openFeedbackModal(user) {
  if (document.getElementById('feedbackModalBg')) return;

  const bg = document.createElement('div');
  bg.id = 'feedbackModalBg';
  bg.style.cssText = `
    position: fixed; inset: 0; background: rgba(20,52,137,.55); z-index: 10000;
    display: flex; align-items: center; justify-content: center; padding: 1rem;
    font-family: 'Source Sans Pro', Arial, sans-serif;
  `;
  bg.innerHTML = `
    <div style="background:#fff; border-radius:8px; max-width:520px; width:100%; padding:1.75rem; box-shadow: 0 18px 48px rgba(0,0,0,.25);">
      <div style="display:flex; align-items:center; justify-content:space-between; margin-bottom:.75rem;">
        <h2 style="margin:0; font-family:'Playfair Display', Georgia, serif; color:#1F4FC1; font-size:1.4rem;">Send Feedback</h2>
        <button id="fbClose" type="button" style="background:none; border:0; font-size:1.5rem; cursor:pointer; color:#888; line-height:1;">×</button>
      </div>
      <p style="margin:0 0 1rem; color:#555A6B; font-size:.9rem;">
        We read every one. Bug, suggestion, or just a question — anything helps.
      </p>
      <div id="fbBanner" style="display:none; padding:.6rem .8rem; border-radius:4px; margin-bottom:.75rem; font-size:.9rem;"></div>
      <form id="fbForm">
        <div style="margin-bottom:.85rem;">
          <label style="display:block; font-weight:600; color:#1F4FC1; margin-bottom:.3rem; font-size:.9rem;">Type</label>
          <select id="fbCategory" style="width:100%; padding:.55rem .65rem; border:1px solid #DDE3F0; border-radius:4px; font-family:inherit; font-size:.95rem;">
            <option value="bug">🐛 Bug — something is broken</option>
            <option value="suggestion">💡 Suggestion — improve something</option>
            <option value="question">❓ Question — how does this work?</option>
            <option value="praise">🌟 Praise — this part works great</option>
            <option value="general" selected>📝 General — anything else</option>
          </select>
        </div>
        <div style="margin-bottom:1rem;">
          <label style="display:block; font-weight:600; color:#1F4FC1; margin-bottom:.3rem; font-size:.9rem;">Your message</label>
          <textarea id="fbMessage" rows="5" required placeholder="What did you see? What would you change?" style="width:100%; padding:.55rem .65rem; border:1px solid #DDE3F0; border-radius:4px; font-family:inherit; font-size:.95rem; resize:vertical;"></textarea>
          <div style="font-size:.8rem; color:#6B7280; margin-top:.3rem;">
            We'll automatically include the page URL, your role, and the current time so we can reproduce the issue.
          </div>
        </div>
        <div style="display:flex; gap:.5rem; justify-content:flex-end;">
          <button type="button" id="fbCancel" style="padding:.55rem 1rem; background:#fff; color:#555A6B; border:1px solid #DDE3F0; border-radius:4px; font-weight:600; cursor:pointer; font-family:inherit;">Cancel</button>
          <button type="submit" id="fbSubmit" style="padding:.55rem 1.1rem; background:#5FAB22; color:#fff; border:0; border-radius:4px; font-weight:700; letter-spacing:.04em; text-transform:uppercase; cursor:pointer; font-family:inherit; font-size:.85rem;">Send Feedback</button>
        </div>
      </form>
    </div>
  `;
  document.body.appendChild(bg);

  function closeModal() { bg.remove(); }
  document.getElementById('fbClose').addEventListener('click', closeModal);
  document.getElementById('fbCancel').addEventListener('click', closeModal);
  bg.addEventListener('click', (e) => { if (e.target === bg) closeModal(); });

  document.getElementById('fbForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const submitBtn = document.getElementById('fbSubmit');
    const banner = document.getElementById('fbBanner');
    const message = document.getElementById('fbMessage').value.trim();
    const category = document.getElementById('fbCategory').value;
    if (!message) return;

    submitBtn.disabled = true;
    submitBtn.textContent = 'Sending…';
    banner.style.display = 'none';

    try {
      // Demo mode falls back to mailto so feedback never gets lost
      if (typeof window.investproAuth !== 'undefined' && window.investproAuth.isDemoMode()) {
        const subject = encodeURIComponent(`Portal feedback — ${document.title}`);
        const body = encodeURIComponent(`Category: ${category}\nFrom: ${user.name || user.email} (${user.role})\nPage: ${location.href}\n\n${message}`);
        location.href = `mailto:zhongkennylin@gmail.com?subject=${subject}&body=${body}`;
        return;
      }
      const sb = await getFeedbackSupa();
      const payload = {
        user_id: user.id || null,
        user_name: user.name || null,
        user_email: user.email || null,
        user_role: user.role || null,
        page_url: location.href,
        page_title: document.title,
        user_agent: navigator.userAgent,
        category, message
      };
      const { error } = await sb.from('feedback').insert(payload);
      if (error) throw error;

      // Fire-and-forget email notification to Kenny via Netlify function.
      // We don't await/block on this — if the email fails, the feedback
      // is already safely stored in Supabase. The function reads
      // RESEND_API_KEY from Netlify env vars and uses Resend's free tier.
      try {
        fetch('/.netlify/functions/feedback-notify', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        }).catch(() => {});
      } catch {}

      banner.style.display = 'block';
      banner.style.background = '#D1FAE5';
      banner.style.color = '#065F46';
      banner.textContent = '✓ Thanks! Your feedback was sent to Kenny.';
      setTimeout(closeModal, 1500);
    } catch (err) {
      banner.style.display = 'block';
      banner.style.background = '#FEE2E2';
      banner.style.color = '#B0342B';
      banner.textContent = '✗ Could not send: ' + (err.message || err);
      submitBtn.disabled = false;
      submitBtn.textContent = 'Send Feedback';
    }
  });
}

let _fbSupa = null;
async function getFeedbackSupa() {
  if (_fbSupa) return _fbSupa;
  const { createClient } = await import('https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm');
  _fbSupa = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
  return _fbSupa;
}

/* ----------------------- Helpers ----------------------- */
/** Demo mode only: try to infer a role from a placeholder staff email
 *  (e.g. va@investprorealty.net → 'va'). Lets reviewers test each role
 *  without entering the role manually. */
function guessRoleFromEmail(email) {
  if (!email) return null;
  const map = {
    'broker@':     'broker',
    'va@':         'va',
    'accounting@': 'accounting',
    'compliance@': 'compliance',
    'leasing@':    'leasing',
    'pm@':         'pm_service',
    'admin@':      'admin_onsite',
    'agent@':      'agent_showing',
    'owner@':      'owner',
    'tenant@':     'tenant',
    'applicant@':  'applicant',
  };
  const lower = email.toLowerCase();
  for (const prefix in map) if (lower.startsWith(prefix)) return map[prefix];
  return null;
}
