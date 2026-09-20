export interface ClipboardWriter {
  writeText(value: string): Promise<void>
}

export async function writeClipboardText(value: string, clipboard: ClipboardWriter): Promise<void> {
  await clipboard.writeText(value)
}
