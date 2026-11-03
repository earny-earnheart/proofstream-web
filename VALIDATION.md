# Validation results

Last updated 2026-11-03, after adding account project storage and Google / password
sign-in (branch `account-project-storage`, PR #5, not yet deployed).

## Sign-in (PR #5)

- `tests/registration.test.mjs` and `tests/google.test.mjs` run against real SQLite
  with every migration. Covered: password sign-up stores a PBKDF2 hash, never the
  password; signing up again with an existing email returns 409 and no cookie (the
  account-takeover fix); wrong password and unknown email get the same 401; Turnstile
  required on both forms and fails closed; old `ps_reg` cookies and tampered or
  foreign-secret cookies are refused; bumping `session_version` signs out everywhere.
- Google: redirect carries PKCE S256 and a signed state cookie; forged, missing,
  tampered or expired state is refused before Google is called; the token request
  proves the PKCE verifier; unverified emails and tokens with the wrong audience,
  issuer, expiry or subject are refused; the same Google account always reaches the
  same ProofStream account; a verified Google sign-in takes over an unverified password
  account, removing the password and ending its sessions; an email linked to Google
  cannot get a password by signing up; closed registration still admits existing
  creators.
- Not yet checked: a real Google sign-in (needs the OAuth client and production URL).

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
