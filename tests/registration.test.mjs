import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import worker from '../src/worker.js';
import { origin, envWith, get, post, cookieOf, verifyCalls, PASSWORD, signUp, signIn } from './helpers.mjs';

const account = (env, email) => env.DB.db.prepare('SELECT * FROM registrations WHERE email = ?').get(email);

test('unregistered visitors get the sign-in page at / and 403 for app.js', async () => {
  const env = await envWith();
  const home = await worker.fetch(get('/'), env);
  assert.equal(home.status, 200);
  assert.equal(await home.text(), 'asset:/register');
  assert.equal(home.headers.get('cache-control'), 'private, no-cache');
  assert.equal(home.headers.get('vary'), 'cookie');
  const script = await worker.fetch(get('/app.js'), env);
  assert.equal(script.status, 403);
  assert.deepEqual(env.calls, ['/register']);
  // Public assets stay reachable so the sign-in page can render.
  assert.equal(await (await worker.fetch(get('/styles.css'), env)).text(), 'asset:/styles.css');
});

test('a password sign-up returns 201 with a secure session cookie that unlocks the workspace', async () => {
  const env = await envWith();
  const response = await worker.fetch(post('/api/register', { name: 'Ada', email: 'Ada@Example.com ', password: PASSWORD }), env);
  assert.equal(response.status, 201);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  const setCookie = response.headers.getSetCookie()[0];
  for (const flag of ['ps_session=', 'HttpOnly', 'Secure', 'SameSite=Lax', 'Path=/', 'Max-Age=31536000']) assert(setCookie.includes(flag), flag);
  const row = account(env, 'ada@example.com');
  assert.equal(row.name, 'Ada');
  assert.match(row.password_hash, /^pbkdf2-sha256\$100000\$[\w-]{22}\$[\w-]{43}$/);
  assert(!row.password_hash.includes(PASSWORD));
  assert.equal(row.email_verified, 0);
  const cookie = cookieOf(response);
  assert.equal(await (await worker.fetch(get('/', cookie), env)).text(), 'asset:/');
  assert.equal((await worker.fetch(get('/app.js', cookie), env)).status, 200);
  assert.deepEqual(await (await worker.fetch(get('/api/session', cookie), env)).json(), { registered: true, registrationOpen: true, googleSignIn: false });
});

test('an existing email cannot be signed into by signing up again', async () => {
  const env = await envWith();
  const first = await worker.fetch(post('/api/register', { name: 'Ada', email: 'ada@example.com', password: PASSWORD }, { type: 'application/x-www-form-urlencoded' }), env);
  assert.equal(first.status, 201);
  const again = await worker.fetch(post('/api/register', { name: 'Mallory', email: 'ADA@example.com', password: 'mallory-password' }), env);
  assert.equal(again.status, 409);
  assert.equal(again.headers.get('set-cookie'), null);
  assert.equal(account(env, 'ada@example.com').name, 'Ada');
  assert.equal(await signIn(env, 'ada@example.com', 'mallory-password'), undefined);
});

test('sign-in needs the right password and gives the same answer for unknown emails', async () => {
  const env = await envWith();
  const signupCookie = await signUp(env, 'ada@example.com');
  const ok = await worker.fetch(post('/api/login', { email: ' ADA@example.com', password: PASSWORD }), env);
  assert.equal(ok.status, 200);
  const cookie = cookieOf(ok);
  assert.notEqual(cookie, undefined);
  assert.equal(cookie.split('=')[1].split('.')[0], signupCookie.split('=')[1].split('.')[0]);
  const wrong = await worker.fetch(post('/api/login', { email: 'ada@example.com', password: PASSWORD + 'x' }), env);
  const unknown = await worker.fetch(post('/api/login', { email: 'nobody@example.com', password: PASSWORD }), env);
  assert.equal(wrong.status, 401);
  assert.equal(unknown.status, 401);
  assert.deepEqual(await wrong.json(), await unknown.json());
  assert.equal(wrong.headers.get('set-cookie'), null);
  assert.equal((await worker.fetch(post('/api/login', { email: 'ada@example.com' }), env)).status, 401);
  assert.equal((await worker.fetch(post('/api/login', { email: 'ada@example.com', password: 42 }), env)).status, 401);
});

test('rejects invalid input, cross-origin posts and missing configuration', async () => {
  const env = await envWith();
  const register = body => worker.fetch(post('/api/register', { name: 'Ada', email: 'ada@example.com', password: PASSWORD, ...body }), env);
  assert.equal((await register({ email: 'not-an-email' })).status, 400);
  assert.equal((await register({ name: '' })).status, 400);
  assert.equal((await register({ name: 'x'.repeat(101) })).status, 400);
  assert.equal((await register({ password: 'short' })).status, 400);
  assert.equal((await register({ password: 'x'.repeat(129) })).status, 400);
  assert.equal((await register({ password: undefined })).status, 400);
  assert.equal((await worker.fetch(post('/api/register', { name: 'Ada', email: 'ada@example.com', password: PASSWORD }, { type: 'text/plain' }), env)).status, 400);
  for (const path of ['/api/register', '/api/login']) {
    assert.equal((await worker.fetch(post(path, { name: 'Ada', email: 'ada@example.com', password: PASSWORD }, { origin: 'https://evil.example' }), env)).status, 403);
    const noOrigin = new Request(origin + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    assert.equal((await worker.fetch(noOrigin, env)).status, 403);
    assert.equal((await worker.fetch(post(path, { name: 'Ada', email: 'ada@example.com', password: PASSWORD }), await envWith({ DB: undefined }))).status, 503);
  }
  assert.equal(env.DB.db.prepare('SELECT COUNT(*) AS n FROM registrations').get().n, 0);
});

test('Turnstile must pass for sign-up and sign-in, and fails closed', async () => {
  const env = await envWith();
  verifyCalls.length = 0;
  const ok = await worker.fetch(post('/api/register', { name: 'Ada', email: 'ada@example.com', password: PASSWORD }), env);
  assert.equal(ok.status, 201);
  assert.deepEqual(verifyCalls[0], { secret: 'turnstile-secret', response: 'pass', remoteip: '203.0.113.7' });
  for (const token of [null, '', 'fail', 'down', 'x'.repeat(3000)]) {
    for (const path of ['/api/register', '/api/login']) {
      const blocked = await worker.fetch(post(path, { name: 'Bo', email: 'ada@example.com', password: PASSWORD }, { token }), env);
      assert.equal(blocked.status, 403, `${path} token ${String(token).slice(0, 10)}`);
      assert.equal(blocked.headers.get('set-cookie'), null);
    }
  }
  const noSecret = await worker.fetch(post('/api/login', { email: 'ada@example.com', password: PASSWORD }), await envWith({ TURNSTILE_SECRET: undefined }));
  assert.equal(noSecret.status, 503);
});

test('honeypot submissions get a quiet 200 with no row and no cookie', async () => {
  const env = await envWith();
  const response = await worker.fetch(post('/api/register', { name: 'Bot', email: 'bot@example.com', password: PASSWORD, website: 'http://spam' }), env);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('set-cookie'), null);
  assert.equal(account(env, 'bot@example.com'), undefined);
});

test('closing registration refuses new accounts but existing creators still sign in', async () => {
  const env = await envWith();
  await signUp(env, 'ada@example.com');
  env.REGISTRATION_OPEN = 'false';
  const fresh = await worker.fetch(post('/api/register', { name: 'Bo', email: 'bo@example.com', password: PASSWORD }), env);
  assert.equal(fresh.status, 403);
  assert.equal(fresh.headers.get('set-cookie'), null);
  const cookie = await signIn(env, 'ada@example.com');
  assert.equal(await (await worker.fetch(get('/', cookie), env)).text(), 'asset:/');
  assert.equal((await (await worker.fetch(get('/api/session'), env)).json()).registrationOpen, false);
});

test('legacy email-only accounts can be claimed with a password once', async () => {
  const env = await envWith();
  env.DB.db.prepare("INSERT INTO registrations (id, email, name, created_at) VALUES ('legacy', 'ada@example.com', 'Ada', '2026-10-30')").run();
  env.REGISTRATION_OPEN = 'false';
  const claimed = await worker.fetch(post('/api/register', { name: 'Ada', email: 'ada@example.com', password: PASSWORD }), env);
  assert.equal(claimed.status, 200);
  assert.equal(cookieOf(claimed).split('=')[1].split('.')[0], 'legacy');
  const second = await worker.fetch(post('/api/register', { name: 'Bo', email: 'ada@example.com', password: 'another-password' }), env);
  assert.equal(second.status, 409);

  // The claim itself re-checks every condition: a verified or Google-linked legacy row
  // (as left by a Google sign-in racing the claim) never gets a password.
  for (const [id, setup] of [['verified', "UPDATE registrations SET email_verified = 1 WHERE id = 'verified'"],
    ['linked', "INSERT INTO identities VALUES ('google', 'sub-linked', 'linked', 'linked@example.com', '2026-11-03')"]]) {
    env.DB.db.prepare(`INSERT INTO registrations (id, email, name, created_at) VALUES ('${id}', '${id}@example.com', 'X', '2026-10-30')`).run();
    env.DB.db.prepare(setup).run();
    const response = await worker.fetch(post('/api/register', { name: 'X', email: `${id}@example.com`, password: PASSWORD }), env);
    assert.equal(response.status, 409, id);
    assert.equal(env.DB.db.prepare('SELECT password_hash FROM registrations WHERE id = ?').get(id).password_hash, null);
  }
});

test('cookies from the old email-only sign-up, tampered cookies and foreign secrets stay gated', async () => {
  const env = await envWith();
  const cookie = await signUp(env, 'ada@example.com');
  const [name, value] = cookie.split('=');
  const tampered = `${name}=${value.replace(/^./, c => (c === 'a' ? 'b' : 'a'))}`;
  assert.equal(await (await worker.fetch(get('/', tampered), env)).text(), 'asset:/register');
  assert.equal(await (await worker.fetch(get('/', 'ps_session=garbage'), env)).text(), 'asset:/register');
  assert.equal(await (await worker.fetch(get('/', 'ps_reg=' + value), env)).text(), 'asset:/register');
  assert.equal(await (await worker.fetch(get('/', cookie), await envWith({ SESSION_SECRET: 'other' }))).text(), 'asset:/register');
  assert.equal(await (await worker.fetch(get('/', cookie), { ...env, SESSION_SECRET: undefined })).text(), 'asset:/register');
});

test('deleting a registration or bumping its session version revokes cookies; bad issue times are refused', async () => {
  const env = await envWith();
  const cookie = await signUp(env, 'ada@example.com');
  assert.equal(await (await worker.fetch(get('/', cookie), env)).text(), 'asset:/');
  env.DB.db.prepare("UPDATE registrations SET session_version = session_version + 1 WHERE email = 'ada@example.com'").run();
  assert.equal(await (await worker.fetch(get('/', cookie), env)).text(), 'asset:/register');
  const next = await signIn(env, 'ada@example.com');
  assert.equal(await (await worker.fetch(get('/', next), env)).text(), 'asset:/');
  env.DB.db.prepare("DELETE FROM registrations WHERE email = 'ada@example.com'").run();
  assert.equal((await (await worker.fetch(get('/api/session', next), env)).json()).registered, false);

  // Forge correctly signed cookies with out-of-range issue times.
  await signUp(env, 'bo@example.com');
  const { id, session_version: version } = account(env, 'bo@example.com');
  const sign = async payload => {
    const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(env.SESSION_SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const mac = Buffer.from(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payload))).toString('base64url');
    return `ps_session=${payload}.${mac}`;
  };
  const now = Math.floor(Date.now() / 1000);
  assert.equal(await (await worker.fetch(get('/', await sign(`${id}.${version}.${now - 60}`)), env)).text(), 'asset:/');
  assert.equal(await (await worker.fetch(get('/', await sign(`${id}.${version}.${now - 366 * 86400}`)), env)).text(), 'asset:/register');
  assert.equal(await (await worker.fetch(get('/', await sign(`${id}.${version}.${now + 3600}`)), env)).text(), 'asset:/register');
  assert.equal(await (await worker.fetch(get('/', await sign(`${id}.${version + 1}.${now}`)), env)).text(), 'asset:/register');
  assert.equal(await (await worker.fetch(get('/', await sign(`${id}.${now}`)), env)).text(), 'asset:/register');
});

test('other write methods and paths remain 405', async () => {
  const env = await envWith();
  for (const [path, method] of [['/api/register', 'PUT'], ['/api/login', 'DELETE'], ['/api/session', 'POST'], ['/auth/google', 'POST'], ['/', 'POST']]) {
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
