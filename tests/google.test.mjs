import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/worker.js';
import { origin, envWith, get, post, cookieOf, google, PASSWORD, signUp, signIn } from './helpers.mjs';

const CLIENT_ID = 'client-id.apps.googleusercontent.com';
const withGoogle = (overrides = {}) => envWith({ GOOGLE_CLIENT_ID: CLIENT_ID, GOOGLE_CLIENT_SECRET: 'google-secret', ...overrides });
const claims = (extra = {}) => ({
  iss: 'https://accounts.google.com', aud: CLIENT_ID, sub: 'google-ada', email: 'Ada@Example.com',
  email_verified: true, hd: 'example.com', name: 'Ada Lovelace', exp: Math.floor(Date.now() / 1000) + 300, ...extra,
});

// Start the flow, then return to the callback as Google would.
async function googleSignIn(env, tokenClaims = claims(), tweak = {}) {
  google.claims = tokenClaims;
  const start = await worker.fetch(get('/auth/google'), env);
  const target = new URL(start.headers.get('location'));
  const oauth = tweak.cookie ?? cookieOf(start, 'ps_oauth');
  const state = tweak.state ?? target.searchParams.get('state');
  const callback = await worker.fetch(get(`/auth/google/callback?code=auth-code&state=${encodeURIComponent(state)}`, oauth), env);
  return { start, target, callback, session: cookieOf(callback) };
}

const accounts = env => env.DB.db.prepare('SELECT * FROM registrations').all();

test('starting Google sign-in redirects with PKCE and a signed, short-lived state cookie', async () => {
  const env = await withGoogle();
  const response = await worker.fetch(get('/auth/google'), env);
  assert.equal(response.status, 302);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  const target = new URL(response.headers.get('location'));
  assert.equal(target.origin + target.pathname, 'https://accounts.google.com/o/oauth2/v2/auth');
  const params = Object.fromEntries(target.searchParams);
  assert.equal(params.client_id, CLIENT_ID);
  assert.equal(params.redirect_uri, 'https://proofstreamapp.com/auth/google/callback');
  assert.equal(params.response_type, 'code');
  assert.equal(params.scope, 'openid email profile');
  assert.equal(params.code_challenge_method, 'S256');
  assert.match(params.state, /^[\w-]{43}$/);
  assert.match(params.code_challenge, /^[\w-]{43}$/);
  const setCookie = response.headers.getSetCookie()[0];
  for (const flag of ['ps_oauth=', 'Max-Age=600', 'Path=/auth/google', 'HttpOnly', 'Secure', 'SameSite=Lax']) assert(setCookie.includes(flag), flag);
  assert(!setCookie.includes('google-secret'));

  for (const missing of ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET']) {
    const off = await worker.fetch(get('/auth/google'), await withGoogle({ [missing]: undefined }));
    assert.equal(off.headers.get('location'), '/?auth=unavailable');
  }
  assert.equal((await (await worker.fetch(get('/api/session'), env)).json()).googleSignIn, true);
});

test('a first Google sign-in creates a verified account and a working session', async () => {
  const env = await withGoogle();
  google.calls.length = 0;
  const { target, callback, session } = await googleSignIn(env);
  assert.equal(callback.status, 302);
  assert.equal(callback.headers.get('location'), '/');
  assert(callback.headers.getSetCookie().some(c => c.startsWith('ps_oauth=;') && c.includes('Max-Age=0')));
  assert.equal(await (await worker.fetch(get('/', session), env)).text(), 'asset:/');

  // The token request proved possession of the PKCE verifier behind the challenge.
  const sent = google.calls[0];
  assert.equal(sent.code, 'auth-code');
  assert.equal(sent.client_secret, 'google-secret');
  assert.equal(sent.redirect_uri, 'https://proofstreamapp.com/auth/google/callback');
  const challenge = Buffer.from(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(sent.code_verifier))).toString('base64url');
  assert.equal(challenge, target.searchParams.get('code_challenge'));

  const [row] = accounts(env);
  assert.equal(row.email, 'ada@example.com');
  assert.equal(row.name, 'Ada Lovelace');
  assert.equal(row.email_verified, 1);
  assert.equal(row.password_hash, null);
  assert.deepEqual({ ...env.DB.db.prepare('SELECT provider, subject, account_id FROM identities').get() }, { provider: 'google', subject: 'google-ada', account_id: row.id });
});

test('returning Google users reach the same account, even after changing their Google email', async () => {
  const env = await withGoogle();
  const first = await googleSignIn(env);
  const again = await googleSignIn(env, claims({ email: 'ada@newdomain.example' }));
  const id = cookie => cookie.split('=')[1].split('.')[0];
  assert.equal(id(again.session), id(first.session));
  assert.equal(accounts(env).length, 1);
  // A different Google account gets a different ProofStream account.
  const other = await googleSignIn(env, claims({ sub: 'google-bo', email: 'bo@example.com' }));
  assert.notEqual(id(other.session), id(first.session));
});

test('forged, missing, reused or expired state is refused before calling Google', async () => {
  const env = await withGoogle();
  google.calls.length = 0;
  const forged = await googleSignIn(env, claims(), { state: 'attacker-state' });
  const missing = await googleSignIn(env, claims(), { cookie: '' });
  const tampered = await googleSignIn(env, claims(), { cookie: 'ps_oauth=a.b.1.signature' });
  for (const { callback, session } of [forged, missing, tampered]) {
    assert.equal(callback.headers.get('location'), '/?auth=failed');
    assert.equal(session, undefined);
  }
  assert.equal(google.calls.length, 0);

  // A correctly signed state cookie older than ten minutes.
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(env.SESSION_SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const payload = `old-state.verifier.${Math.floor(Date.now() / 1000) - 601}`;
  const mac = Buffer.from(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payload))).toString('base64url');
  const expired = await googleSignIn(env, claims(), { cookie: `ps_oauth=${payload}.${mac}`, state: 'old-state' });
  assert.equal(expired.session, undefined);
  assert.equal(google.calls.length, 0);
  assert.equal(accounts(env).length, 0);
});

test('unverified emails and tokens for another app, issuer or time are refused', async () => {
  const env = await withGoogle();
  for (const bad of [
    claims({ email_verified: false }), claims({ email_verified: 'true' }), claims({ aud: 'someone-else' }),
    claims({ iss: 'https://evil.example' }), claims({ exp: Math.floor(Date.now() / 1000) - 1 }),
    claims({ sub: '' }), claims({ email: 'not-an-email' }),
  ]) {
    const { callback, session } = await googleSignIn(env, bad);
    assert.equal(callback.headers.get('location'), '/?auth=failed', JSON.stringify(bad).slice(0, 80));
    assert.equal(session, undefined);
  }
  google.status = 400;
  assert.equal((await googleSignIn(env)).session, undefined);
  google.status = 200;
  assert.equal(accounts(env).length, 0);
});

test('a verified Google sign-in takes over an unverified password account and ends its sessions', async () => {
  const env = await withGoogle();
  // Someone signs up with Ada's email before she does.
  const squatter = await signUp(env, 'ada@example.com', 'squatter-password');
  const { session } = await googleSignIn(env);
  assert.equal(session.split('=')[1].split('.')[0], squatter.split('=')[1].split('.')[0]);
  assert.equal(await (await worker.fetch(get('/', squatter), env)).text(), 'asset:/register');
  assert.equal(await signIn(env, 'ada@example.com', 'squatter-password'), undefined);
  assert.equal(await (await worker.fetch(get('/', session), env)).text(), 'asset:/');
  assert.equal(accounts(env)[0].email_verified, 1);
});

test('emails that belong to a Google account cannot get a password by signing up', async () => {
  const env = await withGoogle();
  await googleSignIn(env);
  const response = await worker.fetch(post('/api/register', { name: 'Mallory', email: 'ada@example.com', password: PASSWORD }), env);
  assert.equal(response.status, 409);
  assert.equal(response.headers.get('set-cookie'), null);
  assert.equal(await signIn(env, 'ada@example.com'), undefined);
});

test('closed registration refuses new Google accounts but lets existing ones in', async () => {
  const env = await withGoogle({ REGISTRATION_OPEN: 'false' });
  assert.equal((await googleSignIn(env)).callback.headers.get('location'), '/?auth=closed');
  env.DB.db.prepare("INSERT INTO registrations (id, email, name, created_at) VALUES ('legacy', 'ada@example.com', 'Ada', '2026-10-30')").run();
  const { session } = await googleSignIn(env);
  assert.equal(session.split('=')[1].split('.')[0], 'legacy');
});

test('Google sign-in is unavailable without configuration', async () => {
  const env = await envWith();
  assert.equal((await worker.fetch(get('/auth/google/callback?code=x&state=y'), env)).headers.get('location'), '/?auth=unavailable');
  assert.equal((await (await worker.fetch(get('/api/session'), env)).json()).googleSignIn, false);
  assert.equal(origin, 'https://proofstreamapp.com');
});

test('Google emails it cannot vouch for open new accounts but never take over existing ones', async () => {
  const env = await withGoogle();
  const personal = claims({ hd: undefined });
  // No account yet: a new, unverified account is fine.
  const fresh = await googleSignIn(env, personal);
  assert.equal(fresh.callback.headers.get('location'), '/');
  assert.equal(accounts(env)[0].email_verified, 0);

  // An existing password account is left alone, password and sessions intact.
  const other = await withGoogle();
  const owner = await signUp(other, 'ada@example.com');
  for (const bad of [personal, claims({ hd: 'other.example' })]) {
    const { callback, session } = await googleSignIn(other, bad);
    assert.equal(callback.headers.get('location'), '/?auth=exists');
    assert.equal(session, undefined);
  }
  assert.equal(await (await worker.fetch(get('/', owner), other)).text(), 'asset:/');
  assert.notEqual(await signIn(other, 'ada@example.com'), undefined);
  assert.equal(other.DB.db.prepare('SELECT COUNT(*) AS n FROM identities').get().n, 0);

  // Gmail addresses are authoritative without an hd claim.
  const gmail = await withGoogle();
  const squatter = await signUp(gmail, 'ada@gmail.com', 'squatter-password');
  const { session } = await googleSignIn(gmail, claims({ hd: undefined, email: 'ada@gmail.com' }));
  assert.notEqual(session, undefined);
  assert.equal(await (await worker.fetch(get('/', squatter), gmail)).text(), 'asset:/register');
});

test('an account linked to one Google account cannot be joined by another', async () => {
  const env = await withGoogle();
  const first = await googleSignIn(env);
  const second = await googleSignIn(env, claims({ sub: 'google-someone-else' }));
  assert.equal(second.callback.headers.get('location'), '/?auth=exists');
  assert.equal(second.session, undefined);
  assert.equal(env.DB.db.prepare('SELECT COUNT(*) AS n FROM identities').get().n, 1);
  assert.equal(await (await worker.fetch(get('/', first.session), env)).text(), 'asset:/');
});

test('a vouched Google sign-in replaces an unvouched Google account that got the email first', async () => {
  const env = await withGoogle();
  const early = await googleSignIn(env, claims({ sub: 'google-stale', hd: undefined }));
  assert.equal(accounts(env)[0].email_verified, 0);
  const owner = await googleSignIn(env, claims({ sub: 'google-owner' }));
  assert.equal(owner.callback.headers.get('location'), '/');
  assert.equal(owner.session.split('=')[1].split('.')[0], early.session.split('=')[1].split('.')[0]);
  assert.equal(await (await worker.fetch(get('/', early.session), env)).text(), 'asset:/register');
  assert.deepEqual(env.DB.db.prepare('SELECT subject FROM identities').all().map(r => r.subject), ['google-owner']);
  // The unvouched account can no longer get in.
  assert.equal((await googleSignIn(env, claims({ sub: 'google-stale', hd: undefined }))).callback.headers.get('location'), '/?auth=exists');
});
