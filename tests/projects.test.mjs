import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/worker.js';
import { origin, envWith, signUp, signIn } from './helpers.mjs';

const hash = c => c.repeat(64);
const project = (id, extra = {}) => ({
  id, name: 'The quiet hours', category: 'Music', description: 'An EP', createdAt: '2026-11-01T10:00:00.000Z',
  milestones: [{ id: 'm-1', title: 'Final mix', stage: 'Final', creator: 'local-profile', fileName: 'mix.wav', fileSize: 24_000_000, hash: hash('a'), createdAt: '2026-11-01T11:00:00.000Z' }],
  ...extra,
});
const put = (cookie, id, body, headers = {}) => new Request(`${origin}/api/projects/${id}`, {
  method: 'PUT',
  headers: { origin, 'content-type': 'application/json', ...(cookie ? { cookie } : {}), ...headers },
  body: typeof body === 'string' ? body : JSON.stringify(body),
});
const list = async (env, cookie) => (await (await worker.fetch(new Request(origin + '/api/projects', { headers: { cookie } }), env)).json()).projects;

test('a saved project follows the account to another device', async () => {
  const env = await envWith();
  const laptop = await signUp(env, 'ada@example.com');
  const created = await worker.fetch(put(laptop, 'p-1', project('p-1')), env);
  assert.equal(created.status, 201);
  assert.equal(created.headers.get('cache-control'), 'no-store');

  // Signing in with the password elsewhere issues a new cookie for the same account.
  const phone = await signIn(env, 'ADA@example.com');
  assert.notEqual(phone, undefined);
  assert.deepEqual(await list(env, phone), [project('p-1')]);

  const updated = project('p-1', { name: 'Renamed' });
  assert.equal((await worker.fetch(put(phone, 'p-1', updated), env)).status, 200);
  assert.equal((await list(env, laptop))[0].name, 'Renamed');
});

test('accounts never see or overwrite each other\'s projects, even with the same project id', async () => {
  const env = await envWith();
  const ada = await signUp(env, 'ada@example.com');
  const bo = await signUp(env, 'bo@example.com');
  await worker.fetch(put(ada, 'shared-id', project('shared-id', { name: 'Ada private' })), env);
  assert.deepEqual(await list(env, bo), []);
  assert.equal((await worker.fetch(put(bo, 'shared-id', project('shared-id', { name: 'Bo' })), env)).status, 201);
  assert.equal((await list(env, ada))[0].name, 'Ada private');
  assert.equal((await list(env, bo))[0].name, 'Bo');
});

test('only allow-listed metadata is stored, so file contents cannot reach the database', async () => {
  const env = await envWith();
  const cookie = await signUp(env, 'ada@example.com');
  const smuggled = project('p-1', { fileData: 'UklGRiQAAABXQVZF', sample: true });
  smuggled.milestones[0].bytes = 'UklGRiQAAABXQVZF';
  const response = await worker.fetch(put(cookie, 'p-1', smuggled), env);
  assert.equal(response.status, 201);
  const stored = env.DB.db.prepare('SELECT data FROM projects').get().data;
  assert(!stored.includes('UklGRiQ'), 'file-like payload was stored');
  assert.deepEqual(JSON.parse(stored), project('p-1'));
});

test('rejects invalid records, oversized bodies, cross-origin writes and anonymous callers', async () => {
  const env = await envWith();
  const cookie = await signUp(env, 'ada@example.com');
  const bad = [
    project('other-id'),
    project('p-1', { name: '' }),
    project('p-1', { name: 'x'.repeat(81) }),
    project('p-1', { createdAt: 'yesterday' }),
    project('p-1', { milestones: [{ ...project('p-1').milestones[0], hash: 'not-a-hash' }] }),
    project('p-1', { milestones: [{ ...project('p-1').milestones[0], stage: 'Published' }] }),
    project('p-1', { milestones: [{ ...project('p-1').milestones[0], fileSize: -1 }] }),
    project('p-1', { milestones: 'none' }),
  ];
  for (const body of bad) assert.equal((await worker.fetch(put(cookie, 'p-1', body), env)).status, 400, JSON.stringify(body).slice(0, 80));
  assert.equal((await worker.fetch(put(cookie, 'p-1', '{not json'), env)).status, 400);
  assert.equal((await worker.fetch(put(cookie, 'p-1', project('p-1', { description: 'x'.repeat(600 * 1024) })), env)).status, 413);
  assert.equal((await worker.fetch(put(cookie, 'p-1', project('p-1'), { origin: 'https://evil.example' }), env)).status, 403);
  assert.equal((await worker.fetch(put(cookie, 'p-1', project('p-1'), { 'content-type': 'text/plain' }), env)).status, 415);
  assert.equal((await worker.fetch(put(null, 'p-1', project('p-1')), env)).status, 401);
  assert.equal((await worker.fetch(new Request(origin + '/api/projects'), env)).status, 401);
  assert.equal((await worker.fetch(put(cookie + 'x', 'p-1', project('p-1')), env)).status, 401);
  assert.equal((await worker.fetch(put(cookie, 'bad%20id', project('bad id')), env)).status, 404);
  assert.deepEqual(await list(env, cookie), []);
});

test('caps the number of projects per account', async () => {
  const env = await envWith();
  const cookie = await signUp(env, 'ada@example.com');
  const { id } = env.DB.db.prepare('SELECT id FROM registrations').get();
  const insert = env.DB.db.prepare("INSERT INTO projects VALUES (?, ?, '{}', '2026-11-01', '2026-11-01')");
  for (let i = 0; i < 500; i++) insert.run(id, 'p' + i);
  assert.equal((await worker.fetch(put(cookie, 'one-more', project('one-more')), env)).status, 409);
  assert.equal((await worker.fetch(put(cookie, 'p0', project('p0')), env)).status, 200, 'updates still work at the cap');
});

test('deleting a registration revokes access and deletes that creator\'s projects', async () => {
  const env = await envWith();
  const cookie = await signUp(env, 'ada@example.com');
  await worker.fetch(put(cookie, 'p-1', project('p-1')), env);
  env.DB.db.prepare("DELETE FROM registrations WHERE email = 'ada@example.com'").run();
  assert.equal(env.DB.db.prepare('SELECT COUNT(*) AS n FROM projects').get().n, 0);
  assert.equal((await worker.fetch(new Request(origin + '/api/projects', { headers: { cookie } }), env)).status, 401);
});

test('sign-out clears the cookie and is same-origin only', async () => {
  const env = await envWith();
  const out = await worker.fetch(new Request(origin + '/api/logout', { method: 'POST', headers: { origin } }), env);
  assert.equal(out.status, 200);
  assert.match(out.headers.get('set-cookie'), /^ps_session=; Max-Age=0; Path=\/; HttpOnly; Secure; SameSite=Lax$/);
  const cross = await worker.fetch(new Request(origin + '/api/logout', { method: 'POST', headers: { origin: 'https://evil.example' } }), env);
  assert.equal(cross.status, 403);
  assert.equal(cross.headers.get('set-cookie'), null);
});
