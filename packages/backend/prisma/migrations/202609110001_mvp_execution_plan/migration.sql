ALTER TABLE "tasks"
  ADD COLUMN IF NOT EXISTS "execution_plan" JSONB,
  ADD COLUMN IF NOT EXISTS "delivery_status" TEXT;
