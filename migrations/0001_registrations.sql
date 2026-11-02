-- Creators who completed the proofstreamapp.com registration gate.
CREATE TABLE IF NOT EXISTS registrations (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL,
  user_agent TEXT
);
