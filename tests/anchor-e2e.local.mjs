// End-to-end check against a real ProofStreamRegistry on a local Hardhat chain (not run by
// `npm test`). Start `npx hardhat node`, deploy with scripts/deploy-registry.cjs granting
// ISSUER_ROLE to Hardhat account #1, then: REGISTRY_ADDRESS=0x... node tests/anchor-e2e.local.mjs
import assert from 'node:assert/strict';
import worker from '../src/worker.js';
import { runAnchoring } from '../src/anchor.js';
import { chainFromEnv } from '../src/chain.js';
import { origin, envWith, signUp } from './helpers.mjs';

const chainEnv = {
  ANCHOR_PRIVATE_KEY: '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d', // Hardhat test account #1
  REGISTRY_ADDRESS: process.env.REGISTRY_ADDRESS,
  CHAIN_ID: '31337',
  CHAIN_RPC_URL: 'http://127.0.0.1:8545',
};
const post = (cookie, path, body) => new Request(origin + path, { method: 'POST', headers: { origin, 'content-type': 'application/json', cookie }, body: JSON.stringify(body) });
const call = async (env, req) => (await worker.fetch(req, env)).json();

const env = await envWith({ ADMIN_EMAILS: 'boss@example.com', ...chainEnv });
const admin = await signUp(env, 'boss@example.com');
env.DB.db.prepare("UPDATE registrations SET email_verified = 1 WHERE email = 'boss@example.com'").run();
const ada = await signUp(env, 'ada@example.com');
const rec = await call(env, post(ada, '/api/v1/recordings', {
  isrc: 'US-SKG-26-12345', title: 'Morphine', artist_display: 'PowerMoveSmoove', duration_ms: 187000, audio_hash_sha256: 'a'.repeat(64),
  rights: [{ role: 'master_owner', split_bps: 10000 }, { role: 'writer', split_bps: 5000, ipi: '123456789' }, { role: 'writer', split_bps: 5000 }],
}));
await call(env, post(admin, `/api/v1/admin/recordings/${rec.recording_id}/verify`, { version: 0 }));
const chain = chainFromEnv(env);
const first = await runAnchoring(env, chain);
console.log('run 1:', JSON.stringify(first.results));
assert.equal(first.results[0].result, 'anchored');

const row = env.DB.db.prepare('SELECT * FROM recording_versions WHERE version = 0').get();
const onChain = await chain.read('USSKG2612345');
assert.equal(onChain.found, true);
assert.equal(onChain.status, 1);
assert.equal(onChain.payloadHash, row.payload_hash);
console.log('on-chain payloadHash matches D1:', onChain.payloadHash, 'tx', row.tx_hash, 'block', row.block_number);

// A corrected split, verified and anchored with updateClaim.
await call(env, post(ada, `/api/v1/recordings/${rec.recording_id}/claims`, { rights: [{ role: 'master_owner', split_bps: 6000 }, { role: 'master_owner', split_bps: 4000 }], reason: 'split_correction' }));
await call(env, post(admin, `/api/v1/admin/recordings/${rec.recording_id}/verify`, { version: 1 }));
const second = await runAnchoring(env, chain);
console.log('run 2:', JSON.stringify(second.results));
const v1 = env.DB.db.prepare('SELECT payload_hash FROM recording_versions WHERE version = 1').get();
assert.equal((await chain.read('USSKG2612345')).payloadHash, v1.payload_hash);
const third = await runAnchoring(env, chain);
assert.equal(third.results.length, 0);
console.log('E2E OK: register, updateClaim and an idempotent rerun all match the contract.');
