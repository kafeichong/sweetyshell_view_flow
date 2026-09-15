-- Preview v2 records are deliberately independent from tasks, attempts and
-- budget reservations so a successful request check cannot be claimed by a
-- Worker or interpreted as a paid generation intent.
CREATE TABLE "preflight_records" (
    "id" UUID NOT NULL,
    "actor_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "contract_version" INTEGER NOT NULL,
    "workflow_version" TEXT NOT NULL,
    "contract_digest" TEXT NOT NULL,
    "intent_digest" TEXT NOT NULL,
    "quote_digest" TEXT NOT NULL,
    "effective_request" JSONB NOT NULL,
    "report" JSONB NOT NULL,
    "quote_snapshot" JSONB NOT NULL,

    CONSTRAINT "preflight_records_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "preflight_records_actor_id_created_at_idx"
    ON "preflight_records"("actor_id", "created_at");

CREATE INDEX "preflight_records_expires_at_idx"
    ON "preflight_records"("expires_at");
