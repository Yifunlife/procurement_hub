CREATE TABLE staff_roles_next (
  user_id TEXT PRIMARY KEY REFERENCES users(id),
  role TEXT NOT NULL CHECK(role IN ('purchaser', 'finance', 'boss', 'admin', 'department'))
);
INSERT INTO staff_roles_next SELECT user_id, role FROM staff_roles;
DROP TABLE staff_roles;
ALTER TABLE staff_roles_next RENAME TO staff_roles;
