-- Recordings keyed by ISRC, with an append-only history of rights-claim versions.
-- Each version stores the RFC 8785 canonical JSON that was hashed, so anyone can recompute
-- payload_hash and compare it with the on-chain ProofStreamRegistry anchor. Audio never
-- reaches the server: audio_hash is the SHA-256 the browser computed.
-- ISRCs are stored in canonical form (12 characters, no dashes). A claim is not ownership:
-- several accounts may claim the same ISRC or audio, and every claim starts 'unverified'.
-- 'verified' means a ProofStream admin confirmed one version (verified_version); a new
-- version resets it. Creators ask for verification with evidence hashes (never documents).
-- Only verified claims are anchored on-chain. 'Contested' is derived when read, never stored.
-- An account claims an ISRC once.
CREATE TABLE IF NOT EXISTS recordings (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES registrations(id) ON DELETE CASCADE,
  isrc TEXT NOT NULL,
  title TEXT NOT NULL,
  version_title TEXT NOT NULL,
  artist TEXT NOT NULL,
  duration_ms INTEGER NOT NULL,
  audio_hash TEXT NOT NULL,
  parent_isrc TEXT,
  status TEXT NOT NULL DEFAULT 'unverified' CHECK (status IN ('unverified', 'verified', 'disputed', 'revoked')),
  current_version INTEGER NOT NULL DEFAULT 0,
  verification_requested_at TEXT,
  verification_evidence TEXT,
  verified_version INTEGER,
  verified_at TEXT,
  verified_by TEXT,
  status_reason TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (account_id, isrc)
);
CREATE INDEX IF NOT EXISTS recordings_isrc ON recordings(isrc);
CREATE INDEX IF NOT EXISTS recordings_account ON recordings(account_id, created_at);
CREATE INDEX IF NOT EXISTS recordings_audio ON recordings(audio_hash);

-- anchor_status: pending (not verified, never anchored) -> queued (verified, waiting for the
-- anchoring job) -> submitted (transaction sent) -> anchored (confirmed on-chain), or failed.
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
  anchor_status TEXT NOT NULL DEFAULT 'pending' CHECK (anchor_status IN ('pending', 'queued', 'submitted', 'anchored', 'failed')),
  anchor_attempts INTEGER NOT NULL DEFAULT 0,
  anchor_error TEXT,
  submitted_at TEXT,
  chain_id INTEGER,
  contract_address TEXT,
  tx_hash TEXT,
  block_number INTEGER,
  anchored_at TEXT,
  PRIMARY KEY (recording_id, version),
  UNIQUE (recording_id, idempotency_key)
);
CREATE INDEX IF NOT EXISTS recording_versions_anchor ON recording_versions(anchor_status, created_at);
