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
    return u;
  },

  /** Convenience: require ANY signed-in user (for shared portal pages). */
  async requireAuth() {
    const u = await this.currentUser();
    if (!u) { location.href = '/portal/login.html'; return null; }
    return u;
  }
};

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
