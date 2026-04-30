/* InvestPro PM — Properties Store
 * --------------------------------------------------------------------
 * Single source-of-truth for property records used by the listings page,
 * the application form, and the property management pages.
 *
 * In DEMO_MODE (default): persists to localStorage so the team can test
 * end-to-end without a backend. Includes 3 seed properties so the public
 * listings page is never empty.
 *
 * In real mode: reads/writes to Supabase `properties` table via the same
 * API surface (window.propertiesStore.list / get / create / update / delete).
 */

const STORAGE_KEY = 'investpro_properties_v1';

const SEED_PROPERTIES = [
  {
    id: 'seed-3601-sahara',
    address_line1: '3601 W Sahara Ave',
    address_line2: '#207',
    city: 'Las Vegas',
    state: 'NV',
    zip: '89102',
    monthly_rent: 1850,
    security_deposit_amount: 1850,
    pet_deposit_amount: 300,
    pet_rent_monthly: 35,
    bedrooms: 2,
    bathrooms: 2,
    sqft: 1120,
    year_built: 2008,
    parking: '1 covered space',
    pets_allowed: 'cats',
    has_pool: true,
    hoa_name: 'Sahara West Villas',
    property_type: 'condo',
    status: 'listed',
    listing_at: '2026-04-15',
    sewer_trash_included_in_rent: true,
    description: 'Modern 2BD/2BA condo on West Sahara — quick access to Strip + Summerlin. Updated kitchen with stainless appliances, in-unit laundry, secure parking, community pool.',
    listing_agent_name: 'Kenny Lin',
    photos: ['../../images/property-placeholder.svg']
  },
  {
    id: 'seed-2440-vegas',
    address_line1: '2440 Vegas Drive',
    city: 'Las Vegas',
    state: 'NV',
    zip: '89106',
    monthly_rent: 2400,
    security_deposit_amount: 2400,
    pet_deposit_amount: 0,
    pet_rent_monthly: 0,
    bedrooms: 3,
    bathrooms: 2,
    sqft: 1750,
    year_built: 1998,
    parking: '2-car garage',
    pets_allowed: 'none',
    has_pool: false,
    property_type: 'sfh',
    status: 'listed',
    listing_at: '2026-04-24',
    sewer_trash_included_in_rent: true,
    description: 'Spacious 3BD/2BA single-family home on a quiet residential street. Large backyard, 2-car garage, recently updated kitchen.',
    listing_agent_name: 'Kenny Lin',
    photos: ['../../images/property-placeholder.svg']
  },
  {
    id: 'seed-9100-decatur',
    address_line1: '9100 N Decatur Blvd',
    address_line2: '#11',
    city: 'Las Vegas',
    state: 'NV',
    zip: '89131',
    monthly_rent: 1650,
    security_deposit_amount: 1650,
    pet_deposit_amount: 250,
    pet_rent_monthly: 30,
    bedrooms: 2,
    bathrooms: 1.5,
    sqft: 980,
    year_built: 2002,
    parking: '1 covered space',
    pets_allowed: 'both',
    has_pool: true,
    property_type: 'condo',
    status: 'listed',
    listing_at: '2026-04-08',
    sewer_trash_included_in_rent: true,
    description: '2BD/1.5BA condo in Northwest Las Vegas. Pet-friendly community with pool and gym. Easy access to US-95.',
    listing_agent_name: 'Kenny Lin',
    photos: ['../../images/property-placeholder.svg']
  }
];

function loadFromStorage() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return JSON.parse(raw);
  } catch {}
  // First load: seed
  saveToStorage(SEED_PROPERTIES);
  return [...SEED_PROPERTIES];
}

function saveToStorage(items) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(items)); }
  catch (e) { console.warn('Properties save failed:', e); }
}

function genId() {
  return 'prop-' + Math.random().toString(36).slice(2, 10);
}

window.propertiesStore = {
  /** List all properties (in real mode, filterable by status). */
  async list({ status } = {}) {
    if (!window.investproAuth || window.investproAuth.isDemoMode()) {
      let items = loadFromStorage();
      if (status) items = items.filter(p => p.status === status);
      return items;
    }
    // Real mode: query Supabase
    const sb = await getSupa();
    let q = sb.from('properties').select('*').order('listing_at', { ascending: false });
    if (status) q = q.eq('status', status);
    const { data } = await q;
    return data || [];
  },

  /** Get a single property by ID. */
  async get(id) {
    if (!window.investproAuth || window.investproAuth.isDemoMode()) {
      return loadFromStorage().find(p => p.id === id) || null;
    }
    const sb = await getSupa();
    const { data } = await sb.from('properties').select('*').eq('id', id).single();
    return data;
  },

  /** Create a property. Returns the new ID. */
  async create(obj) {
    if (!window.investproAuth || window.investproAuth.isDemoMode()) {
      const items = loadFromStorage();
      const newProp = { id: genId(), ...obj };
      items.push(newProp);
      saveToStorage(items);
      return newProp.id;
    }
    const sb = await getSupa();
    const { data, error } = await sb.from('properties').insert(obj).select('id').single();
    if (error) throw error;
    return data.id;
  },

  /** Update a property by ID. */
  async update(id, obj) {
    if (!window.investproAuth || window.investproAuth.isDemoMode()) {
      const items = loadFromStorage();
      const idx = items.findIndex(p => p.id === id);
      if (idx >= 0) {
        items[idx] = { ...items[idx], ...obj, id };
        saveToStorage(items);
      }
      return;
    }
    const sb = await getSupa();
    const { error } = await sb.from('properties').update(obj).eq('id', id);
    if (error) throw error;
  },

  /** Delete a property. */
  async delete(id) {
    if (!window.investproAuth || window.investproAuth.isDemoMode()) {
      const items = loadFromStorage().filter(p => p.id !== id);
      saveToStorage(items);
      return;
    }
    const sb = await getSupa();
    const { error } = await sb.from('properties').delete().eq('id', id);
    if (error) throw error;
  },

  /** Reset to seed (for testing — wipes manually entered properties!). */
  async resetToSeed() {
    if (!confirm('Reset properties to the 3 seed entries? Manually-entered properties will be lost.')) return;
    if (!window.investproAuth || window.investproAuth.isDemoMode()) {
      saveToStorage([...SEED_PROPERTIES]);
      location.reload();
    }
  }
};

// Lazy-load Supabase client (only used in real mode)
async function getSupa() {
  const { createClient } = await import('https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm');
  // Pull keys from auth.js — they're set there once
  return createClient(
    typeof SUPABASE_URL !== 'undefined' ? SUPABASE_URL : window.SUPABASE_URL,
    typeof SUPABASE_ANON_KEY !== 'undefined' ? SUPABASE_ANON_KEY : window.SUPABASE_ANON_KEY
  );
}

/** Helper: format a property as a one-line label. */
window.formatPropertyLabel = function(p) {
  if (!p) return '';
  return `${p.address_line1}${p.address_line2 ? ' ' + p.address_line2 : ''}, ${p.city || 'Las Vegas'}, ${p.state || 'NV'} ${p.zip}`;
};
