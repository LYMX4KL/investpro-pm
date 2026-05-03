/* InvestPro Realty — Public-page sign-in state
 * --------------------------------------------------------------------
 * On public marketing pages (index.html, recruiting.html, whyus.html,
 * about.html, contact.html, sales.html, listings.html, etc.) — check
 * if the visitor already has a Supabase session and, if so, swap the
 * "Sign In" nav button for an "Open Dashboard" button that points to
 * their role's dashboard.
 *
 * Why this exists:
 *   Helen + Omyko reported "clicking the logo logs me out." Reality:
 *   the session is still valid; the public homepage just doesn't know
 *   about it because it doesn't load auth.js. From the user's
 *   perspective it looks identical to being signed out.
 *
 * Loads in addition to preview-gate.js + main.js. Safe to include on
 * every public page — does nothing destructive if there's no session.
 */

(function () {
  // Skip if we're inside the portal (those pages have their own header)
  if (location.pathname.includes('/portal/')) return;

  // Skip in demo mode (no real Supabase backend)
  // We need to read DEMO_MODE / SUPABASE_URL from auth.js. Easiest: fetch + regex.
  loadAndRun().catch(err => console.warn('header-auth: skipped —', err.message));

  async function loadAndRun() {
    const authSrc = await fetch('/js/auth.js').then(r => r.text()).catch(() => null);
    if (!authSrc) return;
    const demoMatch = authSrc.match(/const DEMO_MODE\s*=\s*(true|false)/);
    const urlMatch  = authSrc.match(/SUPABASE_URL\s*=\s*'([^']+)'/);
    const keyMatch  = authSrc.match(/SUPABASE_ANON_KEY\s*=\s*'([^']+)'/);
    if (!urlMatch || !keyMatch) return;
    if (demoMatch && demoMatch[1] === 'true') return; // demo mode — skip

    const { createClient } = await import('https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm');
    const supa = createClient(urlMatch[1], keyMatch[1]);
    const { data } = await supa.auth.getSession();
    if (!data?.session) return;          // not signed in → leave the nav alone

    // Look up role via profiles
    const userId = data.session.user.id;
    const { data: prof } = await supa.from('profiles').select('role, full_name').eq('id', userId).maybeSingle();
    const role = prof?.role || data.session.user.user_metadata?.role || 'tenant';
    const dashUrl = homeForRole(role);

    swapNavButton(dashUrl, prof?.full_name || data.session.user.email);
  }

  function homeForRole(role) {
    const base = '/portal';
    switch (role) {
      case 'broker':        return `${base}/broker/dashboard.html`;
      case 'va':            return `${base}/va/dashboard.html`;
      case 'accounting':    return `${base}/accounting/dashboard.html`;
      case 'compliance':    return `${base}/compliance/dashboard.html`;
      case 'leasing':       return `${base}/leasing/dashboard.html`;
      case 'pm_service':    return `${base}/pm/dashboard.html`;
      case 'admin_onsite':  return `${base}/admin/dashboard.html`;
      case 'agent_listing':
      case 'agent_showing': return `${base}/agent/dashboard.html`;
      case 'tenant':        return `${base}/tenant-dashboard.html`;
      case 'owner':         return `${base}/owner-dashboard.html`;
      case 'applicant':     return `${base}/applicant/dashboard.html`;
      case 'vendor':        return `${base}/agent/dashboard.html`; // vendor uses the agent shell for now
      default:              return `${base}/login.html`;
    }
  }

  function swapNavButton(dashUrl, name) {
    // Find any "Sign In" / "Owner / Tenant Login" button in the public nav
    const nav = document.querySelector('header .nav, .site-header .nav');
    if (!nav) return;

    // Match by href ending with /portal/login.html (most reliable)
    const candidates = nav.querySelectorAll('a[href*="portal/login"]');
    if (!candidates.length) return;

    const firstName = (name || '').split(/[ @]/)[0] || 'Dashboard';

    candidates.forEach(a => {
      a.textContent = `Open ${firstName}'s Dashboard →`;
      a.setAttribute('href', dashUrl);
      a.classList.add('btn-primary');
      a.title = 'You are signed in. Click to return to your dashboard.';
    });
  }
})();
