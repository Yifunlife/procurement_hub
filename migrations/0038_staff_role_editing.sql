ALTER TABLE account_changes ADD COLUMN old_role TEXT;
ALTER TABLE account_changes ADD COLUMN new_role TEXT;
ALTER TABLE account_changes ADD COLUMN old_supplier_operations INTEGER;
ALTER TABLE account_changes ADD COLUMN new_supplier_operations INTEGER;
ALTER TABLE account_changes ADD COLUMN old_finance_settlement INTEGER;
ALTER TABLE account_changes ADD COLUMN new_finance_settlement INTEGER;
