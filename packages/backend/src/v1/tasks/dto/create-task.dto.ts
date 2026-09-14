export class CreateTaskDto {
  // 旧客户端字段：保留兼容，Production 会映射到工作流注册表。
  capability?: string;
  profile?: string;
  params?: Record<string, unknown>;
  // 新统一工作流契约。
  workflowKey?: string;
  prompt?: { positive?: string };
  generation?: { duration?: number; ratio?: string; resolution?: string };
  media?: { assetId?: string; role?: string }[];
  mode?: 'preview' | 'production';
}
