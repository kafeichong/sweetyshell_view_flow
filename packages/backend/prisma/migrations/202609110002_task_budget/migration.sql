-- T02: Task budget reservation and production gate

-- Create task budget reservation table
CREATE TABLE "task_budget_reservations" (
    "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    "task_id" UUID NOT NULL UNIQUE,
    "actor_id" TEXT NOT NULL,
    "reserved_cny" DECIMAL(18,6) NOT NULL,
    "settled_cny" DECIMAL(18,6),
    "state" TEXT NOT NULL DEFAULT 'reserved',
    "day_key" TEXT NOT NULL,
    "month_key" TEXT NOT NULL,
    "pricing_version" TEXT NOT NULL,
    "created_at" TIMESTAMP NOT NULL DEFAULT NOW(),
    "updated_at" TIMESTAMP NOT NULL DEFAULT NOW(),
    CONSTRAINT "fk_task" FOREIGN KEY ("task_id") REFERENCES "tasks"("id") ON DELETE CASCADE
);

CREATE INDEX "idx_budget_actor_day" ON "task_budget_reservations"("actor_id", "day_key");
CREATE INDEX "idx_budget_actor_month" ON "task_budget_reservations"("actor_id", "month_key");
CREATE INDEX "idx_budget_state" ON "task_budget_reservations"("state");

-- Create production gate singleton
CREATE TABLE "production_gates" (
    "id" TEXT PRIMARY KEY DEFAULT 'production',
    "paused" BOOLEAN NOT NULL DEFAULT true,
    "reason" TEXT,
    "updated_at" TIMESTAMP NOT NULL DEFAULT NOW(),
    CONSTRAINT "chk_singleton" CHECK (id = 'production')
);

-- Insert default production gate (paused)
INSERT INTO "production_gates" ("id", "paused", "reason")
VALUES ('production', true, 'Initial state - awaiting first deployment verification');

-- Add new fields to Task table for T02
ALTER TABLE "tasks"
ADD COLUMN "execution_plan" JSONB,
ADD COLUMN "delivery_status" TEXT;
