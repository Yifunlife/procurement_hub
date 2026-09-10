ALTER TABLE order_items ADD COLUMN production_photo_waived INTEGER NOT NULL DEFAULT 0 CHECK (production_photo_waived IN (0, 1));
