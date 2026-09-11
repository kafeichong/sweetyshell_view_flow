-- The empty-database compatibility migration creates assets before
-- execution_attempts exists. Add the normal domain foreign keys once all
-- referenced tables are present. Existing databases keep their constraints.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'assets_task_fkey'
  ) THEN
    ALTER TABLE "assets"
      ADD CONSTRAINT "assets_task_fkey"
      FOREIGN KEY ("task_id") REFERENCES "tasks"("id") ON DELETE CASCADE;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'assets_attempt_fkey'
  ) THEN
    ALTER TABLE "assets"
      ADD CONSTRAINT "assets_attempt_fkey"
      FOREIGN KEY ("attempt_id") REFERENCES "execution_attempts"("id") ON DELETE CASCADE;
  END IF;
END $$;
