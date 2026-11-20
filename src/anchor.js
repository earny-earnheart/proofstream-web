// Anchoring job: writes verified claim versions to the ProofStreamRegistry contract.
// Runs from the Worker's cron trigger (and on demand for admins). It is safe to rerun at any
// point: before sending anything it reads the chain, and a version whose payload hash is
// already on-chain is marked anchored without a new transaction. The chain is passed in
// (see chain.js), so tests run against a fake.
import { getAddress, keccak256, stringToHex, toBytes } from 'viem';

const BATCH = 5;
const MAX_ATTEMPTS = 5;
const STUCK_MS = 15 * 60 * 1000;     // a submitted transaction with no receipt after this is retried
const WAIT_MS = 60 * 1000;
const ACTIVE = 1;                    // ProofStreamRegistry.Status.Active

// Each account is represented on-chain by an address derived from its id. Nobody holds a key
// for it; ProofStream's issuer acts for it (custodial), and no personal data is revealed.
export const accountAddress = account => getAddress('0x' + keccak256(toBytes('proofstream:account:' + account)).slice(-40));

const code = value => stringToHex(value, { size: 32 });

// The contract's Split[] for a claim: roles and territories are codes, and each beneficiary
// is an opaque reference to its position in the claim. Identifiers such as IPI numbers stay
// out of it (they are short enough to brute-force from a hash); payloadHash commits to them.
export function splitsFor(recordingId, claim) {
  return claim.rights.map((r, index) => ({
    beneficiaryHash: keccak256(toBytes(`proofstream:beneficiary:${recordingId}:${index}`)),
    basisPoints: r.split_bps,
    rightType: code(r.role),
    territory: code(r.territory),
  }));
}

export function anchorArgs(row) {
  const claim = JSON.parse(row.claim);
  return {
    isrc: row.isrc,
    claimant: accountAddress(row.account_id),
    payloadHash: row.payload_hash,
    claimHash: row.claim_hash,
    splits: splitsFor(row.recording_id, claim),
    parentIsrc: row.parent_isrc || '',
    reason: code(row.reason),
  };
}

const message = error => String(error?.shortMessage || error?.message || error).slice(0, 300);

async function markAnchored(env, chain, row, receipt, now) {
  await env.DB.prepare("UPDATE recording_versions SET anchor_status = 'anchored', anchor_error = NULL, chain_id = ?, contract_address = ?, tx_hash = COALESCE(?, tx_hash), block_number = ?, anchored_at = ? WHERE recording_id = ? AND version = ?")
    .bind(chain.chainId, chain.address, receipt.txHash ?? null, receipt.blockNumber ?? null, now, row.recording_id, row.version).run();
}

async function markFailed(env, row, error, attempts) {
  const status = attempts >= MAX_ATTEMPTS ? 'failed' : 'queued';
  await env.DB.prepare('UPDATE recording_versions SET anchor_status = ?, anchor_error = ?, anchor_attempts = ? WHERE recording_id = ? AND version = ?')
    .bind(status, message(error), attempts, row.recording_id, row.version).run();
  return status;
}

// Settles transactions sent by an earlier run.
async function reconcile(env, chain, now) {
  const { results } = await env.DB.prepare("SELECT * FROM recording_versions WHERE anchor_status = 'submitted' ORDER BY submitted_at LIMIT ?").bind(BATCH * 2).all();
  const settled = [];
  for (const row of results) {
    const receipt = await chain.receipt(row.tx_hash);
    if (receipt?.status === 'success') {
      await markAnchored(env, chain, row, { txHash: row.tx_hash, blockNumber: receipt.blockNumber }, new Date(now).toISOString());
      settled.push({ recording_id: row.recording_id, version: row.version, result: 'anchored' });
    } else if (receipt?.status === 'reverted' || (!receipt && now - Date.parse(row.submitted_at) > STUCK_MS)) {
      const status = await markFailed(env, row, receipt ? 'transaction reverted' : 'no receipt; retrying', row.anchor_attempts + 1);
      settled.push({ recording_id: row.recording_id, version: row.version, result: status });
    }
  }
  return settled;
}

async function anchorOne(env, chain, row, now) {
  const args = anchorArgs(row);
  const iso = new Date(now).toISOString();
  const onChain = await chain.read(args.isrc);
  if (onChain.found && onChain.payloadHash.toLowerCase() === args.payloadHash.toLowerCase()) {
    await markAnchored(env, chain, row, {}, iso);
    return 'anchored';
  }
  if (onChain.found && onChain.status !== ACTIVE) throw new Error(`on-chain status is ${onChain.status}, not Active; needs an arbiter`);

  let txHash;
  if (!onChain.found) {
    txHash = await chain.register(args);
  } else {
    // The ISRC is on-chain under another claimant (an earlier claim was revoked and this
    // one verified): move it to this claimant, citing this version as the transfer evidence.
    if (getAddress(onChain.claimant) !== args.claimant) {
      const transfer = await chain.transfer({ isrc: args.isrc, newClaimant: args.claimant, transferHash: args.payloadHash });
      const receipt = await chain.wait(transfer, WAIT_MS);
      if (receipt?.status !== 'success') throw new Error('rights transfer did not confirm');
    }
    txHash = await chain.update(args);
  }
  await env.DB.prepare("UPDATE recording_versions SET anchor_status = 'submitted', tx_hash = ?, submitted_at = ?, anchor_attempts = anchor_attempts + 1 WHERE recording_id = ? AND version = ?")
    .bind(txHash, iso, row.recording_id, row.version).run();
  const receipt = await chain.wait(txHash, WAIT_MS);
  if (receipt?.status === 'success') {
    await markAnchored(env, chain, row, { txHash, blockNumber: receipt.blockNumber }, iso);
    return 'anchored';
  }
  if (receipt?.status === 'reverted') return markFailed(env, row, 'transaction reverted', row.anchor_attempts + 1);
  return 'submitted';  // no receipt yet; the next run settles it
}

export async function runAnchoring(env, chain, { now = Date.now() } = {}) {
  if (!chain) return { ok: true, skipped: 'Anchoring is not configured.' };
  const results = await reconcile(env, chain, now);
  // Only the verified version of a verified recording is ever anchored.
  const { results: queue } = await env.DB.prepare(
    "SELECT v.*, r.isrc, r.account_id, r.parent_isrc FROM recording_versions v JOIN recordings r ON r.id = v.recording_id WHERE v.anchor_status = 'queued' AND r.status = 'verified' AND r.verified_version = v.version ORDER BY v.created_at LIMIT ?",
  ).bind(BATCH).all();
  for (const row of queue) {
    let result;
    try {
      result = await anchorOne(env, chain, row, now);
    } catch (error) {
      console.error('anchor failed', row.recording_id, row.version, message(error));
      result = await markFailed(env, row, error, row.anchor_attempts + 1);
    }
    results.push({ recording_id: row.recording_id, version: row.version, result });
  }
  return { ok: true, chain_id: chain.chainId, contract_address: chain.address, results };
}
