import { Muxer, ArrayBufferTarget } from "mp4-muxer";
import type { SubtitleItem, VideoEditSettings, VideoProject, VoiceSettings } from "../types";
import {
  applyAdversarialPerturbationToImageData,
  buildCssFilterString,
  createAdversarialPerturbationTile,
} from "./videoFilters";
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

    y += sub.words.length > 0 ? 66 : 16;
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
    if (cutTime <= acc + scene.durationSec || i === project.scenes.length - 1) {
      return Math.min(scene.endSec, scene.startSec + Math.max(0, cutTime - acc));
    }
    acc += scene.durationSec;
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
  const scenesDuration = project.scenes.reduce((acc, sc) => acc + Math.max(0, sc.durationSec), 0);
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

    const { cards } = measureSubtitleList(ctx, project.subtitles, width);

    const getActiveCardIndex = (t: number): number => {
      let idx = -1;
      for (let i = 0; i < cards.length; i++) {
        if (t >= cards[i].sub.startTime) idx = i;
        else break;
      }
      return idx;
    };

    const getScrollYForTime = (t: number): number => {
      const activeIdx = Math.max(0, getActiveCardIndex(t));
      const active = cards[activeIdx];
      if (!active) return 0;
      const desiredCenter = active.topY + active.height * 0.5 - listH * 0.42;
      return Math.max(0, desiredCenter);
    };

    let currentScrollY = 0;

    const renderFrameAtTime = async (t: number, frameIdx = 0) => {
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
        ctx.fillStyle = darkMode ? "#1e293b" : "#cbd5e1";
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

        for (let ci = 0; ci < cards.length; ci++) {
          const card = cards[ci];
          const screenTop = card.topY - currentScrollY;
          if (screenTop + card.height < -60 || screenTop > listH + 60) continue;

          const isActive = ci === activeCardIdx;

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

          ctx.fillStyle = isActive
            ? darkMode
              ? "#818cf8"
              : "#4f46e5"
            : darkMode
              ? "#1e293b"
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
              ctx.fillStyle = "#64748b";
            }
            ctx.fillText(wl.phonetic, wl.x + 5, wl.y);

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

          if (card.wordLayouts.length > 0) {
            const dividerY = card.burmeseStartY - 30;
            ctx.fillStyle = isActive
              ? darkMode
                ? "rgba(99, 102, 241, 0.22)"
                : "#e0e7ff"
              : darkMode
                ? "#1e293b"
                : "#f1f5f9";
            ctx.fillRect(54, dividerY, width - 96, 1);
          }

          ctx.font = "600 15px 'JetBrains Mono', monospace";
          ctx.fillStyle = isActive
            ? darkMode
              ? "#818cf8"
              : "#6366f1"
            : darkMode
              ? "#475569"
              : "#94a3b8";
          ctx.fillText(String(ci + 1).padStart(2, "0"), 54, card.burmeseStartY - 1);

          ctx.font = "500 22px 'Noto Sans Myanmar', 'Plus Jakarta Sans', sans-serif";
          ctx.fillStyle = isActive
            ? darkMode
              ? "#99f6e4"
              : "#115e59"
            : "#64748b";
          card.burmeseLines.forEach((line, li) => {
            ctx.fillText(line, 86, card.burmeseStartY + li * 34);
          });
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

    if (!videoBytes) {
      // Fallback: MediaRecorder WebM capture (render frame 0 before starting so no blank initial frame)
      videoFormat = "webm";
      currentScrollY = 0;
      await renderFrameAtTime(0, 0);

      const stream = canvas.captureStream(fps);
      const track = stream.getVideoTracks()[0] as
        | (MediaStreamTrack & { requestFrame?: () => void })
        | undefined;

      const mimeType = MediaRecorder.isTypeSupported("video/webm;codecs=vp9")
        ? "video/webm;codecs=vp9"
        : MediaRecorder.isTypeSupported("video/webm;codecs=vp8")
          ? "video/webm;codecs=vp8"
          : "video/webm";

      const recorder = new MediaRecorder(stream, {
        mimeType,
        videoBitsPerSecond: 2_600_000,
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

      recorder.start(250);
      const frameIntervalMs = 1000 / fps;
      for (let frameIdx = 0; frameIdx < totalFrames; frameIdx++) {
        const frameStart = performance.now();
        const t = (frameIdx / fps) * speed;
        await renderFrameAtTime(t, frameIdx);
        track?.requestFrame?.();
        if (frameIdx % 12 === 0) {
          onProgress({
            phase: "rendering",
            percent: 10 + Math.round((frameIdx / totalFrames) * 75),
          });
        }
        const elapsed = performance.now() - frameStart;
        const waitMs = Math.max(4, frameIntervalMs - elapsed);
        await new Promise((r) => setTimeout(r, waitMs));
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
