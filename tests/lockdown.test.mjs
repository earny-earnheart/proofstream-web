import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/worker.js';
import { REQUEST_RECEIVED } from '../src/access.js';
import { origin, envWith, signUp, signIn, post, get, cookieOf, PASSWORD } from './helpers.mjs';

const ADMIN = 'boss@example.com';
const adminPost = (cookie, path, body = {}) => new Request(origin + path, {
  method: 'POST', headers: { origin, 'content-type': 'application/json', cookie }, body: JSON.stringify(body),
});
const ask = (body, opts) => post('/api/access-request', { name: 'Kai', email: 'kai@example.com', role: 'Producer', note: 'Catalog of 40 beats', ...body }, opts);

async function invitationOnly(overrides = {}) {
  const env = await envWith({ ADMIN_EMAILS: ADMIN, ...overrides });
  const admin = await signUp(env, ADMIN);
  env.DB.db.prepare('UPDATE registrations SET email_verified = 1 WHERE email = ?').run(ADMIN);
  env.REGISTRATION_OPEN = 'false';
  return { env, admin };
}

test('a visitor can request access; every request gets the same answer and is stored once', async () => {
  const { env } = await invitationOnly();
  const first = await worker.fetch(ask(), env);
  assert.equal(first.status, 200);
  assert.equal((await first.json()).message, REQUEST_RECEIVED);
  const again = await worker.fetch(ask({ name: 'Someone else' }), env);
  assert.equal((await again.json()).message, REQUEST_RECEIVED, 'a repeat looks the same');
  const member = await worker.fetch(ask({ email: ADMIN }), env);
  assert.equal((await member.json()).message, REQUEST_RECEIVED, 'a member email looks the same too');
  const rows = env.DB.db.prepare("SELECT name, role, note, status FROM access_requests WHERE email = 'kai@example.com'").all();
  assert.deepEqual(rows.map(r => ({ ...r })), [{ name: 'Kai', role: 'Producer', note: 'Catalog of 40 beats', status: 'pending' }]);
});

test('access requests need the bot check, the same origin and valid fields; the honeypot stores nothing', async () => {
  const { env } = await invitationOnly();
  assert.equal((await worker.fetch(ask({}, { token: 'fail' }), env)).status, 403);
  assert.equal((await worker.fetch(ask({}, { origin: 'https://evil.example' }), env)).status, 403);
  assert.equal((await worker.fetch(ask({ email: 'nope' }), env)).status, 400);
  assert.equal((await worker.fetch(ask({ role: 'Astronaut' }), env)).status, 400);
  assert.equal((await worker.fetch(ask({ note: 'x'.repeat(501) }), env)).status, 400);
  assert.equal((await worker.fetch(ask({ website: 'spam.example' }), env)).status, 200);
  assert.equal(env.DB.db.prepare('SELECT COUNT(*) AS n FROM access_requests').get().n, 0);
});

test('while invitation only, a new email cannot sign up until an admin approves it', async () => {
  const { env, admin } = await invitationOnly();
  const session = await (await worker.fetch(get('/api/session'), env)).json();
  assert.equal(session.invitationOnly, true);
  const early = await worker.fetch(post('/api/register', { name: 'Kai', email: 'kai@example.com', password: PASSWORD }), env);
  assert.equal(early.status, 403);
  assert.match((await early.json()).error, /invitation only/);

  await worker.fetch(ask(), env);
  const list = await (await worker.fetch(get('/api/v1/admin/access-requests', admin), env)).json();
  assert.equal(list.requests.length, 1);
  assert.equal(list.requests[0].has_account, false);
  const approve = await worker.fetch(adminPost(admin, `/api/v1/admin/access-requests/${list.requests[0].id}/approve`), env);
  assert.equal(approve.status, 200);

  const joined = await worker.fetch(post('/api/register', { name: 'Kai', email: 'KAI@example.com', password: PASSWORD }), env);
  assert.equal(joined.status, 201, 'the approved email can now create its account, in any letter case');
  assert(cookieOf(joined));
  const audit = env.DB.db.prepare('SELECT action, subject FROM audit_log').all();
  assert.deepEqual(audit.map(a => a.action), ['access.approve']);
});

test('a declined request stays declined and cannot sign up or re-request its way in', async () => {
  const { env, admin } = await invitationOnly();
  await worker.fetch(ask(), env);
  const { id } = env.DB.db.prepare('SELECT id FROM access_requests').get();
  assert.equal((await worker.fetch(adminPost(admin, `/api/v1/admin/access-requests/${id}/decline`), env)).status, 200);
  await worker.fetch(ask(), env);
  assert.equal(env.DB.db.prepare('SELECT status FROM access_requests').get().status, 'declined');
  assert.equal((await worker.fetch(post('/api/register', { name: 'Kai', email: 'kai@example.com', password: PASSWORD }), env)).status, 403);
});

test('only verified admins can list or decide access requests', async () => {
  const { env } = await invitationOnly();
  env.REGISTRATION_OPEN = 'true';
  const ada = await signUp(env, 'ada@example.com');
  await worker.fetch(ask(), env);
  const { id } = env.DB.db.prepare('SELECT id FROM access_requests').get();
  assert.equal((await worker.fetch(get('/api/v1/admin/access-requests', ada), env)).status, 404);
  assert.equal((await worker.fetch(get('/api/v1/admin/access-requests'), env)).status, 404);
  assert.equal((await worker.fetch(adminPost(ada, `/api/v1/admin/access-requests/${id}/approve`), env)).status, 404);
  assert.equal(env.DB.db.prepare('SELECT status FROM access_requests').get().status, 'pending');
});

test('signing out ends that session everywhere: a copied cookie stops working', async () => {
  const env = await envWith();
  const cookie = await signUp(env, 'ada@example.com');
  const copy = cookie;
  assert.equal((await worker.fetch(get('/api/projects', copy), env)).status, 200);
  const out = await worker.fetch(new Request(origin + '/api/logout', { method: 'POST', headers: { origin, cookie } }), env);
  assert.equal(out.status, 200);
  assert.match(out.headers.get('set-cookie'), /Max-Age=0/);
  assert.equal((await worker.fetch(get('/api/projects', copy), env)).status, 401, 'the old cookie no longer works');
  const again = await signIn(env, 'ada@example.com');
  assert.equal((await worker.fetch(get('/api/projects', again), env)).status, 200, 'signing in again works');
});

test('sessions last 30 days', async () => {
  const env = await envWith();
  const response = await worker.fetch(post('/api/register', { name: 'Ada', email: 'ada@example.com', password: PASSWORD }), env);
  assert.match(response.headers.get('set-cookie'), /Max-Age=2592000;/);
});

test('sign-in, sign-up, reset and access requests answer 429 when the rate limiter says so', async () => {
  const deny = { limit: async () => ({ success: false }) };
  const env = await envWith({ AUTH_LIMITER: deny, SIGNUP_LIMITER: deny });
  for (const path of ['/api/login', '/api/register', '/api/password/forgot', '/api/password/reset', '/api/access-request']) {
    const response = await worker.fetch(post(path, { email: 'ada@example.com', password: PASSWORD, name: 'Ada', role: 'Artist' }), env);
    assert.equal(response.status, 429, path);
    assert.equal(response.headers.get('retry-after'), '60');
  }
  assert.equal(env.DB.db.prepare('SELECT COUNT(*) AS n FROM registrations').get().n, 0);
});

test('a limiter error never locks people out', async () => {
  const broken = { limit: async () => { throw new Error('down'); } };
  const env = await envWith({ AUTH_LIMITER: broken, SIGNUP_LIMITER: broken });
  assert.equal((await worker.fetch(post('/api/register', { name: 'Ada', email: 'ada@example.com', password: PASSWORD }), env)).status, 201);
});
