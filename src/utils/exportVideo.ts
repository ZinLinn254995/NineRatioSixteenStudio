import { Muxer, ArrayBufferTarget } from "mp4-muxer";
import type { SubtitleItem, VideoEditSettings, VideoProject, VoiceSettings } from "../types";
import { buildCssFilterString } from "./videoFilters";
import { uploadBlobInChunks } from "./uploadFile";
import { getEffectivePlaybackSpeed } from "./voicePresets";

export interface ExportProgress {
  phase: "preparing" | "rendering" | "muxing";
  percent: number;
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
  burmeseLines: string[];
  burmeseStartY: number;
}

function measureSubtitleList(
  ctx: CanvasRenderingContext2D,
  subtitles: SubtitleItem[],
  width: number
): { cards: MeasuredCard[]; totalHeight: number } {
  const padX = 40;
  const maxInnerW = width - padX * 2 - 28;
  let cursorY = 34;
  const cards: MeasuredCard[] = [];

  for (const sub of subtitles) {
    const cardTop = cursorY;
    let y = 28;

    ctx.font = "600 28px 'Plus Jakarta Sans', sans-serif";
    let lineX = 0;
    const rowGap = 56;
    const wordLayouts: MeasuredCard["wordLayouts"] = [];

    for (const w of sub.words) {
      const tokenWidth = ctx.measureText(w.phonetic).width + 18;
      if (lineX + tokenWidth > maxInnerW && lineX > 0) {
        lineX = 0;
        y += rowGap;
      }
      wordLayouts.push({
        phonetic: w.phonetic,
        gloss: w.burmeseGloss || "",
        x: padX + 18 + lineX,
        y: cardTop + y,
        w: tokenWidth,
        h: 36,
        startTime: sub.startTime + w.startOffsetSec,
        endTime: sub.startTime + w.endOffsetSec,
      });
      lineX += tokenWidth + 8;
    }

    y += 66;
    ctx.font = "500 22px 'Noto Sans Myanmar', 'Plus Jakarta Sans', sans-serif";
    const burmeseLines = wrapTextLines(ctx, sub.burmese, maxInnerW - 34);
    const burmeseStartY = cardTop + y;
    y += burmeseLines.length * 34 + 22;

    cards.push({
      sub,
      topY: cardTop,
      height: y,
      wordLayouts,
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
  ctx.roundRect(x, y, w, h, r);
  ctx.closePath();
}

async function loadImage(url: string): Promise<HTMLImageElement | null> {
  return new Promise((resolve) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = url;
  });
}

function mapCutTimeToSourceTime(project: VideoProject, cutTime: number): number {
  let acc = 0;
  for (const scene of project.scenes) {
    if (cutTime <= acc + scene.durationSec || scene.index === project.scenes.length - 1) {
      return Math.min(scene.endSec, scene.startSec + Math.max(0, cutTime - acc));
    }
    acc += scene.durationSec;
  }
  return 0;
}

export async function exportProjectToMp4(
  project: VideoProject,
  darkMode: boolean,
  voiceSettings: VoiceSettings,
  editSettings: VideoEditSettings,
  onProgress: (p: ExportProgress) => void
): Promise<Blob> {
  const width = 720;
  const height = 1280;
  const hasSubtitles = project.subtitles.length > 0;
  const heightPct = Math.max(26, Math.min(52, editSettings.videoHeightPct || 35));
  const topVideoH = hasSubtitles ? Math.round((height * heightPct) / 100) : height;
  const listH = height - topVideoH;
  const fps = 24;
  const speed = getEffectivePlaybackSpeed(
    project.sourceType,
    editSettings.playbackSpeed,
    voiceSettings.speed
  );
  const sourceTotalDuration = Math.max(2, project.targetDurationSec || 10);
  const totalDuration = sourceTotalDuration / speed;
  const totalFrames = Math.ceil(totalDuration * fps);

  onProgress({ phase: "preparing", percent: 5 });

  let resolvedUploadId = project.uploadId;
  if (!resolvedUploadId && project.sourceType === "local" && project.localFile) {
    resolvedUploadId = await uploadBlobInChunks(project.localFile, project.localFile.name);
    project.uploadId = resolvedUploadId;
  }

  // Ensure fonts are loaded before measuring canvas text
  await document.fonts.ready;

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d")!;

  // Load media source: either local <video> element or proxied YouTube keyframes
  let localVideoEl: HTMLVideoElement | null = null;
  const loadedFrames: HTMLImageElement[] = [];

  if (project.sourceType === "local" && project.localUrl) {
    localVideoEl = document.createElement("video");
    localVideoEl.src = project.localUrl;
    localVideoEl.muted = true;
    localVideoEl.playsInline = true;
    await new Promise<void>((resolve) => {
      if (!localVideoEl) return resolve();
      localVideoEl.onloadeddata = () => resolve();
      localVideoEl.onerror = () => resolve();
    });
  } else {
    const imgs = await Promise.all((project.keyframeUrls || []).map((u) => loadImage(u)));
    for (const img of imgs) {
      if (img) loadedFrames.push(img);
    }
  }

  const { cards } = measureSubtitleList(ctx, project.subtitles, width);

  const getActiveCardIndex = (t: number): number => {
    let idx = -1;
    for (let i = 0; i < cards.length; i++) {
      if (t >= cards[i].sub.startTime) idx = i;
      else break;
    }
    return idx;
  };

  // Smoothly compute target scrollY for any time t
  const getScrollYForTime = (t: number): number => {
    const activeIdx = Math.max(0, getActiveCardIndex(t));
    const active = cards[activeIdx];
    if (!active) return 0;

    // Smooth ease across subtitle transitions
    const desiredCenter = active.topY + active.height * 0.5 - listH * 0.42;
    return Math.max(0, desiredCenter);
  };

  let currentScrollY = 0;

  const renderFrameAtTime = async (t: number) => {
    // 1. Background (warm study paper in light mode, deep study slate in dark mode)
    ctx.fillStyle = darkMode ? "#0b1120" : "#f8fafc";
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
      ctx.filter = buildCssFilterString(editSettings);
      ctx.drawImage(source, -dw / 2, -dh / 2, dw, dh);
      ctx.restore();
      ctx.filter = "none";
    };

    if (localVideoEl && localVideoEl.readyState >= 2) {
      const targetSrcTime = mapCutTimeToSourceTime(project, t);
      if (Math.abs(localVideoEl.currentTime - targetSrcTime) > 0.015) {
        localVideoEl.currentTime = targetSrcTime;
        await new Promise<void>((res) => {
          const onSeeked = () => {
            localVideoEl?.removeEventListener("seeked", onSeeked);
            res();
          };
          localVideoEl?.addEventListener("seeked", onSeeked, { once: true });
          setTimeout(res, 350);
        });
      }
      drawEditedSource(
        localVideoEl,
        localVideoEl.videoWidth || 16,
        localVideoEl.videoHeight || 9
      );
    } else if (loadedFrames.length > 0) {
      // Smooth Ken Burns across scene keyframes
      const activeSub = project.subtitles.find((s) => t >= s.startTime && t < s.endTime);
      const sceneIdx = activeSub?.sceneIndex ?? Math.floor((t / sourceTotalDuration) * loadedFrames.length);
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
      // Subtle divider below video
      ctx.fillStyle = darkMode ? "#1e293b" : "#cbd5e1";
      ctx.fillRect(0, topVideoH, width, 1);

      // 3. Bottom Scrolling List Item Subtitle View (Educational Study Palette)
      const targetScroll = getScrollYForTime(t);
      currentScrollY += (targetScroll - currentScrollY) * 0.14;

      ctx.save();
      ctx.beginPath();
      ctx.rect(0, topVideoH + 1, width, listH - 1);
      ctx.clip();
      ctx.translate(0, topVideoH - currentScrollY);

      const activeCardIdx = getActiveCardIndex(t);

      for (let ci = 0; ci < cards.length; ci++) {
        const card = cards[ci];
        const screenTop = card.topY - currentScrollY;
        if (screenTop + card.height < -60 || screenTop > listH + 60) continue;

        const isActive = ci === activeCardIdx;

        // Educational card container surface
        ctx.fillStyle = isActive
          ? darkMode
            ? "#131c31"
            : "#ffffff"
          : darkMode
            ? "rgba(15, 23, 42, 0.55)"
            : "rgba(255, 255, 255, 0.72)";
        drawRoundedRect(ctx, 22, card.topY, width - 44, card.height, 18);
        ctx.fill();
        ctx.strokeStyle = isActive
          ? darkMode
            ? "rgba(99, 102, 241, 0.45)"
            : "#c7d2fe"
          : darkMode
            ? "#1e293b"
            : "#e2e8f0";
        ctx.lineWidth = isActive ? 1.75 : 1;
        ctx.stroke();

        // Educational left accent bar
        ctx.fillStyle = isActive
          ? darkMode
            ? "#818cf8"
            : "#4f46e5"
          : darkMode
            ? "#1e293b"
            : "#e2e8f0";
        drawRoundedRect(ctx, 32, card.topY + 18, 5, Math.max(24, card.height - 36), 3);
        ctx.fill();

        // Line 1: Word-by-word English phonetic Thai with warm Amber study-highlighter
        for (let wi = 0; wi < card.wordLayouts.length; wi++) {
          const wl = card.wordLayouts[wi];
          const isLastWord = wi === card.wordLayouts.length - 1;
          const isSpoken =
            isActive &&
            t >= wl.startTime &&
            (isLastWord ? t <= wl.endTime : t < wl.endTime);
          const wasSpoken = isActive && (isLastWord ? t > wl.endTime : t >= wl.endTime);

          if (isSpoken) {
            ctx.fillStyle = darkMode ? "#fbbf24" : "#fde047";
            drawRoundedRect(ctx, wl.x - 4, wl.y - 26, wl.w + 2, 38, 9);
            ctx.fill();
            if (!darkMode) {
              ctx.strokeStyle = "#facc15";
              ctx.lineWidth = 1;
              ctx.stroke();
            }
          }

          ctx.font = "600 28px 'Plus Jakarta Sans', sans-serif";
          if (isSpoken) {
            ctx.fillStyle = "#0f172a";
          } else if (isActive) {
            ctx.fillStyle = darkMode
              ? wasSpoken
                ? "#a5b4fc"
                : "#cbd5e1"
              : wasSpoken
                ? "#4338ca"
                : "#334155";
          } else {
            ctx.fillStyle = darkMode ? "#64748b" : "#64748b";
          }
          ctx.fillText(wl.phonetic, wl.x + 5, wl.y);

          // Word gloss below key words (Amber when active spoken, Teal for study gloss)
          if (wl.gloss) {
            ctx.font = "500 13px 'Noto Sans Myanmar', sans-serif";
            ctx.fillStyle = isSpoken
              ? darkMode
                ? "#fcd34d"
                : "#b45309"
              : isActive
                ? darkMode
                  ? "#5eead4"
                  : "#0f766e"
                : darkMode
                  ? "#475569"
                  : "#94a3b8";
            ctx.fillText(wl.gloss, wl.x + 5, wl.y + 22);
          }
        }

        // Subtle divider between Phonetics & Burmese Translation
        const dividerY = card.burmeseStartY - 30;
        ctx.fillStyle = isActive
          ? darkMode
            ? "rgba(99, 102, 241, 0.22)"
            : "#e0e7ff"
          : darkMode
            ? "#1e293b"
            : "#f1f5f9";
        ctx.fillRect(54, dividerY, width - 96, 1);

        // Lesson cue index number
        ctx.font = "600 15px 'JetBrains Mono', monospace";
        ctx.fillStyle = isActive
          ? darkMode
            ? "#818cf8"
            : "#6366f1"
          : darkMode
            ? "#475569"
            : "#94a3b8";
        ctx.fillText(String(ci + 1).padStart(2, "0"), 54, card.burmeseStartY - 1);

        // Line 2: Burmese translation line (rich Teal for active study reading)
        ctx.font = "500 22px 'Noto Sans Myanmar', 'Plus Jakarta Sans', sans-serif";
        ctx.fillStyle = isActive
          ? darkMode
            ? "#99f6e4"
            : "#115e59"
          : darkMode
            ? "#64748b"
            : "#64748b";
        card.burmeseLines.forEach((line, li) => {
          ctx.fillText(line, 86, card.burmeseStartY + li * 34);
        });
      }

      ctx.restore();
    }
  };

  // Pick best encoding path: WebCodecs VideoEncoder + mp4-muxer (fast offline render)
  let videoBytes: Uint8Array | null = null;
  let videoFormat: "mp4" | "webm" = "mp4";

  const codecsToTry = ["avc1.42001f", "avc1.4d001f", "avc1.64001f"];
  let supportedCodec: string | null = null;
  if (typeof VideoEncoder !== "undefined") {
    for (const c of codecsToTry) {
      try {
        const support = await VideoEncoder.isConfigSupported({
          codec: c,
          width,
          height,
          bitrate: 2_400_000,
          framerate: fps,
        });
        if (support.supported) {
          supportedCodec = c;
          break;
        }
      } catch {
        // continue
      }
    }
  }

  if (supportedCodec) {
    const target = new ArrayBufferTarget();
    const muxer = new Muxer({
      target,
      video: {
        codec: "avc",
        width,
        height,
      },
      fastStart: "in-memory",
    });

    const encoder = new VideoEncoder({
      output: (chunk, meta) => muxer.addVideoChunk(chunk, meta),
      error: (err) => {
        console.error("VideoEncoder error:", err);
      },
    });

    encoder.configure({
      codec: supportedCodec,
      width,
      height,
      bitrate: 2_400_000,
      framerate: fps,
    });

    for (let frameIdx = 0; frameIdx < totalFrames; frameIdx++) {
      const t = (frameIdx / fps) * speed;
      await renderFrameAtTime(t);

      const frame = new VideoFrame(canvas, {
        timestamp: Math.round((frameIdx * 1_000_000) / fps),
        duration: Math.round(1_000_000 / fps),
      });
      encoder.encode(frame, { keyFrame: frameIdx % (fps * 2) === 0 });
      frame.close();

      if (encoder.encodeQueueSize > 8) {
        await new Promise((r) => setTimeout(r, 8));
      }

      if (frameIdx % 12 === 0) {
        onProgress({
          phase: "rendering",
          percent: 10 + Math.round((frameIdx / totalFrames) * 75),
        });
        await new Promise((r) => setTimeout(r, 0));
      }
    }

    await encoder.flush();
    encoder.close();
    muxer.finalize();
    videoBytes = new Uint8Array(target.buffer);
    videoFormat = "mp4";
  } else {
    // Fallback: MediaRecorder WebM capture
    videoFormat = "webm";
    const stream = canvas.captureStream(fps);
    const recorder = new MediaRecorder(stream, {
      mimeType: MediaRecorder.isTypeSupported("video/webm;codecs=vp9")
        ? "video/webm;codecs=vp9"
        : "video/webm",
    });
    const chunks: BlobPart[] = [];
    recorder.ondataavailable = (e) => {
      if (e.data.size > 0) chunks.push(e.data);
    };
    const donePromise = new Promise<Uint8Array>((resolve) => {
      recorder.onstop = async () => {
        const blob = new Blob(chunks, { type: "video/webm" });
        resolve(new Uint8Array(await blob.arrayBuffer()));
      };
    });
    recorder.start();
    const startMs = performance.now();
    while (true) {
      const elapsed = (performance.now() - startMs) / 1000;
      if (elapsed >= totalDuration) break;
      await renderFrameAtTime(elapsed * speed);
      onProgress({
        phase: "rendering",
        percent: 10 + Math.min(75, Math.round((elapsed / totalDuration) * 75)),
      });
      await new Promise((r) => setTimeout(r, 1000 / fps));
    }
    recorder.stop();
    videoBytes = await donePromise;
  }

  onProgress({ phase: "muxing", percent: 90 });

  let renderedVideoUploadId: string | undefined;
  let videoBase64: string | undefined;
  if (videoBytes.byteLength > 8 * 1024 * 1024) {
    const renderedBlob = new Blob([videoBytes.buffer as ArrayBuffer], {
      type: "application/octet-stream",
    });
    renderedVideoUploadId = await uploadBlobInChunks(renderedBlob, `rendered.${videoFormat}`);
  } else {
    videoBase64 = uint8ToBase64(videoBytes);
  }

  const resp = await fetch("/api/mux-mp4", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      videoBase64,
      renderedVideoUploadId,
      videoFormat,
      uploadId: resolvedUploadId,
      scenes: project.scenes,
      voiceSettings: { ...voiceSettings, speed },
    }),
  });

  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error(errText || "Failed to finalize MP4 download.");
  }

  onProgress({ phase: "muxing", percent: 100 });
  return await resp.blob();
}
