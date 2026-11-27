import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/worker.js';
import { runAnchoring, accountAddress, anchorArgs } from '../src/anchor.js';
import { origin, envWith, signUp } from './helpers.mjs';

const ADMIN = 'boss@example.com';
const recording = (extra = {}) => ({
  isrc: 'US-SKG-26-12345', title: 'Morphine', artist_display: 'PowerMoveSmoove', duration_ms: 187000,
  audio_hash_sha256: 'a'.repeat(64), rights: [{ role: 'master_owner', split_bps: 10000 }], ...extra,
});
const post = (cookie, path, body = {}) => new Request(origin + path, {
  method: 'POST', headers: { origin, 'content-type': 'application/json', cookie }, body: JSON.stringify(body),
});
const get = (path, cookie) => new Request(origin + path, { headers: cookie ? { cookie } : {} });
const call = async (env, request) => { const r = await worker.fetch(request, env); return { status: r.status, body: await r.json().catch(() => null) }; };

async function setup() {
  const env = await envWith({ ADMIN_EMAILS: ` ${ADMIN} , other@example.com` });
  const admin = await signUp(env, ADMIN);
  env.DB.db.prepare('UPDATE registrations SET email_verified = 1 WHERE email = ?').run(ADMIN);
  const ada = await signUp(env, 'ada@example.com');
  const { body } = await call(env, post(ada, '/api/v1/recordings', recording()));
  return { env, admin, ada, id: body.recording_id };
}
const requestVerification = (env, cookie, id) => call(env, post(cookie, `/api/v1/recordings/${id}/verification-request`, { evidence_hashes: ['sha256:' + 'e'.repeat(64)] }));

// A stand-in for the registry contract, with the same rules the anchoring job relies on.
function fakeChain() {
  const records = new Map();
  const txs = new Map();
  let n = 0;
  const send = effect => { const hash = '0x' + (++n).toString(16).padStart(64, '0'); txs.set(hash, effect); return hash; };
  return {
    chainId: 11155111, address: '0x' + 'c'.repeat(40), records, sent: [], receiptsWithheld: false,
    async read(isrc) { const r = records.get(isrc); return r ? { found: true, ...r } : { found: false, status: 0, payloadHash: '0x' + '0'.repeat(64), claimant: '0x' + '0'.repeat(40) }; },
    async register(a) { this.sent.push(['register', a]); return send(() => records.set(a.isrc, { status: 1, payloadHash: a.payloadHash, claimant: a.claimant })); },
    async update(a) { this.sent.push(['update', a]); return send(() => { records.get(a.isrc).payloadHash = a.payloadHash; }); },
    async transfer(a) { this.sent.push(['transfer', a]); return send(() => { records.get(a.isrc).claimant = a.newClaimant; }); },
    async wait(hash) { if (this.receiptsWithheld) return null; return this.receipt(hash); },
    async receipt(hash) {
      if (this.receiptsWithheld) return null;
      const effect = txs.get(hash);
      if (!effect) return null;
      if (effect !== true) { effect(); txs.set(hash, true); }
      return { status: 'success', blockNumber: 100 + n };
    },
  };
}

test('only verified admins can use the admin API and page', async () => {
  const { env, admin, ada } = await setup();
  assert.equal((await call(env, get('/api/v1/admin/verification-queue', ada))).status, 404);
  assert.equal((await worker.fetch(get('/admin', ada), env)).status, 404);
  assert.equal((await worker.fetch(get('/admin.js'), env)).status, 404);
  for (const path of ['/%61dmin.html', '/ADMIN.js', '/Admin', '//admin.html', '/admin%2Ejs', '/%E0%A4%A'])
    assert.equal((await worker.fetch(get(path, ada), env)).status, 404, path);
  assert.equal((await call(env, get('/api/v1/admin/verification-queue', admin))).status, 200);
  assert.equal((await worker.fetch(get('/admin', admin), env)).status, 200);
  // An admin address whose email is not verified is not an admin.
  env.DB.db.prepare('UPDATE registrations SET email_verified = 0 WHERE email = ?').run(ADMIN);
  assert.equal((await call(env, get('/api/v1/admin/verification-queue', admin))).status, 404);
  // No ADMIN_EMAILS configured means no admins.
  env.DB.db.prepare('UPDATE registrations SET email_verified = 1 WHERE email = ?').run(ADMIN);
  assert.equal((await call({ ...env, ADMIN_EMAILS: '' }, get('/api/v1/admin/verification-queue', admin))).status, 404);
});

test('a creator requests verification with evidence hashes; the admin sees it in the queue', async () => {
  const { env, admin, ada, id } = await setup();
  assert.equal((await call(env, post(ada, `/api/v1/recordings/${id}/verification-request`, { evidence_hashes: [] }))).status, 422);
  assert.equal((await call(env, post(ada, `/api/v1/recordings/${id}/verification-request`, { evidence_hashes: ['not-a-hash'] }))).status, 422);
  assert.equal((await requestVerification(env, ada, id)).status, 202);
  const { body } = await call(env, get('/api/v1/admin/verification-queue', admin));
  assert.equal(body.queue.length, 1);
  assert.equal(body.queue[0].account_email, 'ada@example.com');
  assert.deepEqual(body.queue[0].evidence_hashes, ['e'.repeat(64)]);
});

test('verifying a version queues it for anchoring; a stale version is refused', async () => {
  const { env, admin, ada, id } = await setup();
  await requestVerification(env, ada, id);
  assert.equal((await call(env, post(admin, `/api/v1/admin/recordings/${id}/verify`, { version: 3 }))).status, 409);
  const ok = await call(env, post(admin, `/api/v1/admin/recordings/${id}/verify`, { version: 0 }));
  assert.equal(ok.status, 200);
  const v = (await call(env, get('/api/v1/verify/USSKG2612345', admin))).body;
  assert.equal(v.valid, true);
  assert.equal(v.claims[0].anchor.status, 'queued');
  assert.equal((await call(env, get(`/api/v1/recordings/${id}`, ada))).body.verification.verified_version, 0);
});

test('a second claim cannot be verified while another claim on the ISRC is verified', async () => {
  const { env, admin, ada, id } = await setup();
  await call(env, post(admin, `/api/v1/admin/recordings/${id}/verify`, { version: 0 }));
  const bo = await signUp(env, 'bo@example.com');
  const rival = (await call(env, post(bo, '/api/v1/recordings', recording({ audio_hash_sha256: 'b'.repeat(64) })))).body;
  assert.equal((await call(env, post(admin, `/api/v1/admin/recordings/${rival.recording_id}/verify`, { version: 0 }))).status, 409);
  // Revoking the first claim lets the rival be verified.
  assert.equal((await call(env, post(admin, `/api/v1/admin/recordings/${id}/revoke`, { reason: 'Evidence was forged' }))).status, 200);
  assert.equal((await call(env, post(admin, `/api/v1/admin/recordings/${rival.recording_id}/verify`, { version: 0 }))).status, 200);
  assert.equal((await call(env, post(ada, `/api/v1/recordings/${id}/claims`, { rights: recording().rights, reason: 'retry' }))).status, 409, 'revoked claims are locked');
});

test('rejecting keeps the claim unverified with a note; reasons are required', async () => {
  const { env, admin, ada, id } = await setup();
  await requestVerification(env, ada, id);
  assert.equal((await call(env, post(admin, `/api/v1/admin/recordings/${id}/reject`, {}))).status, 422);
  assert.equal((await call(env, post(admin, `/api/v1/admin/recordings/${id}/reject`, { reason: 'Split sheet unsigned' }))).status, 200);
  const rec = (await call(env, get(`/api/v1/recordings/${id}`, ada))).body;
  assert.equal(rec.status, 'unverified');
  assert.equal(rec.verification.requested_at, null);
  assert.equal(rec.verification.note, 'Split sheet unsigned');
  assert.equal((await call(env, get('/api/v1/admin/verification-queue', admin))).body.queue.length, 0);
});

test('a new version after verification stops the queued anchor and needs re-verification', async () => {
  const { env, admin, ada, id } = await setup();
  await call(env, post(admin, `/api/v1/admin/recordings/${id}/verify`, { version: 0 }));
  await call(env, post(ada, `/api/v1/recordings/${id}/claims`, { rights: [{ role: 'master_owner', split_bps: 5000 }, { role: 'master_owner', split_bps: 5000 }], reason: 'split_correction' }));
  const rows = env.DB.db.prepare('SELECT version, anchor_status FROM recording_versions ORDER BY version').all();
  assert.deepEqual(rows.map(r => r.anchor_status), ['pending', 'pending']);
  const chain = fakeChain();
  await runAnchoring(env, chain);
  assert.equal(chain.sent.length, 0, 'nothing unverified is anchored');
});

test('anchoring registers a verified claim once, and records the transaction', async () => {
  const { env, admin, id } = await setup();
  const chain = fakeChain();
  assert.equal((await runAnchoring(env, null)).skipped, 'Anchoring is not configured.');
  await call(env, post(admin, `/api/v1/admin/recordings/${id}/verify`, { version: 0 }));
  const result = await runAnchoring(env, chain);
  assert.deepEqual(result.results.map(r => r.result), ['anchored']);
  const [kind, args] = chain.sent[0];
  assert.equal(kind, 'register');
  assert.equal(args.isrc, 'USSKG2612345');
  const accountId = env.DB.db.prepare("SELECT id FROM registrations WHERE email = 'ada@example.com'").get().id;
  assert.equal(args.claimant, accountAddress(accountId));
  assert.equal(args.splits[0].basisPoints, 10000);
  assert(!JSON.stringify(args.splits).includes('123456789'));
  const row = env.DB.db.prepare('SELECT * FROM recording_versions').get();
  assert.equal(row.anchor_status, 'anchored');
  assert.equal(args.payloadHash, row.payload_hash);
  assert.match(row.tx_hash, /^0x[0-9a-f]{64}$/);
  assert.equal(row.chain_id, 11155111);
  const v = (await call(env, get('/api/v1/verify/USSKG2612345', admin))).body;
  assert.equal(v.claims[0].anchor.status, 'anchored');
  assert.equal(v.claims[0].anchor.tx_hash, row.tx_hash);

  // Running again sends nothing.
  await runAnchoring(env, chain);
  assert.equal(chain.sent.length, 1);
});

test('a later verified version is anchored with updateClaim', async () => {
  const { env, admin, ada, id } = await setup();
  const chain = fakeChain();
  await call(env, post(admin, `/api/v1/admin/recordings/${id}/verify`, { version: 0 }));
  await runAnchoring(env, chain);
  await call(env, post(ada, `/api/v1/recordings/${id}/claims`, { rights: [{ role: 'master_owner', split_bps: 5000 }, { role: 'master_owner', split_bps: 5000 }], reason: 'split_correction' }));
  await call(env, post(admin, `/api/v1/admin/recordings/${id}/verify`, { version: 1 }));
  await runAnchoring(env, chain);
  assert.deepEqual(chain.sent.map(s => s[0]), ['register', 'update']);
  assert.equal(chain.records.get('USSKG2612345').payloadHash, env.DB.db.prepare('SELECT payload_hash FROM recording_versions WHERE version = 1').get().payload_hash);
});

test('when a revoked claim is replaced, the ISRC moves to the new claimant on-chain', async () => {
  const { env, admin, id } = await setup();
  const chain = fakeChain();
  await call(env, post(admin, `/api/v1/admin/recordings/${id}/verify`, { version: 0 }));
  await runAnchoring(env, chain);
  await call(env, post(admin, `/api/v1/admin/recordings/${id}/revoke`, { reason: 'Wrong owner' }));
  const bo = await signUp(env, 'bo@example.com');
  const rival = (await call(env, post(bo, '/api/v1/recordings', recording({ audio_hash_sha256: 'b'.repeat(64) })))).body;
  await call(env, post(admin, `/api/v1/admin/recordings/${rival.recording_id}/verify`, { version: 0 }));
  await runAnchoring(env, chain);
  assert.deepEqual(chain.sent.map(s => s[0]), ['register', 'transfer', 'update']);
  const boId = env.DB.db.prepare("SELECT id FROM registrations WHERE email = 'bo@example.com'").get().id;
  assert.equal(chain.records.get('USSKG2612345').claimant, accountAddress(boId));
});

test('a transaction without a receipt is settled by a later run, never resent', async () => {
  const { env, admin, id } = await setup();
  const chain = fakeChain();
  await call(env, post(admin, `/api/v1/admin/recordings/${id}/verify`, { version: 0 }));
  chain.receiptsWithheld = true;
  assert.deepEqual((await runAnchoring(env, chain)).results.map(r => r.result), ['submitted']);
  assert.equal((await runAnchoring(env, chain)).results.length, 0, 'still waiting, nothing resent');
  chain.receiptsWithheld = false;
  assert.deepEqual((await runAnchoring(env, chain)).results.map(r => r.result), ['anchored']);
  assert.equal(chain.sent.length, 1);
});

test('if the hash is already on-chain (a lost database write), it is marked anchored without a new transaction', async () => {
  const { env, admin, id } = await setup();
  const chain = fakeChain();
  await call(env, post(admin, `/api/v1/admin/recordings/${id}/verify`, { version: 0 }));
  const row = env.DB.db.prepare('SELECT v.*, r.isrc, r.account_id, r.parent_isrc FROM recording_versions v JOIN recordings r ON r.id = v.recording_id').get();
  const args = anchorArgs(row);
  chain.records.set('USSKG2612345', { status: 1, payloadHash: args.payloadHash, claimant: args.claimant });
  await runAnchoring(env, chain);
  assert.equal(chain.sent.length, 0);
  assert.equal(env.DB.db.prepare('SELECT anchor_status FROM recording_versions').get().anchor_status, 'anchored');
});

test('errors are retried, then marked failed after five attempts', async () => {
  const { env, admin, id } = await setup();
  const chain = fakeChain();
  chain.register = async () => { throw new Error('insufficient funds for gas'); };
  await call(env, post(admin, `/api/v1/admin/recordings/${id}/verify`, { version: 0 }));
  for (let i = 0; i < 4; i++) assert.deepEqual((await runAnchoring(env, chain)).results.map(r => r.result), ['queued']);
  assert.deepEqual((await runAnchoring(env, chain)).results.map(r => r.result), ['failed']);
  const row = env.DB.db.prepare('SELECT anchor_status, anchor_error, anchor_attempts FROM recording_versions').get();
  assert.equal(row.anchor_attempts, 5);
  assert.match(row.anchor_error, /insufficient funds/);
  assert.equal((await runAnchoring(env, chain)).results.length, 0);
});

test('the admin can run anchoring on demand; it reports when not configured', async () => {
  const { env, admin } = await setup();
  const { status, body } = await call(env, post(admin, '/api/v1/admin/anchor-now'));
  assert.equal(status, 200);
  assert.equal(body.skipped, 'Anchoring is not configured.');
});
