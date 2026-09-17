/**
 * 免费的真实联调：用后端编译出来的真实服务，对真实方舟跑一次素材登记。
 *
 * 覆盖四个环节：AK/SK 签名 → GetAsset → 取回字节 → ffprobe 检查 → 写我方 OSS → 建行。
 * **不调用生成接口，不产生费用。**
 *
 * 用法（从仓库根的 .env 取 OSS 凭证）：
 *   node /tmp/vf-ark/ark_ingest_probe.js <arkAssetId> [arkAssetId2 ...]
 */
const path = require('path');
const fs = require('fs');

const DIST = path.join(__dirname, 'packages/backend/dist/src/assets');
const { ArkAssetLibraryService } = require(path.join(DIST, 'ark-asset-library.service'));
const { ArkAssetIngestService } = require(path.join(DIST, 'ark-asset-ingest.service'));
const { MediaInspectorService, defaultMediaProbeRunner } = require(path.join(DIST, 'media-inspector.service'));
const { AssetPresignService } = require(path.join(DIST, 'asset-presign.service'));

// 从仓库根的 .env 读 OSS 配置（只取需要的键，不打印值）。
function loadEnvFile() {
  const envPath = path.join(__dirname, '..', '..', '..', 'Users', 'steven', 'works', '20260909video_flow', '.env');
  const candidates = ['/Users/steven/works/20260909video_flow/.env'];
  for (const file of candidates) {
    if (!fs.existsSync(file)) continue;
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
      const match = /^([A-Z_]+)=(.*)$/.exec(line.trim());
      if (match && process.env[match[1]] === undefined) process.env[match[1]] = match[2];
    }
    return file;
  }
  throw new Error('找不到 .env');
}

async function main() {
  const assetIds = process.argv.slice(2);
  if (!assetIds.length) throw new Error('用法: node ark_ingest_probe.js <arkAssetId> [...]');

  // 真实联调：绝不能带 TEST_MODE——那会触发"合同环境禁止真实凭证"的闸门（那是刻意的）。
  delete process.env.VIDEO_FLOW_TEST_MODE;

  const envFile = loadEnvFile();
  console.log(`配置来自 ${envFile}`);

  const ark = new ArkAssetLibraryService();
  console.log('素材库客户端已配置:', ark.isConfigured());
  if (!ark.isConfigured()) throw new Error('AK/SK 没读到——检查 ~/.video-flow/ark-asset-credentials');

  const presign = new AssetPresignService();
  console.log('OSS 已配置:', presign.isConfigured());
  if (!presign.isConfigured()) throw new Error('OSS 没配置');

  const inspector = new MediaInspectorService(defaultMediaProbeRunner);

  // 真实库里不该写东西——用一个只记录调用的替身，这样这次联调**不落任何数据库行**。
  const created = [];
  const prisma = {
    asset: {
      findFirst: async () => null,
      create: async ({ data }) => {
        created.push(data);
        return { id: 'scratch-不落库', ...data };
      },
    },
  };

  const ingest = new ArkAssetIngestService(prisma, ark, inspector, presign);

  for (const assetId of assetIds) {
    console.log(`\n=== ${assetId} ===`);
    try {
      const asset = await ingest.materialize('probe-actor', assetId);
      console.log('✓ 登记成功');
      console.log('  mimeType      :', asset.mimeType);
      console.log('  sizeBytes     :', Number(asset.sizeBytes));
      console.log('  fileHash      :', String(asset.fileHash).slice(0, 16) + '…');
      console.log('  mediaMetadata :', JSON.stringify(asset.mediaMetadata));
      console.log('  objectKey     :', asset.objectKey);
      console.log('  arkAssetId    :', asset.arkAssetId);
      console.log('  arkGroupId    :', asset.arkGroupId);
      // 复核：写进桶的那份字节，是不是我方检查器认可的那一份。
      const head = await presign.inspectObject(asset.objectKey);
      console.log('  桶里回读       : size', head.sizeBytes, '| mime', head.mimeType, '| sha256',
        String(head.fileHash).slice(0, 16) + '…');
      const ok = head.sizeBytes === Number(asset.sizeBytes) && head.fileHash === asset.fileHash;
      console.log(ok ? '  ✓ 回读与登记一致' : '  ✗ 回读与登记不一致');
    } catch (error) {
      console.log('✗ 失败:', error.code ?? error.name, '—', error.message);
    }
  }
  console.log(`\n（替身共记录 ${created.length} 次 create，未落库）`);
}

main().catch((error) => {
  console.error('探测失败:', error);
  process.exit(1);
});
