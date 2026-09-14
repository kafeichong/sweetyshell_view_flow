export class UploadTicketDto {
  filename!: string;
  mimeType!: string;
  sizeBytes!: number;
  sha256?: string;
}
