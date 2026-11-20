// Recordings API (v1): ISRC-keyed rights claims with an append-only version history.
// Each version is hashed from RFC 8785 canonical JSON, stored with the exact text that was
// hashed, and queued for anchoring in the ProofStreamRegistry contract. Timestamps are the
// server's, never the browser's. ISRCs are brought by the creator: ProofStream does not
// issue them (SoundExchange / IFPI-authorized channels do).

const MAX_RECORDINGS = 10000;
const MAX_VERSIONS = 1000;
const MAX_RIGHTS = 32;          // matches ProofStreamRegistry.MAX_SPLITS
const FULL_SHARE = 10000;
const ROLES = new Set(['master_owner', 'publisher', 'writer', 'producer', 'featured_artist']);
const REASONS = /^[a-z][a-z0-9_]{0,30}$/;  // fits the contract's bytes32 reason code
const ISRC = /^[A-Z]{2}[A-Z0-9]{3}[0-9]{7}$/;
const TERRITORY = /^(WW|[A-Z]{2})$/;
const IPI = /^[0-9]{9,11}$/;
const HASH = /^[a-f0-9]{64}$/;
const RECORDING_PATH = /^\/api\/v1\/recordings\/(rec_[a-f0-9-]{36})(\/claims)?$/;
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
    versions: versions.map(versionView),
    created_at: r.created_at,
    updated_at: r.updated_at,
  };
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

  // Dedupe: one ISRC per recording, and one recording per audio file, platform-wide.
  const sameIsrc = await env.DB.prepare('SELECT * FROM recordings WHERE isrc = ?').bind(isrc).first();
  if (sameIsrc) {
    // The same creator retrying the same recording gets the original back, not a duplicate.
    if (sameIsrc.account_id === account && sameIsrc.audio_hash === audioHash) {
      return json({ ...recordingView(sameIsrc, await versionsOf(env, sameIsrc.id)), idempotent_replay: true }, 200);
    }
    return problem(json, 409, 'duplicate-isrc', 'ISRC already recorded', `${displayIsrc(isrc)} is already recorded on ProofStream. If it is yours, open a dispute.`, { existing_isrc: displayIsrc(isrc) });
  }
  const sameAudio = await env.DB.prepare('SELECT isrc FROM recordings WHERE audio_hash = ?').bind(audioHash).first();
  if (sameAudio) {
    return problem(json, 409, 'duplicate-recording', 'Duplicate recording', `This audio is already recorded as ${displayIsrc(sameAudio.isrc)}. A re-release keeps its ISRC; a remix or edit has different audio.`, { existing_isrc: displayIsrc(sameAudio.isrc) });
  }
  const { n } = await env.DB.prepare('SELECT COUNT(*) AS n FROM recordings WHERE account_id = ?').bind(account).first();
  if (n >= MAX_RECORDINGS) return problem(json, 409, 'limit', 'Limit reached', 'You have reached the recording limit.');

  const now = new Date().toISOString();
  const rec = {
    id: 'rec_' + crypto.randomUUID(), account_id: account, isrc, title, version_title: versionTitle, artist,
    duration_ms: body.duration_ms, audio_hash: audioHash, parent_isrc: parentIsrc, status: 'active',
    current_version: 0, created_at: now, updated_at: now,
  };
  const v = await versionRecord(rec, rights, 'initial', 0, now);
  try {
    await env.DB.batch([
      env.DB.prepare('INSERT INTO recordings (id, account_id, isrc, title, version_title, artist, duration_ms, audio_hash, parent_isrc, status, current_version, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .bind(rec.id, account, isrc, title, versionTitle, artist, rec.duration_ms, audioHash, parentIsrc, 'active', 0, now, now),
      env.DB.prepare('INSERT INTO recording_versions (recording_id, version, payload, payload_hash, claim, claim_hash, reason, created_at) VALUES (?, 0, ?, ?, ?, ?, ?, ?)')
        .bind(rec.id, v.payload, v.payload_hash, v.claim, v.claim_hash, 'initial', now),
    ]);
  } catch {
    // A concurrent request recorded this ISRC first.
    return problem(json, 409, 'duplicate-isrc', 'ISRC already recorded', `${displayIsrc(isrc)} is already recorded on ProofStream.`, { existing_isrc: displayIsrc(isrc) });
  }
  return json({ ...recordingView(rec, await versionsOf(env, rec.id)), idempotent_replay: false }, 201);
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
  if (rec.status !== 'active') return problem(json, 409, 'not-active', 'Recording not active', `Claims cannot change while the recording is ${rec.status}.`);
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
    env.DB.prepare("INSERT INTO recording_versions (recording_id, version, payload, payload_hash, claim, claim_hash, reason, idempotency_key, created_at) SELECT ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM recordings WHERE id = ? AND current_version = ? AND status = 'active')")
      .bind(id, version, v.payload, v.payload_hash, v.claim, v.claim_hash, body.reason, key, now, id, rec.current_version),
    env.DB.prepare("UPDATE recordings SET current_version = ?, updated_at = ? WHERE id = ? AND current_version = ? AND status = 'active' RETURNING id")
      .bind(version, now, id, rec.current_version),
  ]);
  if (!updated.results.length) return problem(json, 409, 'conflict', 'Conflict', 'The recording changed while you were saving. Reload and try again.');
  const saved = await env.DB.prepare('SELECT * FROM recording_versions WHERE recording_id = ? AND version = ?').bind(id, version).first();
  return json({ ...versionView(saved), idempotent_replay: false }, 201);
}

// Public: anyone can check a recording's current claim and recompute its hash.
async function verify(env, rawIsrc, json) {
  const isrc = canonicalIsrc(rawIsrc);
  if (!isrc) return problem(json, 400, 'invalid-isrc', 'Invalid ISRC', 'Pass a 12-character ISRC such as US-SKG-26-12345.');
  const rec = await env.DB.prepare('SELECT * FROM recordings WHERE isrc = ?').bind(isrc).first();
  if (!rec) return json({ found: false, valid: false, isrc: displayIsrc(isrc) }, 404, { 'cache-control': 'public, max-age=60' });
  const v = await env.DB.prepare('SELECT * FROM recording_versions WHERE recording_id = ? AND version = ?').bind(rec.id, rec.current_version).first();
  return json({
    found: true,
    valid: rec.status === 'active',
    isrc: displayIsrc(isrc),
    title: rec.title,
    version: rec.version_title,
    artist_display: rec.artist,
    status: rec.status,
    dispute_status: rec.status === 'disputed' ? 'open' : 'none',
    record_version: rec.current_version,
    registered_at: rec.created_at,
    updated_at: rec.updated_at,
    payload: v.payload,
    payload_hash: v.payload_hash,
    claim_hash: v.claim_hash,
    hash_check: 'payload_hash = sha256(payload). Compare it with the on-chain anchor once anchor.status is anchored.',
    anchor: versionView(v).anchor,
  }, 200, { 'cache-control': 'public, max-age=60' });
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
    return json(recordingView(rec, await versionsOf(env, rec.id)));
  }
  if (match && match[2] && method === 'POST') return addClaim(request, env, id, match[1], json);
  return problem(json, 404, 'not-found', 'Not found', 'No such endpoint.');
}
