export const showcaseRoutes = {
  list: '/v1/showcase/tasks',
  video: (assetId: string) => `/v1/tasks/showcase/videos/${assetId}`,
  detail: (taskId: string) => `/v1/tasks/showcase/tasks/${taskId}`,
};
