import { Muxer, ArrayBufferTarget } from "mp4-muxer";
import type { SubtitleItem, VideoEditSettings, VideoProject, VoiceSettings } from "../types";
import { buildCssFilterString } from "./videoFilters";

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
  const padX = 34;
  const maxInnerW = width - padX * 2 - 28;
  let cursorY = 36;
  const cards: MeasuredCard[] = [];

  for (const sub of subtitles) {
    const cardTop = cursorY;
    let y = 26;

    ctx.font = "600 28px 'Plus Jakarta Sans', sans-serif";
    let lineX = 0;
    const rowGap = 54;
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
        x: padX + 14 + lineX,
        y: cardTop + y,
        w: tokenWidth,
        h: 36,
        startTime: sub.startTime + w.startOffsetSec,
        endTime: sub.startTime + w.endOffsetSec,
      });
      lineX += tokenWidth + 8;
    }

    y += 56;
    ctx.font = "500 22px 'Noto Sans Myanmar', 'Plus Jakarta Sans', sans-serif";
    const burmeseLines = wrapTextLines(ctx, sub.burmese, maxInnerW);
    const burmeseStartY = cardTop + y;
    y += burmeseLines.length * 34 + 20;

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
  const speed = Math.max(0.75, Math.min(1.4, voiceSettings.speed || 1));
  const sourceTotalDuration = Math.max(2, project.targetDurationSec || 10);
  const totalDuration = sourceTotalDuration / speed;
  const totalFrames = Math.ceil(totalDuration * fps);

  onProgress({ phase: "preparing", percent: 5 });

  let resolvedUploadId = project.uploadId;
  if (!resolvedUploadId && project.sourceType === "local" && project.localFile) {
    const upResp = await fetch("/api/upload-raw", {
      method: "POST",
      headers: {
        "Content-Type": project.localFile.type || "application/octet-stream",
      },
      body: project.localFile,
    });
    if (!upResp.ok) {
      throw new Error("Failed to prepare uploaded audio for MP4 export.");
    }
    const upData = (await upResp.json()) as { uploadId?: string };
    resolvedUploadId = upData.uploadId;
    if (resolvedUploadId) {
      project.uploadId = resolvedUploadId;
    }
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

  // Smoothly compute target scrollY for any time t
  const getScrollYForTime = (t: number): number => {
    let activeIdx = cards.findIndex((c) => t >= c.sub.startTime && t < c.sub.endTime);
    if (activeIdx === -1) {
      activeIdx = t >= sourceTotalDuration ? Math.max(0, cards.length - 1) : 0;
    }
    const active = cards[activeIdx];
    if (!active) return 0;

    // Smooth ease across subtitle transitions
    const desiredCenter = active.topY + active.height * 0.5 - listH * 0.42;
    return Math.max(0, desiredCenter);
  };

  let currentScrollY = 0;

  const renderFrameAtTime = async (t: number) => {
    // 1. Background
    ctx.fillStyle = darkMode ? "#0a0a0a" : "#ffffff";
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
      if (Math.abs(localVideoEl.currentTime - targetSrcTime) > 0.04) {
        localVideoEl.currentTime = targetSrcTime;
        await new Promise<void>((res) => {
          const onSeeked = () => {
            localVideoEl?.removeEventListener("seeked", onSeeked);
            res();
          };
          localVideoEl?.addEventListener("seeked", onSeeked, { once: true });
          setTimeout(res, 120);
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
      ctx.fillStyle = darkMode ? "#262626" : "#e5e5e5";
      ctx.fillRect(0, topVideoH, width, 1);

      // 3. Bottom Scrolling List Item Subtitle View
      const targetScroll = getScrollYForTime(t);
      currentScrollY += (targetScroll - currentScrollY) * 0.14;

      ctx.save();
      ctx.beginPath();
      ctx.rect(0, topVideoH + 1, width, listH - 1);
      ctx.clip();
      ctx.translate(0, topVideoH - currentScrollY);

      for (const card of cards) {
        const screenTop = card.topY - currentScrollY;
        if (screenTop + card.height < -60 || screenTop > listH + 60) continue;

        const isActive = t >= card.sub.startTime && t < card.sub.endTime;

        // Active row highlight surface (monochrome crisp contrast)
        if (isActive) {
          ctx.fillStyle = darkMode ? "#171717" : "#f4f4f5";
          drawRoundedRect(ctx, 20, card.topY, width - 40, card.height, 18);
          ctx.fill();
          ctx.strokeStyle = darkMode ? "#2e2e2e" : "#e4e4e7";
          ctx.lineWidth = 1.5;
          ctx.stroke();
        }

        // Line 1: Word-by-word English phonetic Thai with animated active highlight
        for (const wl of card.wordLayouts) {
          const isSpoken = isActive && t >= wl.startTime && t <= wl.endTime;
          const wasSpoken = isActive && t > wl.endTime;

          if (isSpoken) {
            ctx.fillStyle = darkMode ? "#ffffff" : "#0a0a0a";
            drawRoundedRect(ctx, wl.x - 4, wl.y - 26, wl.w + 2, 38, 9);
            ctx.fill();
          }

          ctx.font = "600 28px 'Plus Jakarta Sans', sans-serif";
          if (isSpoken) {
            ctx.fillStyle = darkMode ? "#0a0a0a" : "#ffffff";
          } else if (isActive) {
            ctx.fillStyle = darkMode
              ? wasSpoken
                ? "#fafafa"
                : "#a3a3a3"
              : wasSpoken
                ? "#0a0a0a"
                : "#525252";
          } else {
            ctx.fillStyle = darkMode ? "#737373" : "#737373";
          }
          ctx.fillText(wl.phonetic, wl.x + 5, wl.y);

          // Optional Burmese word gloss below key words (like reference screenshot)
          if (wl.gloss) {
            ctx.font = "500 13px 'Noto Sans Myanmar', sans-serif";
            ctx.fillStyle = isActive
              ? darkMode
                ? "#a3a3a3"
                : "#525252"
              : darkMode
                ? "#525252"
                : "#a3a3a3";
            ctx.fillText(wl.gloss, wl.x + 5, wl.y + 22);
          }
        }

        // Line 2: Burmese translation line
        ctx.font = "500 22px 'Noto Sans Myanmar', 'Plus Jakarta Sans', sans-serif";
        ctx.fillStyle = isActive
          ? darkMode
            ? "#e5e5e5"
            : "#171717"
          : darkMode
            ? "#737373"
            : "#737373";
        card.burmeseLines.forEach((line, li) => {
          ctx.fillText(line, 48, card.burmeseStartY + li * 34);
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

  const resp = await fetch("/api/mux-mp4", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      videoBase64: uint8ToBase64(videoBytes),
      videoFormat,
      uploadId: resolvedUploadId,
      scenes: project.scenes,
      voiceSettings,
    }),
  });

  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error(errText || "Failed to finalize MP4 download.");
  }

  onProgress({ phase: "muxing", percent: 100 });
  return await resp.blob();
}
