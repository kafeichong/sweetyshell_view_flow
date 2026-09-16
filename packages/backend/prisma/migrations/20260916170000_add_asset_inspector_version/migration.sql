-- 资产检查器版本：记录这份 media_metadata 是哪一版检查器算出来的。
-- 内容寻址复用不会重检旧资产，检查器一改，库里的旧值就会和客户端的新口径对不上；
-- 有了这一列，才能判定"哪些资产需要重检"（见 src/tools/asset-reinspection.ts）。
ALTER TABLE "assets" ADD COLUMN "inspector_version" TEXT;
