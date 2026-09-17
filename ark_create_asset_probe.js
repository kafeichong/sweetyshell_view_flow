/**
 * 验证「以后能不能从 ComfyUI 上传素材到方舟素材库」。
 *
 * 要回答三件事：
 *   1. 方舟能不能取到**我方 OSS** 里的对象（我们给的是签名地址）；
 *   2. 从 CreateAsset 到 Status=Active 要多久——这决定签名地址该签多长；
 *   3. 建出来的素材能不能被 GetAsset 读回、能不能删干净。
 *
 * **不产生生成费用**：建/查/删素材都不按次计费，只临时占用素材与素材组配额。
 * 跑完会把测试素材与测试素材组都删掉。
 */
const fs = require('fs');
const path = require('path');
const OSS = require(path.join(__dirname, 'packages/backend/node_modules/ali-oss'));
const { buildSignedRequest } = require(path.join(__dirname, 'packages/backend/dist/src/assets/ark-asset-library.service'));

const PROJECT = 'default';
const GROUP_NAME = 'video-flow-probe-temp';
const SOURCE_OBJECT_KEY = 'inputs/probe-actor/ark-asset-20260917115246-cgmtw';
const SIGNED_URL_SECONDS = 3600; // 故意签长一点，先看方舟多久来取

function loadEnv() {
  for (const line of fs.readFileSync('/Users/steven/works/20260909video_flow/.env', 'utf8').split('\n')) {
    const m = /^([A-Z_]+)=(.*)$/.exec(line.trim());
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2];
  }
}

function credentials() {
  const lines = fs.readFileSync(path.join(process.env.HOME, '.video-flow/ark-asset-credentials'), 'utf8')
    .split('\n').map((l) => l.trim()).filter(Boolean);
  return { accessKeyId: lines[0], secretAccessKey: lines[1] };
}

const xDate = (d) => d.toISOString().replace(/[:-]|\.\d{3}/g, '');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function call(creds, action, body = {}) {
  const { url, headers, payload } = buildSignedRequest(creds, action, body, xDate(new Date()));
  const response = await fetch(url, { method: 'POST', headers, body: payload });
  const text = await response.text();
  let parsed = null;
  try { parsed = JSON.parse(text); } catch { /* 原样带出 */ }
  if (!response.ok) {
    const err = parsed?.ResponseMetadata?.Error;
    throw new Error(`${action} 失败 HTTP ${response.status}: ${err?.Code ?? ''} ${err?.Message ?? text.slice(0, 300)}`);
  }
  return parsed?.Result ?? parsed ?? {};
}

async function main() {
  loadEnv();
  const creds = credentials();

  const oss = new OSS({
    region: process.env.OSS_REGION, accessKeyId: process.env.OSS_ACCESS_KEY_ID,
    accessKeySecret: process.env.OSS_ACCESS_KEY_SECRET, bucket: process.env.OSS_BUCKET, secure: true,
  });
  const signedUrl = oss.signatureUrl(SOURCE_OBJECT_KEY, { method: 'GET', expires: SIGNED_URL_SECONDS });
  console.log('源对象 :', `oss://${process.env.OSS_BUCKET}/${SOURCE_OBJECT_KEY}`);
  console.log('签名有效期:', SIGNED_URL_SECONDS, '秒');

  // 清理兜底：无论中途怎么失败，都尽量把测试留下的东西删掉。
  let groupId = null;
  let assetId = null;
  const cleanup = async () => {
    if (assetId) {
      try { await call(creds, 'DeleteAsset', { Id: assetId, ProjectName: PROJECT }); console.log('  ✓ 已删除测试素材', assetId); }
      catch (e) { console.log('  ✗ 删除素材失败:', e.message); }
    }
    if (groupId) {
      try { await call(creds, 'DeleteAssetGroup', { Id: groupId }); console.log('  ✓ 已删除测试素材组', groupId); }
      catch (e) { console.log('  ✗ 删除素材组失败:', e.message); }
    }
  };

  try {
    console.log('\n=== 1. 建一个临时素材组 ===');
    const group = await call(creds, 'CreateAssetGroup', {
      Name: GROUP_NAME, Description: '视频流程联调临时组，验证完即删', ProjectName: PROJECT,
    });
    groupId = group.Id;
    console.log('  ✓', groupId);

    console.log('\n=== 2. 用我方 OSS 的签名地址建素材 ===');
    const created = await call(creds, 'CreateAsset', {
      GroupId: groupId, URL: signedUrl, AssetType: 'Image',
      Name: 'probe-from-our-oss', ProjectName: PROJECT,
    });
    assetId = created.Id;
    console.log('  ✓', assetId);

    console.log('\n=== 3. 轮询到 Active（这段耗时决定签名该签多长）===');
    const startedAt = Date.now();
    let status = 'unknown';
    for (let attempt = 1; attempt <= 30; attempt += 1) {
      const asset = await call(creds, 'GetAsset', { Id: assetId, ProjectName: PROJECT });
      status = asset.Status;
      const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
      console.log(`  ${String(attempt).padStart(2)}: ${status}  (${elapsed}s)`);
      if (status === 'Active' || status === 'Failed') break;
      await sleep(3000);
    }

    console.log('\n=== 4. 回读确认 ===');
    const final = await call(creds, 'GetAsset', { Id: assetId, ProjectName: PROJECT });
    console.log('  Status     :', final.Status);
    console.log('  ProjectName:', final.ProjectName);
    console.log('  AssetType  :', final.AssetType);
    console.log('  回传地址是方舟自己的桶:', String(final.URL ?? '').includes('tos-cn-beijing') ? '是' : `否（${String(final.URL).slice(0, 50)}…）`);

    if (final.Status === 'Active') {
      console.log('\n✓ 结论：方舟**能**从我们的 OSS 取到对象并入库');
      console.log('  → ComfyUI 里上传素材到素材库这条路可行');
    } else {
      console.log('\n✗ 没有变成 Active，方舟原文:', JSON.stringify(final).slice(0, 600));
    }
  } finally {
    console.log('\n=== 5. 清理（把配额还回去）===');
    await cleanup();
  }
}

main().catch((error) => { console.error('\n探测失败:', error.message); process.exit(1); });
