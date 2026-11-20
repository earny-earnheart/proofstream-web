-- Recordings keyed by ISRC, with an append-only history of rights-claim versions.
-- Each version stores the RFC 8785 canonical JSON that was hashed, so anyone can recompute
-- payload_hash and compare it with the on-chain ProofStreamRegistry anchor. Audio never
-- reaches the server: audio_hash is the SHA-256 the browser computed.
-- ISRCs are stored in canonical form (12 characters, no dashes) and are unique platform-wide.
CREATE TABLE IF NOT EXISTS recordings (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES registrations(id) ON DELETE CASCADE,
  isrc TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  version_title TEXT NOT NULL,
  artist TEXT NOT NULL,
  duration_ms INTEGER NOT NULL,
  audio_hash TEXT NOT NULL,
  parent_isrc TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  current_version INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS recordings_account ON recordings(account_id, created_at);
CREATE INDEX IF NOT EXISTS recordings_audio ON recordings(audio_hash);

-- anchor_status: queued until the anchoring job records payload_hash on-chain, then anchored.
CREATE TABLE IF NOT EXISTS recording_versions (
  recording_id TEXT NOT NULL REFERENCES recordings(id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  payload TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  claim TEXT NOT NULL,
  claim_hash TEXT NOT NULL,
  reason TEXT NOT NULL,
  idempotency_key TEXT,
  created_at TEXT NOT NULL,
  anchor_status TEXT NOT NULL DEFAULT 'queued',
  chain_id INTEGER,
  contract_address TEXT,
  tx_hash TEXT,
  block_number INTEGER,
  anchored_at TEXT,
  PRIMARY KEY (recording_id, version),
  UNIQUE (recording_id, idempotency_key)
);
CREATE INDEX IF NOT EXISTS recording_versions_anchor ON recording_versions(anchor_status, created_at);
