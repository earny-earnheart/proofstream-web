---
name: ship
description: Test, deploy proofstream-web to Cloudflare production, then run the live-site checks
disable-model-invocation: true
---

Deploy proofstream-web to production. Run each step from the project root and stop at the first failure.

1. **Preflight.** Run `git status --short`. If there are uncommitted changes, list them and ask whether to deploy anyway. Do not commit on the user's behalf.
2. **Test.** Run `npm test`. If any test fails, show the failing output and stop. Do not deploy.
3. **Deploy.** Run `npx wrangler deploy`. Report the version ID and the routes (expect `proofstreamapp.com` and `www.proofstreamapp.com`). If the bindings differ from `DB`, `ASSETS` and `REGISTRATION_OPEN`, flag it.
4. **Verify.** Run `npm run verify:production`. If any check fails, show the failures and offer to roll back with `npx wrangler rollback`. Do not roll back without a yes.
5. **Report.** Give the version ID, the test count and the check count in two or three lines.

Never print, echo or ask for secret values. If a secret looks missing, tell the user to run `! npx wrangler secret put <NAME>` themselves.
