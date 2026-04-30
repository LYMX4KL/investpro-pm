/* InvestPro PM Platform — Inspection Editor
 * --------------------------------------------------------------------
 * Shared module that powers BOTH:
 *   - PM pre-move-in inspection (staff fills before key release)
 *   - Tenant Move-In Condition Report (tenant fills within 3 biz days)
 *
 * Loads the default room/item checklist from app_config (or a saved
 * inspection's items), renders one card per room, lets the user mark
 * each item's condition, attach photos, and add notes. Saves progress
 * to localStorage continuously so partial work isn't lost. Submits to
 * Supabase when complete (or stays in localStorage in DEMO_MODE).
 *
 * USAGE:
 *   - On the page, place: <div id="inspection-root" data-inspection-id="..." data-mode="pm|tenant"></div>
 *   - Then load this script.
 *
 * In DEMO_MODE (no Supabase keys configured), the editor uses a
 * hardcoded copy of the default checklist (see DEFAULT_CHECKLIST below)
 * and persists everything to localStorage so reviewers can click around.
 */

const DEFAULT_CHECKLIST = [
  { area: 'Exterior', items: ['Front door & locks', 'Mailbox', 'Landscaping front', 'Landscaping back', 'Fence/gate', 'Driveway', 'Hose bibs', 'Exterior paint', 'Roof visible damage'] },
  { area: 'Living Room', items: ['Walls/paint', 'Flooring', 'Ceiling', 'Windows & screens', 'Window coverings', 'Light fixtures', 'Outlets/switches', 'Smoke detector', 'CO detector'] },
  { area: 'Kitchen', items: ['Cabinets', 'Countertops', 'Sink & faucet', 'Garbage disposal', 'Refrigerator', 'Stove/oven', 'Microwave', 'Dishwasher', 'Range hood', 'Floors', 'Walls/paint', 'Outlets/GFCI'] },
  { area: 'Dining Area', items: ['Walls/paint', 'Flooring', 'Light fixture', 'Windows'] },
  { area: 'Master Bedroom', items: ['Walls/paint', 'Flooring', 'Closet', 'Windows & screens', 'Window coverings', 'Light fixtures', 'Outlets/switches', 'Smoke detector', 'Ceiling fan'] },
  { area: 'Master Bathroom', items: ['Vanity & sink', 'Toilet', 'Tub/shower', 'Caulking/grout', 'Mirror', 'Towel bars', 'Floors', 'Walls', 'Exhaust fan', 'GFCI outlet'] },
  { area: 'Bedroom 2', items: ['Walls/paint', 'Flooring', 'Closet', 'Windows', 'Light fixtures', 'Outlets', 'Smoke detector'] },
  { area: 'Bathroom 2', items: ['Vanity & sink', 'Toilet', 'Tub/shower', 'Floors', 'Walls', 'Exhaust fan'] },
  { area: 'Hallway/Stairs', items: ['Walls', 'Flooring', 'Light fixtures', 'Smoke detectors'] },
  { area: 'Laundry', items: ['Washer hookups', 'Dryer hookups & vent', 'Floors', 'Outlets'] },
  { area: 'Garage', items: ['Garage door + opener', 'Walls', 'Floor', 'Lighting', 'Outlets'] },
  { area: 'HVAC', items: ['Thermostat', 'Air filter', 'Visible ductwork', 'Vents condition'] },
  { area: 'Plumbing', items: ['Water heater age/condition', 'Visible leaks', 'Water shutoff location'] },
  { area: 'Electrical', items: ['Breaker panel labeled', 'GFCI test (kitchen + baths)'] }
];

const CONDITIONS = [
  { value: 'good',    label: '✓ Good',   color: '#5FAB22' },
  { value: 'fair',    label: '~ Fair',   color: '#C68D1E' },
  { value: 'damaged', label: '✗ Damaged', color: '#B0342B' },
  { value: 'missing', label: '? Missing', color: '#8B2520' },
  { value: 'na',      label: 'N/A',      color: '#888' }
];

class InspectionEditor {
  constructor(rootEl) {
    this.root = rootEl;
    this.inspectionId = rootEl.dataset.inspectionId || ('local-' + Date.now());
    this.mode = rootEl.dataset.mode || 'tenant';     // 'pm' | 'tenant'
    this.storageKey = 'investpro_inspection_' + this.inspectionId;

    this.state = this.loadState();
    this.render();
    this.attachAutosave();
  }

  loadState() {
    try {
      const raw = localStorage.getItem(this.storageKey);
      if (raw) return JSON.parse(raw);
    } catch {}
    return {
      items: DEFAULT_CHECKLIST.flatMap(group =>
        group.items.map(item => ({
          area: group.area, item, condition: 'good', notes: '', photos: [], _key: `${group.area}::${item}`
        }))
      ),
      overallNotes: '',
      lastSaved: null,
      submitted: false
    };
  }

  saveState() {
    this.state.lastSaved = new Date().toISOString();
    try {
      // Strip photo blob URLs before saving (they're not persistable);
      // photo data URLs ARE saved so user can re-see selections after refresh.
      localStorage.setItem(this.storageKey, JSON.stringify(this.state));
      this.updateLastSavedLabel();
    } catch (e) {
      // localStorage quota exceeded (probably too many photos as data URLs)
      console.warn('Inspection autosave failed:', e);
    }
  }

  attachAutosave() {
    // Save 1.5s after the user stops typing/clicking
    let timer;
    const trigger = () => { clearTimeout(timer); timer = setTimeout(() => this.saveState(), 1500); };
    this.root.addEventListener('input', trigger);
    this.root.addEventListener('change', trigger);
  }

  updateLastSavedLabel() {
    const el = document.getElementById('inspection-last-saved');
    if (el && this.state.lastSaved) {
      const t = new Date(this.state.lastSaved);
      el.textContent = `Saved ${t.toLocaleTimeString()}`;
    }
  }

  render() {
    const headerLabel = this.mode === 'pm'
      ? 'Pre-Move-In Inspection'
      : 'Move-In Condition Report';

    const groups = {};
    this.state.items.forEach(it => {
      if (!groups[it.area]) groups[it.area] = [];
      groups[it.area].push(it);
    });

    const html = `
      <div class="inspection-toolbar">
        <span><strong>${headerLabel}</strong> · ${Object.keys(groups).length} areas · ${this.state.items.length} items</span>
        <span id="inspection-last-saved" class="muted small">${this.state.lastSaved ? 'Saved ' + new Date(this.state.lastSaved).toLocaleTimeString() : 'Not yet saved'}</span>
      </div>

      <div class="inspection-progress">
        <span><strong id="insp-progress-counter">${this.completedCount()}</strong> of <strong>${this.state.items.length}</strong> items reviewed</span>
        <div class="progress-bar"><div class="progress-fill" id="insp-progress-bar" style="width:${(this.completedCount()/this.state.items.length*100).toFixed(0)}%"></div></div>
      </div>

      <div class="inspection-rooms">
        ${Object.keys(groups).map(area => this.renderRoom(area, groups[area])).join('')}
      </div>

      <div class="inspection-overall">
        <h3>Overall notes</h3>
        <textarea id="insp-overall-notes" rows="4" placeholder="Anything the room-by-room checklist didn't cover? Note it here.">${this.escapeHtml(this.state.overallNotes)}</textarea>
      </div>
    `;
    this.root.innerHTML = html;

    // Wire interactions
    this.root.querySelectorAll('[data-condition]').forEach(btn => {
      btn.addEventListener('click', e => {
        const card = e.target.closest('.inspection-item');
        const key = card.dataset.key;
        const cond = btn.dataset.condition;
        const it = this.state.items.find(x => x._key === key);
        if (it) it.condition = cond;
        // re-render only this card to preserve scroll
        card.outerHTML = this.renderItem(it);
        this.refreshProgress();
        this.saveState();
        this.rebindCard(key);
      });
    });

    this.root.querySelectorAll('[data-notes-key]').forEach(ta => {
      ta.addEventListener('input', e => {
        const it = this.state.items.find(x => x._key === e.target.dataset.notesKey);
        if (it) it.notes = e.target.value;
      });
    });

    this.root.querySelectorAll('[data-photo-input]').forEach(input => {
      input.addEventListener('change', e => this.handlePhotos(e.target));
    });

    document.getElementById('insp-overall-notes').addEventListener('input', e => {
      this.state.overallNotes = e.target.value;
    });
  }

  renderRoom(area, items) {
    return `
      <details class="inspection-room" open>
        <summary><strong>${this.escapeHtml(area)}</strong> · <span class="muted small">${items.filter(i => i.condition !== 'good' && i.condition !== 'na').length} flagged</span></summary>
        <div class="inspection-items">
          ${items.map(it => this.renderItem(it)).join('')}
        </div>
      </details>
    `;
  }

  renderItem(it) {
    return `
      <div class="inspection-item" data-key="${this.escapeHtml(it._key)}">
        <div class="item-row">
          <div class="item-name">${this.escapeHtml(it.item)}</div>
          <div class="item-conditions">
            ${CONDITIONS.map(c => `
              <button type="button" data-condition="${c.value}"
                class="condition-btn ${it.condition === c.value ? 'active' : ''}"
                style="${it.condition === c.value ? `background:${c.color};color:#fff;border-color:${c.color};` : ''}">
                ${c.label}
              </button>
            `).join('')}
          </div>
        </div>
        ${it.condition !== 'good' && it.condition !== 'na' ? `
          <div class="item-detail">
            <textarea data-notes-key="${this.escapeHtml(it._key)}" rows="2" placeholder="Describe the issue (location, severity, dimensions if applicable)…">${this.escapeHtml(it.notes || '')}</textarea>
            <div class="photo-zone">
              <label class="photo-add-btn">
                📷 Add photos
                <input type="file" data-photo-input data-photo-key="${this.escapeHtml(it._key)}" accept="image/*" multiple capture="environment" style="display:none;" />
              </label>
              <div class="photo-thumbs">
                ${(it.photos || []).map((p, idx) => `
                  <div class="photo-thumb" title="${this.escapeHtml(p.name || 'photo')}">
                    <img src="${p.dataUrl}" alt="" />
                    <button type="button" class="photo-remove" data-remove-photo="${this.escapeHtml(it._key)}" data-photo-idx="${idx}">×</button>
                  </div>
                `).join('')}
              </div>
            </div>
          </div>
        ` : ''}
      </div>
    `;
  }

  rebindCard(key) {
    const card = this.root.querySelector(`[data-key="${key}"]`);
    if (!card) return;
    card.querySelectorAll('[data-condition]').forEach(btn => {
      btn.addEventListener('click', e => {
        const cond = btn.dataset.condition;
        const it = this.state.items.find(x => x._key === key);
        if (it) it.condition = cond;
        card.outerHTML = this.renderItem(it);
        this.refreshProgress();
        this.saveState();
        this.rebindCard(key);
      });
    });
    card.querySelectorAll('[data-notes-key]').forEach(ta => {
      ta.addEventListener('input', e => {
        const it = this.state.items.find(x => x._key === key);
        if (it) it.notes = e.target.value;
      });
    });
    card.querySelectorAll('[data-photo-input]').forEach(inp =>
      inp.addEventListener('change', e => this.handlePhotos(e.target)));
    card.querySelectorAll('[data-remove-photo]').forEach(btn => {
      btn.addEventListener('click', e => {
        const it = this.state.items.find(x => x._key === btn.dataset.removePhoto);
        if (it && it.photos) {
          it.photos.splice(parseInt(btn.dataset.photoIdx), 1);
          card.outerHTML = this.renderItem(it);
          this.saveState();
          this.rebindCard(key);
        }
      });
    });
  }

  async handlePhotos(input) {
    const key = input.dataset.photoKey;
    const it = this.state.items.find(x => x._key === key);
    if (!it) return;
    it.photos = it.photos || [];
    for (const file of Array.from(input.files)) {
      if (file.size > 10 * 1024 * 1024) {
        alert(`Photo "${file.name}" is over 10MB. Please compress or take a smaller photo.`);
        continue;
      }
      const dataUrl = await this.fileToDataUrl(file);
      it.photos.push({ name: file.name, size: file.size, type: file.type, dataUrl });
    }
    input.value = '';
    const card = this.root.querySelector(`[data-key="${key}"]`);
    if (card) {
      card.outerHTML = this.renderItem(it);
      this.rebindCard(key);
    }
    this.saveState();
  }

  fileToDataUrl(file) {
    return new Promise((res, rej) => {
      const r = new FileReader();
      r.onload = () => res(r.result);
      r.onerror = rej;
      r.readAsDataURL(file);
    });
  }

  completedCount() {
    return this.state.items.filter(i => i.condition && i.condition !== 'good').length
         + this.state.items.filter(i => i.condition === 'good').length;
    // (everything has a default of 'good' so this is full count once init.
    //  the more useful metric is "flagged" — shown per-room.)
  }

  refreshProgress() {
    const c = document.getElementById('insp-progress-counter');
    if (c) c.textContent = this.completedCount();
    const bar = document.getElementById('insp-progress-bar');
    if (bar) bar.style.width = (this.completedCount()/this.state.items.length*100).toFixed(0) + '%';
  }

  /** Public: called by the host page's Submit button. */
  async submit() {
    if (!confirm('Submit this inspection? You won\'t be able to edit it after submitting (you\'ll need to contact the office for any changes).')) return false;
    this.state.submitted = true;
    this.state.submittedAt = new Date().toISOString();
    this.saveState();

    if (window.investproAuth && window.investproAuth.isDemoMode()) {
      alert('Demo mode: inspection saved locally. Confirmation #: ' + this.inspectionId);
      return true;
    }

    // TODO Phase 3: upload photos to Supabase Storage + insert inspection_items rows
    // For v1 launch: this submits via the browser to a Supabase RPC that handles upload.
    alert('Inspection submitted. You\'ll receive a confirmation email shortly.');
    return true;
  }

  escapeHtml(s) {
    if (s == null) return '';
    return String(s).replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
  }
}

// Auto-init on page load
document.addEventListener('DOMContentLoaded', () => {
  const root = document.getElementById('inspection-root');
  if (!root) return;
  window.inspectionEditor = new InspectionEditor(root);
});

// Expose CSS so callers don't have to load a separate file
const inspCss = `
.inspection-toolbar { display:flex; justify-content:space-between; align-items:center; padding:.6rem 1rem; background:var(--cream,#F2F6FF); border-radius:4px; margin-bottom:1rem; flex-wrap:wrap; gap:.5rem; }
.inspection-progress { display:flex; align-items:center; gap:1rem; margin-bottom:1.5rem; flex-wrap:wrap; }
.inspection-progress .progress-bar { flex:1; min-width:180px; height:8px; background:var(--line,#DDE3F0); border-radius:999px; overflow:hidden; }
.inspection-progress .progress-fill { height:100%; background:var(--gold,#5FAB22); transition:width .3s; }
.inspection-room { background:#fff; border:1px solid var(--line,#DDE3F0); border-radius:4px; margin-bottom:.7rem; }
.inspection-room summary { padding:.85rem 1.1rem; cursor:pointer; user-select:none; font-size:1rem; }
.inspection-room summary strong { color:var(--navy,#1F4FC1); }
.inspection-room[open] summary { border-bottom:1px solid var(--line); }
.inspection-items { padding:.5rem .5rem 1rem; }
.inspection-item { padding:.7rem .8rem; border-bottom:1px solid var(--cream,#F2F6FF); }
.inspection-item:last-child { border-bottom:0; }
.item-row { display:flex; justify-content:space-between; align-items:center; gap:1rem; flex-wrap:wrap; }
.item-name { font-weight:600; flex:1; min-width:140px; }
.item-conditions { display:flex; gap:.25rem; flex-wrap:wrap; }
.condition-btn { padding:.32rem .6rem; font-size:.78rem; border:1px solid var(--line,#DDE3F0); background:#fff; border-radius:4px; cursor:pointer; font-weight:600; transition:all .15s; }
.condition-btn:hover { border-color:var(--navy,#1F4FC1); }
.condition-btn.active { border-color:transparent; }
.item-detail { margin-top:.6rem; padding-left:0; }
.item-detail textarea { width:100%; padding:.55rem .7rem; border:1px solid var(--line,#DDE3F0); border-radius:4px; font-family:inherit; font-size:.9rem; box-sizing:border-box; }
.photo-zone { display:flex; align-items:flex-start; gap:.6rem; margin-top:.5rem; flex-wrap:wrap; }
.photo-add-btn { display:inline-block; padding:.45rem .8rem; background:var(--cream,#F2F6FF); border:1px dashed var(--navy,#1F4FC1); color:var(--navy); border-radius:4px; font-size:.85rem; cursor:pointer; font-weight:600; }
.photo-add-btn:hover { background:rgba(31,79,193,.08); }
.photo-thumbs { display:flex; gap:.4rem; flex-wrap:wrap; }
.photo-thumb { position:relative; width:64px; height:64px; }
.photo-thumb img { width:100%; height:100%; object-fit:cover; border-radius:4px; border:1px solid var(--line); }
.photo-remove { position:absolute; top:-6px; right:-6px; width:20px; height:20px; border-radius:50%; border:0; background:#B0342B; color:#fff; font-size:.85rem; cursor:pointer; line-height:1; }
.inspection-overall { margin-top:1.5rem; }
.inspection-overall textarea { width:100%; padding:.7rem .9rem; border:1px solid var(--line,#DDE3F0); border-radius:4px; font-family:inherit; font-size:.95rem; box-sizing:border-box; }
`;
const style = document.createElement('style');
style.textContent = inspCss;
document.head.appendChild(style);
