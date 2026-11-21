import { Muxer, ArrayBufferTarget } from "mp4-muxer";
import type { SubtitleItem, VideoEditSettings, VideoProject, VoiceSettings } from "../types";
import {
  applyAdversarialPerturbationToImageData,
  buildCssFilterString,
  createAdversarialPerturbationTile,
} from "./videoFilters";
import { uploadBlobInChunks } from "./uploadFile";
import { getEffectivePlaybackSpeed } from "./voicePresets";
import { getSceneDurationSec } from "./projectTimeline";

export interface ExportProgress {
  phase: "preparing" | "uploading" | "rendering" | "muxing" | "downloading";
  percent: number;
  detail?: string;
}

export interface ExportedVideoResult {
  blob: Blob;
  blobUrl: string;
  fileName: string;
  sizeBytes: number;
}

function buildSafeMp4FileName(title: string): string {
  const safeName = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 36);
  return `${safeName || "thai-burmese"}-9x16.mp4`;
}

function formatMb(bytes: number): string {
  return (bytes / (1024 * 1024)).toFixed(1);
}

function isLikelyValidMp4Header(bytes: Uint8Array): boolean {
  if (bytes.byteLength < 12) return false;
  // ISO BMFF / MP4 box starts with 4-byte size + "ftyp" (0x66 0x74 0x79 0x70)
  return (
    bytes[4] === 0x66 &&
    bytes[5] === 0x74 &&
    bytes[6] === 0x79 &&
    bytes[7] === 0x70
  );
}

const DOWNLOAD_CHUNK_BYTES = 8 * 1024 * 1024; // 8 MB Range chunks (4x below Cloud Run 32 MB limit)

async function fetchRangeChunkWithRetry(
  downloadUrl: string,
  start: number,
  end: number,
  signal?: AbortSignal
): Promise<{ bytes: Uint8Array<ArrayBuffer>; totalSize: number }> {
  let lastError: unknown = null;

  for (let attempt = 0; attempt < 3; attempt++) {
    if (signal?.aborted) {
      throw new DOMException("Export cancelled by user.", "AbortError");
    }

    const ctrl = new AbortController();
    let timedOut = false;
    const timer = window.setTimeout(() => {
      timedOut = true;
      ctrl.abort();
    }, 45_000);
    const onExtAbort = () => ctrl.abort();
    signal?.addEventListener("abort", onExtAbort, { once: true });

    try {
      const resp = await fetch(downloadUrl, {
        method: "GET",
        credentials: "same-origin",
        cache: "no-store",
        headers: {
          Range: `bytes=${start}-${end}`,
        },
        signal: ctrl.signal,
      });

      const contentType = (resp.headers.get("content-type") || "").toLowerCase();
      if (contentType.includes("text/html")) {
        throw new Error(
          "Download was blocked by a browser session check. Please refresh and try again."
        );
      }

      if (resp.status === 206 || resp.status === 200) {
        const buf = await resp.arrayBuffer();
        const bytes = new Uint8Array(buf);
        let totalSize = 0;
        const contentRange = resp.headers.get("content-range") || "";
        const rangeMatch = /\/(\d+)$/.exec(contentRange);
        if (rangeMatch) {
          totalSize = Number(rangeMatch[1]) || 0;
        } else if (resp.status === 200) {
          totalSize = Number(resp.headers.get("content-length") || 0) || bytes.byteLength;
        }
        return { bytes, totalSize };
      }

      const retryable = resp.status >= 500 || resp.status === 429;
      lastError = new Error(`Failed to fetch exported MP4 (HTTP ${resp.status}). Please try again.`);
      if (!retryable || attempt === 2) {
        throw lastError;
      }
    } catch (err) {
      if (signal?.aborted) {
        throw new DOMException("Export cancelled by user.", "AbortError");
      }
      const resolved = timedOut
        ? new Error("Timed out while transferring the exported MP4. Please try again.")
        : err;
      lastError = resolved;
      if (attempt === 2) {
        throw resolved;
      }
    } finally {
      window.clearTimeout(timer);
      signal?.removeEventListener("abort", onExtAbort);
    }

    await new Promise((r) => setTimeout(r, 400 * (attempt + 1)));
  }

  throw lastError instanceof Error
    ? lastError
    : new Error("Failed to transfer exported MP4. Please try again.");
}

async function fetchVerifiedMp4Blob(
  downloadUrl: string,
  expectedSizeBytes: number,
  fileName: string,
  onProgress: (p: ExportProgress) => void,
  signal?: AbortSignal
): Promise<ExportedVideoResult> {
  const chunks: BlobPart[] = [];
  let offset = 0;
  let totalSize = Math.max(0, expectedSizeBytes);

  onProgress({
    phase: "downloading",
    percent: 84,
    detail: totalSize > 0 ? `0.0 / ${formatMb(totalSize)} MB` : "Preparing file...",
  });

  while (true) {
    if (signal?.aborted) {
      throw new DOMException("Export cancelled by user.", "AbortError");
    }

    const chunkEnd =
      totalSize > 0
        ? Math.min(totalSize - 1, offset + DOWNLOAD_CHUNK_BYTES - 1)
        : offset + DOWNLOAD_CHUNK_BYTES - 1;

    const { bytes, totalSize: reportedTotal } = await fetchRangeChunkWithRetry(
      downloadUrl,
      offset,
      chunkEnd,
      signal
    );

    if (reportedTotal > 0) {
      totalSize = reportedTotal;
    }

    if (offset === 0) {
      if (bytes.byteLength < 12 || !isLikelyValidMp4Header(bytes)) {
        throw new Error("Server returned an invalid file instead of MP4. Please retry.");
      }
    }

    if (bytes.byteLength === 0) {
      break;
    }

    chunks.push(bytes);
    offset += bytes.byteLength;

    const progressRatio = totalSize > 0 ? Math.min(1, offset / totalSize) : 1;
    onProgress({
      phase: "downloading",
      percent: 84 + Math.min(15, Math.round(progressRatio * 15)),
      detail:
        totalSize > 0
          ? `${formatMb(Math.min(offset, totalSize))} / ${formatMb(totalSize)} MB`
          : `${formatMb(offset)} MB`,
    });

    if (totalSize > 0 && offset >= totalSize) {
      break;
    }
    if (totalSize === 0 && bytes.byteLength < DOWNLOAD_CHUNK_BYTES) {
      break;
    }
  }

  if (offset < 256) {
    throw new Error("Exported MP4 file was empty or incomplete. Please retry.");
  }

  const blob = new Blob(chunks, { type: "video/mp4" });
  onProgress({
    phase: "downloading",
    percent: 100,
    detail: `${formatMb(blob.size)} MB`,
  });

  return {
    blob,
    blobUrl: URL.createObjectURL(blob),
    fileName,
    sizeBytes: blob.size,
  };
}

function uint8ToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const slice = bytes.subarray(i, i + chunkSize);
    binary += String.fromCharCode(...slice);
  }
  return btoa(binary);
}

function wrapTextLines(
  ctx: CanvasRenderingContext2D,
  text: string,
  maxWidth: number
): string[] {
  const chars = Array.from(text);
  const lines: string[] = [];
  let current = "";
  // Prefer space splitting for Latin/spaced text; character wrapping for Burmese
  const hasSpaces = /\s/.test(text);
  if (hasSpaces && !/[\u1000-\u109F]/.test(text)) {
    const words = text.split(/\s+/);
    for (const w of words) {
      const test = current ? `${current} ${w}` : w;
      if (ctx.measureText(test).width > maxWidth && current) {
        lines.push(current);
        current = w;
      } else {
        current = test;
      }
    }
    if (current) lines.push(current);
    return lines;
  }

  for (const ch of chars) {
    const test = current + ch;
    if (ctx.measureText(test).width > maxWidth && current) {
      lines.push(current);
      current = ch;
    } else {
      current = test;
    }
  }
  if (current) lines.push(current);
  return lines;
}

interface MeasuredCard {
  sub: SubtitleItem;
  topY: number;
  height: number;
  wordLayouts: {
    phonetic: string;
    gloss: string;
    x: number;
    y: number;
    w: number;
    h: number;
    startTime: number;
    endTime: number;
  }[];
  thaiLines: string[];
  thaiStartY: number;
  burmeseLines: string[];
  burmeseStartY: number;
}

function measureSubtitleList(
  ctx: CanvasRenderingContext2D,
  subtitles: SubtitleItem[],
  width: number,
  opts: {
    showThaiScript?: boolean;
    showWordGloss?: boolean;
    showBurmeseLine?: boolean;
    fontScale?: number;
  } = {}
): { cards: MeasuredCard[]; totalHeight: number } {
  const showThaiScript = Boolean(opts.showThaiScript);
  const showWordGloss = opts.showWordGloss !== false;
  const showBurmeseLine = opts.showBurmeseLine !== false;
  const fs = opts.fontScale ?? 1;
  const padX = 40;
  const maxInnerW = width - padX * 2 - 28;
  let cursorY = 34;
  const cards: MeasuredCard[] = [];

  const phoneticFontPx = Math.round(28 * fs);
  const thaiFontPx = Math.round(20 * fs);
  const burmeseFontPx = Math.round(22 * fs);
  const thaiLineH = Math.round(28 * fs);
  const burmeseLineH = Math.round(34 * fs);

  for (const sub of subtitles) {
    const cardTop = cursorY;
    let y = 28;

    ctx.font = `600 ${phoneticFontPx}px 'Plus Jakarta Sans', sans-serif`;
    let lineX = 0;
    const rowGap = showWordGloss ? Math.round(56 * fs) : Math.round(42 * fs);
    const wordLayouts: MeasuredCard["wordLayouts"] = [];

    for (const w of sub.words) {
      const tokenWidth = ctx.measureText(w.phonetic).width + 18;
      if (lineX + tokenWidth > maxInnerW && lineX > 0) {
        lineX = 0;
        y += rowGap;
      }
      wordLayouts.push({
        phonetic: w.phonetic,
        gloss: showWordGloss ? w.burmeseGloss || "" : "",
        x: padX + 18 + lineX,
        y: cardTop + y,
        w: tokenWidth,
        h: Math.round(36 * fs),
        startTime: sub.startTime + w.startOffsetSec,
        endTime: sub.startTime + w.endOffsetSec,
      });
      lineX += tokenWidth + 8;
    }

    y += sub.words.length > 0 ? (showWordGloss ? Math.round(48 * fs) : Math.round(34 * fs)) : 12;

    let thaiLines: string[] = [];
    let thaiStartY = cardTop + y;
    if (showThaiScript && sub.thaiScript && sub.thaiScript.trim()) {
      ctx.font = `500 ${thaiFontPx}px 'Noto Sans Thai', 'Plus Jakarta Sans', sans-serif`;
      thaiLines = wrapTextLines(ctx, sub.thaiScript.trim(), maxInnerW - 10);
      y += 4;
      thaiStartY = cardTop + y;
      y += thaiLines.length * thaiLineH + 14;
    } else if (showBurmeseLine) {
      y += 14;
    }

    let burmeseLines: string[] = [];
    let burmeseStartY = cardTop + y;
    if (showBurmeseLine) {
      ctx.font = `500 ${burmeseFontPx}px 'Noto Sans Myanmar', 'Plus Jakarta Sans', sans-serif`;
      burmeseLines = wrapTextLines(ctx, sub.burmese, maxInnerW - 34);
      burmeseStartY = cardTop + y;
      y += burmeseLines.length * burmeseLineH + 22;
    } else {
      y += 14;
    }

    cards.push({
      sub,
      topY: cardTop,
      height: y,
      wordLayouts,
      thaiLines,
      thaiStartY,
      burmeseLines,
      burmeseStartY,
    });

    cursorY += y + 18;
  }

  return { cards, totalHeight: cursorY };
}

function drawRoundedRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number
) {
  ctx.beginPath();
  if (typeof ctx.roundRect === "function") {
    ctx.roundRect(x, y, w, h, r);
  } else {
    const rr = Math.min(r, w / 2, h / 2);
    ctx.moveTo(x + rr, y);
    ctx.lineTo(x + w - rr, y);
    ctx.quadraticCurveTo(x + w, y, x + w, y + rr);
    ctx.lineTo(x + w, y + h - rr);
    ctx.quadraticCurveTo(x + w, y + h, x + w - rr, y + h);
    ctx.lineTo(x + rr, y + h);
    ctx.quadraticCurveTo(x, y + h, x, y + h - rr);
    ctx.lineTo(x, y + rr);
    ctx.quadraticCurveTo(x, y, x + rr, y);
  }
  ctx.closePath();
}

function toProxiedImageUrl(url: string): string {
  if (url.startsWith("https://i.ytimg.com/")) {
    return `/api/image-proxy?url=${encodeURIComponent(url)}`;
  }
  return url;
}

async function loadImage(url: string): Promise<HTMLImageElement | null> {
  return new Promise((resolve) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    const timer = window.setTimeout(() => resolve(null), 8000);
    img.onload = () => {
      clearTimeout(timer);
      resolve(img);
    };
    img.onerror = () => {
      clearTimeout(timer);
      resolve(null);
    };
    img.src = toProxiedImageUrl(url);
  });
}

function mapCutTimeToSourceTime(project: VideoProject, cutTime: number): number {
  if (!project.scenes || project.scenes.length === 0) {
    return Math.max(0, cutTime);
  }
  let acc = 0;
  for (let i = 0; i < project.scenes.length; i++) {
    const scene = project.scenes[i];
    const dur = getSceneDurationSec(scene);
    if (cutTime <= acc + dur || i === project.scenes.length - 1) {
      return Math.min(scene.endSec, scene.startSec + Math.max(0, cutTime - acc));
    }
    acc += dur;
  }
  return 0;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new DOMException("Video export cancelled.", "AbortError");
  }
}

async function waitForVideoReady(video: HTMLVideoElement, signal?: AbortSignal): Promise<void> {
  throwIfAborted(signal);
  if (video.readyState >= 2 && video.videoWidth > 0) return;
  await new Promise<void>((resolve, reject) => {
    let done = false;
    let kickedDecode = false;
    const cleanup = () => {
      clearTimeout(timer);
      video.removeEventListener("loadedmetadata", onMetadata);
      video.removeEventListener("loadeddata", check);
      video.removeEventListener("canplay", check);
      video.removeEventListener("seeked", check);
      video.removeEventListener("error", finish);
      signal?.removeEventListener("abort", onAbort);
    };
    const finish = () => {
      if (done) return;
      done = true;
      cleanup();
      resolve();
    };
    const onAbort = () => {
      if (done) return;
      done = true;
      cleanup();
      reject(new DOMException("Video export cancelled.", "AbortError"));
    };
    const check = () => {
      if (video.readyState >= 2 && video.videoWidth > 0) {
        finish();
      }
    };
    const onMetadata = () => {
      if (video.readyState >= 2 && video.videoWidth > 0) {
        finish();
        return;
      }
      // On Android Chrome, a muted hidden <video> sometimes stays at HAVE_METADATA until nudged
      if (!kickedDecode && video.readyState >= 1) {
        kickedDecode = true;
        try {
          video.currentTime = 0.001;
        } catch {
          // ignore
        }
      }
    };
    const timer = window.setTimeout(finish, 8000);
    video.addEventListener("loadedmetadata", onMetadata);
    video.addEventListener("loadeddata", check);
    video.addEventListener("canplay", check);
    video.addEventListener("seeked", check);
    video.addEventListener("error", finish, { once: true });
    signal?.addEventListener("abort", onAbort, { once: true });
    try {
      video.load();
    } catch {
      // ignore
    }
  });
}

async function seekVideoToTime(
  video: HTMLVideoElement,
  targetSec: number,
  signal?: AbortSignal
): Promise<void> {
  throwIfAborted(signal);
  const dur = Number.isFinite(video.duration) && video.duration > 0 ? video.duration : targetSec + 1;
  const maxSeek = Math.max(0, dur - 0.04);
  const clamped = Math.max(0, Math.min(maxSeek, targetSec));

  if (Math.abs(video.currentTime - clamped) > 0.015 || video.seeking) {
    await new Promise<void>((resolve, reject) => {
      let done = false;
      const cleanup = () => {
        clearTimeout(timer);
        video.removeEventListener("seeked", onSeeked);
        signal?.removeEventListener("abort", onAbort);
      };
      const finish = () => {
        if (done) return;
        done = true;
        cleanup();
        resolve();
      };
      const onAbort = () => {
        if (done) return;
        done = true;
        cleanup();
        reject(new DOMException("Video export cancelled.", "AbortError"));
      };
      const onSeeked = () => finish();
      const timer = window.setTimeout(finish, 1200);
      video.addEventListener("seeked", onSeeked, { once: true });
      signal?.addEventListener("abort", onAbort, { once: true });
      video.currentTime = clamped;
    });
  }

  // Wait briefly until decoder confirms frame data is present and not mid-seek
  const waitStart = performance.now();
  while ((video.seeking || video.readyState < 2) && performance.now() - waitStart < 300) {
    throwIfAborted(signal);
    await new Promise((r) => setTimeout(r, 4));
  }
}

export async function exportProjectToMp4(
  project: VideoProject,
  darkMode: boolean,
  voiceSettings: VoiceSettings,
  editSettings: VideoEditSettings,
  onProgress: (p: ExportProgress) => void,
  signal?: AbortSignal
): Promise<ExportedVideoResult> {
  const width = 720;
  const height = 1280;
  const hasSubtitles = project.subtitles.length > 0;
  const heightPct = Math.max(26, Math.min(52, editSettings.videoHeightPct || 35));
  const rawTopH = hasSubtitles ? Math.round((height * heightPct) / 100) : height;
  const topVideoH = hasSubtitles
    ? Math.max(240, Math.min(height - 240, Math.round(rawTopH / 2) * 2))
    : height;
  const listH = height - topVideoH;
  const fps = 24;
  const speed = getEffectivePlaybackSpeed(
    project.sourceType,
    editSettings.playbackSpeed,
    voiceSettings.speed
  );
  const scenesDuration = project.scenes.reduce((acc, sc) => acc + getSceneDurationSec(sc), 0);
  const sourceTotalDuration = Math.max(0.5, scenesDuration || project.targetDurationSec || 10);
  const totalDuration = sourceTotalDuration / speed;
  const totalFrames = Math.max(1, Math.ceil(totalDuration * fps));
  const fileName = buildSafeMp4FileName(project.title);

  if (project.sourceType === "local" && !project.localUrl && !project.localFile) {
    throw new Error("Local video file is not linked. Please re-link or upload the video first.");
  }

  onProgress({ phase: "preparing", percent: 5 });

  let hiddenVideoHost: HTMLDivElement | null = null;
  let localVideoEl: HTMLVideoElement | null = null;
  let preparedClipUrl: string | null = null;
  let tempLocalUrl: string | null = null;

  try {
    throwIfAborted(signal);
    const makeTimedController = (timeoutMs: number) => {
      const ctrl = new AbortController();
      let timedOut = false;
      const timer = window.setTimeout(() => {
        timedOut = true;
        ctrl.abort();
      }, timeoutMs);
      const onExtAbort = () => ctrl.abort();
      if (signal) {
        if (signal.aborted) ctrl.abort();
        else signal.addEventListener("abort", onExtAbort, { once: true });
      }
      return {
        signal: ctrl.signal,
        didTimeout: () => timedOut,
        cleanup: () => {
          window.clearTimeout(timer);
          signal?.removeEventListener("abort", onExtAbort);
        },
      };
    };

    let resolvedUploadId = project.uploadId;
    if (project.sourceType === "local") {
      if (resolvedUploadId) {
        const existsTimed = makeTimedController(6000);
        try {
          const checkResp = await fetch(
            `/api/upload-exists/${encodeURIComponent(resolvedUploadId)}`,
            { signal: existsTimed.signal }
          );
          if (checkResp.ok) {
            const checkData = (await checkResp.json()) as { exists?: boolean };
            if (!checkData.exists) {
              resolvedUploadId = undefined;
            }
          }
        } catch (err) {
          throwIfAborted(signal);
          void err;
        } finally {
          existsTimed.cleanup();
        }
      }
      if (!resolvedUploadId && project.localFile) {
        throwIfAborted(signal);
        const totalMb = formatMb(project.localFile.size);
        onProgress({
          phase: "uploading",
          percent: 5,
          detail: `0.0 / ${totalMb} MB`,
        });
        resolvedUploadId = await uploadBlobInChunks(
          project.localFile,
          project.localFile.name,
          signal,
          (fraction) => {
            const sentMb = formatMb(project.localFile!.size * fraction);
            onProgress({
              phase: "uploading",
              percent: 5 + Math.round(fraction * 23),
              detail: `${sentMb} / ${totalMb} MB`,
            });
          }
        );
        project.uploadId = resolvedUploadId;
      }
    }

    throwIfAborted(signal);

    // Ensure fonts are loaded before measuring canvas text, with a hard 2.5s timeout
    if (document.fonts && document.fonts.ready) {
      await Promise.race([
        document.fonts.ready.catch(() => undefined),
        new Promise<void>((resolve) => window.setTimeout(resolve, 2500)),
      ]);
    }

    throwIfAborted(signal);
    onProgress({ phase: "preparing", percent: 28, detail: "Initializing layout..." });

    // FAST SERVER-COMPOSITE PATH FOR LOCAL VIDEOS:
    // Eliminates downloading prepared clips & eliminates slow Android <video> frame-by-frame seeking!
    // Phone renders ONLY the lightweight 2D subtitle strip (if subtitles exist) at 15fps,
    // and server FFmpeg composites native source video + subtitle strip + voice audio in ONE fast pass.
    if (project.sourceType === "local" && resolvedUploadId) {
      let subtitleBase64: string | undefined;
      let subtitleUploadId: string | undefined;
      let subtitleFormat: "mp4" | "webm" = "mp4";
      let subtitleForceCfr = false;
      let subtitleRecordedDurationSec: number | undefined;
      const subFps = 15;

      if (hasSubtitles && listH >= 120) {
        const subCanvas = document.createElement("canvas");
        subCanvas.width = width;
        subCanvas.height = listH;
        const subCtx = subCanvas.getContext("2d", { alpha: false })!;

        const subFontScale =
          editSettings.subtitleFontScale === "sm"
            ? 0.86
            : editSettings.subtitleFontScale === "lg"
              ? 1.16
              : 1;
        const subTheme: "light" | "dark" | "warm" =
          editSettings.subtitleTheme === "warm"
            ? "warm"
            : editSettings.subtitleTheme === "light"
              ? "light"
              : editSettings.subtitleTheme === "dark"
                ? "dark"
                : darkMode
                  ? "dark"
                  : "light";
        const subHl = editSettings.subtitleHighlightColor || "indigo";
        const showWordGloss = editSettings.showWordGloss !== false;
        const showBurmeseLine = editSettings.showBurmeseLine !== false;

        const { cards } = measureSubtitleList(subCtx, project.subtitles, width, {
          showThaiScript: Boolean(editSettings.showThaiScript),
          showWordGloss,
          showBurmeseLine,
          fontScale: subFontScale,
        });

        const getSubActiveCardIndex = (t: number): number => {
          let activeIdx = -1;
          let lastStartedIdx = -1;
          for (let i = 0; i < cards.length; i++) {
            const sub = cards[i].sub;
            if (t >= sub.startTime) {
              if (lastStartedIdx === -1 || sub.startTime >= cards[lastStartedIdx].sub.startTime) {
                lastStartedIdx = i;
              }
              if (t <= sub.endTime) {
                activeIdx = i;
              }
            }
          }
          return activeIdx >= 0 ? activeIdx : lastStartedIdx;
        };

        const getSubScrollYForTime = (t: number): number => {
          let anchorIdx = getSubActiveCardIndex(t);
          if (anchorIdx < 0) {
            for (let i = 0; i < cards.length; i++) {
              if (t >= cards[i].sub.startTime) anchorIdx = i;
              else break;
            }
          }
          const active = cards[Math.max(0, anchorIdx)];
          if (!active) return 0;
          const desiredCenter = active.topY + active.height * 0.5 - listH * 0.42;
          return Math.max(0, desiredCenter);
        };

        let subScrollY = 0;
        const isDarkPanel = subTheme === "dark";
        const isWarmPanel = subTheme === "warm";
        const phoneticPx = Math.round(28 * subFontScale);
        const glossPx = Math.round(13 * subFontScale);
        const thaiPx = Math.round(20 * subFontScale);
        const thaiLineH = Math.round(28 * subFontScale);
        const idxPx = Math.round(15 * subFontScale);
        const burmesePx = Math.round(22 * subFontScale);
        const burmeseLineH = Math.round(34 * subFontScale);
        const pillFill =
          subHl === "emerald"
            ? isDarkPanel
              ? "#127d5c"
              : "#0d7456"
            : subHl === "indigo"
              ? isDarkPanel
                ? "#2952d6"
                : "#1c3db8"
              : subHl === "rose"
                ? isDarkPanel
                  ? "#a12f88"
                  : "#8b2574"
                : isDarkPanel
                  ? "#cc801a"
                  : "#b0580c";
        const pillTextFill =
          subHl === "amber" && isDarkPanel ? "#0f172a" : "#ffffff";

        const renderSubtitleOnlyFrame = (t: number) => {
          subCtx.fillStyle = isDarkPanel ? "#080b1a" : isWarmPanel ? "#fbf7ef" : "#f8faff";
          subCtx.fillRect(0, 0, width, listH);

          // Top 1px divider separating video and subtitle panel
          subCtx.fillStyle = isDarkPanel ? "#21284c" : isWarmPanel ? "#e7dcc8" : "#d2dcf0";
          subCtx.fillRect(0, 0, width, 1);

          const ht = Math.min(sourceTotalDuration, t + 0.06);
          const targetScroll = getSubScrollYForTime(ht);
          subScrollY += (targetScroll - subScrollY) * 0.22;

          subCtx.save();
          subCtx.beginPath();
          subCtx.rect(0, 1, width, listH - 1);
          subCtx.clip();
          subCtx.translate(0, -subScrollY);

          const activeCardIdx = getSubActiveCardIndex(ht);

          for (let ci = 0; ci < cards.length; ci++) {
            const card = cards[ci];
            const screenTop = card.topY - subScrollY;
            if (screenTop + card.height < -60 || screenTop > listH + 60) continue;

            const isActive = ci === activeCardIdx;
            subCtx.fillStyle = isActive
              ? isDarkPanel
                ? "#12183a"
                : isWarmPanel
                  ? "#fffdf8"
                  : "#ffffff"
              : isDarkPanel
                ? "rgba(13, 18, 41, 0.72)"
                : isWarmPanel
                  ? "rgba(244, 237, 224, 0.72)"
                  : "rgba(255, 255, 255, 0.75)";
            drawRoundedRect(subCtx, 22, card.topY, width - 44, card.height, 18);
            subCtx.fill();
            subCtx.strokeStyle = isActive
              ? isDarkPanel
                ? "rgba(78, 126, 247, 0.5)"
                : isWarmPanel
                  ? "#dfae52"
                  : "#8da2ea"
              : isDarkPanel
                ? "#1e264a"
                : isWarmPanel
                  ? "#e5dac6"
                  : "#e2e8f5";
            subCtx.lineWidth = isActive ? 1.75 : 1;
            subCtx.stroke();

            subCtx.fillStyle = isActive
              ? isDarkPanel
                ? "#5b85f7"
                : isWarmPanel
                  ? "#b86310"
                  : "#1c3db8"
              : isDarkPanel
                ? "#1e264a"
                : isWarmPanel
                  ? "#dfd3be"
                  : "#e2e8f5";
            drawRoundedRect(subCtx, 32, card.topY + 18, 5, Math.max(24, card.height - 36), 3);
            subCtx.fill();

            for (let wi = 0; wi < card.wordLayouts.length; wi++) {
              const wl = card.wordLayouts[wi];
              const isLastWord = wi === card.wordLayouts.length - 1;
              const isSpoken =
                isActive &&
                ht >= wl.startTime &&
                (isLastWord ? ht <= wl.endTime : ht < wl.endTime);
              const wasSpoken = isActive && (isLastWord ? ht > wl.endTime : ht >= wl.endTime);

              if (isSpoken) {
                const pillH = Math.round(38 * subFontScale);
                subCtx.fillStyle = pillFill;
                drawRoundedRect(
                  subCtx,
                  wl.x - 4,
                  wl.y - Math.round(26 * subFontScale),
                  wl.w + 2,
                  pillH,
                  9
                );
                subCtx.fill();
              }

              subCtx.font = `600 ${phoneticPx}px 'Plus Jakarta Sans', sans-serif`;
              if (isSpoken) {
                subCtx.fillStyle = pillTextFill;
              } else if (isActive) {
                subCtx.fillStyle = isDarkPanel
                  ? wasSpoken
                    ? "#8cb5f5"
                    : "#cbd5e1"
                  : isWarmPanel
                    ? wasSpoken
                      ? "#944808"
                      : "#292524"
                    : wasSpoken
                      ? "#1938a8"
                      : "#334155";
              } else {
                subCtx.fillStyle = isWarmPanel ? "#78716c" : "#64748b";
              }
              subCtx.fillText(wl.phonetic, wl.x + 5, wl.y);

              if (wl.gloss) {
                subCtx.font = `500 ${glossPx}px 'Noto Sans Myanmar', sans-serif`;
                subCtx.fillStyle = isSpoken
                  ? subHl === "emerald"
                    ? isDarkPanel
                      ? "#43b892"
                      : "#0b664b"
                    : subHl === "indigo"
                      ? isDarkPanel
                        ? "#80a6ff"
                        : "#1836a3"
                      : subHl === "rose"
                        ? isDarkPanel
                          ? "#e386cf"
                          : "#7d1e68"
                        : isDarkPanel
                          ? "#e5a64e"
                          : "#9c4b08"
                  : isActive
                    ? isDarkPanel
                      ? "#6c97f8"
                      : "#1c3db8"
                    : isDarkPanel
                      ? "#515e87"
                      : isWarmPanel
                        ? "#a8a29e"
                        : "#94a3b8";
                subCtx.fillText(wl.gloss, wl.x + 5, wl.y + Math.round(22 * subFontScale));
              }
            }

            if (card.thaiLines.length > 0) {
              subCtx.font = `500 ${thaiPx}px 'Noto Sans Thai', 'Plus Jakarta Sans', sans-serif`;
              subCtx.fillStyle = isActive
                ? isDarkPanel
                  ? "#e2e8f0"
                  : isWarmPanel
                    ? "#44403c"
                    : "#334155"
                : isWarmPanel
                  ? "#78716c"
                  : "#64748b";
              card.thaiLines.forEach((line, li) => {
                subCtx.fillText(line, 58, card.thaiStartY + li * thaiLineH);
              });
            }

            if (showBurmeseLine) {
              if (card.wordLayouts.length > 0 || card.thaiLines.length > 0) {
                const dividerY = card.burmeseStartY - 30;
                subCtx.fillStyle = isActive
                  ? isDarkPanel
                    ? "rgba(78, 126, 247, 0.28)"
                    : isWarmPanel
                      ? "#ebd197"
                      : "#d3dff8"
                  : isDarkPanel
                    ? "#1e264a"
                    : isWarmPanel
                      ? "#e7dcc8"
                      : "#f1f5f9";
                subCtx.fillRect(54, dividerY, width - 96, 1);
              }

              subCtx.font = `600 ${idxPx}px 'JetBrains Mono', monospace`;
              subCtx.fillStyle = isActive
                ? isDarkPanel
                  ? "#5b85f7"
                  : isWarmPanel
                    ? "#a3550b"
                    : "#1c3db8"
                : isDarkPanel
                  ? "#515e87"
                  : isWarmPanel
                    ? "#a8a29e"
                    : "#94a3b8";
              subCtx.fillText(String(ci + 1).padStart(2, "0"), 54, card.burmeseStartY - 1);

              subCtx.font = `500 ${burmesePx}px 'Noto Sans Myanmar', 'Plus Jakarta Sans', sans-serif`;
              subCtx.fillStyle = isActive
                ? isDarkPanel
                  ? "#99b8ff"
                  : "#122b87"
                : isWarmPanel
                  ? "#57534e"
                  : "#64748b";
              card.burmeseLines.forEach((line, li) => {
                subCtx.fillText(line, 86, card.burmeseStartY + li * burmeseLineH);
              });
            }
          }
          subCtx.restore();
        };

        const subTotalFrames = Math.max(1, Math.ceil(totalDuration * subFps));
        const encodeSubStripWebCodecs = async (
          hwAccel: HardwareAcceleration
        ): Promise<Uint8Array | null> => {
          if (typeof VideoEncoder === "undefined") return null;
          const codecsToTry = [
            "avc1.420028",
            "avc1.4d0028",
            "avc1.42001f",
            "avc1.4d001f",
          ];
          let chosenConfig: VideoEncoderConfig | null = null;
          for (const codec of codecsToTry) {
            const cfg: VideoEncoderConfig = {
              codec,
              width,
              height: listH,
              bitrate: 1_200_000,
              framerate: subFps,
              latencyMode: "realtime",
              hardwareAcceleration: hwAccel,
              avc: { format: "avc" },
            };
            try {
              const support = await VideoEncoder.isConfigSupported(cfg);
              if (support.supported) {
                chosenConfig = support.config || cfg;
                break;
              }
            } catch {
              // continue
            }
          }
          if (!chosenConfig) return null;

          subScrollY = 0;
          let encoderError: Error | null = null;
          const target = new ArrayBufferTarget();
          const muxer = new Muxer({
            target,
            video: { codec: "avc", width, height: listH, frameRate: subFps },
            fastStart: "in-memory",
            firstTimestampBehavior: "offset",
          });
          const encoder = new VideoEncoder({
            output: (chunk, meta) => {
              try {
                muxer.addVideoChunk(chunk, meta);
              } catch (err) {
                encoderError = err instanceof Error ? err : new Error(String(err));
              }
            },
            error: (err) => {
              encoderError = err instanceof Error ? err : new Error(String(err));
            },
          });
          encoder.configure(chosenConfig);

          try {
            for (let frameIdx = 0; frameIdx < subTotalFrames; frameIdx++) {
              throwIfAborted(signal);
              if (encoderError || encoder.state !== "configured") return null;

              const t = (frameIdx / subFps) * speed;
              renderSubtitleOnlyFrame(t);

              const frame = new VideoFrame(subCanvas, {
                timestamp: Math.round((frameIdx * 1_000_000) / subFps),
                duration: Math.round(1_000_000 / subFps),
              });
              try {
                encoder.encode(frame, { keyFrame: frameIdx % (subFps * 2) === 0 });
              } finally {
                frame.close();
              }

              const queueWaitStart = performance.now();
              while (encoder.encodeQueueSize > 8 && !encoderError) {
                throwIfAborted(signal);
                if (performance.now() - queueWaitStart > 4000) {
                  encoderError = new Error("Subtitle encoder stalled.");
                  break;
                }
                await new Promise((r) => setTimeout(r, 4));
              }

              if (frameIdx % 10 === 0) {
                onProgress({
                  phase: "rendering",
                  percent: 28 + Math.round((frameIdx / subTotalFrames) * 34),
                  detail: `Frame ${frameIdx} / ${subTotalFrames}`,
                });
                await new Promise((r) => setTimeout(r, 0));
              }
            }

            if (encoderError) return null;
            throwIfAborted(signal);
            const flushResult = await Promise.race([
              encoder.flush().then(() => "ok" as const),
              new Promise<"timeout">((resolve) => window.setTimeout(() => resolve("timeout"), 8000)),
            ]);
            throwIfAborted(signal);
            if (flushResult === "timeout" || encoderError) return null;

            muxer.finalize();
            const bytes = new Uint8Array(target.buffer);
            return bytes.byteLength >= 512 && !encoderError ? bytes : null;
          } finally {
            try {
              if (encoder.state !== "closed") encoder.close();
            } catch {
              // ignore
            }
          }
        };

        onProgress({ phase: "rendering", percent: 28, detail: "Rendering subtitles..." });
        let subBytes = await encodeSubStripWebCodecs("no-preference");
        throwIfAborted(signal);
        if (!subBytes) {
          subBytes = await encodeSubStripWebCodecs("prefer-software");
        }
        throwIfAborted(signal);

        if (!subBytes && typeof MediaRecorder !== "undefined" && typeof subCanvas.captureStream === "function") {
          subScrollY = 0;
          renderSubtitleOnlyFrame(0);
          const probeStream = subCanvas.captureStream(0);
          const probeTrack = probeStream.getVideoTracks()[0] as
            | (MediaStreamTrack & { requestFrame?: () => void })
            | undefined;
          const useManual = typeof probeTrack?.requestFrame === "function";
          let stream = probeStream;
          let track = probeTrack;
          if (!useManual) {
            probeStream.getTracks().forEach((tr) => tr.stop());
            stream = subCanvas.captureStream(subFps);
            track = stream.getVideoTracks()[0] as
              | (MediaStreamTrack & { requestFrame?: () => void })
              | undefined;
          }
          const candidates: { mime: string; format: "webm" | "mp4" }[] = [
            { mime: "video/webm;codecs=vp8", format: "webm" },
            { mime: "video/webm", format: "webm" },
            { mime: "video/mp4", format: "mp4" },
          ];
          const chosen = candidates.find(
            (c) => typeof MediaRecorder.isTypeSupported === "function" && MediaRecorder.isTypeSupported(c.mime)
          );
          subtitleFormat = chosen?.format ?? "webm";
          const recorder = chosen
            ? new MediaRecorder(stream, { mimeType: chosen.mime, videoBitsPerSecond: 1_200_000 })
            : new MediaRecorder(stream, { videoBitsPerSecond: 1_200_000 });
          const chunks: BlobPart[] = [];
          recorder.ondataavailable = (e) => {
            if (e.data.size > 0) chunks.push(e.data);
          };
          const donePromise = new Promise<Uint8Array>((resolve, reject) => {
            recorder.onerror = () => reject(new Error("Subtitle strip recording failed."));
            recorder.onstop = async () => {
              try {
                const blob = new Blob(chunks, { type: chosen?.mime || "video/webm" });
                resolve(new Uint8Array(await blob.arrayBuffer()));
              } catch (e) {
                reject(e instanceof Error ? e : new Error("Failed reading subtitle strip."));
              }
            };
          });
          const recStart = performance.now();
          recorder.start(250);
          let recCancelled = false;
          try {
            const intervalMs = 1000 / subFps;
            for (let frameIdx = 0; frameIdx < subTotalFrames; frameIdx++) {
              throwIfAborted(signal);
              const fStart = performance.now();
              renderSubtitleOnlyFrame((frameIdx / subFps) * speed);
              if (useManual) {
                track?.requestFrame?.();
                if (frameIdx % 4 === 0) await new Promise((r) => setTimeout(r, 0));
              } else {
                const waitMs = Math.max(4, intervalMs - (performance.now() - fStart));
                await new Promise((r) => setTimeout(r, waitMs));
              }
              if (frameIdx % 10 === 0) {
                onProgress({
                  phase: "rendering",
                  percent: 28 + Math.round((frameIdx / subTotalFrames) * 34),
                  detail: `Frame ${frameIdx} / ${subTotalFrames}`,
                });
              }
            }
          } catch (err) {
            recCancelled = Boolean(signal?.aborted);
            throw err;
          } finally {
            if (recorder.state !== "inactive") recorder.stop();
            subtitleRecordedDurationSec = Math.max(0.1, (performance.now() - recStart) / 1000);
            try {
              if (!recCancelled) subBytes = await donePromise;
              else donePromise.catch(() => {});
            } finally {
              stream.getTracks().forEach((tr) => tr.stop());
            }
          }
          subtitleForceCfr = useManual;
        }

        if (subBytes && subBytes.byteLength >= 512) {
          if (subBytes.byteLength > 8 * 1024 * 1024) {
            const subBlob = new Blob([subBytes.buffer as ArrayBuffer], {
              type: "application/octet-stream",
            });
            subtitleUploadId = await uploadBlobInChunks(
              subBlob,
              `subtitles.${subtitleFormat}`,
              signal
            );
          } else {
            subtitleBase64 = uint8ToBase64(subBytes);
          }
        }
      }

      throwIfAborted(signal);
      let encodePct = 64;
      onProgress({ phase: "muxing", percent: encodePct, detail: "Encoding 9:16 MP4 on server..." });
      const encodeTicker = window.setInterval(() => {
        if (signal?.aborted) return;
        encodePct = Math.min(82, encodePct + 1);
        onProgress({
          phase: "muxing",
          percent: encodePct,
          detail: "Encoding 9:16 MP4 on server...",
        });
      }, 900);

      const fastTimed = makeTimedController(115_000);
      try {
        const fastResp = await fetch("/api/export-fast-mp4", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            uploadId: resolvedUploadId,
            scenes: project.scenes,
            voiceSettings: { ...voiceSettings, speed },
            editSettings,
            width,
            height,
            topVideoH,
            subtitleBase64,
            subtitleUploadId,
            subtitleFormat,
            subtitleFps: subFps,
            subtitleForceCfr,
            subtitleRecordedDurationSec,
            targetDurationSec: totalDuration,
            fileName,
          }),
          signal: fastTimed.signal,
        });

        window.clearInterval(encodeTicker);

        if (fastResp.ok) {
          const data = (await fastResp.json()) as {
            downloadUrl?: string;
            fileName?: string;
            sizeBytes?: number;
          };
          if (data.downloadUrl) {
            return await fetchVerifiedMp4Blob(
              data.downloadUrl,
              Number(data.sizeBytes) || 0,
              data.fileName || fileName,
              onProgress,
              signal
            );
          }
        } else if (fastResp.status !== 404) {
          const errText = await fastResp.text();
          let errMsg = errText;
          try {
            const parsed = JSON.parse(errText) as { error?: string };
            if (parsed?.error) errMsg = parsed.error;
          } catch {
            // plain text
          }
          throw new Error(errMsg || "Failed to export 9:16 MP4.");
        }
      } catch (err) {
        throwIfAborted(signal);
        if (fastTimed.didTimeout()) {
          throw new Error("Server video export timed out. Please try a shorter clip or retry.");
        }
        throw err;
      } finally {
        window.clearInterval(encodeTicker);
        fastTimed.cleanup();
      }
    }

    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d", {
      alpha: false,
      willReadFrequently: Boolean(editSettings.adversarialNoise),
    })!;

    const advTiles = editSettings.adversarialNoise
      ? [0, 1, 2, 3].map((p) => createAdversarialPerturbationTile(p))
      : null;

    // Last-known-good offscreen frame buffer guarantees zero blinking / black frames
    const lastFrameCanvas = document.createElement("canvas");
    const lastFrameCtx = lastFrameCanvas.getContext("2d", { alpha: false });
    let hasCapturedVideoFrame = false;
    let usingPreparedClip = false;

    const loadedFrames: HTMLImageElement[] = [];

    if (project.sourceType === "local") {
      // Ask server ffmpeg to pre-extract an adaptive all-keyframe yuv420p H.264 clip (30s timeout)
      // so every browser frame seek completes in a few ms; fall back cleanly to localUrl if unavailable.
      if (resolvedUploadId) {
        const prepTimed = makeTimedController(30_000);
        try {
          const prepResp = await fetch("/api/prepare-export-clip", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              uploadId: resolvedUploadId,
              scenes: project.scenes,
            }),
            signal: prepTimed.signal,
          });
          if (prepResp.ok) {
            const prepBlob = await prepResp.blob();
            throwIfAborted(signal);
            if (prepBlob.size > 512) {
              preparedClipUrl = URL.createObjectURL(prepBlob);
              usingPreparedClip = true;
            }
          }
        } catch (err) {
          throwIfAborted(signal);
          void err;
          // Fall back to direct browser localUrl decoding below
        } finally {
          prepTimed.cleanup();
        }
      }

      throwIfAborted(signal);
      onProgress({ phase: "preparing", percent: 9 });

      let activeVideoSrc = preparedClipUrl || project.localUrl || "";
      if (!activeVideoSrc && project.localFile) {
        tempLocalUrl = URL.createObjectURL(project.localFile);
        activeVideoSrc = tempLocalUrl;
      }

      if (activeVideoSrc) {
        hiddenVideoHost = document.createElement("div");
        // Keep inside viewport at 2x2 opacity:0.001 so Android Chrome does not throttle offscreen <video> decoding
        hiddenVideoHost.style.cssText =
          "position:fixed;left:0;top:0;width:2px;height:2px;opacity:0.001;pointer-events:none;overflow:hidden;z-index:-1;";
        localVideoEl = document.createElement("video");
        localVideoEl.preload = "auto";
        localVideoEl.muted = true;
        localVideoEl.playsInline = true;
        localVideoEl.src = activeVideoSrc;
        hiddenVideoHost.appendChild(localVideoEl);
        document.body.appendChild(hiddenVideoHost);

        await waitForVideoReady(localVideoEl, signal);

        // If prepared clip failed to decode in browser for any reason, fall back to original localUrl
        if ((localVideoEl.readyState < 2 || localVideoEl.videoWidth === 0) && usingPreparedClip) {
          usingPreparedClip = false;
          const fallbackSrc =
            project.localUrl ||
            (project.localFile
              ? (tempLocalUrl ?? (tempLocalUrl = URL.createObjectURL(project.localFile)))
              : "");
          if (fallbackSrc) {
            localVideoEl.src = fallbackSrc;
            await waitForVideoReady(localVideoEl, signal);
          }
        }

        if (localVideoEl.readyState >= 2 && localVideoEl.videoWidth > 0) {
          const initialTime = usingPreparedClip ? 0 : mapCutTimeToSourceTime(project, 0);
          await seekVideoToTime(localVideoEl, initialTime, signal);
          if (
            lastFrameCtx &&
            localVideoEl.readyState >= 2 &&
            !localVideoEl.seeking &&
            localVideoEl.videoWidth > 0 &&
            localVideoEl.videoHeight > 0
          ) {
            lastFrameCanvas.width = localVideoEl.videoWidth;
            lastFrameCanvas.height = localVideoEl.videoHeight;
            lastFrameCtx.drawImage(
              localVideoEl,
              0,
              0,
              lastFrameCanvas.width,
              lastFrameCanvas.height
            );
            hasCapturedVideoFrame = true;
          }
        }
      }
    } else {
      const candidateUrls = [...(project.keyframeUrls || [])];
      if (candidateUrls.length === 0 && project.videoId) {
        candidateUrls.push(`https://i.ytimg.com/vi/${project.videoId}/hqdefault.jpg`);
      }
      const imgs = await Promise.all(candidateUrls.map((u) => loadImage(u)));
      for (const img of imgs) {
        if (img && img.naturalWidth > 0) loadedFrames.push(img);
      }
      if (loadedFrames.length === 0 && project.videoId) {
        const fallbackImg = await loadImage(
          `https://i.ytimg.com/vi/${project.videoId}/hqdefault.jpg`
        );
        if (fallbackImg && fallbackImg.naturalWidth > 0) {
          loadedFrames.push(fallbackImg);
        }
      }
    }

    const subFontScale =
      editSettings.subtitleFontScale === "sm"
        ? 0.86
        : editSettings.subtitleFontScale === "lg"
          ? 1.16
          : 1;
    const subTheme: "light" | "dark" | "warm" =
      editSettings.subtitleTheme === "warm"
        ? "warm"
        : editSettings.subtitleTheme === "light"
          ? "light"
          : editSettings.subtitleTheme === "dark"
            ? "dark"
            : darkMode
              ? "dark"
              : "light";
    const subHl = editSettings.subtitleHighlightColor || "indigo";
    const showWordGloss = editSettings.showWordGloss !== false;
    const showBurmeseLine = editSettings.showBurmeseLine !== false;

    const { cards } = measureSubtitleList(ctx, project.subtitles, width, {
      showThaiScript: Boolean(editSettings.showThaiScript),
      showWordGloss,
      showBurmeseLine,
      fontScale: subFontScale,
    });

    const getActiveCardIndex = (t: number): number => {
      let activeIdx = -1;
      let lastStartedIdx = -1;
      for (let i = 0; i < cards.length; i++) {
        const sub = cards[i].sub;
        if (t >= sub.startTime) {
          if (lastStartedIdx === -1 || sub.startTime >= cards[lastStartedIdx].sub.startTime) {
            lastStartedIdx = i;
          }
          if (t <= sub.endTime) {
            activeIdx = i;
          }
        }
      }
      return activeIdx >= 0 ? activeIdx : lastStartedIdx;
    };

    const getScrollYForTime = (t: number): number => {
      let anchorIdx = getActiveCardIndex(t);
      if (anchorIdx < 0) {
        for (let i = 0; i < cards.length; i++) {
          if (t >= cards[i].sub.startTime) anchorIdx = i;
          else break;
        }
      }
      const active = cards[Math.max(0, anchorIdx)];
      if (!active) return 0;
      const desiredCenter = active.topY + active.height * 0.5 - listH * 0.42;
      return Math.max(0, desiredCenter);
    };

    let currentScrollY = 0;
    const cssFilterStr = buildCssFilterString(editSettings);
    const hasCssFilter = cssFilterStr !== "none";

    const renderFrameAtTime = async (t: number, frameIdx = 0) => {
      throwIfAborted(signal);
      // 1. Background (matched to active subtitle theme)
      ctx.fillStyle =
        subTheme === "dark" ? "#080b1a" : subTheme === "warm" ? "#fbf7ef" : "#f8faff";
      ctx.fillRect(0, 0, width, height);

      // 2. Top 9:16 Video Frame with Transform, Filter & Vignette
      ctx.save();
      ctx.beginPath();
      ctx.rect(0, 0, width, topVideoH);
      ctx.clip();
      ctx.fillStyle = "#111111";
      ctx.fillRect(0, 0, width, topVideoH);

      const drawEditedSource = (
        source: CanvasImageSource,
        sw: number,
        sh: number,
        extraPanX = 0,
        extraZoom = 1
      ) => {
        if (sw <= 0 || sh <= 0) return;
        const baseScale =
          editSettings.fitMode === "contain"
            ? Math.min(width / sw, topVideoH / sh)
            : Math.max(width / sw, topVideoH / sh);
        const dw = sw * baseScale * extraZoom;
        const dh = sh * baseScale * extraZoom;

        ctx.save();
        const cx = width / 2 + (editSettings.panX / 100) * width + extraPanX;
        const cy = topVideoH / 2 + (editSettings.panY / 100) * topVideoH;
        ctx.translate(cx, cy);
        ctx.scale(
          editSettings.zoom * (editSettings.flipH ? -1 : 1),
          editSettings.zoom * (editSettings.flipV ? -1 : 1)
        );
        ctx.rotate((editSettings.rotateDeg * Math.PI) / 180);
        if (hasCssFilter) {
          ctx.filter = cssFilterStr;
        }
        ctx.drawImage(source, -dw / 2, -dh / 2, dw, dh);
        ctx.restore();
        if (hasCssFilter) {
          ctx.filter = "none";
        }
      };

      if (localVideoEl && localVideoEl.readyState >= 1) {
        const targetSrcTime = usingPreparedClip ? t : mapCutTimeToSourceTime(project, t);
        await seekVideoToTime(localVideoEl, targetSrcTime, signal);

        if (
          lastFrameCtx &&
          localVideoEl.readyState >= 2 &&
          !localVideoEl.seeking &&
          localVideoEl.videoWidth > 0 &&
          localVideoEl.videoHeight > 0
        ) {
          if (
            lastFrameCanvas.width !== localVideoEl.videoWidth ||
            lastFrameCanvas.height !== localVideoEl.videoHeight
          ) {
            lastFrameCanvas.width = localVideoEl.videoWidth;
            lastFrameCanvas.height = localVideoEl.videoHeight;
          }
          lastFrameCtx.drawImage(
            localVideoEl,
            0,
            0,
            lastFrameCanvas.width,
            lastFrameCanvas.height
          );
          hasCapturedVideoFrame = true;
        }

        if (hasCapturedVideoFrame && lastFrameCanvas.width > 0) {
          drawEditedSource(lastFrameCanvas, lastFrameCanvas.width, lastFrameCanvas.height);
        } else if (localVideoEl.readyState >= 2 && localVideoEl.videoWidth > 0) {
          drawEditedSource(localVideoEl, localVideoEl.videoWidth, localVideoEl.videoHeight);
        }
      } else if (loadedFrames.length > 0) {
        const activeSub = project.subtitles.find((s) => t >= s.startTime && t < s.endTime);
        const sceneIdx =
          activeSub?.sceneIndex ?? Math.floor((t / sourceTotalDuration) * loadedFrames.length);
        const frameImg = loadedFrames[sceneIdx % loadedFrames.length];
        const sceneProgress = (t % 8) / 8;
        const zoom = 1.04 + 0.08 * Math.sin(sceneProgress * Math.PI);
        const panX = (sceneIdx % 2 === 0 ? 1 : -1) * 18 * (sceneProgress - 0.5);
        drawEditedSource(
          frameImg,
          frameImg.naturalWidth || 1280,
          frameImg.naturalHeight || 720,
          panX,
          zoom
        );
      }

      if (advTiles && advTiles.length > 0) {
        try {
          const imgData = ctx.getImageData(0, 0, width, topVideoH);
          const tile = advTiles[frameIdx % advTiles.length];
          applyAdversarialPerturbationToImageData(
            imgData,
            editSettings.adversarialStrength,
            tile
          );
          ctx.putImageData(imgData, 0, 0);
        } catch {
          // Ignore if cross-origin canvas tainting occurs
        }
      }

      if (editSettings.vignette > 0) {
        const alpha = Math.max(0, Math.min(0.85, (editSettings.vignette / 100) * 0.85));
        const grad = ctx.createRadialGradient(
          width / 2,
          topVideoH / 2,
          Math.min(width, topVideoH) * 0.25,
          width / 2,
          topVideoH / 2,
          Math.max(width, topVideoH) * 0.65
        );
        grad.addColorStop(0, "rgba(0,0,0,0)");
        grad.addColorStop(1, `rgba(0,0,0,${alpha.toFixed(2)})`);
        ctx.fillStyle = grad;
        ctx.fillRect(0, 0, width, topVideoH);
      }
      ctx.restore();

      if (hasSubtitles) {
        const isDarkPanel = subTheme === "dark";
        const isWarmPanel = subTheme === "warm";
        ctx.fillStyle = isDarkPanel ? "#21284c" : isWarmPanel ? "#e7dcc8" : "#d2dcf0";
        ctx.fillRect(0, topVideoH, width, 1);

        const ht = Math.min(sourceTotalDuration, t + 0.06);
        const targetScroll = getScrollYForTime(ht);
        currentScrollY += (targetScroll - currentScrollY) * 0.14;

        ctx.save();
        ctx.beginPath();
        ctx.rect(0, topVideoH + 1, width, listH - 1);
        ctx.clip();
        ctx.translate(0, topVideoH - currentScrollY);

        const activeCardIdx = getActiveCardIndex(ht);
        const phoneticPx = Math.round(28 * subFontScale);
        const glossPx = Math.round(13 * subFontScale);
        const thaiPx = Math.round(20 * subFontScale);
        const thaiLineH = Math.round(28 * subFontScale);
        const idxPx = Math.round(15 * subFontScale);
        const burmesePx = Math.round(22 * subFontScale);
        const burmeseLineH = Math.round(34 * subFontScale);
        const pillFill =
          subHl === "emerald"
            ? isDarkPanel
              ? "#127d5c"
              : "#0d7456"
            : subHl === "indigo"
              ? isDarkPanel
                ? "#2952d6"
                : "#1c3db8"
              : subHl === "rose"
                ? isDarkPanel
                  ? "#a12f88"
                  : "#8b2574"
                : isDarkPanel
                  ? "#cc801a"
                  : "#b0580c";
        const pillTextFill =
          subHl === "amber" && isDarkPanel ? "#0f172a" : "#ffffff";

        for (let ci = 0; ci < cards.length; ci++) {
          const card = cards[ci];
          const screenTop = card.topY - currentScrollY;
          if (screenTop + card.height < -60 || screenTop > listH + 60) continue;

          const isActive = ci === activeCardIdx;

          ctx.fillStyle = isActive
            ? isDarkPanel
              ? "#12183a"
              : isWarmPanel
                ? "#fffdf8"
                : "#ffffff"
            : isDarkPanel
              ? "rgba(13, 18, 41, 0.72)"
              : isWarmPanel
                ? "rgba(244, 237, 224, 0.72)"
                : "rgba(255, 255, 255, 0.75)";
          drawRoundedRect(ctx, 22, card.topY, width - 44, card.height, 18);
          ctx.fill();
          ctx.strokeStyle = isActive
            ? isDarkPanel
              ? "rgba(78, 126, 247, 0.5)"
              : isWarmPanel
                ? "#dfae52"
                : "#8da2ea"
            : isDarkPanel
              ? "#1e264a"
              : isWarmPanel
                ? "#e5dac6"
                : "#e2e8f5";
          ctx.lineWidth = isActive ? 1.75 : 1;
          ctx.stroke();

          ctx.fillStyle = isActive
            ? isDarkPanel
              ? "#5b85f7"
              : isWarmPanel
                ? "#b86310"
                : "#1c3db8"
            : isDarkPanel
              ? "#1e264a"
              : isWarmPanel
                ? "#dfd3be"
                : "#e2e8f5";
          drawRoundedRect(ctx, 32, card.topY + 18, 5, Math.max(24, card.height - 36), 3);
          ctx.fill();

          for (let wi = 0; wi < card.wordLayouts.length; wi++) {
            const wl = card.wordLayouts[wi];
            const isLastWord = wi === card.wordLayouts.length - 1;
            const isSpoken =
              isActive &&
              ht >= wl.startTime &&
              (isLastWord ? ht <= wl.endTime : ht < wl.endTime);
            const wasSpoken = isActive && (isLastWord ? ht > wl.endTime : ht >= wl.endTime);

            if (isSpoken) {
              const pillH = Math.round(38 * subFontScale);
              ctx.fillStyle = pillFill;
              drawRoundedRect(
                ctx,
                wl.x - 4,
                wl.y - Math.round(26 * subFontScale),
                wl.w + 2,
                pillH,
                9
              );
              ctx.fill();
            }

            ctx.font = `600 ${phoneticPx}px 'Plus Jakarta Sans', sans-serif`;
            if (isSpoken) {
              ctx.fillStyle = pillTextFill;
            } else if (isActive) {
              ctx.fillStyle = isDarkPanel
                ? wasSpoken
                  ? "#8cb5f5"
                  : "#cbd5e1"
                : isWarmPanel
                  ? wasSpoken
                    ? "#944808"
                    : "#292524"
                  : wasSpoken
                    ? "#1938a8"
                    : "#334155";
            } else {
              ctx.fillStyle = isWarmPanel ? "#78716c" : "#64748b";
            }
            ctx.fillText(wl.phonetic, wl.x + 5, wl.y);

            if (wl.gloss) {
              ctx.font = `500 ${glossPx}px 'Noto Sans Myanmar', sans-serif`;
              ctx.fillStyle = isSpoken
                ? subHl === "emerald"
                  ? isDarkPanel
                    ? "#43b892"
                    : "#0b664b"
                  : subHl === "indigo"
                    ? isDarkPanel
                      ? "#80a6ff"
                      : "#1836a3"
                    : subHl === "rose"
                      ? isDarkPanel
                        ? "#e386cf"
                        : "#7d1e68"
                      : isDarkPanel
                        ? "#e5a64e"
                        : "#9c4b08"
                : isActive
                  ? isDarkPanel
                    ? "#6c97f8"
                    : "#1c3db8"
                  : isDarkPanel
                    ? "#515e87"
                    : isWarmPanel
                      ? "#a8a29e"
                      : "#94a3b8";
              ctx.fillText(wl.gloss, wl.x + 5, wl.y + Math.round(22 * subFontScale));
            }
          }

          if (card.thaiLines.length > 0) {
            ctx.font = `500 ${thaiPx}px 'Noto Sans Thai', 'Plus Jakarta Sans', sans-serif`;
            ctx.fillStyle = isActive
              ? isDarkPanel
                ? "#e2e8f0"
                : isWarmPanel
                  ? "#44403c"
                  : "#334155"
              : isWarmPanel
                ? "#78716c"
                : "#64748b";
            card.thaiLines.forEach((line, li) => {
              ctx.fillText(line, 58, card.thaiStartY + li * thaiLineH);
            });
          }

          if (showBurmeseLine) {
            if (card.wordLayouts.length > 0 || card.thaiLines.length > 0) {
              const dividerY = card.burmeseStartY - 30;
              ctx.fillStyle = isActive
                ? isDarkPanel
                  ? "rgba(78, 126, 247, 0.28)"
                  : isWarmPanel
                    ? "#ebd197"
                    : "#d3dff8"
                : isDarkPanel
                  ? "#1e264a"
                  : isWarmPanel
                    ? "#e7dcc8"
                    : "#f1f5f9";
              ctx.fillRect(54, dividerY, width - 96, 1);
            }

            ctx.font = `600 ${idxPx}px 'JetBrains Mono', monospace`;
            ctx.fillStyle = isActive
              ? isDarkPanel
                ? "#5b85f7"
                : isWarmPanel
                  ? "#a3550b"
                  : "#1c3db8"
              : isDarkPanel
                ? "#515e87"
                : isWarmPanel
                  ? "#a8a29e"
                  : "#94a3b8";
            ctx.fillText(String(ci + 1).padStart(2, "0"), 54, card.burmeseStartY - 1);

            ctx.font = `500 ${burmesePx}px 'Noto Sans Myanmar', 'Plus Jakarta Sans', sans-serif`;
            ctx.fillStyle = isActive
              ? isDarkPanel
                ? "#99b8ff"
                : "#122b87"
              : isWarmPanel
                ? "#57534e"
                : "#64748b";
            card.burmeseLines.forEach((line, li) => {
              ctx.fillText(line, 86, card.burmeseStartY + li * burmeseLineH);
            });
          }
        }

        ctx.restore();
      }
    };

    const encodeWithWebCodecs = async (
      hwAccel: HardwareAcceleration
    ): Promise<Uint8Array | null> => {
      if (typeof VideoEncoder === "undefined") return null;

      const codecsToTry = [
        "avc1.420028",
        "avc1.4d0028",
        "avc1.640028",
        "avc1.42001f",
        "avc1.4d001f",
      ];
      let chosenConfig: VideoEncoderConfig | null = null;
      for (const codec of codecsToTry) {
        const cfg: VideoEncoderConfig = {
          codec,
          width,
          height,
          bitrate: 2_600_000,
          framerate: fps,
          latencyMode: "realtime",
          hardwareAcceleration: hwAccel,
          avc: { format: "avc" },
        };
        try {
          const support = await VideoEncoder.isConfigSupported(cfg);
          if (support.supported) {
            chosenConfig = support.config || cfg;
            break;
          }
        } catch {
          // continue
        }
      }
      if (!chosenConfig) return null;

      currentScrollY = 0;
      let encoderError: Error | null = null;
      const target = new ArrayBufferTarget();
      const muxer = new Muxer({
        target,
        video: {
          codec: "avc",
          width,
          height,
          frameRate: fps,
        },
        fastStart: "in-memory",
        firstTimestampBehavior: "offset",
      });

      const encoder = new VideoEncoder({
        output: (chunk, meta) => {
          try {
            muxer.addVideoChunk(chunk, meta);
          } catch (err) {
            encoderError = err instanceof Error ? err : new Error(String(err));
          }
        },
        error: (err) => {
          console.error("VideoEncoder error:", err);
          encoderError = err instanceof Error ? err : new Error(String(err));
        },
      });

      encoder.configure(chosenConfig);

      try {
        for (let frameIdx = 0; frameIdx < totalFrames; frameIdx++) {
          throwIfAborted(signal);
          if (encoderError || encoder.state !== "configured") {
            return null;
          }

          const t = (frameIdx / fps) * speed;
          await renderFrameAtTime(t, frameIdx);
          throwIfAborted(signal);

          const frame = new VideoFrame(canvas, {
            timestamp: Math.round((frameIdx * 1_000_000) / fps),
            duration: Math.round(1_000_000 / fps),
          });
          try {
            encoder.encode(frame, { keyFrame: frameIdx % fps === 0 });
          } finally {
            frame.close();
          }

          const queueWaitStart = performance.now();
          while (encoder.encodeQueueSize > 8 && !encoderError) {
            throwIfAborted(signal);
            if (performance.now() - queueWaitStart > 5000) {
              encoderError = new Error("VideoEncoder queue stalled.");
              break;
            }
            await new Promise((r) => setTimeout(r, 4));
          }

          if (frameIdx % 6 === 0) {
            onProgress({
              phase: "rendering",
              percent: 10 + Math.round((frameIdx / totalFrames) * 75),
            });
            await new Promise((r) => setTimeout(r, 0));
          }
        }

        if (encoderError) {
          return null;
        }

        throwIfAborted(signal);
        const flushResult = await Promise.race([
          encoder.flush().then(() => "ok" as const),
          new Promise<"timeout">((resolve) => window.setTimeout(() => resolve("timeout"), 10_000)),
        ]);
        throwIfAborted(signal);
        if (flushResult === "timeout" || encoderError) {
          return null;
        }

        muxer.finalize();
        const bytes = new Uint8Array(target.buffer);
        if (bytes.byteLength < 1024 || encoderError) {
          return null;
        }
        return bytes;
      } finally {
        try {
          if (encoder.state !== "closed") {
            encoder.close();
          }
        } catch {
          // ignore
        }
      }
    };

    throwIfAborted(signal);
    onProgress({ phase: "rendering", percent: 10 });

    let videoBytes: Uint8Array | null = await encodeWithWebCodecs("no-preference");
    throwIfAborted(signal);
    if (!videoBytes) {
      videoBytes = await encodeWithWebCodecs("prefer-software");
    }
    throwIfAborted(signal);

    let videoFormat: "mp4" | "webm" = "mp4";
    let forceCfrFromFrames = false;
    let recordedDurationSec: number | undefined;

    if (!videoBytes) {
      if (typeof MediaRecorder === "undefined" || typeof canvas.captureStream !== "function") {
        throw new Error(
          "This browser does not support client-side video export. Please try Chrome, Edge, or Safari 17+."
        );
      }

      // Render frame 0 before starting stream capture so no blank initial frame is recorded
      currentScrollY = 0;
      await renderFrameAtTime(0, 0);

      // Probe whether manual frame capture (captureStream(0) + requestFrame) is supported
      const probeStream = canvas.captureStream(0);
      const probeTrack = probeStream.getVideoTracks()[0] as
        | (MediaStreamTrack & { requestFrame?: () => void })
        | undefined;
      const useManualCapture = typeof probeTrack?.requestFrame === "function";
      let stream: MediaStream = probeStream;
      let track = probeTrack;
      if (!useManualCapture) {
        probeStream.getTracks().forEach((tr) => tr.stop());
        stream = canvas.captureStream(fps);
        track = stream.getVideoTracks()[0] as
          | (MediaStreamTrack & { requestFrame?: () => void })
          | undefined;
      }

      const candidates: { mime: string; format: "webm" | "mp4" }[] = [
        { mime: "video/webm;codecs=vp9", format: "webm" },
        { mime: "video/webm;codecs=vp8", format: "webm" },
        { mime: "video/webm", format: "webm" },
        { mime: "video/mp4;codecs=avc1", format: "mp4" },
        { mime: "video/mp4", format: "mp4" },
      ];
      const chosen = candidates.find(
        (c) => typeof MediaRecorder.isTypeSupported === "function" && MediaRecorder.isTypeSupported(c.mime)
      );
      videoFormat = chosen?.format ?? "webm";

      let recorder: MediaRecorder;
      try {
        recorder = chosen
          ? new MediaRecorder(stream, {
              mimeType: chosen.mime,
              videoBitsPerSecond: 2_600_000,
            })
          : new MediaRecorder(stream, { videoBitsPerSecond: 2_600_000 });
        if (!chosen && recorder.mimeType.includes("mp4")) {
          videoFormat = "mp4";
        }
      } catch (err) {
        stream.getTracks().forEach((tr) => tr.stop());
        throw new Error(
          err instanceof Error
            ? `Video export recording is not supported on this browser: ${err.message}`
            : "Video export recording is not supported on this browser."
        );
      }

      const chunks: BlobPart[] = [];
      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunks.push(e.data);
      };
      const donePromise = new Promise<Uint8Array>((resolve, reject) => {
        recorder.onerror = () => {
          reject(new Error("Video recording failed during export."));
        };
        recorder.onstop = async () => {
          try {
            const blob = new Blob(chunks, {
              type: chosen?.mime || (videoFormat === "mp4" ? "video/mp4" : "video/webm"),
            });
            resolve(new Uint8Array(await blob.arrayBuffer()));
          } catch (e) {
            reject(e instanceof Error ? e : new Error("Failed to read recorded video."));
          }
        };
      });

      const recStartMs = performance.now();
      recorder.start(250);
      let recCancelled = false;
      try {
        const frameIntervalMs = 1000 / fps;
        for (let frameIdx = 0; frameIdx < totalFrames; frameIdx++) {
          throwIfAborted(signal);
          const frameStart = performance.now();
          const t = (frameIdx / fps) * speed;
          await renderFrameAtTime(t, frameIdx);
          throwIfAborted(signal);
          if (useManualCapture) {
            track?.requestFrame?.();
            if (frameIdx % 4 === 0) {
              await new Promise((r) => setTimeout(r, 0));
            }
          } else {
            const elapsed = performance.now() - frameStart;
            const waitMs = Math.max(4, frameIntervalMs - elapsed);
            await new Promise((r) => setTimeout(r, waitMs));
          }
          if (frameIdx % 6 === 0) {
            onProgress({
              phase: "rendering",
              percent: 10 + Math.round((frameIdx / totalFrames) * 75),
            });
          }
        }
      } catch (err) {
        recCancelled = Boolean(signal?.aborted);
        throw err;
      } finally {
        if (recorder.state !== "inactive") {
          recorder.stop();
        }
        recordedDurationSec = Math.max(0.1, (performance.now() - recStartMs) / 1000);
        try {
          if (!recCancelled) {
            videoBytes = await donePromise;
          } else {
            donePromise.catch(() => {});
          }
        } finally {
          stream.getTracks().forEach((tr) => tr.stop());
        }
      }
      forceCfrFromFrames = useManualCapture;
    }

    throwIfAborted(signal);
    if (!videoBytes || videoBytes.byteLength < 512) {
      throw new Error("Rendered video stream was empty. Please try exporting again.");
    }

    onProgress({ phase: "muxing", percent: 90 });

    let renderedVideoUploadId: string | undefined;
    let videoBase64: string | undefined;
    if (videoBytes.byteLength > 8 * 1024 * 1024) {
      const renderedBlob = new Blob([videoBytes.buffer as ArrayBuffer], {
        type: "application/octet-stream",
      });
      renderedVideoUploadId = await uploadBlobInChunks(
        renderedBlob,
        `rendered.${videoFormat}`,
        signal
      );
    } else {
      videoBase64 = uint8ToBase64(videoBytes);
    }

    throwIfAborted(signal);
    const muxTimed = makeTimedController(120_000);
    let resp: Response;
    try {
      resp = await fetch("/api/mux-mp4", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          videoBase64,
          renderedVideoUploadId,
          videoFormat,
          uploadId: resolvedUploadId,
          scenes: project.scenes,
          voiceSettings: { ...voiceSettings, speed },
          targetDurationSec: totalDuration,
          expectedFrameCount: totalFrames,
          forceCfrFromFrames,
          recordedDurationSec,
          returnDownloadUrl: true,
          fileName,
        }),
        signal: muxTimed.signal,
      });
    } catch (err) {
      throwIfAborted(signal);
      if (muxTimed.didTimeout()) {
        throw new Error("MP4 finalization timed out on the server. Please try again.");
      }
      throw err;
    } finally {
      muxTimed.cleanup();
    }

    if (!resp.ok) {
      const errText = await resp.text();
      let errMsg = errText;
      try {
        const parsed = JSON.parse(errText) as { error?: string };
        if (parsed?.error) errMsg = parsed.error;
      } catch {
        // Keep plain text
      }
      throw new Error(errMsg || "Failed to finalize MP4 download.");
    }

    const muxData = (await resp.json()) as {
      downloadUrl?: string;
      fileName?: string;
      sizeBytes?: number;
    };
    if (!muxData.downloadUrl) {
      throw new Error("Server did not return a download link for the exported MP4.");
    }

    return await fetchVerifiedMp4Blob(
      muxData.downloadUrl,
      Number(muxData.sizeBytes) || 0,
      muxData.fileName || fileName,
      onProgress,
      signal
    );
  } finally {
    if (localVideoEl) {
      try {
        localVideoEl.pause();
        localVideoEl.removeAttribute("src");
        localVideoEl.load();
      } catch {
        // ignore
      }
    }
    if (hiddenVideoHost && hiddenVideoHost.parentNode) {
      hiddenVideoHost.parentNode.removeChild(hiddenVideoHost);
    }
    if (preparedClipUrl) URL.revokeObjectURL(preparedClipUrl);
    if (tempLocalUrl) URL.revokeObjectURL(tempLocalUrl);
  }
}
