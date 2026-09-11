-- 同一 actor 的同一类素材按 SHA-256 内容寻址。
-- PostgreSQL 允许唯一索引中包含多个 NULL，因此未回填 file_hash 的旧记录
-- 不会互相冲突；非空 hash 的并发创建由数据库选择唯一 canonical Asset。
CREATE UNIQUE INDEX IF NOT EXISTS "assets_owner_id_role_file_hash_key"
  ON "assets"("owner_id", "role", "file_hash");
