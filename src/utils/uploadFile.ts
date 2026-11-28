import type { SubtitleGenerationProgress } from "../types";

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

export function formatReadableApiError(
  raw: unknown,
  fallback = "Processing failed. Please try again."
): string {
  const rawStr = raw instanceof Error ? raw.message : String(raw || "");
  const trimmed = rawStr.trim();
  if (!trimmed) return fallback;

  let msg = trimmed;
  let code = 0;
  let statusText = "";

  if (trimmed.startsWith("{")) {
    try {
      const parsed = JSON.parse(trimmed) as {
        error?: { code?: number; message?: string; status?: string } | string;
        code?: number;
        message?: string;
        status?: string;
      };
      const inner =
        parsed.error && typeof parsed.error === "object" ? parsed.error : parsed;
      if (typeof inner.code === "number") code = inner.code;
      if (typeof inner.status === "string") statusText = inner.status;
      if (typeof inner.message === "string" && inner.message.trim()) {
        msg = inner.message.trim();
      } else if (typeof parsed.error === "string" && parsed.error.trim()) {
        msg = parsed.error.trim();
      }
    } catch {
      // Keep trimmed text
    }
  }

  if (
    code === 503 ||
    /503|UNAVAILABLE|high demand|overloaded/i.test(`${statusText} ${msg}`)
  ) {
    return "Gemini AI is temporarily experiencing high demand (503). Please wait a few seconds and try again.";
  }
  if (
    code === 429 ||
    /429|RESOURCE_EXHAUSTED|rate limit|quota/i.test(`${statusText} ${msg}`)
  ) {
    return "AI rate limit or quota reached (429). Please wait a moment and try again, or check your API key in Settings > Secrets.";
  }
  if (
    code === 403 ||
    /PERMISSION_DENIED|API_KEY_INVALID|API key not valid/i.test(`${statusText} ${msg}`)
  ) {
    return "Gemini API key is invalid or lacks permission. Please check your API key in Settings > Secrets.";
  }
  if (
    (raw instanceof DOMException && raw.name === "NotReadableError") ||
    /NotReadableError|could not be read|permission problems that have occurred after a reference to a file was acquired/i.test(
      msg
    )
  ) {
    return "Your browser lost read access to this local video file (common on Android after switching tabs or sleep). Please re-link or re-select the video file and try again.";
  }
  if (/Command failed:\s*ffmpeg|\[libx264|frame=\s*\d+\s+fps=/i.test(msg)) {
    return "Video encoding timed out or failed on the server. Please try again.";
  }

  return msg.length > 320 ? `${msg.slice(0, 317)}...` : msg;
}

export async function readStreamingProcessResponse<T extends { error?: string }>(
  resp: Response,
  onProgress?: (ev: SubtitleGenerationProgress) => void
): Promise<T> {
  const contentType = resp.headers.get("content-type") || "";
  if (!contentType.includes("application/x-ndjson") || !resp.body) {
    const data = await safeReadJson<T>(resp);
    if (!resp.ok) {
      throw new Error(
        formatReadableApiError(data.error, `Processing failed (HTTP ${resp.status}).`)
      );
    }
    return data;
  }

  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let finalResult: T | null = null;
  let streamError: string | null = null;

  const handleLine = (rawLine: string) => {
    const line = rawLine.trim();
    if (!line) return;
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(line) as Record<string, unknown>;
    } catch {
      return;
    }
    if (parsed.type === "progress") {
      onProgress?.({
        stage: (parsed.stage as SubtitleGenerationProgress["stage"]) || "generating",
        label: String(parsed.label || "Generating subtitles..."),
        percent: Math.max(0, Math.min(100, Math.round(Number(parsed.percent) || 0))),
        clipIndex: typeof parsed.clipIndex === "number" ? parsed.clipIndex : undefined,
        totalClips: typeof parsed.totalClips === "number" ? parsed.totalClips : undefined,
      });
    } else if (parsed.type === "error") {
      streamError = formatReadableApiError(parsed.error, "Processing failed.");
    } else if (parsed.type === "result") {
      finalResult = parsed.data as T;
    }
  };

  while (true) {
    const { value, done } = await reader.read();
    if (value) {
      buffer += decoder.decode(value, { stream: true });
      let newlineIdx = buffer.indexOf("\n");
      while (newlineIdx !== -1) {
        const line = buffer.slice(0, newlineIdx);
        buffer = buffer.slice(newlineIdx + 1);
        handleLine(line);
        if (streamError) {
          await reader.cancel().catch(() => undefined);
          throw new Error(streamError);
        }
        newlineIdx = buffer.indexOf("\n");
      }
    }
    if (done) break;
  }

  buffer += decoder.decode();
  if (buffer.trim()) {
    handleLine(buffer);
  }
  if (streamError) {
    throw new Error(streamError);
  }
  if (!finalResult) {
    throw new Error("Processing ended before returning subtitles. Please try again.");
  }
  return finalResult;
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
    const chunkJobs: Array<{ offset: number; end: number }> = [];
    for (let offset = 0; offset < blob.size; offset += CHUNK_SIZE_BYTES) {
      chunkJobs.push({ offset, end: Math.min(blob.size, offset + CHUNK_SIZE_BYTES) });
    }

    const uploadedPerJob = new Array<number>(chunkJobs.length).fill(0);
    let totalUploaded = 0;
    let nextJobIdx = 0;
    const workerCount = Math.min(3, Math.max(1, chunkJobs.length));

    const runWorker = async () => {
      while (nextJobIdx < chunkJobs.length) {
        const jobIdx = nextJobIdx++;
        if (signal?.aborted) {
          throw new DOMException("Aborted", "AbortError");
        }
        const job = chunkJobs[jobIdx];
        const chunk = blob.slice(job.offset, job.end);
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
                "x-chunk-offset": String(job.offset),
                "x-chunk-mode": "parallel",
              },
              body: chunk,
              signal: chunkTimed.signal,
            });
            const chunkData = await safeReadJson<{ ok?: boolean; error?: string }>(chunkResp);
            if (chunkResp.ok) {
              chunkUploaded = true;
              const prev = uploadedPerJob[jobIdx];
              uploadedPerJob[jobIdx] = chunk.size;
              totalUploaded += chunk.size - prev;
              onProgress?.(Math.min(1, totalUploaded / blob.size));
              break;
            }
            const retryable = chunkResp.status >= 500 || chunkResp.status === 429;
            lastErr = new Error(
              chunkData.error || `Failed while uploading video chunk (HTTP ${chunkResp.status}).`
            );
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
    };

    await Promise.all(Array.from({ length: workerCount }, () => runWorker()));
    return uploadId;
  } catch (err) {
    await abortUploadSession(uploadId);
    throw err;
  }
}
