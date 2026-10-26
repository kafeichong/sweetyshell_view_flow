-- Migration: 添加月度账单模型
-- 日期: 2026-09-21
-- 描述: 新增 MonthlyProviderBill 和 BillLine 表用于存储 Provider 账单快照

-- 1. 月度 Provider 账单快照表
CREATE TABLE "monthly_provider_bills" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "provider" TEXT NOT NULL,
    "month_key" TEXT NOT NULL,
    "detail_count" INTEGER NOT NULL,
    "total_cny" DECIMAL(18,6) NOT NULL,
    "source_digest" TEXT NOT NULL,
    "snapshot_json" JSONB NOT NULL,
    "confirmed_at" TIMESTAMP(3),
    "confirmed_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "monthly_provider_bills_pkey" PRIMARY KEY ("id")
);

-- 2. 账单明细行表
CREATE TABLE "bill_lines" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "bill_id" UUID NOT NULL,
    "bill_detail_id" TEXT NOT NULL,
    "product" TEXT NOT NULL,
    "configuration" TEXT NOT NULL,
    "instance_id" TEXT NOT NULL,
    "billing_unit" TEXT NOT NULL,
    "payable_cny" DECIMAL(18,6) NOT NULL,

    CONSTRAINT "bill_lines_pkey" PRIMARY KEY ("id")
);

-- 3. 创建唯一约束
CREATE UNIQUE INDEX "monthly_provider_bills_provider_month_key_key" ON "monthly_provider_bills"("provider", "month_key");
CREATE UNIQUE INDEX "bill_lines_bill_id_bill_detail_id_key" ON "bill_lines"("bill_id", "bill_detail_id");

-- 4. 创建索引
CREATE INDEX "monthly_provider_bills_month_key_idx" ON "monthly_provider_bills"("month_key");
CREATE INDEX "monthly_provider_bills_confirmed_at_idx" ON "monthly_provider_bills"("confirmed_at");
CREATE INDEX "bill_lines_bill_id_idx" ON "bill_lines"("bill_id");

-- 5. 添加外键约束
ALTER TABLE "bill_lines" ADD CONSTRAINT "bill_lines_bill_id_fkey" FOREIGN KEY ("bill_id") REFERENCES "monthly_provider_bills"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- 6. 添加注释
COMMENT ON TABLE "monthly_provider_bills" IS '月度 Provider 账单快照表';
COMMENT ON TABLE "bill_lines" IS '账单明细行表';
COMMENT ON COLUMN "monthly_provider_bills"."source_digest" IS '包含行的 SHA256 摘要';
COMMENT ON COLUMN "monthly_provider_bills"."snapshot_json" IS 'BillingMonthSnapshot 完整 JSON';
