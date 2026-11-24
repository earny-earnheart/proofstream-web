-- Invitation-only access: visitors ask for access, an admin approves or declines, and
-- only an approved email can create an account while REGISTRATION_OPEN is not "true".
CREATE TABLE access_requests (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name TEXT NOT NULL,
  role TEXT NOT NULL,
  note TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'declined')),
  created_at TEXT NOT NULL,
  decided_at TEXT,
  decided_by TEXT,
  user_agent TEXT
);
CREATE INDEX access_requests_status ON access_requests(status, created_at);

-- Admin actions are written down so there is a record of who approved what, and when.
CREATE TABLE audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL,
  actor TEXT,
  action TEXT NOT NULL,
  subject TEXT,
  detail TEXT
);
CREATE INDEX audit_log_at ON audit_log(at);
