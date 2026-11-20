import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import worker from '../src/worker.js';
import { canonicalJson, canonicalIsrc } from '../src/recordings.js';
import { origin, envWith, signUp } from './helpers.mjs';

const audio = c => c.repeat(64);
const recording = (extra = {}) => ({
  isrc: 'US-SKG-26-12345',
  title: 'Morphine',
  artist_display: 'PowerMoveSmoove',
  duration_ms: 187000,
  audio_hash_sha256: audio('a'),
  rights: [{ role: 'master_owner', split_bps: 10000, territory: 'WW' }],
  ...extra,
});
const post = (cookie, path, body, headers = {}) => new Request(origin + path, {
  method: 'POST',
  headers: { origin, 'content-type': 'application/json', ...(cookie ? { cookie } : {}), ...headers },
  body: JSON.stringify(body),
});
const get = (path, cookie) => new Request(origin + path, { headers: cookie ? { cookie } : {} });
const create = async (env, cookie, body = recording()) => worker.fetch(post(cookie, '/api/v1/recordings', body), env);
const sha = text => '0x' + createHash('sha256').update(text).digest('hex');

test('ISRCs are canonicalized and validated', () => {
  assert.equal(canonicalIsrc('US-SKG-26-12345'), 'USSKG2612345');
  assert.equal(canonicalIsrc('usskg2612345'), 'USSKG2612345');
  for (const bad of ['US-SKG-26-1234', 'U1SKG2612345', 'USSKG26A2345', '', null, 'US-SKG-26-12345-']) assert.equal(canonicalIsrc(bad), null);
});

test('canonical JSON sorts keys at every level and is stable', () => {
  assert.equal(canonicalJson({ b: 1, a: [{ d: null, c: 'x' }], 'é': true }), '{"a":[{"c":"x","d":null}],"b":1,"é":true}');
  assert.throws(() => canonicalJson({ a: 1.5 }));
});

test('records a recording with a server timestamp and a recomputable hash', async () => {
  const env = await envWith();
  const cookie = await signUp(env, 'ada@example.com');
  const before = new Date().toISOString();
  const response = await create(env, cookie);
  assert.equal(response.status, 201);
  const body = await response.json();
  assert.match(body.recording_id, /^rec_/);
  assert.equal(body.isrc, 'US-SKG-26-12345');
  assert.equal(body.versions.length, 1);
  assert(body.created_at >= before);
  assert.equal(body.versions[0].anchor.status, 'queued');

  const stored = env.DB.db.prepare('SELECT payload, payload_hash, claim, claim_hash FROM recording_versions').get();
  assert.equal(stored.payload_hash, sha(stored.payload));
  assert.equal(stored.claim_hash, sha(stored.claim));
  assert.equal(stored.payload, canonicalJson(JSON.parse(stored.payload)));
  assert.equal(JSON.parse(stored.payload).recorded_at, body.created_at);
});

test('public verify returns the current claim without sign-in, and the hash checks out', async () => {
  const env = await envWith();
  const cookie = await signUp(env, 'ada@example.com');
  await create(env, cookie);
  for (const path of ['/api/v1/verify?isrc=US-SKG-26-12345', '/api/v1/verify/usskg2612345']) {
    const response = await worker.fetch(get(path), env);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'public, max-age=60');
    const v = await response.json();
    assert.equal(v.found, true);
    assert.equal(v.valid, true);
    assert.equal(v.status, 'active');
    assert.equal(v.payload_hash, sha(v.payload));
    assert.equal(v.anchor.status, 'queued');
    assert(!JSON.stringify(v).includes('ada@example.com'), 'no account email in public output');
  }
  const missing = await worker.fetch(get('/api/v1/verify?isrc=USSKG2699999'), env);
  assert.equal(missing.status, 404);
  assert.equal((await missing.json()).found, false);
  assert.equal((await worker.fetch(get('/api/v1/verify?isrc=nope'), env)).status, 400);
});

test('never records the same ISRC or the same audio twice', async () => {
  const env = await envWith();
  const ada = await signUp(env, 'ada@example.com');
  const bo = await signUp(env, 'bo@example.com');
  const first = await (await create(env, ada)).json();

  // The same creator retrying gets the original back.
  const retry = await create(env, ada);
  assert.equal(retry.status, 200);
  const replay = await retry.json();
  assert.equal(replay.idempotent_replay, true);
  assert.equal(replay.recording_id, first.recording_id);

  const otherAccount = await create(env, bo);
  assert.equal(otherAccount.status, 409);
  assert.equal((await otherAccount.json()).type, 'https://proofstreamapp.com/errors/duplicate-isrc');

  const sameAudio = await create(env, bo, recording({ isrc: 'GBAYE2600001' }));
  assert.equal(sameAudio.status, 409);
  const dupe = await sameAudio.json();
  assert.equal(dupe.type, 'https://proofstreamapp.com/errors/duplicate-recording');
  assert.equal(dupe.existing_isrc, 'US-SKG-26-12345');
  assert.equal(env.DB.db.prepare('SELECT COUNT(*) AS n FROM recordings').get().n, 1);
});

test('remixes link to a parent ISRC', async () => {
  const env = await envWith();
  const cookie = await signUp(env, 'ada@example.com');
  await create(env, cookie);
  const remix = await create(env, cookie, recording({ isrc: 'USSKG2612346', audio_hash_sha256: audio('b'), version: 'remix', parent_isrc: 'US-SKG-26-12345' }));
  assert.equal(remix.status, 201);
  assert.equal((await remix.json()).parent_isrc, 'US-SKG-26-12345');
  const self = await create(env, cookie, recording({ isrc: 'USSKG2612347', audio_hash_sha256: audio('c'), parent_isrc: 'USSKG2612347' }));
  assert.equal(self.status, 422);
});

test('splits must total exactly 100% per role and territory', async () => {
  const env = await envWith();
  const cookie = await signUp(env, 'ada@example.com');
  const w = (bps, territory = 'WW') => ({ role: 'writer', split_bps: bps, territory });
  const bad = [
    [w(5000), w(4999)],
    [w(5000), w(5001)],
    [w(10000), w(10000, 'US'), w(1, 'US')],
    [{ role: 'owner', split_bps: 10000 }],
    [{ role: 'writer', split_bps: 10000, territory: 'World' }],
    [{ role: 'writer', split_bps: 10000, ipi: 'ABC' }],
    [{ role: 'writer', split_bps: 100.5 }],
    [],
    Array.from({ length: 33 }, (_, i) => w(1, 'A' + String.fromCharCode(65 + (i % 26)))),
  ];
  for (const rights of bad) {
    const response = await create(env, cookie, recording({ rights }));
    assert.equal(response.status, 422, JSON.stringify(rights).slice(0, 80));
  }
  const ok = await create(env, cookie, recording({ rights: [
    { role: 'master_owner', split_bps: 10000 },
    { role: 'writer', split_bps: 5000, ipi: '123456789' },
    { role: 'writer', split_bps: 5000, ipi: '987654321' },
  ] }));
  assert.equal(ok.status, 201);
});

test('rejects bad recordings, anonymous callers and cross-origin writes', async () => {
  const env = await envWith();
  const cookie = await signUp(env, 'ada@example.com');
  for (const body of [
    recording({ isrc: 'US-SKG-26-1234' }),
    recording({ title: '' }),
    recording({ artist_display: 'x'.repeat(201) }),
    recording({ duration_ms: 12.5 }),
    recording({ audio_hash_sha256: 'abc' }),
  ]) assert.equal((await create(env, cookie, body)).status, 422, JSON.stringify(body).slice(0, 80));
  assert.equal((await create(env, null)).status, 401);
  assert.equal((await worker.fetch(post(cookie, '/api/v1/recordings', recording(), { origin: 'https://evil.example' }), env)).status, 403);
  assert.equal((await worker.fetch(get('/api/v1/recordings'), env)).status, 401);
});

test('claim updates append versions; the original stays verifiable', async () => {
  const env = await envWith();
  const cookie = await signUp(env, 'ada@example.com');
  const { recording_id: id } = await (await create(env, cookie)).json();
  const rights = [{ role: 'master_owner', split_bps: 6000 }, { role: 'master_owner', split_bps: 4000 }];
  const update = await worker.fetch(post(cookie, `/api/v1/recordings/${id}/claims`, { rights, reason: 'split_correction' }), env);
  assert.equal(update.status, 201);
  assert.equal((await update.json()).version, 1);

  const detail = await (await worker.fetch(get(`/api/v1/recordings/${id}`, cookie), env)).json();
  assert.equal(detail.current_version, 1);
  assert.equal(detail.versions.length, 2);
  assert.notEqual(detail.versions[0].payload_hash, detail.versions[1].payload_hash);
  assert.deepEqual(detail.rights.map(r => r.split_bps), [6000, 4000]);
  const v0 = env.DB.db.prepare('SELECT payload, payload_hash FROM recording_versions WHERE version = 0').get();
  assert.equal(v0.payload_hash, sha(v0.payload));

  const verified = await (await worker.fetch(get('/api/v1/verify/USSKG2612345'), env)).json();
  assert.equal(verified.record_version, 1);
});

test('claim updates are idempotent with an Idempotency-Key and need a reason', async () => {
  const env = await envWith();
  const cookie = await signUp(env, 'ada@example.com');
  const { recording_id: id } = await (await create(env, cookie)).json();
  const body = { rights: [{ role: 'master_owner', split_bps: 10000 }], reason: 'metadata_fix' };
  const key = { 'idempotency-key': 'retry-key-1234' };
  const first = await worker.fetch(post(cookie, `/api/v1/recordings/${id}/claims`, body, key), env);
  const again = await worker.fetch(post(cookie, `/api/v1/recordings/${id}/claims`, body, key), env);
  assert.equal(first.status, 201);
  assert.equal(again.status, 200);
  assert.equal((await again.json()).idempotent_replay, true);
  assert.equal(env.DB.db.prepare('SELECT COUNT(*) AS n FROM recording_versions').get().n, 2);
  for (const reason of [undefined, '', 'initial', 'Has Spaces']) {
    assert.equal((await worker.fetch(post(cookie, `/api/v1/recordings/${id}/claims`, { ...body, reason }), env)).status, 422);
  }
});

test('claims freeze while a recording is not active, and other accounts cannot touch it', async () => {
  const env = await envWith();
  const ada = await signUp(env, 'ada@example.com');
  const bo = await signUp(env, 'bo@example.com');
  const { recording_id: id } = await (await create(env, ada)).json();
  const body = { rights: [{ role: 'master_owner', split_bps: 10000 }], reason: 'takeover' };
  assert.equal((await worker.fetch(post(bo, `/api/v1/recordings/${id}/claims`, body), env)).status, 404);
  assert.equal((await worker.fetch(get(`/api/v1/recordings/${id}`, bo), env)).status, 404);
  assert.deepEqual((await (await worker.fetch(get('/api/v1/recordings', bo), env)).json()).recordings, []);

  env.DB.db.prepare("UPDATE recordings SET status = 'disputed'").run();
  assert.equal((await worker.fetch(post(ada, `/api/v1/recordings/${id}/claims`, body), env)).status, 409);
  const verified = await (await worker.fetch(get('/api/v1/verify/USSKG2612345'), env)).json();
  assert.equal(verified.valid, false);
  assert.equal(verified.dispute_status, 'open');
});

test('deleting an account deletes its recordings', async () => {
  const env = await envWith();
  const cookie = await signUp(env, 'ada@example.com');
  await create(env, cookie);
  env.DB.db.prepare("DELETE FROM registrations WHERE email = 'ada@example.com'").run();
  assert.equal(env.DB.db.prepare('SELECT COUNT(*) AS n FROM recordings').get().n, 0);
  assert.equal(env.DB.db.prepare('SELECT COUNT(*) AS n FROM recording_versions').get().n, 0);
});
