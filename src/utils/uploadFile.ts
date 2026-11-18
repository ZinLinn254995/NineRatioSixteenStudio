const CHUNK_SIZE_BYTES = 4 * 1024 * 1024; // 4 MB chunks (safely under proxy/Cloud Run 32 MB limit)
const MAX_UPLOAD_BYTES = 500 * 1024 * 1024; // 500 MB cumulative upload limit

export async function safeReadJson<T = Record<string, unknown>>(resp: Response): Promise<T> {
  const contentType = resp.headers.get("content-type") || "";
  const text = await resp.text();
  if (contentType.includes("application/json")) {
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new Error(`Invalid JSON response (HTTP ${resp.status}).`);
    }
  }

  // Fallback: maybe JSON without header, or HTML error page from proxy
  const trimmed = text.trim();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      return JSON.parse(trimmed) as T;
    } catch {
      // fall through
    }
  }

  const titleMatch = trimmed.match(/<title>([^<]+)<\/title>/i);
  const hint = titleMatch?.[1]?.trim() || `HTTP ${resp.status}`;
  throw new Error(`Upload/processing request failed (${hint}). Please try again.`);
}

async function abortUploadSession(uploadId: string): Promise<void> {
  try {
    await fetch("/api/upload-abort", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ uploadId }),
      keepalive: true,
    });
  } catch {
    // Ignore best-effort cleanup errors
  }
}

export async function uploadBlobInChunks(
  blob: Blob,
  fileName = "video.mp4"
): Promise<string> {
  if (!blob || blob.size <= 0) {
    throw new Error("Selected video file is empty or unreadable.");
  }
  if (blob.size > MAX_UPLOAD_BYTES) {
    throw new Error("Video file exceeds the 500 MB upload limit.");
  }

  const initResp = await fetch("/api/upload-init", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ fileName, totalSize: blob.size }),
  });
  const initData = await safeReadJson<{ uploadId?: string; error?: string }>(initResp);
  if (!initResp.ok || !initData.uploadId) {
    throw new Error(initData.error || "Failed to start chunked upload.");
  }

  const uploadId = initData.uploadId;
  try {
    for (let offset = 0; offset < blob.size; offset += CHUNK_SIZE_BYTES) {
      const chunk = blob.slice(offset, Math.min(blob.size, offset + CHUNK_SIZE_BYTES));
      let chunkUploaded = false;
      let lastErr: unknown = null;

      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const chunkResp = await fetch("/api/upload-chunk", {
            method: "POST",
            headers: {
              "Content-Type": "application/octet-stream",
              "x-upload-id": uploadId,
              "x-chunk-offset": String(offset),
            },
            body: chunk,
          });
          const chunkData = await safeReadJson<{ ok?: boolean; error?: string }>(chunkResp);
          if (chunkResp.ok) {
            chunkUploaded = true;
            break;
          }
          // Retry only on transient gateway/server errors
          const retryable = chunkResp.status >= 500 || chunkResp.status === 429;
          lastErr = new Error(chunkData.error || `Failed while uploading video chunk (HTTP ${chunkResp.status}).`);
          if (!retryable || attempt === 2) {
            throw lastErr;
          }
        } catch (err) {
          lastErr = err;
          if (attempt === 2) throw err;
        }
        await new Promise((r) => setTimeout(r, 400 * (attempt + 1)));
      }

      if (!chunkUploaded) {
        throw lastErr instanceof Error ? lastErr : new Error("Failed while uploading video chunk.");
      }
    }

    return uploadId;
  } catch (err) {
    await abortUploadSession(uploadId);
    throw err;
  }
}
