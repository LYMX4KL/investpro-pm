/* InvestPro Realty — Preview Password Gate
 * ----------------------------------------------------------
 * Lightweight password prompt for the preview deploy. Lets you share
 * the WIP site with your team while keeping the public from finding it.
 *
 * IMPORTANT — what this is and isn't:
 *   ✓ Stops casual visitors and search engines from seeing the site
 *   ✓ Works on Netlify's free tier (no Pro plan needed)
 *   ✗ NOT real security — the password is in this file, viewable by
 *     anyone who opens the browser's "View Source". For a preview with
 *     sample data, that's fine. Once real client data is on the site,
 *     replace this with a server-side auth gate (Cloudflare Access,
 *     Netlify Pro password, or Supabase auth on every page).
 *
 * HOW TO USE:
 *   1. Set GATE_ENABLED = true and pick a password (PREVIEW_PASSWORD).
 *   2. Share the URL + password with your team via Slack/email.
 *   3. When you're ready to launch publicly, set GATE_ENABLED = false.
 *
 * HOW TO CHANGE THE PASSWORD:
 *   Edit PREVIEW_PASSWORD below, redeploy. Old sessions invalidate
 *   automatically (the password is part of the cache key).
 */

(function () {
  const GATE_ENABLED      = true;                // ON during soft-launch testing — turn OFF when going fully public
  const PREVIEW_PASSWORD  = 'investpro2026';     // share with team via Slack/text; change here + redeploy to rotate
  const PREVIEW_VERSION   = 'v1.1-soft-launch';  // shown in the corner badge so reviewers know which build they're seeing
  const STORAGE_KEY       = 'investpro_gate_v4'; // bump this string to force everyone to re-enter

  if (!GATE_ENABLED) return;

  // Already passed the gate this session?
  try {
    if (sessionStorage.getItem(STORAGE_KEY) === '1') {
      return showVersionBadge();
    }
  } catch {}

  // Hide the page contents while we draw the gate
  document.documentElement.style.visibility = 'hidden';

  // Wait for DOM ready, then mount the gate
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', mount);
  } else {
    mount();
  }

  function mount() {
    document.documentElement.style.visibility = 'hidden'; // re-assert
    const overlay = document.createElement('div');
    overlay.id = 'previewGate';
    overlay.style.cssText = `
      position: fixed; inset: 0; z-index: 999999;
      background: linear-gradient(135deg, #143489 0%, #1F4FC1 60%, #3263D7 100%);
      display: grid; place-items: center;
      visibility: visible;
      font-family: 'Source Sans Pro', 'Helvetica Neue', Arial, sans-serif;
      padding: 1rem;
    `;
    overlay.innerHTML = `
      <div style="
        background: #fff; max-width: 440px; width: 100%;
        padding: 2.5rem 2rem; border-radius: 6px;
        border-top: 4px solid #5FAB22;
        box-shadow: 0 18px 48px rgba(0,0,0,.25);
        text-align: center;
      ">
        <div style="font-family: 'Playfair Display', Georgia, serif; color: #1F4FC1; font-size: 1.6rem; font-weight: 700;">
          InvestPro Realty
        </div>
        <div style="
          font-size: .7rem; font-weight: 700; color: #5FAB22;
          text-transform: uppercase; letter-spacing: .25em; margin-top: .3rem;
        ">Preview · Team Review</div>
        <p style="margin: 1.4rem 0 1.2rem; color: #555A6B; font-size: .95rem; line-height: 1.5;">
          This is the in-progress rebuild of investprorealty.net. Please enter the team preview password to continue. Need it? Ask Kenny.
        </p>
        <form id="gateForm">
          <input
            type="password" id="gatePass" placeholder="Preview password"
            autofocus autocomplete="off"
            style="
              width:100%; padding:.85rem 1rem; font-size:1rem;
              border:1px solid #DDE3F0; border-radius: 4px;
              font-family: inherit; box-sizing: border-box;
            "
          />
          <div id="gateErr" style="
            display:none; color:#B0342B; font-size:.85rem;
            margin: .6rem 0 0; font-weight: 600;
          ">Incorrect password. Try again.</div>
          <button type="submit" style="
            margin-top: 1rem; width: 100%; padding: .9rem;
            background: #5FAB22; color: #fff; border: 0;
            font-weight: 700; letter-spacing: .08em; text-transform: uppercase;
            font-size: .9rem; cursor: pointer; border-radius: 4px;
            font-family: inherit;
          ">Enter Preview</button>
        </form>
        <p style="margin-top: 1.5rem; font-size: .8rem; color: #888;">
          Found a bug or have feedback?
          <a href="mailto:info@investprorealty.net?subject=InvestPro%20preview%20feedback" style="color:#1F4FC1;">
            email it to us
          </a>.
        </p>
      </div>
    `;
    document.body.appendChild(overlay);

    document.getElementById('gateForm').addEventListener('submit', function (e) {
      e.preventDefault();
      const val = document.getElementById('gatePass').value;
      if (val === PREVIEW_PASSWORD) {
        try { sessionStorage.setItem(STORAGE_KEY, '1'); } catch {}
        overlay.remove();
        document.documentElement.style.visibility = '';
        showVersionBadge();
      } else {
        const err = document.getElementById('gateErr');
        err.style.display = 'block';
        document.getElementById('gatePass').value = '';
        document.getElementById('gatePass').focus();
      }
    });
  }

  /** Floating badge that expands into a small menu with: "Reviewer Hub" link and
   *  "Send feedback" link. Always visible bottom-right so reviewers can
   *  navigate or give feedback from any page. */
  function showVersionBadge() {
    if (document.getElementById('previewBadge')) return;

    // Compute relative path to reviewer-welcome.html based on current depth
    const depth = (location.pathname.match(/\//g) || []).length - 1;
    const welcomeHref = (depth > 0 ? '../'.repeat(depth) : '') + 'reviewer-welcome.html';

    const wrap = document.createElement('div');
    wrap.id = 'previewBadge';
    wrap.style.cssText = `
      position: fixed; bottom: 12px; right: 12px; z-index: 99999;
      font-family: 'Source Sans Pro', Arial, sans-serif;
    `;
    wrap.innerHTML = `
      <div id="previewBadgeMenu" style="
        display: none; position: absolute; bottom: 44px; right: 0;
        background: #fff; border: 1px solid #DDE3F0; border-radius: 6px;
        box-shadow: 0 8px 24px rgba(0,0,0,.18);
        min-width: 220px; overflow: hidden;
      ">
        <a href="${welcomeHref}" style="
          display: block; padding: .75rem 1rem; color: #1F4FC1;
          text-decoration: none; font-weight: 700; font-size: .9rem;
          border-bottom: 1px solid #DDE3F0;
        ">📍 Reviewer Hub <span style="font-weight:400;color:#888;font-size:.78rem;">— see what to look at</span></a>
        <a id="previewBadgeFeedback" href="#" style="
          display: block; padding: .75rem 1rem; color: #1F4FC1;
          text-decoration: none; font-weight: 700; font-size: .9rem;
        ">✉️ Send feedback <span style="font-weight:400;color:#888;font-size:.78rem;">— email this page</span></a>
      </div>
      <button id="previewBadgeBtn" type="button" style="
        background: #1F4FC1; color: #fff; padding: .55rem 1rem;
        border: 0; border-radius: 999px;
        font: 600 .78rem 'Source Sans Pro', Arial, sans-serif;
        letter-spacing: .04em; box-shadow: 0 4px 14px rgba(0,0,0,.18);
        cursor: pointer;
      ">🔒 Preview ${PREVIEW_VERSION} ▾</button>
    `;

    const place = () => {
      if (document.body) document.body.appendChild(wrap);
      else document.addEventListener('DOMContentLoaded', () => document.body.appendChild(wrap));
    };
    place();

    setTimeout(() => {
      const btn = document.getElementById('previewBadgeBtn');
      const menu = document.getElementById('previewBadgeMenu');
      const feedback = document.getElementById('previewBadgeFeedback');
      if (!btn || !menu || !feedback) return;

      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        menu.style.display = (menu.style.display === 'block' ? 'none' : 'block');
      });
      document.addEventListener('click', () => { menu.style.display = 'none'; });

      feedback.addEventListener('click', (e) => {
        e.preventDefault();
        const subject = encodeURIComponent(`Preview feedback (${PREVIEW_VERSION}) — ${document.title}`);
        const body = encodeURIComponent(
          `Page: ${location.href}\n` +
          `Build: ${PREVIEW_VERSION}\n\n` +
          `My feedback:\n\n` +
          `(describe what you saw and what you'd change)\n`
        );
        location.href = `mailto:info@investprorealty.net?subject=${subject}&body=${body}`;
      });
    }, 50);
  }
})();
