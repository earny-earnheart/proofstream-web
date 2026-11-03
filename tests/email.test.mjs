import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/worker.js';
import { origin, envWith, get, post, cookieOf, PASSWORD, signUp, signIn } from './helpers.mjs';

// A stand-in for the Cloudflare Email Service binding that records every message.
function mailbox() {
  const sent = [];
  return { sent, async send(message) { sent.push(message); return { messageId: String(sent.length) }; } };
}
const withEmail = async (overrides = {}) => { const EMAIL = mailbox(); return { ...(await envWith({ EMAIL, ...overrides })), EMAIL }; };
const tokenIn = message => message.text.match(/#([\w-]+)/)[1];
const send = (path, body, cookie, from = origin) => new Request(origin + path, {
  method: 'POST',
  headers: { origin: from, 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
  body: JSON.stringify(body),
});
const account = (env, email) => env.DB.db.prepare('SELECT * FROM registrations WHERE email = ?').get(email);
const session = async (env, cookie) => (await worker.fetch(get('/api/session', cookie), env)).json();

test('sign-up emails a confirmation link; only the hash of its token is stored', async () => {
  const env = await withEmail();
  const cookie = await signUp(env, 'ada@example.com');
  assert.equal(env.EMAIL.sent.length, 1);
  const message = env.EMAIL.sent[0];
  assert.equal(message.to, 'ada@example.com');
  assert.deepEqual(message.from, { email: 'no-reply@proofstreamapp.com', name: 'ProofStream' });
  assert(message.html && message.text);
  const token = tokenIn(message);
  assert(message.text.includes('https://proofstreamapp.com/verify#' + token));
  const stored = env.DB.db.prepare('SELECT * FROM email_tokens').all();
  assert.equal(stored.length, 1);
  assert.notEqual(stored[0].token_hash, token);
  assert.deepEqual(await session(env, cookie), { registered: true, registrationOpen: true, googleSignIn: false, emailLinks: true, emailVerified: false });

  const verified = await worker.fetch(send('/api/email/verify', { token }, cookie), env);
  assert.equal(verified.status, 200);
  assert.equal(account(env, 'ada@example.com').email_verified, 1);
  assert.equal((await session(env, cookie)).emailVerified, true);
  // Links work once.
  assert.equal((await worker.fetch(send('/api/email/verify', { token }, cookie), env)).status, 400);
});

test('a confirmation link only counts in a browser signed in to that account', async () => {
  const env = await withEmail();
  await signUp(env, 'victim@example.com'); // made by a stranger using the victim's address
  const token = tokenIn(env.EMAIL.sent[0]);
  const other = await signUp(env, 'bo@example.com');
  assert.equal((await worker.fetch(send('/api/email/verify', { token }), env)).status, 401);
  assert.equal((await worker.fetch(send('/api/email/verify', { token }, other), env)).status, 403);
  assert.equal(account(env, 'victim@example.com').email_verified, 0);
  // The refused attempts did not use up the link.
  assert.equal(env.DB.db.prepare("SELECT COUNT(*) AS n FROM email_tokens WHERE account_id = ?").get(account(env, 'victim@example.com').id).n, 1);
});

test('resending a confirmation is limited to three emails an hour', async () => {
  const env = await withEmail();
  const cookie = await signUp(env, 'ada@example.com');
  const resend = () => worker.fetch(send('/api/email/resend', {}, cookie), env);
  assert.equal((await resend()).status, 200);
  assert.equal((await resend()).status, 200);
  assert.equal((await resend()).status, 429);
  assert.equal(env.EMAIL.sent.length, 3);
  assert.equal((await worker.fetch(send('/api/email/resend', {}, cookie, 'https://evil.example'), env)).status, 403);
});

test('forgot-password gives the same answer for known and unknown emails and needs the bot check', async () => {
  const env = await withEmail();
  await signUp(env, 'ada@example.com');
  env.EMAIL.sent.length = 0;
  const known = await worker.fetch(post('/api/password/forgot', { email: 'ADA@example.com' }), env);
  const unknown = await worker.fetch(post('/api/password/forgot', { email: 'nobody@example.com' }), env);
  assert.equal(known.status, 200);
  assert.deepEqual(await known.json(), await unknown.json());
  assert.equal(env.EMAIL.sent.length, 1);
  assert.equal(env.EMAIL.sent[0].to, 'ada@example.com');
  assert(env.EMAIL.sent[0].text.includes('https://proofstreamapp.com/reset#'));
  assert.equal((await worker.fetch(post('/api/password/forgot', { email: 'ada@example.com' }, { token: 'fail' }), env)).status, 403);
  // Three links an hour per account; extra requests still get the same answer.
  for (let i = 0; i < 4; i++) assert.equal((await worker.fetch(post('/api/password/forgot', { email: 'ada@example.com' }), env)).status, 200);
  assert.equal(env.EMAIL.sent.length, 3);
});

test('a reset link sets a new password, verifies the email, signs out every device and works once', async () => {
  const env = await withEmail();
  const laptop = await signUp(env, 'ada@example.com');
  await worker.fetch(post('/api/password/forgot', { email: 'ada@example.com' }), env);
  const token = tokenIn(env.EMAIL.sent.at(-1));
  const NEW = 'a brand new passphrase';
  assert.equal((await worker.fetch(send('/api/password/reset', { token, password: 'short' }), env)).status, 400);
  const reset = await worker.fetch(send('/api/password/reset', { token, password: NEW }), env);
  assert.equal(reset.status, 200);
  const fresh = cookieOf(reset);
  assert.equal((await session(env, fresh)).registered, true);
  assert.equal((await session(env, laptop)).registered, false, 'old sessions end');
  assert.equal(account(env, 'ada@example.com').email_verified, 1);
  assert.equal(await signIn(env, 'ada@example.com'), undefined, 'old password no longer works');
  assert.notEqual(await signIn(env, 'ada@example.com', NEW), undefined);
  assert.equal((await worker.fetch(send('/api/password/reset', { token, password: 'another passphrase' }), env)).status, 400);
  assert.equal((await worker.fetch(send('/api/password/reset', { token: 'x'.repeat(43), password: NEW }), env)).status, 400);
  assert.equal((await worker.fetch(send('/api/password/reset', { token, password: NEW }, null, 'https://evil.example'), env)).status, 403);
});

test('the email owner resetting an unverified account removes a Google link that could not vouch for it', async () => {
  const env = await withEmail();
  env.DB.db.prepare("INSERT INTO registrations (id, email, name, created_at, email_verified) VALUES ('acct', 'ada@corp.example', 'Ada', '2026-11-01', 0)").run();
  env.DB.db.prepare("INSERT INTO identities (provider, subject, account_id, email, created_at) VALUES ('google', 'squatter', 'acct', 'ada@corp.example', '2026-11-01')").run();
  await worker.fetch(post('/api/password/forgot', { email: 'ada@corp.example' }), env);
  const reset = await worker.fetch(send('/api/password/reset', { token: tokenIn(env.EMAIL.sent[0]), password: PASSWORD }), env);
  assert.equal(reset.status, 200);
  assert.equal(env.DB.db.prepare('SELECT COUNT(*) AS n FROM identities').get().n, 0);
  // A verified account keeps its Google link.
  env.DB.db.prepare("INSERT INTO identities (provider, subject, account_id, email, created_at) VALUES ('google', 'owner', 'acct', 'ada@corp.example', '2026-11-01')").run();
  await worker.fetch(post('/api/password/forgot', { email: 'ada@corp.example' }), env);
  assert.equal((await worker.fetch(send('/api/password/reset', { token: tokenIn(env.EMAIL.sent.at(-1)), password: PASSWORD }), env)).status, 200);
  assert.equal(env.DB.db.prepare('SELECT COUNT(*) AS n FROM identities').get().n, 1);
});

test('expired links and links for an address the account no longer has do not work', async () => {
  const env = await withEmail();
  await signUp(env, 'ada@example.com');
  await worker.fetch(post('/api/password/forgot', { email: 'ada@example.com' }), env);
  const token = tokenIn(env.EMAIL.sent.at(-1));
  env.DB.db.prepare("UPDATE email_tokens SET expires_at = 0 WHERE purpose = 'reset'").run();
  assert.equal((await worker.fetch(send('/api/password/reset', { token, password: PASSWORD }), env)).status, 400);
  await worker.fetch(post('/api/password/forgot', { email: 'ada@example.com' }), env);
  const second = tokenIn(env.EMAIL.sent.at(-1));
  env.DB.db.prepare("UPDATE registrations SET email = 'new@example.com'").run();
  assert.equal((await worker.fetch(send('/api/password/reset', { token: second, password: PASSWORD }), env)).status, 400);
});

test('two requests racing with one reset link: only one succeeds', async () => {
  const env = await withEmail();
  await signUp(env, 'ada@example.com');
  await worker.fetch(post('/api/password/forgot', { email: 'ada@example.com' }), env);
  const token = tokenIn(env.EMAIL.sent.at(-1));
  const results = await Promise.all([1, 2].map(() => worker.fetch(send('/api/password/reset', { token, password: PASSWORD }), env)));
  assert.deepEqual(results.map(r => r.status).sort(), [200, 400]);
});

test('without the email binding the features report off and sign-up still works', async () => {
  const env = await envWith();
  const cookie = await signUp(env, 'ada@example.com');
  assert.notEqual(cookie, undefined);
  assert.equal((await session(env, cookie)).emailLinks, false);
  assert.equal((await worker.fetch(post('/api/password/forgot', { email: 'ada@example.com' }), env)).status, 503);
  assert.equal((await worker.fetch(send('/api/password/reset', { token: 'x'.repeat(43), password: PASSWORD }), env)).status, 503);
});

test('a failed send does not break sign-up', async () => {
  const env = await envWith({ EMAIL: { async send() { throw new Error('down'); } } });
  assert.notEqual(await signUp(env, 'ada@example.com'), undefined);
});

