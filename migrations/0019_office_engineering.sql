CREATE TABLE staff_roles_next (
  user_id TEXT PRIMARY KEY REFERENCES users(id),
  role TEXT NOT NULL CHECK(role IN ('purchaser','finance','boss','admin','engineering','warehouse','office'))
);
INSERT INTO staff_roles_next SELECT user_id, CASE WHEN role='department' THEN 'engineering' ELSE role END FROM staff_roles;
DROP TABLE staff_roles;
ALTER TABLE staff_roles_next RENAME TO staff_roles;
