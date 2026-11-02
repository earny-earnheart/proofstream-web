import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import worker from '../src/worker.js';

const origin = 'https://proofstreamapp.com';

// Minimal stand-in for the D1 prepared-statement API used by the Worker.
function fakeDB() {
  const rows = new Map();
  return {
    rows,
    prepare(sql) {
      return {
        bind(...args) {
          return {
            async first() {
              const row = rows.get(args[0]);
              return row ? { id: row.id } : null;
            },
            async run() {
              assert.match(sql, /^INSERT INTO registrations/);
              const [id, email, name, created_at, user_agent] = args;
              if (!rows.has(email)) rows.set(email, { id, email, name, created_at, user_agent });
              return { success: true };
            },
          };
        },
      };
    },
  };
}

function envWith(overrides = {}) {
  const calls = [];
  return {
    calls,
    DB: fakeDB(),
    SESSION_SECRET: 'test-secret-value',
    REGISTRATION_OPEN: 'true',
    ASSETS: { fetch: async req => { calls.push(new URL(req.url).pathname); return new Response('asset:' + new URL(req.url).pathname, { headers: { 'content-type': 'text/html' } }); } },
    ...overrides,
  };
}

const post = (body, { origin: from = origin, type = 'application/json' } = {}) => new Request(origin + '/api/register', {
  method: 'POST',
  headers: { origin: from, 'content-type': type },
  body: type === 'application/json' ? JSON.stringify(body) : new URLSearchParams(body),
});
const get = (path, cookie) => new Request(origin + path, { headers: cookie ? { cookie } : {} });
const cookieOf = response => response.headers.get('set-cookie')?.split(';')[0];

test('unregistered visitors get the register page at / and 403 for app.js', async () => {
  const env = envWith();
  const home = await worker.fetch(get('/'), env);
  assert.equal(home.status, 200);
  assert.equal(await home.text(), 'asset:/register');
  assert.equal(home.headers.get('cache-control'), 'private, no-cache');
  assert.equal(home.headers.get('vary'), 'cookie');
  const script = await worker.fetch(get('/app.js'), env);
  assert.equal(script.status, 403);
  assert.deepEqual(env.calls, ['/register']);
  // Public assets stay reachable so the register page can render.
  assert.equal(await (await worker.fetch(get('/styles.css'), env)).text(), 'asset:/styles.css');
});

test('a valid registration returns 201 with a secure session cookie that unlocks the workspace', async () => {
  const env = envWith();
  const response = await worker.fetch(post({ name: 'Ada', email: 'Ada@Example.com ' }), env);
  assert.equal(response.status, 201);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  const setCookie = response.headers.get('set-cookie');
  for (const flag of ['HttpOnly', 'Secure', 'SameSite=Lax', 'Path=/', 'Max-Age=31536000']) assert(setCookie.includes(flag), flag);
  assert.equal(env.DB.rows.get('ada@example.com').name, 'Ada');
  const cookie = cookieOf(response);
  assert.equal(await (await worker.fetch(get('/', cookie), env)).text(), 'asset:/');
  assert.equal((await worker.fetch(get('/app.js', cookie), env)).status, 200);
  assert.deepEqual(await (await worker.fetch(get('/api/session', cookie), env)).json(), { registered: true, registrationOpen: true });
});

test('form-encoded submissions work and duplicate emails sign back in with 200', async () => {
  const env = envWith();
  const first = await worker.fetch(post({ name: 'Ada', email: 'ada@example.com' }, { type: 'application/x-www-form-urlencoded' }), env);
  assert.equal(first.status, 201);
  const again = await worker.fetch(post({ name: 'Someone else', email: 'ADA@example.com' }), env);
  assert.equal(again.status, 200);
  assert.equal((await again.json()).returning, true);
  assert.equal(cookieOf(again), cookieOf(first));
  assert.equal(env.DB.rows.size, 1);
});

test('rejects invalid input, cross-origin posts and missing configuration', async () => {
  const env = envWith();
  assert.equal((await worker.fetch(post({ name: 'Ada', email: 'not-an-email' }), env)).status, 400);
  assert.equal((await worker.fetch(post({ name: '', email: 'ada@example.com' }), env)).status, 400);
  assert.equal((await worker.fetch(post({ name: 'x'.repeat(101), email: 'ada@example.com' }), env)).status, 400);
  assert.equal((await worker.fetch(post({ name: 'Ada', email: 'ada@example.com' }, { type: 'text/plain' }), env)).status, 400);
  assert.equal((await worker.fetch(post({ name: 'Ada', email: 'ada@example.com' }, { origin: 'https://evil.example' }), env)).status, 403);
  const noOrigin = new Request(origin + '/api/register', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  assert.equal((await worker.fetch(noOrigin, env)).status, 403);
  assert.equal((await worker.fetch(post({ name: 'Ada', email: 'ada@example.com' }), envWith({ DB: undefined }))).status, 503);
  assert.equal(env.DB.rows.size, 0);
});

test('honeypot submissions get a quiet 200 with no row and no cookie', async () => {
  const env = envWith();
  const response = await worker.fetch(post({ name: 'Bot', email: 'bot@example.com', website: 'http://spam' }), env);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('set-cookie'), null);
  assert.equal(env.DB.rows.size, 0);
});

test('closing the window refuses new emails but lets existing registrants back in', async () => {
  const env = envWith();
  const first = await worker.fetch(post({ name: 'Ada', email: 'ada@example.com' }), env);
  env.REGISTRATION_OPEN = 'false';
  const fresh = await worker.fetch(post({ name: 'Bo', email: 'bo@example.com' }), env);
  assert.equal(fresh.status, 403);
  assert.equal(fresh.headers.get('set-cookie'), null);
  assert.equal((await worker.fetch(post({ name: 'Ada', email: 'ada@example.com' }), env)).status, 200);
  assert.equal(await (await worker.fetch(get('/', cookieOf(first)), env)).text(), 'asset:/');
  assert.equal((await (await worker.fetch(get('/api/session'), env)).json()).registrationOpen, false);
});

test('tampered, foreign-secret or secretless cookies stay gated', async () => {
  const env = envWith();
  const cookie = cookieOf(await worker.fetch(post({ name: 'Ada', email: 'ada@example.com' }), env));
  const [name, value] = cookie.split('=');
  const tampered = `${name}=${value.replace(/^./, c => (c === 'a' ? 'b' : 'a'))}`;
  assert.equal(await (await worker.fetch(get('/', tampered), env)).text(), 'asset:/register');
  assert.equal(await (await worker.fetch(get('/', 'ps_reg=garbage'), env)).text(), 'asset:/register');
  assert.equal(await (await worker.fetch(get('/', cookie), envWith({ SESSION_SECRET: 'other' }))).text(), 'asset:/register');
  assert.equal(await (await worker.fetch(get('/', cookie), envWith({ SESSION_SECRET: undefined }))).text(), 'asset:/register');
});

test('other write methods and paths remain 405', async () => {
  const env = envWith();
  for (const [path, method] of [['/api/register', 'PUT'], ['/api/register', 'DELETE'], ['/api/session', 'POST'], ['/', 'POST']]) {
    const response = await worker.fetch(new Request(origin + path, { method, headers: { origin } }), env);
    assert.equal(response.status, 405, `${method} ${path}`);
  }
});

test('config binds D1 with migrations and an explicit registration switch', async () => {
  const config = JSON.parse(await readFile(new URL('../wrangler.jsonc', import.meta.url), 'utf8'));
  assert.equal(config.d1_databases[0].binding, 'DB');
  assert.equal(config.d1_databases[0].migrations_dir, 'migrations');
  assert(['true', 'false'].includes(config.vars.REGISTRATION_OPEN));
  const schema = await readFile(new URL('../migrations/0001_registrations.sql', import.meta.url), 'utf8');
  assert.match(schema, /email TEXT NOT NULL UNIQUE COLLATE NOCASE/);
});
