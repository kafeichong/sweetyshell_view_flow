-- Add domain enums
CREATE TYPE "TaskStatus" AS ENUM (
  'draft',
  'pending',
  'queued',
  'in_progress',
  'requires_review',
  'completed',
  'failed',
  'cancelled'
);

CREATE TYPE "AttemptStatus" AS ENUM (
  'pending',
  'submitted',
  'running',
  'requires_review',
  'completed',
  'failed',
  'cancelled'
);

CREATE TYPE "ExecutionMode" AS ENUM (
  'preview',
  'production',
  'comfyui'
);

CREATE TYPE "CostStatus" AS ENUM (
  'estimated',
  'usage_calculated',
  'billed',
  'unavailable'
);

-- expand Task table with stable domain fields, keep old fields untouched
ALTER TABLE "tasks"
  ADD COLUMN IF NOT EXISTS "actor_id" TEXT,
  ADD COLUMN IF NOT EXISTS "client_request_id" TEXT,
  ADD COLUMN IF NOT EXISTS "capability" TEXT,
  ADD COLUMN IF NOT EXISTS "workflow_name" TEXT,
  ADD COLUMN IF NOT EXISTS "workflow_version" TEXT,
  ADD COLUMN IF NOT EXISTS "workflow_hash" TEXT,
  ADD COLUMN IF NOT EXISTS "request_snapshot" JSONB,
  ADD COLUMN IF NOT EXISTS "task_status" "TaskStatus";

ALTER TABLE "tasks"
  ADD COLUMN IF NOT EXISTS "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ADD COLUMN IF NOT EXISTS "lease_owner" TEXT,
  ADD COLUMN IF NOT EXISTS "lease_expires_at" TIMESTAMP(3);

CREATE INDEX IF NOT EXISTS "tasks_status_lease_expires_at_idx"
  ON "tasks"("status", "lease_expires_at");

CREATE UNIQUE INDEX IF NOT EXISTS "tasks_actor_client_request_id_key"
  ON "tasks"("actor_id", "client_request_id");

-- Execution attempt table
CREATE TABLE IF NOT EXISTS "execution_attempts" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "task_id" UUID NOT NULL,
  "attempt_no" INTEGER NOT NULL,
  "mode" "ExecutionMode" NOT NULL,
  "provider" TEXT NOT NULL DEFAULT 'seedance',
  "provider_task_id" TEXT,
  "status" "AttemptStatus" NOT NULL DEFAULT 'pending',
  "provider_usage" JSONB,
  "cost_status" "CostStatus" NOT NULL DEFAULT 'unavailable',
  "estimated_cost_cny" DOUBLE PRECISION,
  "usage_calculated_cost_cny" DOUBLE PRECISION,
  "billed_cost_cny" DOUBLE PRECISION,
  "pricing_version" TEXT,
  "failure_type" TEXT,
  "failure_code" TEXT,
  "failure_message" TEXT,
  "submitted_at" TIMESTAMP(3),
  "started_at" TIMESTAMP(3),
  "finished_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "execution_attempts_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "execution_attempts_task_fkey" FOREIGN KEY ("task_id") REFERENCES "tasks"("id") ON DELETE CASCADE,
  CONSTRAINT "execution_attempts_task_attempt_no_key" UNIQUE ("task_id", "attempt_no")
);

CREATE UNIQUE INDEX IF NOT EXISTS "execution_attempts_provider_task_id_key"
  ON "execution_attempts"("provider_task_id")
  WHERE "provider_task_id" IS NOT NULL;

CREATE INDEX IF NOT EXISTS "execution_attempts_task_status_idx"
  ON "execution_attempts"("status");

-- Asset table
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

  CONSTRAINT "assets_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "assets_task_fkey" FOREIGN KEY ("task_id") REFERENCES "tasks"("id") ON DELETE CASCADE,
  CONSTRAINT "assets_attempt_fkey" FOREIGN KEY ("attempt_id") REFERENCES "execution_attempts"("id") ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS "assets_task_idx" ON "assets"("task_id");
CREATE INDEX IF NOT EXISTS "assets_attempt_idx" ON "assets"("attempt_id");

-- Actor credential table
CREATE TABLE IF NOT EXISTS "actor_credentials" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "actor_id" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "token_hash" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'active',
  "daily_limit_cny" DOUBLE PRECISION,
  "monthly_limit_cny" DOUBLE PRECISION,
  "last_used_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "actor_credentials_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "actor_credentials_actor_id_key" UNIQUE ("actor_id")
);
