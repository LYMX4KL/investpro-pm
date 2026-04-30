/* InvestPro Realty — Applications + Stripe + Supabase helper
 * ----------------------------------------------------------
 * Phase 1 of the PM application workflow:
 *   - Tracks documents uploaded into the form
 *   - Persists in-progress drafts to localStorage so applicants can resume
 *   - On submit: creates a Stripe Checkout session for two charges:
 *     application fee ($75 primary applicant / $50 co-applicant) + the
 *     holding fee amount the applicant entered on the form.
 *   - After Stripe success-redirect, uploads docs to Supabase Storage and
 *     inserts the application row in Supabase.
 *
 * SETUP (see README — section "Phase 1: Application workflow"):
 *   1) Reuse your existing Supabase project (URL + anon key from auth.js).
 *   2) Run the SQL from the README to create:
 *        - applications, application_documents, application_agents tables
 *        - storage bucket "application-docs" with RLS policies
 *   3) Create a Stripe account and add publishable key + a server endpoint
 *      that creates Checkout sessions (Netlify Function or Supabase Edge Fn).
 *   4) Replace STRIPE_PUBLISHABLE_KEY and CREATE_CHECKOUT_URL below.
 *
 * Until those keys are filled in, the form runs in DEMO MODE: all data is
 * saved locally and a fake confirmation # is shown so you can click through.
 */

const STRIPE_PUBLISHABLE_KEY = 'pk_test_REPLACE_ME';
const CREATE_CHECKOUT_URL    = '/.netlify/functions/create-checkout-session';
// Supabase URL/key are read from the existing auth.js so we don't duplicate them.
const SUPABASE_URL_FROM_AUTH      = (typeof SUPABASE_URL !== 'undefined') ? SUPABASE_URL : 'YOUR_SUPABASE_URL';
const SUPABASE_ANON_KEY_FROM_AUTH = (typeof SUPABASE_ANON_KEY !== 'undefined') ? SUPABASE_ANON_KEY : 'YOUR_SUPABASE_ANON_KEY';

const DEMO_MODE = (
  STRIPE_PUBLISHABLE_KEY === 'pk_test_REPLACE_ME' ||
  SUPABASE_URL_FROM_AUTH.startsWith('YOUR_')
);

/* ---------------- File tracker ----------------
 * Multi-file inputs only retain the most recent selection in HTML, which
 * makes it impossible for users to add a file in two clicks. We mirror the
 * selected files into our own JS map so the user can add/remove freely.
 */
const fileBuckets = {}; // { docs_id: [File, File, ...], docs_income: [...], ... }

function fmtSize(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024*1024) return (bytes/1024).toFixed(1) + ' KB';
  return (bytes/1024/1024).toFixed(1) + ' MB';
}

function renderFileList(bucket) {
  const list = document.querySelector(`[data-list="${bucket}"]`);
  if (!list) return;
  list.innerHTML = '';
  (fileBuckets[bucket] || []).forEach((f, i) => {
    const li = document.createElement('li');
    li.innerHTML = `<span class="name">📎 ${f.name} <span class="muted" style="font-size:.8rem;">(${fmtSize(f.size)})</span></span>
                    <button type="button" aria-label="Remove" title="Remove">×</button>`;
    li.querySelector('button').addEventListener('click', () => {
      fileBuckets[bucket].splice(i, 1);
      renderFileList(bucket);
    });
    list.appendChild(li);
  });
}

const appForm = {
  handleFiles(event) {
    const input = event.target;
    const bucket = input.name; // e.g. docs_id
    fileBuckets[bucket] = fileBuckets[bucket] || [];
    Array.from(input.files).forEach(f => {
      if (f.size > 10 * 1024 * 1024) {
        alert(`File "${f.name}" is over 10MB. Please compress or split.`);
        return;
      }
      // De-duplicate by name+size
      const dup = fileBuckets[bucket].some(x => x.name === f.name && x.size === f.size);
      if (!dup) fileBuckets[bucket].push(f);
    });
    input.value = ''; // allow re-selecting the same file
    renderFileList(bucket);
  }
};
window.appForm = appForm;

/* ---------------- Drag & drop on upload zones ---------------- */
function wireDragDrop() {
  document.querySelectorAll('.upload-zone').forEach(zone => {
    const input = zone.querySelector('input[type=file]');
    ['dragenter','dragover'].forEach(ev =>
      zone.addEventListener(ev, e => { e.preventDefault(); zone.classList.add('drag'); }));
    ['dragleave','drop'].forEach(ev =>
      zone.addEventListener(ev, e => { e.preventDefault(); zone.classList.remove('drag'); }));
    zone.addEventListener('drop', e => {
      const files = Array.from(e.dataTransfer.files);
      // Wrap into a fake event so handleFiles works the same way
      input.files = (() => {
        const dt = new DataTransfer();
        files.forEach(f => dt.items.add(f));
        return dt.files;
      })();
      input.dispatchEvent(new Event('change'));
    });
  });
}

/* ---------------- Pet section show/hide + dynamic cards ---------------- */
function wirePets() {
  const sel = document.getElementById('hasPets');
  const countWrap = document.getElementById('petCountWrap');
  const countSel = document.getElementById('petCount');
  const container = document.getElementById('petsContainer');
  const tpl = document.getElementById('petTemplate');
  const petDocs = document.getElementById('petDocsWrap');
  if (!sel) return;

  function render() {
    const has = sel.value === 'yes';
    countWrap.style.display = has ? '' : 'none';
    container.style.display = has ? '' : 'none';
    if (petDocs) petDocs.style.display = has ? '' : 'none';
    if (!has) { container.innerHTML = ''; return; }
    const n = parseInt(countSel.value, 10) || 1;
    container.innerHTML = '';
    for (let i = 0; i < n; i++) {
      const node = tpl.content.cloneNode(true);
      node.querySelector('.pet-num').textContent = (i+1);
      container.appendChild(node);
    }
  }
  sel.addEventListener('change', render);
  countSel.addEventListener('change', render);
  render();
}

/* ---------------- Showing-agent section show/hide ---------------- */
function wireAgentToggle() {
  const radios = document.querySelectorAll('#agentToggle input[type=radio]');
  const section = document.getElementById('agentSection');
  if (!section) return;
  function render() {
    const yes = document.querySelector('#agentToggle input[value=yes]').checked;
    section.style.display = yes ? '' : 'none';
    section.querySelectorAll('input,select,textarea').forEach(el => {
      // Make agent fields required only when "yes"
      if (el.dataset.agentRequired === undefined) el.dataset.agentRequired = el.required ? '1' : '';
      const baseRequired = !!el.dataset.agentRequired;
      el.required = yes && (
        ['agent_first','agent_last','agent_license','agent_email','agent_phone','agent_brokerage'].includes(el.name)
        || baseRequired
      );
    });
  }
  radios.forEach(r => r.addEventListener('change', render));
  render();
}

/* ---------------- Auto-save draft to localStorage ---------------- */
const DRAFT_KEY = 'investpro_application_draft';
function autoSaveDraft(form) {
  const save = () => {
    const fd = new FormData(form);
    const obj = {};
    fd.forEach((v,k) => {
      if (obj[k] === undefined) obj[k] = v;
      else if (Array.isArray(obj[k])) obj[k].push(v);
      else obj[k] = [obj[k], v];
    });
    try { localStorage.setItem(DRAFT_KEY, JSON.stringify(obj)); } catch {}
  };
  form.addEventListener('input', save);
  form.addEventListener('change', save);
}
function restoreDraft(form) {
  try {
    const raw = localStorage.getItem(DRAFT_KEY);
    if (!raw) return;
    const obj = JSON.parse(raw);
    Object.entries(obj).forEach(([k,v]) => {
      const el = form.elements[k];
      if (!el) return;
      if (el.type === 'checkbox') el.checked = !!v;
      else if (el.type !== 'file') el.value = v;
    });
  } catch {}
}

/* ---------------- Submit handler ---------------- */
async function handleSubmit(event) {
  const form = event.target;
  event.preventDefault();

  // Validate auth checkboxes
  const required = ['authScreen','authShare','authTruth','authFee'];
  const missing = required.filter(id => !document.getElementById(id).checked);
  const errEl = document.getElementById('authErrors');
  errEl.classList.toggle('show', missing.length > 0);
  if (missing.length) { errEl.scrollIntoView({behavior:'smooth', block:'center'}); return; }

  // Validate required docs uploaded
  const requiredDocs = ['docs_id','docs_income'];
  const missingDocs = requiredDocs.filter(b => !(fileBuckets[b] && fileBuckets[b].length));
  if (missingDocs.length) {
    alert('Please upload the required documents: government ID and proof of income.');
    document.querySelector(`[data-target="${missingDocs[0]}"]`)?.scrollIntoView({behavior:'smooth',block:'center'});
    return;
  }

  // Build a draft application object
  const fd = new FormData(form);
  const application = {};
  fd.forEach((v,k) => { application[k] = v; });
  application.documents = Object.fromEntries(
    Object.entries(fileBuckets).map(([k,arr]) => [k, arr.map(f => ({name:f.name, size:f.size, type:f.type}))])
  );

  // Each adult submits their own application — fee depends on whether this is
  // the primary applicant for the property or a co-applicant joining one already
  // in flight. Fees: $75 primary, $50 each subsequent co-applicant.
  const isPrimary = (fd.get('applicant_role') || 'primary') === 'primary';
  const feeUsd = isPrimary ? 75 : 50;
  const adults = 1; // one application per submission; admin tallies co-apps in the queue

  if (DEMO_MODE) {
    // Demo: save to localStorage and bounce to confirmation page
    const confirmation = 'IPR-' + Date.now().toString(36).toUpperCase().slice(-7);
    localStorage.setItem('investpro_last_application',
      JSON.stringify({ confirmation, adults, feeUsd, application, demo:true, ts: Date.now() }));
    localStorage.removeItem(DRAFT_KEY);
    location.href = `application-submitted.html?c=${confirmation}&demo=1`;
    return;
  }

  // Real flow: post to backend that creates a Stripe Checkout session.
  // The backend persists the application in Supabase (status='pending_payment')
  // and returns a Stripe Checkout URL. After payment, Stripe redirects back
  // to application-submitted.html?session_id=... and the backend webhook
  // marks status='submitted', uploads documents, etc.
  try {
    // Upload documents first (so they're in Supabase before payment).
    // (Alternatively, defer until webhook; but uploading first is simpler.)
    // ... For now we send a JSON request and let the server URL the upload separately.
    const response = await fetch(CREATE_CHECKOUT_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ application, adults, feeUsd })
    });
    if (!response.ok) throw new Error('Server error creating checkout session.');
    const { checkoutUrl } = await response.json();
    location.href = checkoutUrl;
  } catch (err) {
    alert('Could not start checkout: ' + err.message + '\n\nPlease try again or call our office at 702-816-5555.');
  }
}

/* ---------------- Boot ---------------- */
document.addEventListener('DOMContentLoaded', () => {
  const form = document.getElementById('applicationForm');
  if (!form) return;
  wireDragDrop();
  wirePets();
  wireAgentToggle();
  restoreDraft(form);
  autoSaveDraft(form);
  form.addEventListener('submit', handleSubmit);

  // Default signature date to today
  const dateField = form.elements['signature_date'];
  if (dateField && !dateField.value) dateField.valueAsDate = new Date();

  // Show a small banner if running in demo mode
  if (DEMO_MODE) {
    const banner = document.createElement('div');
    banner.className = 'banner banner-info';
    banner.style.marginBottom = '1rem';
    banner.innerHTML = '⚙️ <strong>Demo mode:</strong> form will save locally and skip real Stripe payment until Supabase + Stripe keys are added. See README → "Phase 1: Application workflow."';
    form.parentElement.insertBefore(banner, form);
  }
});
