ALTER TABLE staff_permissions ADD COLUMN finance_settlement INTEGER NOT NULL DEFAULT 0 CHECK(finance_settlement IN (0,1));
