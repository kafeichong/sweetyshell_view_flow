ALTER TABLE "tasks"
  ADD COLUMN "execution_slot_id" TEXT,
  ADD COLUMN "slot_sequence" INTEGER,
  ADD COLUMN "preflight_id" UUID,
  ADD COLUMN "contract_digest" TEXT,
  ADD COLUMN "intent_digest" TEXT,
  ADD COLUMN "quote_digest" TEXT,
  ADD COLUMN "client_delivery_status" TEXT,
  ADD COLUMN "client_delivered_at" TIMESTAMP(3);

CREATE UNIQUE INDEX "tasks_actor_id_execution_slot_id_slot_sequence_key"
  ON "tasks"("actor_id", "execution_slot_id", "slot_sequence");

CREATE INDEX "tasks_actor_id_execution_slot_id_client_delivery_status_idx"
  ON "tasks"("actor_id", "execution_slot_id", "client_delivery_status");
