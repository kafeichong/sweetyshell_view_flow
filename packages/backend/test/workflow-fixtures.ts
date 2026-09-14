/** 当前 v1 工作流合同的测试夹具；禁止再在合同测试中构造旧 capability/profile/params 请求。 */
export function referenceImageWorkflowRequest(prompt: string, assetId: string, resolution = 'test-resolution') {
  return {
    mode: 'production',
    workflowKey: 'seedance.reference-image-to-video.v1',
    prompt: { positive: prompt },
    generation: { duration: 5, ratio: '16:9', resolution },
    media: [{ assetId, role: 'reference_image' }],
  };
}

export function textPreviewWorkflowRequest(prompt: string, resolution = 'test-resolution') {
  return {
    mode: 'preview',
    workflowKey: 'seedance.text-to-video.v1',
    prompt: { positive: prompt },
    generation: { duration: 5, ratio: '16:9', resolution },
    media: [],
  };
}

export const inspectedImageFixture = {
  mimeType: 'image/jpeg',
  mediaMetadata: { kind: 'image', width: 1280, height: 720 },
};
