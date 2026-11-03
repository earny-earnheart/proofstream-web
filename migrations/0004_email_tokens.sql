-- Single-use links sent by email: password resets and email verification. Only the
-- SHA-256 of each token is stored, so a database read cannot be turned into a link.
-- `email` is the address the link was sent to; a link only works while the account
-- still has that address.
CREATE TABLE email_tokens (
  token_hash TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES registrations(id) ON DELETE CASCADE,
  purpose TEXT NOT NULL CHECK (purpose IN ('reset', 'verify')),
  email TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX email_tokens_account ON email_tokens(account_id, purpose, created_at);
