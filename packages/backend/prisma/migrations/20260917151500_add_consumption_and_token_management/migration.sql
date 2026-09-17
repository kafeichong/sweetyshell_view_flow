-- Migration: 添加费用管理和Token管理增强功能
-- 日期: 2026-09-17
-- 描述: 新增费用预警、对账记录、Token使用日志表；扩展ActorCredential表

-- 1. 费用预警配置表
CREATE TABLE "cost_alerts" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "actor_id" TEXT NOT NULL,
    "alert_type" TEXT NOT NULL,
    "threshold_cny" DECIMAL(18,6) NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "last_triggered_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "cost_alerts_pkey" PRIMARY KEY ("id")
);

-- 2. 费用对账记录表
CREATE TABLE "cost_reconciliations" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "month_key" TEXT NOT NULL,
    "actor_id" TEXT,
    "system_total_cny" DECIMAL(18,6) NOT NULL,
    "provider_bill_cny" DECIMAL(18,6) NOT NULL,
    "variance_cny" DECIMAL(18,6) NOT NULL,
    "variance_percent" DECIMAL(5,2) NOT NULL,
    "evidence_url" TEXT,
    "notes" TEXT,
    "reconciled_by" TEXT NOT NULL,
    "reconciled_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "cost_reconciliations_pkey" PRIMARY KEY ("id")
);

-- 3. Token使用日志表
CREATE TABLE "token_usage_logs" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "actor_id" TEXT NOT NULL,
    "endpoint" TEXT NOT NULL,
    "method" TEXT NOT NULL,
    "status_code" INTEGER NOT NULL,
    "ip_address" TEXT,
    "user_agent" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "token_usage_logs_pkey" PRIMARY KEY ("id")
);

-- 4. 扩展 ActorCredential 表
ALTER TABLE "actor_credentials" ADD COLUMN "last_ip_address" TEXT;
ALTER TABLE "actor_credentials" ADD COLUMN "usage_count" INTEGER NOT NULL DEFAULT 0;

-- 5. 创建唯一约束
CREATE UNIQUE INDEX "cost_alerts_actor_id_alert_type_key" ON "cost_alerts"("actor_id", "alert_type");
CREATE UNIQUE INDEX "cost_reconciliations_month_key_actor_id_key" ON "cost_reconciliations"("month_key", "actor_id");

-- 6. 创建索引
CREATE INDEX "cost_alerts_actor_id_enabled_idx" ON "cost_alerts"("actor_id", "enabled");
CREATE INDEX "cost_reconciliations_month_key_idx" ON "cost_reconciliations"("month_key");
CREATE INDEX "token_usage_logs_actor_id_created_at_idx" ON "token_usage_logs"("actor_id", "created_at");
CREATE INDEX "token_usage_logs_created_at_idx" ON "token_usage_logs"("created_at");

-- 7. 添加注释
COMMENT ON TABLE "cost_alerts" IS '费用预警配置表';
COMMENT ON TABLE "cost_reconciliations" IS '费用对账记录表';
COMMENT ON TABLE "token_usage_logs" IS 'Token使用日志表';
COMMENT ON COLUMN "actor_credentials"."last_ip_address" IS '最后使用IP地址';
COMMENT ON COLUMN "actor_credentials"."usage_count" IS 'Token使用次数';
