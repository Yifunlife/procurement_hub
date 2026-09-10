ALTER TABLE warehouse_records ADD COLUMN record_date TEXT
CHECK(record_date IS NULL OR (length(record_date)=10 AND record_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'));
