/**
 * 真账号付费联调：验证**方舟认不认 asset:// 当参考素材**。
 *
 * 这是唯一没法用单测覆盖的一环——`asset://` 能不能被接受只有方舟说了算。
 * 跑完把成片放进我方 OSS 并签一个长期地址，方便肉眼确认虚拟人像有没有传过去。
 *
 * 用法：node ark_asset_generation_probe.js <arkAssetId> [prompt]
 */
const fs = require('fs');
const path = require('path');
const OSS = require(path.join(__dirname, 'packages/backend/node_modules/ali-oss'));

const BASE = 'https://ark.cn-beijing.volces.com/api/v3';
const MODEL = 'doubao-seedance-2-5-260628';
const VIEW_URL_SECONDS = 24 * 3600;

// 由素材决定输出比例：这张头像是 800×1600（0.5），9:16 与它同向。
const RATIO = '9:16';
const RESOLUTION = '720p';
const DURATION = 4;

function loadEnv() {
  const file = '/Users/steven/works/20260909video_flow/.env';
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const match = /^([A-Z_]+)=(.*)$/.exec(line.trim());
    if (match && process.env[match[1]] === undefined) process.env[match[1]] = match[2];
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function createTask(apiKey, arkAssetId, prompt) {
  const response = await fetch(`${BASE}/contents/generations/tasks`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model: MODEL,
      content: [
        { type: 'text', text: prompt },
        // 关键：参考素材走 asset://，不是我方 OSS 地址。含真人人脸的素材只有这条能过。
        { type: 'image_url', image_url: { url: `asset://${arkAssetId}` }, role: 'reference_image' },
      ],
      generate_audio: true,
      ratio: RATIO,
      resolution: RESOLUTION,
      duration: DURATION,
      watermark: false,
    }),
  });
  const text = await response.text();
  let payload = null;
  try { payload = JSON.parse(text); } catch { /* 原样带出去 */ }
  if (!response.ok) {
    // 失败也要把方舟的原文带出来：拒绝的原因正是这次联调要问的问题。
    throw new Error(`创建任务失败 HTTP ${response.status}: ${text.slice(0, 800)}`);
  }
  return payload;
}

async function waitForTask(apiKey, taskId) {
  for (let attempt = 1; attempt <= 60; attempt += 1) {
    const response = await fetch(`${BASE}/contents/generations/tasks/${taskId}`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    const payload = await response.json();
    const status = payload?.status;
    if (status === 'succeeded' || status === 'failed') return payload;
    console.log(`  轮询 ${attempt}: ${status}`);
    await sleep(10_000);
  }
  throw new Error('轮询超时');
}

async function main() {
  const [arkAssetId, promptArg] = process.argv.slice(2);
  if (!arkAssetId) throw new Error('用法: node ark_asset_generation_probe.js <arkAssetId> [prompt]');
  loadEnv();

  const apiKey = process.env.VOLCENGINE_ACCESS_KEY;
  if (!apiKey) throw new Error('.env 里没有 VOLCENGINE_ACCESS_KEY');

  const prompt = promptArg
    ?? `图片1中的女孩正面朝向镜头，微笑并轻轻点头，镜头缓慢推近到近景。室内柔和自然光，背景干净，人物面部始终清晰，画面无字幕。`;

  console.log('=== 提交生成任务（真实付费）===');
  console.log('  模型   :', MODEL);
  console.log('  参考素材:', `asset://${arkAssetId}`);
  console.log('  参数   :', `${RESOLUTION} / ${RATIO} / ${DURATION}s / 有声 / 无水印`);
  console.log('  提示词 :', prompt);

  const created = await createTask(apiKey, arkAssetId, prompt);
  const taskId = created?.id;
  if (!taskId) throw new Error(`创建任务没有返回 id: ${JSON.stringify(created).slice(0, 400)}`);
  console.log('\n✓ 方舟**接受了** asset:// —— 任务已创建');
  console.log('  providerTaskId:', taskId);

  const finished = await waitForTask(apiKey, taskId);
  console.log('\n终态:', finished.status);
  if (finished.status !== 'succeeded') {
    console.log('方舟原文:', JSON.stringify(finished, null, 2).slice(0, 1200));
    return;
  }
  console.log('  usage:', JSON.stringify(finished.usage));
  console.log('  video_url 前缀:', String(finished.content?.video_url ?? '').slice(0, 60) + '…');

  const videoUrl = finished.content?.video_url;
  const bytes = Buffer.from(await (await fetch(videoUrl)).arrayBuffer());
  console.log(`\n成片大小: ${bytes.length} 字节`);

  const client = new OSS({
    region: process.env.OSS_REGION,
    accessKeyId: process.env.OSS_ACCESS_KEY_ID,
    accessKeySecret: process.env.OSS_ACCESS_KEY_SECRET,
    bucket: process.env.OSS_BUCKET,
    secure: true,
  });
  const objectKey = `probe-output/ark-asset-${arkAssetId}-${Date.now()}.mp4`;
  await client.put(objectKey, bytes, { mime: 'video/mp4' });
  const viewUrl = client.signatureUrl(objectKey, { method: 'GET', expires: VIEW_URL_SECONDS });

  console.log('\n=== 取证 ===');
  console.log('  桶      :', process.env.OSS_BUCKET);
  console.log('  objectKey:', objectKey);
  console.log('  有效期  : 24 小时（过期后重新签一次即可，对象不会删）');
  console.log('\n观看地址:\n' + viewUrl);
}

main().catch((error) => {
  console.error('\n✗ 联调失败:', error.message);
  process.exit(1);
});
