CREATE TABLE staff_permissions (
  user_id TEXT PRIMARY KEY REFERENCES users(id),
  supplier_operations INTEGER NOT NULL DEFAULT 0 CHECK(supplier_operations IN (0,1))
);
