const CHUNK_SIZE_BYTES = 4 * 1024 * 1024; // 4 MB chunks (safely under proxy/Cloud Run 32 MB limit)

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

export async function uploadBlobInChunks(
  blob: Blob,
  fileName = "video.mp4"
): Promise<string> {
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
  for (let offset = 0; offset < blob.size; offset += CHUNK_SIZE_BYTES) {
    const chunk = blob.slice(offset, Math.min(blob.size, offset + CHUNK_SIZE_BYTES));
    const chunkResp = await fetch("/api/upload-chunk", {
      method: "POST",
      headers: {
        "Content-Type": "application/octet-stream",
        "x-upload-id": uploadId,
      },
      body: chunk,
    });
    const chunkData = await safeReadJson<{ ok?: boolean; error?: string }>(chunkResp);
    if (!chunkResp.ok) {
      throw new Error(chunkData.error || "Failed while uploading video chunk.");
    }
  }

  return uploadId;
}
