import { Schema } from "effect";

export const ATTACHMENT_MARKER_KIND = "attachment" as const;

export const MAX_ATTACHMENT_BYTES = 150 * 1024 * 1024;

const AttachmentMarkerSchema = Schema.Struct({
  kind: Schema.Literal(ATTACHMENT_MARKER_KIND),
  fileName: Schema.String,
  savedName: Schema.String,
  relativePath: Schema.String,
  size: Schema.Number,
  contentType: Schema.String,
  botId: Schema.String,
  conversationId: Schema.String,
});

export type AttachmentMarker = typeof AttachmentMarkerSchema.Type;

export function attachmentRelativePath(conversationId: string, savedName: string): string {
  return `./receivedFiles/${conversationId}/${savedName}`;
}

export function attachmentPromptNote(relativePath: string): string {
  return `the user attached a file to this message and it has been saved in ${relativePath}`;
}

export function encodeAttachmentMarker(marker: Omit<AttachmentMarker, "kind">): string {
  const body: AttachmentMarker = {
    kind: ATTACHMENT_MARKER_KIND,
    ...marker,
  };
  return JSON.stringify(body);
}

export function parseAttachmentMarker(content: string): AttachmentMarker | null {
  const trimmed = content.trim();
  if (!trimmed.startsWith("{")) return null;
  try {
    return Schema.decodeUnknownSync(AttachmentMarkerSchema)(JSON.parse(trimmed));
  } catch {
    return null;
  }
}

export function sanitizeAttachmentFileName(raw: string): string {
  const base = raw.replace(/\\/g, "/").split("/").pop() ?? "";
  const cleaned = base.replace(/\0/g, "").trim();
  if (cleaned.length === 0 || cleaned === "." || cleaned === "..") return "file";
  return cleaned;
}
