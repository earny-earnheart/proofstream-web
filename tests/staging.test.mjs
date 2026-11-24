import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/worker.js';
import { envWith } from './helpers.mjs';

// Runs in its own process: PUBLIC_ORIGIN switches the origin for the whole Worker.
const STAGING = 'https://proofstream-staging.pantheon-platform.workers.dev';
const ask = from => new Request(STAGING + '/api/access-request', {
  method: 'POST',
  headers: { origin: from, 'content-type': 'application/json' },
  body: JSON.stringify({ name: 'Kai', email: 'kai@example.com', role: 'Artist', 'cf-turnstile-response': 'pass' }),
});

test('a staging copy accepts its own origin and its own Turnstile hostname, and refuses production ones', async () => {
  const env = await envWith({ PUBLIC_ORIGIN: STAGING, REGISTRATION_OPEN: 'false' });
  const helperFetch = globalThis.fetch;
  let hostname = 'proofstreamapp.com';
  globalThis.fetch = async (url, init) => String(url).includes('turnstile/v0/siteverify')
    ? Response.json({ success: true, hostname })
    : helperFetch(url, init);
  assert.equal((await worker.fetch(ask(STAGING), env)).status, 403, 'a token issued for the production hostname is refused on staging');
  hostname = new URL(STAGING).host;
  assert.equal((await worker.fetch(ask('https://proofstreamapp.com'), env)).status, 403);
  assert.equal((await worker.fetch(ask(STAGING), env)).status, 200);
});

test('the staging config is separate from production: its own Worker, database, no email, no cron, paywall on', async () => {
  const { readFile } = await import('node:fs/promises');
  const config = JSON.parse(await readFile(new URL('../wrangler.jsonc', import.meta.url), 'utf8'));
  const staging = config.env.staging;
  assert.equal(staging.name, 'proofstream-staging');
  assert.notEqual(staging.d1_databases[0].database_id, config.d1_databases[0].database_id);
  assert.equal(staging.d1_databases[0].database_name, 'proofstream-staging');
  assert.deepEqual(staging.routes, []);
  assert.equal(staging.send_email, undefined, 'staging never sends email');
  assert.deepEqual(staging.triggers.crons, [], 'no anchoring cron on staging');
  assert.equal(staging.vars.PAYWALL_ENABLED, 'true');
  assert.equal(staging.vars.POLAR_API_BASE, 'https://sandbox-api.polar.sh/v1');
  assert.equal(config.vars.REGISTRATION_OPEN, 'false', 'production is invitation only');
  assert.equal(config.vars.ANCHORING_ENABLED, 'false', 'production anchoring is off');
  assert.equal(config.vars.PAYWALL_ENABLED, 'false', 'production paywall waits for its own release');
});
