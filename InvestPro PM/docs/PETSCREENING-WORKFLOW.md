# PetScreening Workflow — How Neil (VA) Enters Pet Results

**Audience:** Neil (Application VA), or anyone covering for him
**Last updated:** 2026-04-30
**Status:** Active — manual entry, until API polling (Phase B) is built

---

## The big picture

We use PetScreening.com to FIDO-score every pet, ESA, and service animal on every rental application. PetScreening doesn't push results to our portal automatically — you have to log into PetScreening, view the results, and enter them into the InvestPro VA Screening page. This workflow takes about 1 minute per pet once you're in the rhythm.

---

## When does an applicant complete a PetScreening profile?

**The moment they finish their rental application.** The "Application Submitted" confirmation page automatically shows them a yellow "Complete Pet Screening Now" button — clicked, it takes them to PetScreening's site with their **InvestPro confirmation number** (`IPR-XXXXXXX`) attached as a `referenceNumber` in the URL.

Each pet on their application becomes one PetScreening profile. They pay PetScreening directly. Service animals and ESAs are free.

---

## Step-by-step — what you do, Neil

### Step 1: Get notified

PetScreening will email you (the PM email on file: `kenny@investprorealty.net`) when a new pet profile is completed. The email includes the applicant's name and the FIDO outcome.

### Step 2: Log into PetScreening

Go to **https://app.petscreening.com** and sign in. Click **Profiles** in the top nav to see all submitted pet profiles.

### Step 3: Find the pet profile you need

Two ways to find it:

- **By referenceNumber** — if PetScreening shows the reference number column (look for "External Reference" or similar), search for the InvestPro confirmation number (`IPR-XXXXXXX`).
- **By applicant name or email** — search by the applicant's name from your InvestPro portal application.

### Step 4: Note the FIDO score

Open the pet profile. PetScreening shows a **FIDO score** from 1 to 5:

| FIDO Score | Risk Level |
|---|---|
| 1 | Highest risk — recommend deny or extra deposit |
| 2 | High risk |
| 3 | Moderate risk |
| 4 | Low risk |
| 5 | Lowest risk — recommend approve |

For ESA / service animals: PetScreening will mark them as **N/A (Assistance Animal Validated)** — those are exempt from FIDO scoring per Fair Housing law.

Write down per pet: name, type (dog / cat / etc.), FIDO score (or "N/A — service animal").

### Step 5: Open the InvestPro VA Screening page

Go to **https://investpro-realty.netlify.app/portal/va/screening.html** and log in if needed.

You'll see a queue of applications past payment. Find the one matching the applicant's confirmation number.

### Step 6: Enter the results

Click **Enter Results** on the right side of the row. A modal pops up.

Scroll down to the **Pet Screening (PetScreening.com)** section. For each pet:

1. **Status** — set to:
   - `complete` if FIDO scored
   - `n_a` if service animal / ESA
   - `in_progress` if applicant hasn't finished yet
2. **FIDO Score (1–5)** — enter the number (leave blank for N/A)
3. **Profile URL** (optional) — paste the link to the PetScreening profile if useful for reference

Click **Save Results** at the bottom.

The screening row in the queue updates immediately. The pet column shows ✓ Complete with the count of pets.

---

## What if the applicant never completed their PetScreening profile?

After 48 hours, send them a reminder. The applicant's confirmation email already had the link, but life happens. You can:

- Look up their email in the application
- Send: *"Hi [Name], we haven't received your PetScreening profile yet. Please complete it at [the URL with their referenceNumber] so we can finalize your application. Apps without pet screening will not be approved."*

If they had a service animal / ESA but didn't go through PetScreening at all, that's a special case — talk to Kenny.

---

## What if the FIDO score is 1 or 2 (high risk)?

Don't decide on your own. Flag it for the broker (Kenny) in the application's Recommendation Notes. Suggested phrasing:

> "Pet [Buddy, Pit Bull mix, 65lb] received FIDO score 2. Restricted breed risk per insurance. Recommend higher deposit ($500 extra) or denial of pet only. Defer to broker."

---

## Where to find your PetScreening login

- **Login URL:** https://app.petscreening.com
- **Account email:** `kenny@investprorealty.net`
- **Password:** stored in [your password manager / secure note]

If locked out, click **Forgot password** and Kenny will get the reset email.

---

## What's coming later (Phase B)

We're going to build automatic syncing — a "Sync PetScreening" button on the VA Screening page that pulls new FIDO scores via the PetScreening API and updates the queue automatically. That'll cut your work to clicking one button per session. Until then, the manual flow above is the way.

---

## Questions / problems

Text Kenny. He'll either fix it directly or escalate to whoever built the portal.
