CREATE TABLE auth_attempts (
  key TEXT PRIMARY KEY,
  attempt_count INTEGER NOT NULL,
  window_started_at TEXT NOT NULL,
  locked_until TEXT,
  updated_at TEXT NOT NULL
);

CREATE INDEX auth_attempts_updated_at_idx ON auth_attempts(updated_at);
