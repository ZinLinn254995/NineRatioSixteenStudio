const CHUNK_SIZE_BYTES = 8 * 1024 * 1024; // 8 MB chunks (safely under Express 16 MB & Cloud Run 32 MB limits)
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

function createTimedSignal(
  timeoutMs: number,
  externalSignal?: AbortSignal
): { signal: AbortSignal; cleanup: () => void; didTimeout: () => boolean } {
  const controller = new AbortController();
  let timedOut = false;
  const timer = globalThis.setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  const onExternalAbort = () => controller.abort();
  if (externalSignal) {
    if (externalSignal.aborted) {
      controller.abort();
    } else {
      externalSignal.addEventListener("abort", onExternalAbort, { once: true });
    }
  }

  return {
    signal: controller.signal,
    didTimeout: () => timedOut,
    cleanup: () => {
      globalThis.clearTimeout(timer);
      externalSignal?.removeEventListener("abort", onExternalAbort);
    },
  };
}

export async function uploadBlobInChunks(
  blob: Blob,
  fileName = "video.mp4",
  signal?: AbortSignal,
  onProgress?: (fraction: number) => void
): Promise<string> {
  if (!blob || blob.size <= 0) {
    throw new Error("Selected video file is empty or unreadable.");
  }
  if (blob.size > MAX_UPLOAD_BYTES) {
    throw new Error("Video file exceeds the 500 MB upload limit.");
  }
  if (signal?.aborted) {
    throw new DOMException("Aborted", "AbortError");
  }

  const initTimed = createTimedSignal(20_000, signal);
  let initResp: Response;
  try {
    initResp = await fetch("/api/upload-init", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ fileName, totalSize: blob.size }),
      signal: initTimed.signal,
    });
  } catch (err) {
    if (initTimed.didTimeout()) {
      throw new Error("Timed out starting video upload. Please check your connection and try again.");
    }
    throw err;
  } finally {
    initTimed.cleanup();
  }

  const initData = await safeReadJson<{ uploadId?: string; error?: string }>(initResp);
  if (!initResp.ok || !initData.uploadId) {
    throw new Error(initData.error || "Failed to start chunked upload.");
  }

  const uploadId = initData.uploadId;
  try {
    for (let offset = 0; offset < blob.size; offset += CHUNK_SIZE_BYTES) {
      if (signal?.aborted) {
        throw new DOMException("Aborted", "AbortError");
      }
      const chunkEnd = Math.min(blob.size, offset + CHUNK_SIZE_BYTES);
      const chunk = blob.slice(offset, chunkEnd);
      let chunkUploaded = false;
      let lastErr: unknown = null;

      for (let attempt = 0; attempt < 3; attempt++) {
        if (signal?.aborted) {
          throw new DOMException("Aborted", "AbortError");
        }
        const chunkTimed = createTimedSignal(45_000, signal);
        try {
          const chunkResp = await fetch("/api/upload-chunk", {
            method: "POST",
            headers: {
              "Content-Type": "application/octet-stream",
              "x-upload-id": uploadId,
              "x-chunk-offset": String(offset),
            },
            body: chunk,
            signal: chunkTimed.signal,
          });
          const chunkData = await safeReadJson<{ ok?: boolean; error?: string }>(chunkResp);
          if (chunkResp.ok) {
            chunkUploaded = true;
            onProgress?.(Math.min(1, chunkEnd / blob.size));
            break;
          }
          // Retry only on transient gateway/server errors
          const retryable = chunkResp.status >= 500 || chunkResp.status === 429;
          lastErr = new Error(chunkData.error || `Failed while uploading video chunk (HTTP ${chunkResp.status}).`);
          if (!retryable || attempt === 2) {
            throw lastErr;
          }
        } catch (err) {
          if (signal?.aborted) {
            throw err;
          }
          const resolvedErr = chunkTimed.didTimeout()
            ? new Error("Video upload chunk timed out. Please check your network and try again.")
            : err;
          lastErr = resolvedErr;
          if (attempt === 2) throw resolvedErr;
        } finally {
          chunkTimed.cleanup();
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
