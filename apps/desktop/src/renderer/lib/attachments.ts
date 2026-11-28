import { MAX_ATTACHMENT_BYTES } from "@bebots/domain";
import type { ApiEndpoint } from "../apiClient";

export interface UploadedAttachment {
  readonly botId: string;
  readonly conversationId: string;
  readonly fileName: string;
  readonly savedName: string;
  readonly relativePath: string;
  readonly size: number;
  readonly contentType: string;
}

export interface StagedAttachment {
  readonly id: string;
  readonly file: File;
  /** 0–1 while uploading; null when staged / idle. */
  readonly progress: number | null;
}

export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function validateAttachmentFile(file: File): string | null {
  if (file.size > MAX_ATTACHMENT_BYTES) {
    return `"${file.name}" exceeds the 150 MB limit`;
  }
  return null;
}

export function uploadAttachment(
  endpoint: ApiEndpoint,
  conversationId: string,
  file: File,
  onProgress: (ratio: number) => void,
): Promise<UploadedAttachment> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    const url = `${endpoint.url}/api/v1/conversations/${encodeURIComponent(conversationId)}/attachments`;
    xhr.open("POST", url);
    xhr.setRequestHeader("Authorization", `Bearer ${endpoint.token}`);
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable && event.total > 0) {
        onProgress(event.loaded / event.total);
      }
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        try {
          resolve(JSON.parse(xhr.responseText) as UploadedAttachment);
        } catch (e) {
          reject(e);
        }
        return;
      }
      reject(new Error(`API ${url} failed: ${xhr.status}`));
    };
    xhr.onerror = () => reject(new Error(`API ${url} failed: network error`));
    const body = new FormData();
    body.append("file", file, file.name);
    xhr.send(body);
  });
}

export async function deleteUploadedAttachment(
  endpoint: ApiEndpoint,
  conversationId: string,
  botId: string,
  savedName: string,
): Promise<void> {
  const url = `${endpoint.url}/api/v1/conversations/${encodeURIComponent(conversationId)}/attachments/${encodeURIComponent(savedName)}?botId=${encodeURIComponent(botId)}`;
  const res = await fetch(url, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${endpoint.token}` },
  });
  if (!res.ok && res.status !== 404) {
    throw new Error(`API ${url} failed: ${res.status}`);
  }
}

export async function downloadAttachment(
  endpoint: ApiEndpoint,
  conversationId: string,
  botId: string,
  savedName: string,
  downloadName: string,
): Promise<void> {
  const url = `${endpoint.url}/api/v1/conversations/${encodeURIComponent(conversationId)}/attachments/${encodeURIComponent(savedName)}?botId=${encodeURIComponent(botId)}`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${endpoint.token}` },
  });
  if (!res.ok) {
    throw new Error(`API ${url} failed: ${res.status}`);
  }
  const blob = await res.blob();
  const objectUrl = URL.createObjectURL(blob);
  try {
    const anchor = document.createElement("a");
    anchor.href = objectUrl;
    anchor.download = downloadName;
    anchor.rel = "noopener";
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}
