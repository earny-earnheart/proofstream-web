-- Each creator's projects and milestone fingerprints, keyed to their registration.
-- Only metadata and SHA-256 fingerprints are stored; original files never reach the server.
-- Deleting a registration deletes that creator's projects (D1 enforces foreign keys).
CREATE TABLE IF NOT EXISTS projects (
  account_id TEXT NOT NULL REFERENCES registrations(id) ON DELETE CASCADE,
  id TEXT NOT NULL,
  data TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (account_id, id)
);
