# ProofStream: existing Cloudflare Worker cutover

This complete project replaces the placeholder in the existing `proofstream-web`
Worker with the ProofStream creator-workspace design. No frontend build is required.
All assets are local and included under `public/`.

## What works today

Projects, milestones, browser-local SHA-256 fingerprinting, creator-specific local
verification, JSON record exports, category filtering, project search and optional
wallet-address connection. Files are read locally and are never uploaded. Connecting
a wallet does not request a signature or transaction.

This concept uses browser-local storage and the device clock. It does not provide
shared accounts, database storage, independent witnesses, blockchain registration,
pinning, identity registration, payments or a bond offering. Examples are labeled.
Cryptographic attestation and blockchain anchoring are in development; these are
not statutory notarial acts. Records stored under the previous chatgpt.site hostname
will not automatically appear on proofstreamapp.com: export them before switching.
The current concept exports records but does not yet import them.

## Registration gate

`/`, `/index.html` and `/app.js` require a signed `ps_reg` cookie. Without one, `/` serves
`public/register.html` and `/app.js` returns 403. `POST /api/register` (same-origin only)
validates name/email, stores the creator in D1 `proofstream-registrations` and sets the
cookie (HttpOnly, Secure, SameSite=Lax, 1 year). Repeat emails sign back in. `GET
/api/session` reports `{registered, registrationOpen}`. Set `REGISTRATION_OPEN` to
`"false"` in `wrangler.jsonc` to close new sign-ups; existing registrants still get in.
The cookie carries a signed issue time (checked server-side, 1-year limit) and is signed with the `SESSION_SECRET` secret; without it, everyone stays gated. Every sign-up and sign-back-in must also pass Cloudflare Turnstile (widget sitekey
`0x4AAAAAAFxNFLyzIiuPb_D6`, in `public/register.html`). The Worker checks each token with
Cloudflare's siteverify using the `TURNSTILE_SECRET` secret; without that secret,
registration returns 503 "temporarily unavailable" (it fails closed). To revoke someone, delete their row: `npx wrangler@latest d1 execute proofstream-registrations --remote --command "DELETE FROM registrations WHERE email = 'person@example.com'"`.

One-time setup before the first deploy with the gate:
```sh
npx wrangler@latest d1 create proofstream-registrations   # paste database_id into wrangler.jsonc
npx wrangler@latest d1 migrations apply proofstream-registrations --remote
npx wrangler@latest secret put SESSION_SECRET             # paste a long random value, e.g. openssl rand -hex 32
pbpaste | tr -d '[:space:]' | npx wrangler@latest secret put TURNSTILE_SECRET   # copy the widget's Secret Key first
npx wrangler@latest secret list                           # names only: expect SESSION_SECRET and TURNSTILE_SECRET
```
Run secret commands from this folder so they reach `proofstream-web` in the Pantheon
Enterprise account. Piping from the clipboard avoids saving an empty value from the hidden prompt.
Local testing: put `SESSION_SECRET=...` and Cloudflare's always-pass test secret
`TURNSTILE_SECRET=1x0000000000000000000000000000000AA` in `.dev.vars` (gitignored), then
`npx wrangler@latest d1 migrations apply proofstream-registrations --local` and `npx wrangler@latest dev`.

## Deployment target and routing

- Account: Pantheon Enterprise, `7914583bf80f67154ca9364681c0af85`.
- Existing Worker: `proofstream-web` (do not create a new name).
- Apex: `https://proofstreamapp.com`.
- `www.proofstreamapp.com` redirects to apex, preserving path and query.
- `workers.dev` and preview URLs stay disabled.
- Exactly two Custom Domain routes; no wildcard route.
- No DNS, nameserver, other Worker, Zero Trust or WAF changes.

## Cloudflare bot and edge settings

These zone settings are on and the site is built to work with them:

- **Bot Fight Mode / JavaScript Detections: on.** Cloudflare injects an inline script into
  every HTML page. The Worker puts a fresh `nonce` in each `Content-Security-Policy`
  header and Cloudflare copies it onto that script, so it runs. Do not set the CSP in a
  `<meta>` tag or send `Cache-Control: no-transform` on HTML; either stops this working.
- **Turnstile:** guards `POST /api/register` (see Registration gate). The CSP allows
  `https://challenges.cloudflare.com` for its script and frame, and nothing else remote.
- **Web Analytics (automatic setup): on, intended.** Cloudflare stamps its beacon with
  the nonce, so it runs and reports to this domain's `/cdn-cgi/rum`.
- **Google tag gateway (`GTM-T4W5LNL2`): on, but blocked.** Cloudflare injects its tags
  without the nonce, so the CSP blocks them and the browser console shows two
  "inline script" CSP errors. Turn the gateway off in Tag management to clear them.
  Allowing GTM would need the CSP loosened for Google's scripts; do not add
  `unsafe-inline`.

Anything Cloudflare injects with the nonce can run, so review new zone features that
inject scripts before enabling them. Cloudflare's injections only happen at the edge:
local tests and `wrangler dev` do not show them, so check the live site in a browser
console after changing these settings.

`404-page` is intentional: the app uses hash navigation (`/#verify`, `/#library`,
`/#project/...`) inside the single root page. Hash fragments are never sent to the
server and are not standalone crawlable pages. Only `/` belongs in sitemap.xml;
unknown server paths must stay real HTTP 404 responses.

The Worker redirects www first, then restricts methods to GET/HEAD, serves `/health`,
normalizes trailing slashes and delegates assets. Security headers decorate all
responses, including redirects, errors and health. Asset content type and ETag are
preserved. The site's own pages need no inline scripts or styles, and the CSP has no
`unsafe-inline` or `unsafe-eval`; the per-response nonce exists only for Cloudflare's
injected scripts. Waveform heights use static CSS classes. Contact and company text are supplied by
the owner; no claim of statutory notarization is made.

## Exact commands (run from this folder)

1. Check the files/tests locally:
   ```sh
   node --test tests/*.test.mjs
   ```
2. Authenticate on your own computer (never send a token or seed phrase in chat):
   ```sh
   npx wrangler@latest login
   npx wrangler@latest whoami
   ```
   Confirm the listed account includes `7914583bf80f67154ca9364681c0af85`.
3. Inspect current deployments and retain the output as the rollback record:
   ```sh
   npx wrangler@latest deployments list
   ```
4. Validate the package before cutover:
   ```sh
   npx wrangler@latest deploy --dry-run
   ```
5. Replace the existing placeholder:
   ```sh
   npx wrangler@latest deploy
   ```
6. Check the public result:
   ```sh
   bash scripts/verify-production.sh
   ```

There is no `npm install` or frontend build step for this buildless project. `npx`
fetches Wrangler when needed. The `package.json` only selects ES modules and test
commands. Node.js 22 is recommended. Review any Wrangler prompt against the fixed
worker name and the two declared Custom Domains before continuing.

## Rollback

Run from this same folder:

```sh
npx wrangler@latest rollback
```

Choose the previous known-good placeholder deployment from the history captured
above. Alternatively: Cloudflare Dashboard → Workers & Pages → proofstream-web →
Deployments → select the previous version → Roll back. Rollback requires a previous
version to be retained by Cloudflare; record it before cutover.

## Source of truth

This is the direct Cloudflare deployment requested in the supplied brief. The Sites
copy remains a separate public demo. Do not apply the earlier Sites A/TXT routing
instructions to this Worker cutover; the domain owner has configured Cloudflare.
GitHub preserves this project; a GitHub push alone does not deploy it.
