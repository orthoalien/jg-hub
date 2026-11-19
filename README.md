# JG Hub

Personal home screen for Dr. Jessica Greenberg (Greenie). Static site for GitHub Pages at `jg.drgreenie.com`.

The page is publicly reachable by URL once published. Tiles are only links. There is no authentication and no secrets on the page. Search engines are asked not to index it (`robots.txt` + `noindex`).

## Publish on GitHub Pages

The Cursor GitHub connector cannot create repositories, push files, or enable Pages. Do this once in the GitHub website, signed in as `orthoalien`:

1. Create a **public** repository named `jg-hub` (New repository at https://github.com/new). Public is required for free GitHub Pages. Do not initialize with a README if you will upload these files first.
2. Upload `index.html`, `styles.css`, `app.js`, `CNAME`, and `robots.txt` to the `main` branch root (or push this folder).
3. Open **Settings → Pages**.
4. Under **Build and deployment**, set **Source** to **Deploy from a branch**, **Branch** to **main**, folder to **/ (root)**, then click **Save**.
5. Under **Custom domain**, enter `jg.drgreenie.com` and save. DNS should already be a CNAME of `jg` → `orthoalien.github.io`.
6. When GitHub finishes the TLS certificate (often after DNS has settled), check **Enforce HTTPS**.

The site should then be available at https://jg.drgreenie.com and https://orthoalien.github.io/jg-hub/.

## iTap board (`taps.js`, `taps.css`, `taps-config.js`)

The "iTap board" tile opens an in-page board. It holds **no patient data**: in the browser it signs Greenie in with Google Identity Services (token model, `spreadsheets` scope, `login_hint` jgreenberg21@gmail.com) and reads/writes her private Google Sheet "Tap Board" straight from the Sheets API. Google enforces access to the Sheet; other accounts get 403.

- `Items` tab (read by header name, range A1:Y): patient, case, plan, appt, reason, bar (stop/go/wait/done/purple), section (scan/tap/in_progress/manufacturing/shipped; `done` = manufacturing, `not_urgent` = tap), buttons (`|`), pills (`|`), patientId, open_label, updated (ISO), approved, mfg_eta, ups (UPS tracking #), ups_eta (ETA to office), star (purple/blue/green/red = `STAR_COLORS` in taps.js; anything else or blank shows a gray outline star), count (shown as "plan N: count"), req_date (prefixes the reason), due (shown as "dd <due>" when appt is blank), shipped, delivered, scan_date, cc_ready, review (`not_reviewed` shows a "Not yet reviewed" pill on Needs a tap). "Full check" and "Hold" buttons are never shown; neither is "Double-check". `#case` is not displayed. Sections, in order: MyiTero (always shown), Needs a tap, ClinCheck (only if non-empty), Manufacturing, Shipped/Delivered. Shipped cards disappear more than 7 days after `delivered` (America/New_York). The Shipped/Delivered count badge is S/D (cards in the section after the 7-day hide / how many of those have a delivered date), counted before the star filter. Taps sort by star (purple, green, blue, red, none), then soonest appt (or `due`), undated last. No state ever dims or hides card text. Bump `updated` only when that row's content changes: a tap older than `updated` no longer counts.
- `Answers` tab (A:F): case, patient, choice, ts (ISO, UTC), status (`pending` → set to `confirmed` once acted on), note (text typed with "Modify request" or "Order Invisalign"; blank for other picks). Only Approve, Modify request, Staff resubmit and Call for appointment buttons render from the sheet (`ALLOWED_BUTTONS` in taps.js); scan cards also have Order Invisalign. The board polls every 30 s.
- Until `clientId` is filled in `taps-config.js` the board shows "Not connected yet".
- Never commit patient data, a client secret, or an API key here. The OAuth client ID and Sheet ID are not secrets.
