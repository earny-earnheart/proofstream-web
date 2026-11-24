-- Plans and trials. One row per account, created when the account first starts its trial.
-- Polar (merchant of record) is the payment provider; its webhook keeps this row in sync.
CREATE TABLE subscriptions (
  account_id TEXT PRIMARY KEY REFERENCES registrations(id) ON DELETE CASCADE,
  plan TEXT NOT NULL CHECK (plan IN ('trial', 'creator', 'pro', 'comp')),
  status TEXT NOT NULL CHECK (status IN ('trialing', 'active', 'past_due', 'canceled', 'expired')),
  trial_ends_at TEXT,
  current_period_end TEXT,
  cancel_at_period_end INTEGER NOT NULL DEFAULT 0,
  provider TEXT,
  provider_customer_id TEXT,
  provider_subscription_id TEXT UNIQUE,
  provider_product_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- Every webhook delivery is recorded once by its id, so a retried delivery is not applied
-- twice, and there is a record of what the provider told us and when.
CREATE TABLE billing_events (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  account_id TEXT,
  provider_subscription_id TEXT,
  received_at TEXT NOT NULL,
  applied INTEGER NOT NULL DEFAULT 0
);
