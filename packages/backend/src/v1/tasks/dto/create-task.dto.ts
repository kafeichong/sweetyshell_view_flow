export class CreateTaskDto {
  preflightId?: string;
  executionSlotId?: string;
  media?: { slotId?: string; assetId?: string }[];
  mode?: 'preview' | 'production';
}
