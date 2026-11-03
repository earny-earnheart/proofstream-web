-- Sign-in methods: email and password, or Google.
-- password_hash: PBKDF2 hash, NULL for Google-only and legacy email-only accounts.
-- email_verified: 1 once Google has confirmed the email. A Google sign-in for an
--   unverified account removes any password on it.
-- session_version: part of every session cookie; bumping it signs the account out everywhere.
ALTER TABLE registrations ADD COLUMN password_hash TEXT;
ALTER TABLE registrations ADD COLUMN email_verified INTEGER NOT NULL DEFAULT 0;
ALTER TABLE registrations ADD COLUMN session_version INTEGER NOT NULL DEFAULT 1;

CREATE TABLE IF NOT EXISTS identities (
  provider TEXT NOT NULL,
  subject TEXT NOT NULL,
  account_id TEXT NOT NULL REFERENCES registrations(id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (provider, subject)
);
CREATE INDEX IF NOT EXISTS identities_account ON identities(account_id);
