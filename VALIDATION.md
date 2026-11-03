# Validation results

Last updated 2026-11-03, after the Turnstile and CSP-nonce release.

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
