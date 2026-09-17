-- 私域素材库素材：让一条 Asset 同时是「我们 OSS 上的那份字节」和「方舟素材库里的一份素材」。
-- 生成时送 asset://<ark_asset_id> 而不是我方签名 URL——含真人人脸的参考素材直传会被方舟
-- 输入审核拦下，所以这条通路是唯一解，不是优化项。
--
-- 只加可空列：历史资产（全是普通上传件）不受影响，也不需要回填。
ALTER TABLE "assets" ADD COLUMN "ark_asset_id" TEXT;
ALTER TABLE "assets" ADD COLUMN "ark_group_id" TEXT;
ALTER TABLE "assets" ADD COLUMN "ark_asset_status" TEXT;
ALTER TABLE "assets" ADD COLUMN "ark_asset_status_checked_at" TIMESTAMP(3);
ALTER TABLE "assets" ADD COLUMN "ark_last_inference_time" TIMESTAMP(3);

-- 一份方舟素材只该对应一行。并发的重复登记若各建一行，会往素材组里灌重复素材、白占
-- 权益包容量，而且不好清理。唯一索引是第二道防线（第一道是登记时的 advisory lock）。
-- Postgres 允许多个 NULL，所以普通上传件不受这条约束影响。
CREATE UNIQUE INDEX "assets_ark_asset_id_key" ON "assets"("ark_asset_id");
