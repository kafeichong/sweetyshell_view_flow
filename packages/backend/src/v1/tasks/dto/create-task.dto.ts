export class CreateTaskDto {
  preflightId?: string;
  confirmLiveSubmission?: boolean;
  workflowKey?: string;
  prompt?: { positive?: string };
  generation?: { duration?: number; ratio?: string; resolution?: string };
  media?: { assetId?: string; role?: string }[];
  mode?: 'preview' | 'production';
}
