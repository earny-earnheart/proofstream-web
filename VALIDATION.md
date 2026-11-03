# Validation results

Last updated 2026-11-02, after adding account project storage (not yet deployed).

## Account project storage (branch `account-project-storage`)

- `tests/projects.test.mjs` runs the Worker against real SQLite with both migrations
  and foreign keys on: a project saved on one device appears after signing in on
  another; two accounts with the same project id stay separate; smuggled file data in
  a project or milestone is dropped before storage; invalid, oversized, cross-origin,
  non-JSON and anonymous writes are refused; the 500-project cap holds; deleting a
  registration revokes access and deletes its projects; sign-out clears the cookie.
- Local `wrangler dev` with local D1: save on one session cookie and list on a second
  cookie for the same account returned the project; a second account saw `[]`; a
  smuggled `fileData` field was not in the stored row; deleting the registration
  cascaded to its projects and the old cookie got 401. The workspace UI rendered the
  synced project with no console errors.
- Not yet checked: saving from the UI in a real browser (same-origin checks need
  `https://proofstreamapp.com`), the localStorage migration on real data, and the
  remote migration. Do these on production after deploy, using two devices and two
  accounts.

## Automated (`npm test`)

- 24 Worker, registration, configuration and production-verifier tests pass.
- Registration covers: gating, signed and expiring cookies, revocation by deleting the
  D1 row, honeypot, closed registration, and Turnstile pass / fail / network error /
  oversized token / missing secret (fails closed with 503).
- CSP: fresh nonce per response, only `https://challenges.cloudflare.com` allowed
  remotely, no `unsafe-inline` or `unsafe-eval`.

## Live checks on proofstreamapp.com

- `/health` 200; `/app.js` 403 and `/` serves the sign-up page without a cookie.
- `POST /api/register` without a valid Turnstile token returns 403 ("bot check did not
  pass"); a 503 here means `TURNSTILE_SECRET` is missing or empty.
- The Turnstile widget renders; a real sign-up in a private browser window opened the
  workspace, confirming the stored secret matches the widget.
- Cloudflare's JavaScript Detections script and Web Analytics beacon carry the
  response nonce and run.
- Known console noise: two blocked inline scripts from Cloudflare's Google tag
  gateway (`GTM-T4W5LNL2`). See README, "Cloudflare bot and edge settings".

Run `bash scripts/verify-production.sh` from your authenticated deployment computer
after publishing; investigate any failed check before declaring success.
