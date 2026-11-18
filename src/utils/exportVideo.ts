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

async function waitForVideoReady(video: HTMLVideoElement): Promise<void> {
  if (video.readyState >= 2 && video.videoWidth > 0) return;
  await new Promise<void>((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      video.removeEventListener("loadeddata", check);
      video.removeEventListener("canplay", check);
      video.removeEventListener("error", finish);
      resolve();
    };
    const check = () => {
      if (video.readyState >= 2 && video.videoWidth > 0) {
        finish();
      }
    };
    const timer = window.setTimeout(finish, 15000);
    video.addEventListener("loadeddata", check);
    video.addEventListener("canplay", check);
    video.addEventListener("error", finish, { once: true });
    try {
      video.load();
    } catch {
      // ignore
    }
  });
}

async function seekVideoToTime(video: HTMLVideoElement, targetSec: number): Promise<void> {
  const dur = Number.isFinite(video.duration) && video.duration > 0 ? video.duration : targetSec + 1;
  const maxSeek = Math.max(0, dur - 0.04);
  const clamped = Math.max(0, Math.min(maxSeek, targetSec));

  if (Math.abs(video.currentTime - clamped) > 0.015 || video.seeking) {
    await new Promise<void>((resolve) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        video.removeEventListener("seeked", onSeeked);
        resolve();
      };
      const onSeeked = () => finish();
      const timer = window.setTimeout(finish, 2500);
      video.addEventListener("seeked", onSeeked, { once: true });
      video.currentTime = clamped;
    });
  }

  // Wait briefly until decoder confirms frame data is present and not mid-seek
  const waitStart = performance.now();
  while ((video.seeking || video.readyState < 2) && performance.now() - waitStart < 450) {
    await new Promise((r) => setTimeout(r, 10));
  }
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
  const scenesDuration = project.scenes.reduce((acc, sc) => acc + getSceneDurationSec(sc), 0);
  const sourceTotalDuration = Math.max(0.5, scenesDuration || project.targetDurationSec || 10);
  const totalDuration = sourceTotalDuration / speed;
  const totalFrames = Math.max(1, Math.ceil(totalDuration * fps));

  if (project.sourceType === "local" && !project.localUrl && !project.localFile) {
    throw new Error("Local video file is not linked. Please re-link or upload the video first.");
  }

  onProgress({ phase: "preparing", percent: 5 });

  let hiddenVideoHost: HTMLDivElement | null = null;
  let localVideoEl: HTMLVideoElement | null = null;
  let preparedClipUrl: string | null = null;
  let tempLocalUrl: string | null = null;

  try {
    let resolvedUploadId = project.uploadId;
    if (project.sourceType === "local") {
      if (resolvedUploadId) {
        try {
          const checkResp = await fetch(`/api/upload-exists/${encodeURIComponent(resolvedUploadId)}`);
          if (checkResp.ok) {
            const checkData = (await checkResp.json()) as { exists?: boolean };
            if (!checkData.exists) {
              resolvedUploadId = undefined;
            }
          }
        } catch {
          // ignore network check error
        }
      }
      if (!resolvedUploadId && project.localFile) {
        resolvedUploadId = await uploadBlobInChunks(project.localFile, project.localFile.name);
        project.uploadId = resolvedUploadId;
      }
    }

    // Ensure fonts are loaded before measuring canvas text
    await document.fonts.ready;

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
      // Ask server ffmpeg to pre-extract an all-keyframe (GOP=1) yuv420p H.264 clip
      // for instant, rock-solid frame seeking (also fixes HEVC/MKV/VFR mobile videos)
      if (resolvedUploadId) {
        try {
          const prepResp = await fetch("/api/prepare-export-clip", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              uploadId: resolvedUploadId,
              scenes: project.scenes,
            }),
          });
          if (prepResp.ok) {
            const prepBlob = await prepResp.blob();
            if (prepBlob.size > 512) {
              preparedClipUrl = URL.createObjectURL(prepBlob);
              usingPreparedClip = true;
            }
          }
        } catch {
          // Fall back to direct browser localUrl decoding below
        }
      }

      let activeVideoSrc = preparedClipUrl || project.localUrl || "";
      if (!activeVideoSrc && project.localFile) {
        tempLocalUrl = URL.createObjectURL(project.localFile);
        activeVideoSrc = tempLocalUrl;
      }

      if (activeVideoSrc) {
        hiddenVideoHost = document.createElement("div");
        hiddenVideoHost.style.cssText =
          "position:fixed;left:-9999px;top:0;width:8px;height:8px;opacity:0.001;pointer-events:none;overflow:hidden;z-index:-1;";
        localVideoEl = document.createElement("video");
        localVideoEl.preload = "auto";
        localVideoEl.muted = true;
        localVideoEl.playsInline = true;
        localVideoEl.src = activeVideoSrc;
        hiddenVideoHost.appendChild(localVideoEl);
        document.body.appendChild(hiddenVideoHost);

        await waitForVideoReady(localVideoEl);

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
            await waitForVideoReady(localVideoEl);
          }
        }

        if (localVideoEl.readyState >= 2 && localVideoEl.videoWidth > 0) {
          const initialTime = usingPreparedClip ? 0 : mapCutTimeToSourceTime(project, 0);
          await seekVideoToTime(localVideoEl, initialTime);
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
    const subHl = editSettings.subtitleHighlightColor || "amber";
    const showWordGloss = editSettings.showWordGloss !== false;
    const showBurmeseLine = editSettings.showBurmeseLine !== false;

    const { cards } = measureSubtitleList(ctx, project.subtitles, width, {
      showThaiScript: Boolean(editSettings.showThaiScript),
      showWordGloss,
      showBurmeseLine,
      fontScale: subFontScale,
    });

    const getActiveCardIndex = (t: number): number => {
      let idx = -1;
      for (let i = 0; i < cards.length; i++) {
        if (t >= cards[i].sub.startTime && t <= cards[i].sub.endTime) {
          idx = i;
        }
      }
      return idx;
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

    const renderFrameAtTime = async (t: number, frameIdx = 0) => {
      // 1. Background (matched to active subtitle theme)
      ctx.fillStyle =
        subTheme === "dark" ? "#0b1120" : subTheme === "warm" ? "#fbf7ef" : "#f8fafc";
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
        ctx.filter = buildCssFilterString(editSettings);
        ctx.drawImage(source, -dw / 2, -dh / 2, dw, dh);
        ctx.restore();
        ctx.filter = "none";
      };

      if (localVideoEl && localVideoEl.readyState >= 1) {
        const targetSrcTime = usingPreparedClip ? t : mapCutTimeToSourceTime(project, t);
        await seekVideoToTime(localVideoEl, targetSrcTime);

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
        ctx.fillStyle = isDarkPanel ? "#1e293b" : isWarmPanel ? "#e7dcc8" : "#cbd5e1";
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
            ? "#6ee7b7"
            : subHl === "indigo"
              ? "#6366f1"
              : subHl === "rose"
                ? "#fda4af"
                : isDarkPanel
                  ? "#fbbf24"
                  : "#fde047";
        const pillTextFill = subHl === "indigo" ? "#ffffff" : "#0f172a";

        for (let ci = 0; ci < cards.length; ci++) {
          const card = cards[ci];
          const screenTop = card.topY - currentScrollY;
          if (screenTop + card.height < -60 || screenTop > listH + 60) continue;

          const isActive = ci === activeCardIdx;

          ctx.fillStyle = isActive
            ? isDarkPanel
              ? "#131c31"
              : isWarmPanel
                ? "#fffdf8"
                : "#ffffff"
            : isDarkPanel
              ? "rgba(15, 23, 42, 0.55)"
              : isWarmPanel
                ? "rgba(244, 237, 224, 0.72)"
                : "rgba(255, 255, 255, 0.72)";
          drawRoundedRect(ctx, 22, card.topY, width - 44, card.height, 18);
          ctx.fill();
          ctx.strokeStyle = isActive
            ? isDarkPanel
              ? "rgba(99, 102, 241, 0.45)"
              : isWarmPanel
                ? "#fcd34d"
                : "#c7d2fe"
            : isDarkPanel
              ? "#1e293b"
              : isWarmPanel
                ? "#e5dac6"
                : "#e2e8f0";
          ctx.lineWidth = isActive ? 1.75 : 1;
          ctx.stroke();

          ctx.fillStyle = isActive
            ? isDarkPanel
              ? "#818cf8"
              : isWarmPanel
                ? "#d97706"
                : "#4f46e5"
            : isDarkPanel
              ? "#1e293b"
              : isWarmPanel
                ? "#dfd3be"
                : "#e2e8f0";
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
                  ? "#a5b4fc"
                  : "#cbd5e1"
                : isWarmPanel
                  ? wasSpoken
                    ? "#92400e"
                    : "#292524"
                  : wasSpoken
                    ? "#4338ca"
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
                    ? "#6ee7b7"
                    : "#047857"
                  : subHl === "indigo"
                    ? isDarkPanel
                      ? "#a5b4fc"
                      : "#4338ca"
                    : subHl === "rose"
                      ? isDarkPanel
                        ? "#fda4af"
                        : "#be123c"
                      : isDarkPanel
                        ? "#fcd34d"
                        : "#b45309"
                : isActive
                  ? isDarkPanel
                    ? "#5eead4"
                    : "#0f766e"
                  : isDarkPanel
                    ? "#475569"
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
                  ? "rgba(99, 102, 241, 0.22)"
                  : isWarmPanel
                    ? "#fde68a"
                    : "#e0e7ff"
                : isDarkPanel
                  ? "#1e293b"
                  : isWarmPanel
                    ? "#e7dcc8"
                    : "#f1f5f9";
              ctx.fillRect(54, dividerY, width - 96, 1);
            }

            ctx.font = `600 ${idxPx}px 'JetBrains Mono', monospace`;
            ctx.fillStyle = isActive
              ? isDarkPanel
                ? "#818cf8"
                : isWarmPanel
                  ? "#b45309"
                  : "#6366f1"
              : isDarkPanel
                ? "#475569"
                : isWarmPanel
                  ? "#a8a29e"
                  : "#94a3b8";
            ctx.fillText(String(ci + 1).padStart(2, "0"), 54, card.burmeseStartY - 1);

            ctx.font = `500 ${burmesePx}px 'Noto Sans Myanmar', 'Plus Jakarta Sans', sans-serif`;
            ctx.fillStyle = isActive
              ? isDarkPanel
                ? "#99f6e4"
                : "#115e59"
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

      for (let frameIdx = 0; frameIdx < totalFrames; frameIdx++) {
        if (encoderError || encoder.state !== "configured") {
          try {
            encoder.close();
          } catch {
            // ignore
          }
          return null;
        }

        const t = (frameIdx / fps) * speed;
        await renderFrameAtTime(t, frameIdx);

        const frame = new VideoFrame(canvas, {
          timestamp: Math.round((frameIdx * 1_000_000) / fps),
          duration: Math.round(1_000_000 / fps),
        });
        try {
          encoder.encode(frame, { keyFrame: frameIdx % fps === 0 });
        } finally {
          frame.close();
        }

        while (encoder.encodeQueueSize > 4 && !encoderError) {
          await new Promise((r) => setTimeout(r, 6));
        }

        if (frameIdx % 12 === 0) {
          onProgress({
            phase: "rendering",
            percent: 10 + Math.round((frameIdx / totalFrames) * 75),
          });
          await new Promise((r) => setTimeout(r, 0));
        }
      }

      if (encoderError) {
        try {
          encoder.close();
        } catch {
          // ignore
        }
        return null;
      }

      await encoder.flush();
      encoder.close();
      muxer.finalize();
      const bytes = new Uint8Array(target.buffer);
      if (bytes.byteLength < 1024 || encoderError) {
        return null;
      }
      return bytes;
    };

    let videoBytes: Uint8Array | null = await encodeWithWebCodecs("no-preference");
    if (!videoBytes) {
      videoBytes = await encodeWithWebCodecs("prefer-software");
    }

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
      try {
        const frameIntervalMs = 1000 / fps;
        for (let frameIdx = 0; frameIdx < totalFrames; frameIdx++) {
          const frameStart = performance.now();
          const t = (frameIdx / fps) * speed;
          await renderFrameAtTime(t, frameIdx);
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
          if (frameIdx % 12 === 0) {
            onProgress({
              phase: "rendering",
              percent: 10 + Math.round((frameIdx / totalFrames) * 75),
            });
          }
        }
      } finally {
        if (recorder.state !== "inactive") {
          recorder.stop();
        }
        recordedDurationSec = Math.max(0.1, (performance.now() - recStartMs) / 1000);
        try {
          videoBytes = await donePromise;
        } finally {
          stream.getTracks().forEach((tr) => tr.stop());
        }
      }
      forceCfrFromFrames = useManualCapture;
    }

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
        targetDurationSec: totalDuration,
        expectedFrameCount: totalFrames,
        forceCfrFromFrames,
        recordedDurationSec,
      }),
    });

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

    onProgress({ phase: "muxing", percent: 100 });
    return await resp.blob();
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
