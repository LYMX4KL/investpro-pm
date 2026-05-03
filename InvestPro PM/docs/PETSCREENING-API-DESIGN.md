# PetScreening API Polling — Phase B Design

**Goal:** Replace manual FIDO score entry with automatic syncing from PetScreening's REST API.
**Last updated:** 2026-04-30
**Status:** Design phase — implementation pending PetScreening API documentation

---

## Why this exists

PetScreening doesn't push completed-profile callbacks to our webhook. Their integration model is **API-based** — we hold credentials and call their endpoints to fetch results. Until we build that, Neil enters FIDO scores manually (see `PETSCREENING-WORKFLOW.md`).

What we have already (built but unused for now):
- Netlify webhook function at `/netlify/functions/petscreening-webhook.js` — fires only if PetScreening pushes; they don't, so it never fires
- Schema for PetScreening data: `application_pets.pet_screening_*` columns + `webhook_events` audit log
- Vendor settings: PetScreening URL, webhook URL, webhook secret (the latter two will be repurposed for API auth)

---

## Architecture

```
   ┌──────────────┐
   │  PetScreening│
   │     API      │
   └──────┬───────┘
          │ HTTPS
          │ Bearer auth
          ▼
   ┌──────────────────────────────┐
   │ Netlify function:            │
   │ /netlify/functions/          │
   │   petscreening-sync.js       │
   │                              │
   │ - Reads creds from env vars  │
   │ - Calls PetScreening API     │
   │ - Matches by referenceNumber │
   │ - Writes FIDO scores to DB   │
   └─────────┬────────────────────┘
             │
             ▼
   ┌──────────────────────┐
   │ Supabase database    │
   │  application_pets    │
   │  webhook_events      │
   └──────────────────────┘
```

**Trigger model — RECOMMENDED:** hybrid

- **On-demand** — VA clicks "🔄 Sync PetScreening" button on the screening queue
- **Scheduled** — every 30 minutes via Netlify Scheduled Function (cron trigger)

Start with on-demand. Add scheduled once we trust the function.

---

## Required pieces

### 1. PetScreening API credentials

From `https://app.petscreening.com/property_managers/22633/settings/integrations`:
- **Application ID** (already exists): `CCN3CvFgmKZSbCZoguUrvqYlXcqEOYU6X...` (visible in PM dashboard)
- **Secret Key** (must be GENERATED — only shown once at generation, then never again)

When generating the secret key, paste it **immediately** into:
- Netlify env var: `PETSCREENING_API_SECRET_KEY`
- (Don't store in `vendor_settings` table — env var is more secure)

Plus add to env vars:
- `PETSCREENING_APP_ID` = `CCN3CvFgmKZSbCZoguUrvqYlXcqEOYU6X...`
- `PETSCREENING_PM_ID` = `22633`

### 2. New Netlify function

`/netlify/functions/petscreening-sync.js`

```js
// Pseudocode (final design TBD pending API docs)
exports.handler = async (event) => {
  // 1. Read env vars
  const { PETSCREENING_APP_ID, PETSCREENING_API_SECRET_KEY, PETSCREENING_PM_ID,
          SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = process.env;

  // 2. Get last_sync_at from vendor_settings (so we only fetch new profiles)
  const lastSync = await getLastSyncTimestamp();

  // 3. Call PetScreening API
  //    GET /api/v1/property-managers/{PM_ID}/profiles?completed=true&since={lastSync}
  //    Headers: Authorization: Bearer {API_SECRET_KEY}, X-Application-Id: {APP_ID}
  const profiles = await fetchPetScreeningProfiles(lastSync);

  // 4. For each profile:
  //    - Match application by externalReferenceNumber field
  //    - Update application_pets row (FIDO score, status='complete', completed_at)
  //    - Log to webhook_events for audit
  for (const profile of profiles) {
    await syncProfileToDatabase(profile);
  }

  // 5. Update last_sync_at
  await setLastSyncTimestamp(new Date());

  return { statusCode: 200, body: JSON.stringify({ synced: profiles.length }) };
};
```

### 3. UI button

Add to `/portal/va/screening.html`:

```html
<button id="syncPetScreeningBtn" class="btn btn-primary">🔄 Sync PetScreening</button>
```

JavaScript handler:
```js
syncBtn.addEventListener('click', async () => {
  syncBtn.disabled = true;
  syncBtn.textContent = 'Syncing…';
  const res = await fetch('/.netlify/functions/petscreening-sync', { method: 'POST' });
  const { synced } = await res.json();
  alert(`Synced ${synced} profile(s) from PetScreening.`);
  location.reload();
});
```

### 4. Schema additions

```sql
-- Track last successful sync to support delta polling
INSERT INTO vendor_settings (key, description) VALUES
  ('petscreening_last_sync_at',
   'ISO timestamp of last successful PetScreening API sync. Used as the since= filter for delta polling.')
ON CONFLICT (key) DO NOTHING;
```

### 5. Scheduled trigger (Phase B.2 — later)

`netlify.toml` addition:
```toml
[[scheduled_functions]]
  path = "/.netlify/functions/petscreening-sync"
  schedule = "*/30 * * * *"   # every 30 min
```

Or use a Supabase database cron (`pg_cron`) calling the function via HTTP.

---

## Open questions to resolve before building

| # | Question | Where to find answer |
|---|----------|---------------------|
| 1 | What's the PetScreening API base URL and endpoint structure? | Their **Help Center** or contact support — search for "API documentation" |
| 2 | What's the auth scheme? Bearer token? Basic auth? Custom header? | Same |
| 3 | Does the API expose our `referenceNumber` field on a profile so we can match? | Same. Critical — without this we'd match by applicant email which is fragile |
| 4 | Are there rate limits we need to respect? | Same |
| 5 | What does a "completed profile" payload look like? Field names for FIDO score, pet name, type, etc.? | Same |
| 6 | Cost — is API access free for PM accounts, or does it require a paid tier? | Their pricing page or sales |
| 7 | Pagination — if many profiles, how do we page through? | API docs |
| 8 | Do we need to register our app with PetScreening to use the API, or is the App ID + Secret enough? | API docs |

**Action item:** Kenny to either (a) email PetScreening support asking for API docs, or (b) check their Help Center under Resources → Help Center for "API" or "Integration" articles.

---

## Implementation milestones

### Milestone 1 — Get API access verified (Kenny + me, 1 day)
1. Kenny generates API Secret Key in PetScreening (visible only once — write it down!)
2. Add `PETSCREENING_APP_ID`, `PETSCREENING_API_SECRET_KEY`, `PETSCREENING_PM_ID` env vars in Netlify
3. Test API call manually with `curl` to confirm credentials work
4. Document the endpoint that returns completed profiles

### Milestone 2 — On-demand sync (me, 1 day after Milestone 1)
1. Build `/netlify/functions/petscreening-sync.js`
2. Add "🔄 Sync PetScreening" button to VA Screening page
3. Test end-to-end: applicant submits → completes PetScreening profile → VA clicks Sync → FIDO score appears in queue
4. Deploy

### Milestone 3 — Scheduled sync (me, half day, after a week of on-demand testing)
1. Add `[[scheduled_functions]]` block to `netlify.toml`
2. Move trigger logic so the same function works for both manual and scheduled
3. Set up a Slack/email alert if sync fails
4. Reduce polling frequency once stable

### Milestone 4 — Apply same pattern to TU SmartMove (later)
- Once we know which credit-check vendor we're using
- TU SmartMove also has API access — same architectural pattern
- Different env vars, different endpoint, but same scheduled-function approach

---

## Security considerations

- **Secrets stay in Netlify env vars** — never in `vendor_settings` table (that's readable by anyone with PII access)
- **Webhook signature verification** — keep `PETSCREENING_WEBHOOK_SECRET` in case PetScreening adds webhook support later
- **Service-role key separation** — sync function uses `SUPABASE_SERVICE_ROLE_KEY` to write past RLS. That's already set up
- **Audit log** — every API call result writes to `webhook_events` (we'll repurpose this table — `source='petscreening_api'`)
- **Rate limit defense** — check API docs; if PetScreening enforces 60/min, sync function holds a lock to avoid concurrent runs

---

## What this design does NOT cover (yet)

- ⏸ Resolving discrepancies (PetScreening updates a profile retroactively)
- ⏸ Deleting old/canceled profiles
- ⏸ Handling sub-account profiles (when InvestPro grows beyond one PM ID)
- ⏸ Webhook retries if PetScreening adds webhook support later

These can be added in Phase C.

---

## TLDR — what to do next

1. **Today:** Use the manual workflow doc (`PETSCREENING-WORKFLOW.md`). Neil enters FIDO scores by hand.
2. **This week:** Kenny finds PetScreening API documentation (Help Center or email support).
3. **Next:** I build Milestone 1 + 2 once we have the API endpoint structure.
