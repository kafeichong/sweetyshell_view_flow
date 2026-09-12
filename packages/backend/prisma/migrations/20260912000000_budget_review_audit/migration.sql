-- T05: 人工账单复核痕迹
-- 预占被判定为 review 后，只有 Admin 受控动作才能改动结算，并且必须留下
-- 操作者声明与依据引用。operator 是管理员自报的操作者，不是 token 识别出的员工。

ALTER TABLE "task_budget_reservations"
ADD COLUMN "review_decision" TEXT,
ADD COLUMN "review_amount_cny" DECIMAL(18,6),
ADD COLUMN "review_evidence_ref" TEXT,
ADD COLUMN "review_operator" TEXT,
ADD COLUMN "reviewed_at" TIMESTAMP(3);
