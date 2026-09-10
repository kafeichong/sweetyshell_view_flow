-- 补齐 ExecutionAttempt.model 列。
-- schema.prisma 已声明 `model String?`，但 20260910_expand_execution_domain 的
-- CREATE TABLE 漏建该列，导致 Prisma 的默认 SELECT 报
-- "The column execution_attempts.model does not exist"。
-- 迁移目录名使用晚于上一份迁移的时间戳，确保按字典序在其之后执行。
ALTER TABLE "execution_attempts"
  ADD COLUMN IF NOT EXISTS "model" TEXT;
