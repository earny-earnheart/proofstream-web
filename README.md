# ProofStream: existing Cloudflare Worker cutover

This complete project replaces the placeholder in the existing `proofstream-web`
Worker with the ProofStream creator-workspace design. No frontend build is required.
All assets are local and included under `public/`.

## What works today

Projects, milestones, SHA-256 fingerprinting in the browser, creator-specific
verification, JSON record exports, category filtering, project search, sign-out and
optional wallet-address connection. Files are read locally and are never uploaded.
Connecting a wallet does not request a signature or transaction.

Projects are saved to the creator's account (see "Project storage"), so they appear on
every device the creator signs in from and are invisible to other accounts. Timestamps
come from the device clock. There are no independent witnesses, blockchain
registration, pinning, identity registration, payments or a bond offering. Examples
are labeled. Cryptographic attestation and blockchain anchoring are in development;
these are not statutory notarial acts. Records stored under the previous chatgpt.site
hostname will not automatically appear on proofstreamapp.com: export them before
switching. The current concept exports records but does not yet import them.

## Project storage

`GET /api/projects` lists the signed-in creator's projects; `PUT /api/projects/<id>`
(same-origin, JSON, up to 512 KB) creates or replaces one. Both answer 401 without a
valid `ps_session` cookie, and every query is scoped to the registration id inside that
signed cookie, so one account cannot read or overwrite another's projects, even with
the same project id. The Worker rebuilds each project from an allow-list (name,
category, description, dates, and per milestone: title, stage, creator, file name,
file size and SHA-256), so file contents cannot be stored whatever a client sends.
Limits: 500 projects per account, 2,000 milestones per project. Rows live in the D1
`projects` table (`migrations/0002_projects.sql`) and are deleted with their
registration. `POST /api/logout` (same-origin) clears the cookie.

Records saved by the earlier browser-only preview (localStorage key
`proofstream-studio-v1`) move into the account on the first load after sign-in, then
the local copy is removed. On a browser shared by several creators, the first one to
sign in receives them.

## Sign-in

`/`, `/index.html` and `/app.js` require a signed `ps_session` cookie. Without one, `/`
serves `public/register.html` and `/app.js` returns 403. Creators sign in one of two ways:

- **Email and password.** `POST /api/register` (name, email, password of 10 to 128
  characters) creates an account; `POST /api/login` signs in. Passwords are stored as
  salted PBKDF2-SHA256 at 100,000 iterations (the Workers maximum). Signing up again
  with an email that already has an account returns 409 and no cookie. Wrong passwords
  and unknown emails get the same 401. Both routes are same-origin only and need a
  Cloudflare Turnstile pass. See "Email links" for password reset and verification.
- **Google.** `/auth/google` starts the OAuth authorization-code flow with PKCE; the
  state and verifier ride in a signed 10-minute `ps_oauth` cookie. The callback accepts
  only ID tokens for our client ID from Google's issuer with `email_verified: true`,
  and links the Google account in the D1 `identities` table. A later sign-in with the
  same Google account reaches the same ProofStream account even if its email changes.

Google vouches for who currently owns an email only for Gmail addresses and for Google
Workspace accounts whose `hd` claim matches the email's domain; a password sign-up
proves nothing. So when such a Google sign-in arrives for an email whose account was
never verified, that Google user takes the account over: any password on it is removed
and every existing session ends; that includes replacing a Google account that could
not vouch for the email. Other Google emails can open a new account but are refused
(`/?auth=exists`) if the email already has one. A vouched account linked to one Google
account cannot be joined by another, and an email that belongs to a Google account
cannot get a password by signing up.
Registrations from the earlier email-only sign-up (no password, no Google link) can be
claimed once with a password, or by Google.

The cookie (HttpOnly, Secure, SameSite=Lax, 1 year) carries the account id, its
`session_version` and a signed issue time, signed with the `SESSION_SECRET` secret;
without that secret everyone stays gated. Bumping `session_version` signs the account
out on every device. Cookies from the old email-only sign-up (`ps_reg`) are not
accepted. `GET /api/session` reports `{registered, registrationOpen, googleSignIn}`.
Set `REGISTRATION_OPEN` to `"false"` in `wrangler.jsonc` to stop new accounts; existing
creators still sign in. Turnstile uses widget sitekey `0x4AAAAAAFxNFLyzIiuPb_D6` (in
`public/register.html`) and the `TURNSTILE_SECRET` secret; without that secret, password
sign-up and sign-in return 503 (fail closed). To revoke someone, delete their row (their
projects and Google link are deleted with it): `npx wrangler@latest d1 execute proofstream-registrations --remote --command "DELETE FROM registrations WHERE email = 'person@example.com'"`.

### Google sign-in setup

1. In Google Cloud Console, go to APIs & Services, then Credentials, and create an OAuth
   client ID of type Web application. Authorized redirect URI:
   `https://proofstreamapp.com/auth/google/callback`. On the OAuth consent screen, use
   the `openid`, `email` and `profile` scopes and publish the app.
2. From this folder, store both values as Worker secrets (paste when prompted):
   ```sh
   npx wrangler@latest secret put GOOGLE_CLIENT_ID
   npx wrangler@latest secret put GOOGLE_CLIENT_SECRET
   ```
   Until both exist, the Google button stays hidden and `/auth/google` redirects back
   with "not available".

One-time setup before the first deploy with the gate:
```sh
npx wrangler@latest d1 create proofstream-registrations   # paste database_id into wrangler.jsonc
npx wrangler@latest d1 migrations apply proofstream-registrations --remote
npx wrangler@latest secret put SESSION_SECRET             # paste a long random value, e.g. openssl rand -hex 32
pbpaste | tr -d '[:space:]' | npx wrangler@latest secret put TURNSTILE_SECRET   # copy the widget's Secret Key first
npx wrangler@latest secret list                           # names only: expect SESSION_SECRET, TURNSTILE_SECRET, GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET
```
Run secret commands from this folder so they reach `proofstream-web` in the Pantheon
Enterprise account. Piping from the clipboard avoids saving an empty value from the hidden prompt.
Before deploying a release that adds a migration, apply it remotely first:
`npx wrangler@latest d1 migrations apply proofstream-registrations --remote`.
Local testing: put `SESSION_SECRET=...` and Cloudflare's always-pass test secret
`TURNSTILE_SECRET=1x0000000000000000000000000000000AA` in `.dev.vars` (gitignored), then
`npx wrangler@latest d1 migrations apply proofstream-registrations --local` and `npx wrangler@latest dev`.
Cloudflare's test secret reports the hostname `example.com`, which the Worker rejects,
and same-origin checks expect `https://proofstreamapp.com`. So a local browser cannot
sign up or save. Seed a row in the local D1 and send requests with that origin header
(as `tests/helpers.mjs` does) to exercise the API locally.

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

## Email links: password reset and verification

Sent with Cloudflare Email Service through the `send_email` binding `EMAIL`, from
`no-reply@proofstreamapp.com`. The domain must be onboarded once:
`npx wrangler@latest email sending enable proofstreamapp.com` (it adds SPF/DKIM DNS
records). Without the binding both features switch off (`emailLinks: false` in
`/api/session`) and sign-up still works.

- Links carry a random token in the URL fragment (`/reset#…`, `/verify#…`), so it never
  reaches server logs or referrers. D1 `email_tokens` stores only its SHA-256. Each link
  works once, expires (reset 1 hour, verify 24 hours) and only while the account still
  has the address it was sent to. At most 3 links per purpose per account per hour.
- **Reset.** `POST /api/password/forgot` (email, Turnstile) always answers the same way.
  `POST /api/password/reset` (token, password) sets the password, marks the email
  verified, ends every session and signs this browser in. On an unverified account it
  also removes any Google link that could not vouch for the email, so a creator whose
  address was squatted can recover the account.
- **Verification.** Password sign-ups get a confirmation email. `POST /api/email/verify`
  only counts in a browser signed in to the same account; otherwise the real owner of an
  address, clicking a link from a sign-up a stranger made with it, would vouch for the
  stranger's password. `POST /api/email/resend` sends another. Unverified creators see a
  banner in the workspace; nothing is blocked yet.

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
   If `migrations/` has new files, apply them first (export
   `CLOUDFLARE_ACCOUNT_ID=7914583bf80f67154ca9364681c0af85` if Wrangler sees several accounts):
   ```sh
   npx wrangler@latest d1 migrations apply proofstream-registrations --remote
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
