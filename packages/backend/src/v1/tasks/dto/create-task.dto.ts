export class CreateTaskDto {
  workflowKey?: string;
  prompt?: { positive?: string };
  generation?: { duration?: number; ratio?: string; resolution?: string };
  media?: { assetId?: string; role?: string }[];
  mode?: 'preview' | 'production';
}
