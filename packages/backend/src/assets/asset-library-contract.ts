/**
 * 合同里与私域素材库有关的那一节，供 assets 侧读取。
 *
 * 为什么单独成一个模块、而不是注入 `WorkflowCatalogService`：`TasksModule` 已经依赖
 * `AssetsModule`，反过来注入会成环。合同本身是只读的静态资源，直接读它比绕一圈依赖更清楚。
 */
type AssetLibraryContract = {
  uriScheme: string;
  roles: string[];
  projectName: string;
  assetIdPattern: string;
  unverifiedRoles: string[];
};

const contract = require('../tasks/resources/seedance-workflows.v2.json') as {
  media: { assetLibrary: AssetLibraryContract };
};

/**
 * 素材所属项目。**必须与生成用 API Key 所属项目一致**，否则素材在方舟侧用不了——
 * 而那个失败只在生成任务上暴露，最难查。2026-09-17 用真实账号核对过：素材组与
 * 生成 Key 都在 `default`。
 */
export const ASSET_LIBRARY: AssetLibraryContract = contract.media.assetLibrary;
