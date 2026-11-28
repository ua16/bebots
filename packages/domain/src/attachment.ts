export const ATTACHMENT_MARKER_KIND = "attachment" as const;

export const MAX_ATTACHMENT_BYTES = 150 * 1024 * 1024;

export interface AttachmentMarker {
  readonly kind: typeof ATTACHMENT_MARKER_KIND;
  readonly fileName: string;
  readonly savedName: string;
  readonly relativePath: string;
  readonly size: number;
  readonly contentType: string;
  readonly botId: string;
  readonly conversationId: string;
}

export function attachmentRelativePath(
  conversationId: string,
  savedName: string,
): string {
  return `./receivedFiles/${conversationId}/${savedName}`;
}

export function attachmentPromptNote(relativePath: string): string {
  return `the user attached a file to this message and it has been saved in ${relativePath}`;
}

/** Persist one uploaded file as a structured system-message body. */
export function encodeAttachmentMarker(marker: Omit<AttachmentMarker, "kind">): string {
  const body: AttachmentMarker = {
    kind: ATTACHMENT_MARKER_KIND,
    ...marker,
  };
  return JSON.stringify(body);
}

/** Parse a system-message body into an attachment marker, or null if unrelated. */
export function parseAttachmentMarker(content: string): AttachmentMarker | null {
  const trimmed = content.trim();
  if (!trimmed.startsWith("{")) return null;
  try {
    const parsed = JSON.parse(trimmed) as Partial<AttachmentMarker>;
    if (
      parsed.kind !== ATTACHMENT_MARKER_KIND ||
      typeof parsed.fileName !== "string" ||
      typeof parsed.savedName !== "string" ||
      typeof parsed.relativePath !== "string" ||
      typeof parsed.size !== "number" ||
      typeof parsed.contentType !== "string" ||
      typeof parsed.botId !== "string" ||
      typeof parsed.conversationId !== "string"
    ) {
      return null;
    }
    return {
      kind: ATTACHMENT_MARKER_KIND,
      fileName: parsed.fileName,
      savedName: parsed.savedName,
      relativePath: parsed.relativePath,
      size: parsed.size,
      contentType: parsed.contentType,
      botId: parsed.botId,
      conversationId: parsed.conversationId,
    };
  } catch {
    return null;
  }
}

/** Strip path segments and null bytes; fall back to a generic name. */
export function sanitizeAttachmentFileName(raw: string): string {
  const base = raw.replace(/\\/g, "/").split("/").pop() ?? "";
  const cleaned = base.replace(/\0/g, "").trim();
  if (cleaned.length === 0 || cleaned === "." || cleaned === "..") return "file";
  return cleaned;
}
