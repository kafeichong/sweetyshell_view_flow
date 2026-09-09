-- CreateTable
CREATE TABLE "tasks" (
    "id" UUID NOT NULL,
    "created_by" TEXT NOT NULL,
    "prompt" TEXT NOT NULL,
    "image_url" TEXT,
    "video_url" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "error_msg" TEXT,
    "cost" REAL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" TIMESTAMP(3),

    CONSTRAINT "tasks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "config" (
    "id" TEXT NOT NULL,
    "volcengine_api_key" TEXT NOT NULL,
    "oss_access_key_id" TEXT NOT NULL,
    "oss_access_key_secret" TEXT NOT NULL,
    "oss_bucket" TEXT NOT NULL DEFAULT 'sweetyshell-ai-assets',
    "oss_region" TEXT NOT NULL DEFAULT 'oss-cn-beijing',

    CONSTRAINT "config_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "tasks_status_idx" ON "tasks"("status");

-- CreateIndex
CREATE INDEX "tasks_created_by_idx" ON "tasks"("created_by");
