-- This migration intentionally sorts before
-- 20260910193000_add_asset_owner_role_hash_unique.
--
-- Existing production databases already have assets, so this is a no-op there.
-- A new empty database needs the table before the historical unique-index
-- migration runs. Foreign keys are added by a later repair migration after
-- execution_attempts exists.
CREATE TABLE IF NOT EXISTS "assets" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "owner_id" TEXT,
  "task_id" UUID,
  "attempt_id" UUID,
  "role" TEXT NOT NULL,
  "media_type" TEXT,
  "bucket" TEXT,
  "object_key" TEXT NOT NULL,
  "mime_type" TEXT,
  "size_bytes" BIGINT,
  "file_hash" TEXT,
  "inspection_status" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "assets_pkey" PRIMARY KEY ("id")
);
