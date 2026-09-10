export class CreateTaskDto {
  capability!: string;
  profile!: string;
  params!: Record<string, unknown>;
  mode?: 'preview' | 'production';
}
