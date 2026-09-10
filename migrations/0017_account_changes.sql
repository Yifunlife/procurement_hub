CREATE TABLE account_changes (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  actor_id TEXT NOT NULL REFERENCES users(id),
  old_name TEXT NOT NULL,
  new_name TEXT NOT NULL,
  old_email TEXT NOT NULL,
  new_email TEXT NOT NULL,
  password_reset INTEGER NOT NULL CHECK(password_reset IN (0, 1)),
  created_at TEXT NOT NULL
);
CREATE TRIGGER account_changes_no_update BEFORE UPDATE ON account_changes
BEGIN SELECT RAISE(ABORT, 'Account history is immutable'); END;
CREATE TRIGGER account_changes_no_delete BEFORE DELETE ON account_changes
BEGIN SELECT RAISE(ABORT, 'Account history is immutable'); END;
