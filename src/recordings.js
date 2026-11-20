// Recordings API (v1): ISRC-keyed rights claims with an append-only version history.
// Each version is hashed from RFC 8785 canonical JSON, stored with the exact text that was
// hashed, and anchored in the ProofStreamRegistry contract once an admin verifies it. Times are the
// server's, never the browser's. ISRCs are brought by the creator: ProofStream does not
// issue them (SoundExchange / IFPI-authorized channels do).

// The chain code (viem) loads only when anchoring runs, not on every request.
export async function runAnchor(env) {
  const [{ runAnchoring }, { chainFromEnv }] = await Promise.all([import('./anchor.js'), import('./chain.js')]);
  return runAnchoring(env, chainFromEnv(env));
}
const MAX_RECORDINGS = 10000;
const MAX_VERSIONS = 1000;
const MAX_RIGHTS = 32;          // matches ProofStreamRegistry.MAX_SPLITS
const FULL_SHARE = 10000;
// Stored statuses: unverified (default), verified (an issuer confirmed this claim's current
// version; only verified claims are anchored), disputed, revoked. "Contested" is never stored:
// it is worked out when read, from the other live claims on the same ISRC or audio, so it
// clears itself when a competing claim goes away.
const EDITABLE = new Set(['unverified', 'verified']);
const ROLES = new Set(['master_owner', 'publisher', 'writer', 'producer', 'featured_artist']);
const REASONS = /^[a-z][a-z0-9_]{0,30}$/;  // fits the contract's bytes32 reason code
const ISRC = /^[A-Z]{2}[A-Z0-9]{3}[0-9]{7}$/;
const TERRITORY = /^(WW|[A-Z]{2})$/;
const IPI = /^[0-9]{9,11}$/;
const HASH = /^[a-f0-9]{64}$/;
const RECORDING_PATH = /^\/api\/v1\/recordings\/(rec_[a-f0-9-]{36})(\/claims|\/verification-request)?$/;
const ADMIN_PATH = /^\/api\/v1\/admin\/recordings\/(rec_[a-f0-9-]{36})\/(verify|reject|revoke)$/;
const MAX_EVIDENCE = 10;
const VERIFY_PATH = /^\/api\/v1\/verify\/([A-Za-z0-9-]{12,15})$/;
const ERRORS = 'https://proofstreamapp.com/errors/';

const problem = (json, status, slug, title, detail, extra = {}) =>
  json({ type: ERRORS + slug, title, status, detail, error: detail, ...extra }, status);

// "US-SKG-26-12345" or "usskg2612345" -> "USSKG2612345", or null if it is not an ISRC.
export function canonicalIsrc(value) {
  if (typeof value !== 'string' || value.length > 15) return null;
  const isrc = value.replace(/-/g, '').toUpperCase();
  return ISRC.test(isrc) ? isrc : null;
}

export const displayIsrc = isrc => `${isrc.slice(0, 2)}-${isrc.slice(2, 5)}-${isrc.slice(5, 7)}-${isrc.slice(7)}`;

// RFC 8785 for the values this API produces: strings, safe integers, booleans, null, arrays
// and objects. Keys sort by UTF-16 code units, which is JavaScript's default sort.
export function canonicalJson(value) {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) throw new Error('only safe integers are canonicalized');
    return String(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`;
}

export async function sha256Hex(text) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return '0x' + [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('');
}

function text(value, max) {
  return typeof value === 'string' && value.trim() && value.trim().length <= max ? value.trim() : null;
}

// Returns the cleaned rights list, or a string describing what is wrong. Each
// role + territory group must total exactly 10,000 basis points (100%).
function cleanRights(rights) {
  if (!Array.isArray(rights) || rights.length === 0) return 'Add at least one rights holder.';
  if (rights.length > MAX_RIGHTS) return `Use at most ${MAX_RIGHTS} rights entries.`;
  const totals = new Map();
  const clean = [];
  for (const r of rights) {
    if (!r || typeof r !== 'object') return 'Each rights entry must be an object.';
    if (!ROLES.has(r.role)) return `role must be one of ${[...ROLES].join(', ')}.`;
    const territory = r.territory ?? 'WW';
    if (typeof territory !== 'string' || !TERRITORY.test(territory)) return 'territory must be WW or a two-letter country code.';
    if (!Number.isInteger(r.split_bps) || r.split_bps < 1 || r.split_bps > FULL_SHARE) return 'split_bps must be a whole number from 1 to 10000.';
    if (r.ipi !== undefined && r.ipi !== null && (typeof r.ipi !== 'string' || !IPI.test(r.ipi))) return 'ipi must be 9 to 11 digits.';
    const key = `${r.role}/${territory}`;
    totals.set(key, (totals.get(key) || 0) + r.split_bps);
    clean.push({ role: r.role, ipi: r.ipi ?? null, split_bps: r.split_bps, territory });
  }
  for (const [key, total] of totals) {
    if (total !== FULL_SHARE) return `Shares for ${key} add up to ${total} basis points; they must total 10000.`;
  }
  return clean;
}

async function readJson(request) {
  if (!(request.headers.get('content-type') || '').includes('application/json')) return null;
  try { const body = await request.json(); return body && typeof body === 'object' && !Array.isArray(body) ? body : null; } catch { return null; }
}

// Builds a version: the canonical payload and claim, and their hashes.
async function versionRecord(rec, rights, reason, version, now) {
  const claim = { reason, rights };
  const claimText = canonicalJson(claim);
  const payload = {
    isrc: displayIsrc(rec.isrc),
    title: rec.title,
    version: rec.version_title,
    artist: rec.artist,
    duration_ms: rec.duration_ms,
    audio_hash_sha256: rec.audio_hash,
    parent_isrc: rec.parent_isrc ? displayIsrc(rec.parent_isrc) : null,
    rights,
    reason,
    record_version: version,
    recorded_at: now,
  };
  const payloadText = canonicalJson(payload);
  return { payload: payloadText, payload_hash: await sha256Hex(payloadText), claim: claimText, claim_hash: await sha256Hex(claimText) };
}

function versionView(v) {
  return {
    version: v.version,
    reason: v.reason,
    payload_hash: v.payload_hash,
    claim_hash: v.claim_hash,
    recorded_at: v.created_at,
    anchor: {
      status: v.anchor_status,
      chain_id: v.chain_id,
      contract_address: v.contract_address,
      tx_hash: v.tx_hash,
      block_number: v.block_number,
      anchored_at: v.anchored_at,
    },
  };
}

function recordingView(r, versions) {
  const current = versions.find(v => v.version === r.current_version);
  return {
    recording_id: r.id,
    isrc: displayIsrc(r.isrc),
    title: r.title,
    version: r.version_title,
    artist_display: r.artist,
    duration_ms: r.duration_ms,
    audio_hash_sha256: r.audio_hash,
    parent_isrc: r.parent_isrc ? displayIsrc(r.parent_isrc) : null,
    status: r.status,
    rights: current ? JSON.parse(current.claim).rights : [],
    current_version: r.current_version,
    verification: {
      requested_at: r.verification_requested_at ?? null,
      evidence_count: r.verification_evidence ? JSON.parse(r.verification_evidence).length : 0,
      verified_version: r.status === 'verified' ? r.verified_version : null,
      verified_at: r.status === 'verified' ? r.verified_at : null,
      note: r.status_reason ?? null,
    },
    versions: versions.map(versionView),
    created_at: r.created_at,
    updated_at: r.updated_at,
  };
}

// Another account has a live claim on the same ISRC or the same audio. Nothing about those
// claims is returned to the caller; the public verify output lists claims by ISRC only.
async function isContested(env, rec) {
  const row = await env.DB.prepare("SELECT 1 FROM recordings WHERE account_id != ? AND (isrc = ? OR audio_hash = ?) AND status != 'revoked' LIMIT 1")
    .bind(rec.account_id, rec.isrc, rec.audio_hash).first();
  return Boolean(row);
}

const versionsOf = async (env, id) =>
  (await env.DB.prepare('SELECT * FROM recording_versions WHERE recording_id = ? ORDER BY version').bind(id).all()).results;

async function createRecording(request, env, account, json) {
  const body = await readJson(request);
  if (!body) return problem(json, 400, 'invalid-request', 'Invalid request', 'Send the recording as a JSON object.');
  const isrc = canonicalIsrc(body.isrc);
  if (!isrc) return problem(json, 422, 'invalid-isrc', 'Invalid ISRC', 'Enter a 12-character ISRC such as US-SKG-26-12345. ProofStream records ISRCs; it does not issue them.');
  const title = text(body.title, 200);
  const artist = text(body.artist_display, 200);
  const versionTitle = body.version === undefined ? 'original' : text(body.version, 100);
  if (!title || !artist || !versionTitle) return problem(json, 422, 'invalid-request', 'Missing details', 'title and artist_display are required (up to 200 characters).');
  if (!Number.isSafeInteger(body.duration_ms) || body.duration_ms < 1000 || body.duration_ms > 24 * 3600 * 1000) {
    return problem(json, 422, 'invalid-request', 'Invalid duration', 'duration_ms must be a whole number of milliseconds (at least 1000).');
  }
  const audioHash = typeof body.audio_hash_sha256 === 'string' ? body.audio_hash_sha256.toLowerCase().replace(/^0x/, '') : '';
  if (!HASH.test(audioHash)) return problem(json, 422, 'invalid-request', 'Invalid audio fingerprint', 'audio_hash_sha256 must be the 64-character SHA-256 of the audio file.');
  let parentIsrc = null;
  if (body.parent_isrc !== undefined && body.parent_isrc !== null) {
    parentIsrc = canonicalIsrc(body.parent_isrc);
    if (!parentIsrc || parentIsrc === isrc) return problem(json, 422, 'invalid-isrc', 'Invalid parent ISRC', 'parent_isrc must be a different, valid ISRC.');
  }
  const rights = cleanRights(body.rights);
  if (typeof rights === 'string') return problem(json, 422, 'invalid-splits', 'Invalid rights', rights);

  // A claim is not ownership, so nobody gets an exclusive hold on an ISRC or an audio file
  // by claiming it first. Within one account an ISRC and an audio file are claimed once.
  const own = await env.DB.prepare('SELECT * FROM recordings WHERE account_id = ? AND isrc = ?').bind(account, isrc).first();
  if (own) {
    // The same creator retrying the same recording gets the original back, not a duplicate.
    if (own.audio_hash === audioHash) return json({ ...recordingView(own, await versionsOf(env, own.id)), contested: await isContested(env, own), idempotent_replay: true }, 200);
    return problem(json, 409, 'duplicate-isrc', 'ISRC already in your account', `You already recorded ${displayIsrc(isrc)} with different audio. Add a claim version to change it.`, { existing_isrc: displayIsrc(isrc) });
  }
  const ownAudio = await env.DB.prepare('SELECT isrc FROM recordings WHERE account_id = ? AND audio_hash = ?').bind(account, audioHash).first();
  if (ownAudio) {
    return problem(json, 409, 'duplicate-recording', 'Duplicate recording', `This audio is already in your account as ${displayIsrc(ownAudio.isrc)}. A re-release keeps its ISRC; a remix or edit has different audio.`, { existing_isrc: displayIsrc(ownAudio.isrc) });
  }
  const { n } = await env.DB.prepare('SELECT COUNT(*) AS n FROM recordings WHERE account_id = ?').bind(account).first();
  if (n >= MAX_RECORDINGS) return problem(json, 409, 'limit', 'Limit reached', 'You have reached the recording limit.');

  const status = 'unverified';

  const now = new Date().toISOString();
  const rec = {
    id: 'rec_' + crypto.randomUUID(), account_id: account, isrc, title, version_title: versionTitle, artist,
    duration_ms: body.duration_ms, audio_hash: audioHash, parent_isrc: parentIsrc, status,
    current_version: 0, created_at: now, updated_at: now,
  };
  const v = await versionRecord(rec, rights, 'initial', 0, now);
  try {
    await env.DB.batch([
      env.DB.prepare('INSERT INTO recordings (id, account_id, isrc, title, version_title, artist, duration_ms, audio_hash, parent_isrc, status, current_version, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .bind(rec.id, account, isrc, title, versionTitle, artist, rec.duration_ms, audioHash, parentIsrc, status, 0, now, now),
      env.DB.prepare('INSERT INTO recording_versions (recording_id, version, payload, payload_hash, claim, claim_hash, reason, created_at) VALUES (?, 0, ?, ?, ?, ?, ?, ?)')
        .bind(rec.id, v.payload, v.payload_hash, v.claim, v.claim_hash, 'initial', now),
    ]);
  } catch {
    // A concurrent request from this account recorded this ISRC first.
    return problem(json, 409, 'duplicate-isrc', 'ISRC already in your account', `You already recorded ${displayIsrc(isrc)}.`, { existing_isrc: displayIsrc(isrc) });
  }
  return json({ ...recordingView(rec, await versionsOf(env, rec.id)), contested: await isContested(env, rec), idempotent_replay: false }, 201);
}

async function addClaim(request, env, account, id, json) {
  const rec = await env.DB.prepare('SELECT * FROM recordings WHERE id = ? AND account_id = ?').bind(id, account).first();
  if (!rec) return problem(json, 404, 'not-found', 'Not found', 'No such recording in your account.');
  const key = request.headers.get('idempotency-key');
  if (key !== null && (key.length < 8 || key.length > 100)) return problem(json, 400, 'invalid-request', 'Invalid Idempotency-Key', 'Idempotency-Key must be 8 to 100 characters.');
  if (key) {
    const replay = await env.DB.prepare('SELECT * FROM recording_versions WHERE recording_id = ? AND idempotency_key = ?').bind(id, key).first();
    if (replay) return json({ ...versionView(replay), idempotent_replay: true }, 200);
  }
  if (!EDITABLE.has(rec.status)) return problem(json, 409, 'not-editable', 'Claim locked', `Claims cannot change while the recording is ${rec.status}.`);
  const body = await readJson(request);
  if (!body) return problem(json, 400, 'invalid-request', 'Invalid request', 'Send the claim as a JSON object.');
  if (typeof body.reason !== 'string' || !REASONS.test(body.reason) || body.reason === 'initial') {
    return problem(json, 422, 'invalid-request', 'Reason required', 'reason must be a short code such as split_correction or metadata_fix.');
  }
  const rights = cleanRights(body.rights);
  if (typeof rights === 'string') return problem(json, 422, 'invalid-splits', 'Invalid rights', rights);
  const version = rec.current_version + 1;
  if (version >= MAX_VERSIONS) return problem(json, 409, 'limit', 'Limit reached', 'This recording has reached the version limit.');

  const now = new Date().toISOString();
  const v = await versionRecord(rec, rights, body.reason, version, now);
  // The UPDATE only succeeds if nobody else added a version first, so versions never collide.
  const [, updated] = await env.DB.batch([
    env.DB.prepare("INSERT INTO recording_versions (recording_id, version, payload, payload_hash, claim, claim_hash, reason, idempotency_key, created_at) SELECT ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM recordings WHERE id = ? AND current_version = ? AND status IN ('unverified', 'verified'))")
      .bind(id, version, v.payload, v.payload_hash, v.claim, v.claim_hash, body.reason, key, now, id, rec.current_version),
    // Verification covers one version: a new version goes back to unverified until re-checked,
    // any pending request is cleared, and an earlier version waiting to be anchored stops.
    env.DB.prepare("UPDATE recordings SET current_version = ?, updated_at = ?, status = 'unverified', verification_requested_at = NULL WHERE id = ? AND current_version = ? AND status IN ('unverified', 'verified') RETURNING id")
      .bind(version, now, id, rec.current_version),
    env.DB.prepare("UPDATE recording_versions SET anchor_status = 'pending' WHERE recording_id = ? AND anchor_status = 'queued' AND EXISTS (SELECT 1 FROM recordings WHERE id = ? AND current_version = ?)")
      .bind(id, id, version),
  ]);
  if (!updated.results.length) return problem(json, 409, 'conflict', 'Conflict', 'The recording changed while you were saving. Reload and try again.');
  const saved = await env.DB.prepare('SELECT * FROM recording_versions WHERE recording_id = ? AND version = ?').bind(id, version).first();
  return json({ ...versionView(saved), idempotent_replay: false }, 201);
}

// Public: anyone can see every claim on an ISRC and recompute each claim's hash. Exactly one
// verified claim makes the ISRC valid; unverified claims cannot override it (anyone can file
// one), but they are listed and counted. Two or more verified claims, or only unverified
// claims from different accounts, are contested.
async function verify(env, rawIsrc, json) {
  const isrc = canonicalIsrc(rawIsrc);
  if (!isrc) return problem(json, 400, 'invalid-isrc', 'Invalid ISRC', 'Pass a 12-character ISRC such as US-SKG-26-12345.');
  const cache = { 'cache-control': 'public, max-age=60' };
  const { results } = await env.DB.prepare(
    'SELECT r.*, v.payload, v.payload_hash, v.claim_hash, v.created_at AS recorded_at, v.anchor_status, v.chain_id, v.contract_address, v.tx_hash, v.block_number, v.anchored_at FROM recordings r JOIN recording_versions v ON v.recording_id = r.id AND v.version = r.current_version WHERE r.isrc = ? ORDER BY r.created_at',
  ).bind(isrc).all();
  if (!results.length) return json({ found: false, valid: false, isrc: displayIsrc(isrc), claims: [] }, 404, cache);
  const live = results.filter(r => r.status !== 'revoked');
  const verified = live.filter(r => r.status === 'verified');
  const status = live.length === 0 ? 'revoked'
    : live.some(r => r.status === 'disputed') ? 'disputed'
    : verified.length === 1 ? 'verified'
    : live.length > 1 ? 'contested'
    : 'unverified';
  return json({
    found: true,
    valid: status === 'verified',
    isrc: displayIsrc(isrc),
    status,
    claim_count: results.length,
    unverified_competing_claims: status === 'verified' ? live.length - 1 : undefined,
    note: status === 'verified' ? (live.length > 1 ? 'One claim is verified by ProofStream; other unverified claims are listed below.' : 'One claim, verified by ProofStream.')
      : status === 'contested' ? 'More than one account claims this ISRC. No single claim is verified.'
      : 'Claims are recorded as submitted and are not proof of ownership until verified.',
    hash_check: 'For each claim, payload_hash = sha256(payload). Verified claims are anchored on-chain; compare payload_hash with the anchor.',
    claims: results.map(r => ({
      claim_ref: r.id,
      status: r.status,
      title: r.title,
      version: r.version_title,
      artist_display: r.artist,
      record_version: r.current_version,
      registered_at: r.created_at,
      updated_at: r.updated_at,
      payload: r.payload,
      payload_hash: r.payload_hash,
      claim_hash: r.claim_hash,
      anchor: versionView({ ...r, created_at: r.recorded_at }).anchor,
    })),
  }, 200, cache);
}

// ---- Verification ----

// Admins are the addresses in the ADMIN_EMAILS secret, and only once the email is verified.
export async function isAdmin(env, account) {
  const allowed = new Set(String(env.ADMIN_EMAILS || '').split(',').map(e => e.trim().toLowerCase()).filter(Boolean));
  if (!allowed.size || !account) return false;
  const row = await env.DB.prepare('SELECT email, email_verified FROM registrations WHERE id = ?').bind(account).first();
  return Boolean(row && row.email_verified === 1 && allowed.has(row.email));
}

// The creator asks ProofStream to verify the current version, with SHA-256 hashes of the
// evidence (split sheet, distributor statement, registrant letter). Documents themselves
// are shared out of band; only their hashes are recorded here.
async function requestVerification(request, env, account, id, json) {
  const rec = await env.DB.prepare('SELECT * FROM recordings WHERE id = ? AND account_id = ?').bind(id, account).first();
  if (!rec) return problem(json, 404, 'not-found', 'Not found', 'No such recording in your account.');
  if (rec.status !== 'unverified') return problem(json, 409, 'not-unverified', 'Cannot request verification', `This recording is ${rec.status}.`);
  const body = await readJson(request);
  const evidence = Array.isArray(body?.evidence_hashes) ? body.evidence_hashes.map(h => typeof h === 'string' ? h.toLowerCase().replace(/^(sha256:|0x)/, '') : '') : null;
  if (!evidence || evidence.length < 1 || evidence.length > MAX_EVIDENCE || !evidence.every(h => HASH.test(h))) {
    return problem(json, 422, 'invalid-evidence', 'Evidence required', `evidence_hashes must list 1 to ${MAX_EVIDENCE} SHA-256 hashes of your evidence documents.`);
  }
  const now = new Date().toISOString();
  await env.DB.prepare("UPDATE recordings SET verification_requested_at = ?, verification_evidence = ?, status_reason = NULL, updated_at = ? WHERE id = ? AND status = 'unverified'")
    .bind(now, JSON.stringify([...new Set(evidence)]), now, id).run();
  return json({ ok: true, requested_at: now, version: rec.current_version }, 202);
}

async function verificationQueue(env, json) {
  const { results } = await env.DB.prepare(
    "SELECT r.*, g.email, (SELECT COUNT(*) FROM recordings o WHERE o.id != r.id AND (o.isrc = r.isrc OR o.audio_hash = r.audio_hash) AND o.status != 'revoked') AS competing FROM recordings r JOIN registrations g ON g.id = r.account_id WHERE r.status = 'unverified' AND r.verification_requested_at IS NOT NULL ORDER BY r.verification_requested_at",
  ).bind().all();
  return json({ queue: await Promise.all(results.map(async r => ({
    ...recordingView(r, await versionsOf(env, r.id)),
    account_email: r.email,
    evidence_hashes: JSON.parse(r.verification_evidence || '[]'),
    competing_claims: r.competing,
  }))) });
}

// verify: confirms one version; it fails if that version is no longer current or if another
// claim on the ISRC is already verified (revoke that one first). The version is queued for
// anchoring. reject: declines the request, the claim stays unverified. revoke: final.
async function decide(request, env, admin, id, action, json) {
  const body = (await readJson(request)) || {};
  const rec = await env.DB.prepare('SELECT * FROM recordings WHERE id = ?').bind(id).first();
  if (!rec) return problem(json, 404, 'not-found', 'Not found', 'No such recording.');
  const now = new Date().toISOString();
  if (action === 'verify') {
    if (body.version !== rec.current_version) return problem(json, 409, 'stale-version', 'Version changed', `The current version is ${rec.current_version}. Review it, then verify that version.`);
    if (rec.status !== 'unverified') return problem(json, 409, 'not-unverified', 'Cannot verify', `This recording is ${rec.status}.`);
    const other = await env.DB.prepare("SELECT 1 FROM recordings WHERE isrc = ? AND id != ? AND status = 'verified'").bind(rec.isrc, id).first();
    if (other) return problem(json, 409, 'already-verified', 'Another claim is verified', 'Another claim on this ISRC is verified. Revoke it first.');
    const [updated] = await env.DB.batch([
      env.DB.prepare("UPDATE recordings SET status = 'verified', verified_version = ?, verified_at = ?, verified_by = ?, verification_requested_at = NULL, status_reason = NULL, updated_at = ? WHERE id = ? AND status = 'unverified' AND current_version = ? AND NOT EXISTS (SELECT 1 FROM recordings o WHERE o.isrc = ? AND o.id != ? AND o.status = 'verified') RETURNING id")
        .bind(rec.current_version, now, admin, now, id, rec.current_version, rec.isrc, id),
      env.DB.prepare("UPDATE recording_versions SET anchor_status = 'queued', anchor_error = NULL WHERE recording_id = ? AND version = ? AND anchor_status IN ('pending', 'failed') AND EXISTS (SELECT 1 FROM recordings WHERE id = ? AND status = 'verified' AND verified_version = ?)")
        .bind(id, rec.current_version, id, rec.current_version),
    ]);
    if (!updated.results.length) return problem(json, 409, 'conflict', 'Conflict', 'The recording changed. Reload and try again.');
    return json({ ok: true, status: 'verified', version: rec.current_version });
  }
  const reason = text(body.reason, 300);
  if (!reason) return problem(json, 422, 'invalid-request', 'Reason required', 'Give a reason (up to 300 characters); the creator sees it.');
  if (action === 'reject') {
    if (rec.status !== 'unverified') return problem(json, 409, 'not-unverified', 'Nothing to reject', `This recording is ${rec.status}.`);
    await env.DB.prepare("UPDATE recordings SET verification_requested_at = NULL, status_reason = ?, updated_at = ? WHERE id = ?").bind(reason, now, id).run();
    return json({ ok: true, status: 'unverified' });
  }
  if (rec.status === 'revoked') return problem(json, 409, 'already-revoked', 'Already revoked', 'This claim is already revoked.');
  await env.DB.batch([
    env.DB.prepare("UPDATE recordings SET status = 'revoked', status_reason = ?, verification_requested_at = NULL, updated_at = ? WHERE id = ?").bind(reason, now, id),
    env.DB.prepare("UPDATE recording_versions SET anchor_status = 'pending' WHERE recording_id = ? AND anchor_status = 'queued'").bind(id),
  ]);
  return json({ ok: true, status: 'revoked' });
}

export async function recordingsApi(request, env, url, { account, json, canonicalOrigin }) {
  const { pathname } = url;
  const method = request.method;
  if (pathname === '/api/v1/verify' && (method === 'GET' || method === 'HEAD')) return verify(env, url.searchParams.get('isrc'), json);
  const verifyMatch = pathname.match(VERIFY_PATH);
  if (verifyMatch && (method === 'GET' || method === 'HEAD')) return verify(env, verifyMatch[1], json);

  const id = await account();
  if (!id) return problem(json, 401, 'unauthorized', 'Sign in required', 'Sign in to use the recordings API.');
  if (method === 'POST' && request.headers.get('origin') !== canonicalOrigin) {
    return problem(json, 403, 'forbidden', 'Cross-origin request', 'Cross-origin writes are not allowed.');
  }
  if (pathname === '/api/v1/recordings') {
    if (method === 'POST') return createRecording(request, env, id, json);
    if (method === 'GET' || method === 'HEAD') {
      const { results } = await env.DB.prepare('SELECT * FROM recordings WHERE account_id = ? ORDER BY created_at DESC').bind(id).all();
      return json({ recordings: results.map(r => ({ recording_id: r.id, isrc: displayIsrc(r.isrc), title: r.title, version: r.version_title, artist_display: r.artist, status: r.status, current_version: r.current_version, created_at: r.created_at })) });
    }
  }
  const match = pathname.match(RECORDING_PATH);
  if (match && !match[2] && (method === 'GET' || method === 'HEAD')) {
    const rec = await env.DB.prepare('SELECT * FROM recordings WHERE id = ? AND account_id = ?').bind(match[1], id).first();
    if (!rec) return problem(json, 404, 'not-found', 'Not found', 'No such recording in your account.');
    return json({ ...recordingView(rec, await versionsOf(env, rec.id)), contested: await isContested(env, rec) });
  }
  if (match && match[2] === '/claims' && method === 'POST') return addClaim(request, env, id, match[1], json);
  if (match && match[2] === '/verification-request' && method === 'POST') return requestVerification(request, env, id, match[1], json);

  if (pathname.startsWith('/api/v1/admin/')) {
    const admin = await isAdmin(env, id);
    if (!admin) return problem(json, 404, 'not-found', 'Not found', 'No such endpoint.');
    if (pathname === '/api/v1/admin/verification-queue' && (method === 'GET' || method === 'HEAD')) return verificationQueue(env, json);
    if (pathname === '/api/v1/admin/anchor-now' && method === 'POST') return json(await runAnchor(env), 200);
    const adminMatch = pathname.match(ADMIN_PATH);
    if (adminMatch && method === 'POST') return decide(request, env, id, adminMatch[1], adminMatch[2], json);
  }
  return problem(json, 404, 'not-found', 'Not found', 'No such endpoint.');
}
