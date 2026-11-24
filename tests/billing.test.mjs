import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import worker from '../src/worker.js';
import { verifyWebhook, entitlements, TRIAL_DAYS } from '../src/billing.js';
import { origin, envWith, signUp, get } from './helpers.mjs';

const SECRET = 'whsec_' + Buffer.from('a-test-webhook-secret-32-bytes!!').toString('base64');
const PRODUCTS = { POLAR_PRODUCT_CREATOR: 'prod-creator', POLAR_PRODUCT_PRO: 'prod-pro' };
const paywall = (extra = {}) => envWith({ PAYWALL_ENABLED: 'true', POLAR_WEBHOOK_SECRET: SECRET, ...PRODUCTS, ...extra });
const accountOf = (env, email) => env.DB.db.prepare('SELECT id FROM registrations WHERE email = ?').get(email).id;
const verifyEmail = (env, email) => env.DB.db.prepare('UPDATE registrations SET email_verified = 1 WHERE email = ?').run(email);
const put = (cookie, id, project) => new Request(`${origin}/api/projects/${id}`, {
  method: 'PUT', headers: { origin, cookie, 'content-type': 'application/json' }, body: JSON.stringify({ id, name: 'P ' + id, category: 'Music', createdAt: '2026-11-01T10:00:00.000Z', milestones: [], ...project }),
});
const milestone = n => ({ id: 'm' + n, title: 'Draft ' + n, stage: 'Draft', creator: 'local-profile', fileName: `d${n}.wav`, fileSize: 10, hash: n.toString(16).padStart(64, '0'), createdAt: '2026-11-01T11:00:00.000Z' });
const recording = n => new Request(origin + '/api/v1/recordings', {
  method: 'POST', headers: { origin, 'content-type': 'application/json' },
  body: JSON.stringify({ isrc: `US-SKG-26-${String(n).padStart(5, '0')}`, title: 'T' + n, artist_display: 'A', duration_ms: 180000, audio_hash_sha256: n.toString(16).padStart(64, 'a'), rights: [{ role: 'master_owner', split_bps: 10000 }] }),
});
const withCookie = (request, cookie) => { request.headers.set('cookie', cookie); return request; };

function signed(body, { secret = SECRET, id = 'evt_' + Math.random().toString(36).slice(2), at = Math.floor(Date.now() / 1000), raw = false } = {}) {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  const key = raw ? Buffer.from(secret) : Buffer.from(secret.slice(6), 'base64');
  const sig = createHmac('sha256', key).update(`${id}.${at}.${text}`).digest('base64');
  return new Request(origin + '/api/billing/webhook', { method: 'POST', headers: { 'webhook-id': id, 'webhook-timestamp': String(at), 'webhook-signature': 'v1,' + sig, 'content-type': 'application/json' }, body: text });
}
const subscriptionEvent = (account, extra = {}) => ({ type: 'subscription.active', data: { id: 'sub_1', status: 'active', product_id: 'prod-creator', current_period_end: new Date(Date.now() + 30 * 86400000).toISOString(), customer: { id: 'cus_1', external_id: account }, ...extra } });

test('with the paywall off, nothing changes for anyone', async () => {
  const env = await envWith();
  const cookie = await signUp(env, 'ada@example.com');
  for (let i = 0; i < 5; i++) assert.equal((await worker.fetch(put(cookie, 'p' + i, {}), env)).status, 201);
  assert.equal((await entitlements(env, accountOf(env, 'ada@example.com'))).paywall, false);
});

test('an unconfirmed account is read-only until its email is confirmed, then its 14-day trial starts', async () => {
  const env = await paywall();
  const cookie = await signUp(env, 'ada@example.com');
  const blocked = await worker.fetch(put(cookie, 'p1', {}), env);
  assert.equal(blocked.status, 402);
  assert.match((await blocked.json()).error, /Confirm your email/);
  verifyEmail(env, 'ada@example.com');
  assert.equal((await worker.fetch(put(cookie, 'p1', {}), env)).status, 201);
  const status = await (await worker.fetch(get('/api/billing/status', cookie), env)).json();
  assert.equal(status.plan, 'trial');
  assert.equal(status.writable, true);
  const days = (new Date(status.trialEndsAt) - Date.now()) / 86400000;
  assert(days > TRIAL_DAYS - 0.01 && days <= TRIAL_DAYS, 'trial ends in 14 days');
});

test('trial limits: 3 projects, 25 fingerprints, 5 recordings, then 402 with an upgrade link', async () => {
  const env = await paywall();
  const cookie = await signUp(env, 'ada@example.com');
  verifyEmail(env, 'ada@example.com');
  for (let i = 1; i <= 3; i++) assert.equal((await worker.fetch(put(cookie, 'p' + i, {}), env)).status, 201);
  const fourth = await worker.fetch(put(cookie, 'p4', {}), env);
  assert.equal(fourth.status, 402);
  const body = await fourth.json();
  assert.equal(body.limit, 'projects');
  assert.equal(body.upgrade, '/account/billing');

  const ms = Array.from({ length: 25 }, (_, i) => milestone(i + 1));
  assert.equal((await worker.fetch(put(cookie, 'p1', { milestones: ms }), env)).status, 200, '25 fingerprints fit');
  const over = await worker.fetch(put(cookie, 'p2', { milestones: [milestone(26)] }), env);
  assert.equal(over.status, 402);
  assert.equal((await over.json()).limit, 'fingerprints');
  assert.equal((await worker.fetch(put(cookie, 'p1', { name: 'Renamed', milestones: ms }), env)).status, 200, 're-saving existing work is always allowed');

  for (let i = 1; i <= 5; i++) assert.equal((await worker.fetch(withCookie(recording(i), cookie), env)).status, 201, 'recording ' + i);
  const sixth = await worker.fetch(withCookie(recording(6), cookie), env);
  assert.equal(sixth.status, 402);
  assert.equal((await sixth.json()).limit, 'recordings');
});

test('when the trial ends the account is read-only, but everything stays readable', async () => {
  const env = await paywall();
  const cookie = await signUp(env, 'ada@example.com');
  verifyEmail(env, 'ada@example.com');
  assert.equal((await worker.fetch(put(cookie, 'p1', { milestones: [milestone(1)] }), env)).status, 201);
  env.DB.db.prepare("UPDATE subscriptions SET trial_ends_at = '2020-01-01T00:00:00.000Z'").run();
  const status = await (await worker.fetch(get('/api/billing/status', cookie), env)).json();
  assert.equal(status.status, 'trial_ended');
  assert.equal(status.writable, false);
  assert.equal((await worker.fetch(put(cookie, 'p2', {}), env)).status, 402);
  assert.equal((await worker.fetch(put(cookie, 'p1', { milestones: [milestone(1), milestone(2)] }), env)).status, 402);
  const list = await (await worker.fetch(get('/api/projects', cookie), env)).json();
  assert.equal(list.projects.length, 1, 'saved work is still there');
  assert.equal((await worker.fetch(put(cookie, 'p1', { name: 'Still mine', milestones: [milestone(1)] }), env)).status, 200);
});

test('a signed Polar webhook upgrades the account; retries apply once; comp plans are never overwritten', async () => {
  const env = await paywall();
  const cookie = await signUp(env, 'ada@example.com');
  verifyEmail(env, 'ada@example.com');
  const account = accountOf(env, 'ada@example.com');
  env.DB.db.prepare("UPDATE subscriptions SET trial_ends_at = '2020-01-01T00:00:00.000Z'").run();
  await entitlements(env, account);
  env.DB.db.prepare("UPDATE subscriptions SET trial_ends_at = '2020-01-01T00:00:00.000Z'").run();

  const request = signed(subscriptionEvent(account), { id: 'evt_fixed' });
  const first = await worker.fetch(request, env);
  assert.equal(first.status, 200);
  const status = await (await worker.fetch(get('/api/billing/status', cookie), env)).json();
  assert.equal(status.plan, 'creator');
  assert.equal(status.writable, true);
  const retry = await worker.fetch(signed(subscriptionEvent(account), { id: 'evt_fixed' }), env);
  assert.equal((await retry.json()).duplicate, true);
  assert.equal(env.DB.db.prepare('SELECT COUNT(*) AS n FROM billing_events').get().n, 1);

  await worker.fetch(signed(subscriptionEvent(account, { status: 'canceled' }), {}), env);
  assert.equal((await entitlements(env, account)).writable, false, 'a canceled plan is read-only');

  env.DB.db.prepare("UPDATE subscriptions SET plan = 'comp', status = 'active'").run();
  await worker.fetch(signed(subscriptionEvent(account, { status: 'canceled' })), env);
  assert.equal((await entitlements(env, account)).plan, 'comp');
});

test('webhooks with a bad, stale or missing signature are refused and change nothing', async () => {
  const env = await paywall();
  await signUp(env, 'ada@example.com');
  const account = accountOf(env, 'ada@example.com');
  const event = subscriptionEvent(account);
  assert.equal((await worker.fetch(signed(event, { secret: 'whsec_' + Buffer.from('wrong-secret').toString('base64') }), env)).status, 403);
  assert.equal((await worker.fetch(signed(event, { at: Math.floor(Date.now() / 1000) - 3600 }), env)).status, 403);
  assert.equal((await worker.fetch(new Request(origin + '/api/billing/webhook', { method: 'POST', body: JSON.stringify(event) }), env)).status, 403);
  const tampered = signed(event);
  const forged = new Request(tampered.url, { method: 'POST', headers: tampered.headers, body: JSON.stringify({ ...event, data: { ...event.data, product_id: 'prod-pro' } }) });
  assert.equal((await worker.fetch(forged, env)).status, 403);
  assert.equal(env.DB.db.prepare('SELECT COUNT(*) AS n FROM subscriptions').get().n, 0);
});

test('webhook signatures accept both Standard Webhooks keys and older Polar secrets', async () => {
  const body = '{"type":"ping"}';
  for (const raw of [false, true]) {
    const request = signed(body, { raw });
    assert.equal(await verifyWebhook(request.headers, body, SECRET), true, raw ? 'older Polar secret' : 'Standard Webhooks secret');
  }
});

test('checkout asks Polar for a session for the signed-in account, never for another', async () => {
  const sent = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    if (String(url).startsWith('https://sandbox-api.polar.sh/')) { sent.push({ url: String(url), init }); return Response.json(String(url).includes('checkouts') ? { url: 'https://sandbox.polar.sh/checkout/abc' } : { customer_portal_url: 'https://sandbox.polar.sh/portal/xyz' }); }
    return realFetch(url, init);
  };
  try {
    const env = await paywall({ POLAR_ACCESS_TOKEN: 'polar_oat_test' });
    const cookie = await signUp(env, 'ada@example.com');
    const start = await worker.fetch(new Request(origin + '/api/billing/checkout', { method: 'POST', headers: { origin, cookie, 'content-type': 'application/json' }, body: JSON.stringify({ plan: 'pro', external_customer_id: 'someone-else' }) }), env);
    assert.equal(start.status, 200);
    assert.equal((await start.json()).url, 'https://sandbox.polar.sh/checkout/abc');
    const body = JSON.parse(sent[0].init.body);
    assert.deepEqual(body.products, ['prod-pro']);
    assert.equal(body.external_customer_id, accountOf(env, 'ada@example.com'));
    assert.equal(sent[0].init.headers.authorization, 'Bearer polar_oat_test');
    assert.equal((await worker.fetch(new Request(origin + '/api/billing/checkout', { method: 'POST', headers: { origin: 'https://evil.example', cookie, 'content-type': 'application/json' }, body: '{"plan":"pro"}' }), env)).status, 403);
    assert.equal((await worker.fetch(new Request(origin + '/api/billing/checkout', { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: '{"plan":"pro"}' }), env)).status, 401);
    const portal = await worker.fetch(new Request(origin + '/api/billing/portal', { method: 'POST', headers: { origin, cookie } }), env);
    assert.equal((await portal.json()).url, 'https://sandbox.polar.sh/portal/xyz');
  } finally { globalThis.fetch = realFetch; }
});

test('the billing page is for members only', async () => {
  const env = await envWith();
  const out = await worker.fetch(get('/account/billing'), env);
  assert.equal(out.status, 302);
  assert.match(out.headers.get('location'), /\/register\?mode=signin/);
  const cookie = await signUp(env, 'ada@example.com');
  assert.equal(await (await worker.fetch(get('/account/billing', cookie), env)).text(), 'asset:/billing');
});
