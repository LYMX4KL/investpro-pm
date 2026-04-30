/* InvestPro Realty - main site script
   Handles: nav toggle, simple form helpers, year stamp.
*/

document.addEventListener('DOMContentLoaded', function () {
  // Mobile nav toggle
  const toggle = document.querySelector('.menu-toggle');
  const nav = document.querySelector('.nav');
  if (toggle && nav) {
    toggle.addEventListener('click', () => {
      nav.classList.toggle('open');
      toggle.setAttribute('aria-expanded', nav.classList.contains('open'));
    });
  }

  // Auto-year in footer
  document.querySelectorAll('[data-year]').forEach(el => {
    el.textContent = new Date().getFullYear();
  });

  // Highlight active nav link based on current page
  const path = location.pathname.split('/').pop() || 'index.html';
  document.querySelectorAll('.nav a').forEach(a => {
    const href = a.getAttribute('href');
    if (href === path) a.classList.add('active');
  });

  // Simple form validation + submit handler (Formspree-friendly fallback)
  document.querySelectorAll('form[data-validate]').forEach(form => {
    form.addEventListener('submit', function (e) {
      let valid = true;
      form.querySelectorAll('[required]').forEach(field => {
        const errEl = field.parentElement.querySelector('.form-error');
        if (!field.value.trim()) {
          valid = false;
          field.style.borderColor = '#B0342B';
          if (errEl) errEl.classList.add('show');
        } else {
          field.style.borderColor = '';
          if (errEl) errEl.classList.remove('show');
        }
      });
      if (!valid) { e.preventDefault(); return; }

      // If no real backend configured, intercept and show success banner
      if (!form.action || form.action.endsWith('#') || form.action.endsWith('/')) {
        e.preventDefault();
        const banner = document.createElement('div');
        banner.className = 'banner banner-success';
        banner.textContent = 'Thank you! Your form was received. (Demo mode — connect Formspree or Supabase to receive real submissions; see README.)';
        form.parentElement.insertBefore(banner, form);
        form.reset();
        window.scrollTo({ top: banner.offsetTop - 100, behavior: 'smooth' });
      }
    });
  });

  // Listings filter (very simple client-side)
  const filter = document.getElementById('listingFilter');
  if (filter) {
    const cards = document.querySelectorAll('[data-listing]');
    filter.addEventListener('input', function () {
      const type   = filter.querySelector('[name=type]')?.value || '';
      const beds   = filter.querySelector('[name=beds]')?.value || '';
      const min    = parseInt(filter.querySelector('[name=min]')?.value || '0', 10);
      const max    = parseInt(filter.querySelector('[name=max]')?.value || '999999999', 10);
      const search = (filter.querySelector('[name=q]')?.value || '').toLowerCase();
      cards.forEach(c => {
        const t = c.dataset.type;
        const b = parseInt(c.dataset.beds, 10);
        const p = parseInt(c.dataset.price, 10);
        const txt = (c.textContent || '').toLowerCase();
        const ok =
          (!type || t === type) &&
          (!beds || b >= parseInt(beds,10)) &&
          (p >= min && p <= max) &&
          (!search || txt.includes(search));
        c.style.display = ok ? '' : 'none';
      });
    });
  }
});
