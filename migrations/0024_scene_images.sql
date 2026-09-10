ALTER TABLE attachments ADD COLUMN purpose TEXT CHECK(purpose IS NULL OR purpose='scene');
