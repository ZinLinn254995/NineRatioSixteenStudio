// server.ts
import "dotenv/config";
import express from "express";
import fs from "fs";
import path from "path";
import os from "os";
import crypto from "crypto";
import { execFile } from "child_process";
import { promisify } from "util";
import { GoogleGenAI, Type, ThinkingLevel } from "@google/genai";
var execFileAsync = promisify(execFile);
var FFMPEG_EXEC_OPTS = { maxBuffer: 16 * 1024 * 1024 };
var app = express();
var PORT = 3e3;
app.use(express.json({ limit: "100mb" }));
var MAX_UPLOAD_BYTES = 500 * 1024 * 1024;
var INCOMPLETE_UPLOAD_TTL_MS = 20 * 60 * 1e3;
var COMPLETED_UPLOAD_TTL_MS = 2 * 60 * 60 * 1e3;
var UPLOAD_SWEEP_INTERVAL_MS = 5 * 60 * 1e3;
var uploadSessions = /* @__PURE__ */ new Map();
function registerUploadSession(uploadId, filePath, opts = {}) {
  const now = Date.now();
  const session = {
    id: uploadId,
    filePath,
    createdAt: now,
    lastAccessedAt: now,
    expectedSize: opts.expectedSize,
    receivedBytes: opts.receivedBytes ?? 0,
    finalized: Boolean(opts.finalized),
    activeLocks: 0,
    pendingDelete: false,
    writeChain: Promise.resolve(),
    writtenOffsets: /* @__PURE__ */ new Map()
  };
  uploadSessions.set(uploadId, session);
  return session;
}
function touchUploadSession(session, markFinalized = false) {
  session.lastAccessedAt = Date.now();
  if (markFinalized) {
    session.finalized = true;
  }
}
async function deleteUploadSessionNow(session) {
  if (uploadSessions.get(session.id) === session) {
    uploadSessions.delete(session.id);
  }
  await fs.promises.rm(session.filePath, { force: true }).catch(() => {
  });
}
async function deleteUploadSession(uploadId) {
  const session = uploadSessions.get(uploadId);
  if (!session) return false;
  if (session.activeLocks > 0) {
    session.pendingDelete = true;
    return true;
  }
  await deleteUploadSessionNow(session);
  return true;
}
async function withUploadSessionLock(uploadId, fn, opts = {}) {
  const session = uploadSessions.get(uploadId);
  if (!session || session.pendingDelete || !fs.existsSync(session.filePath)) {
    return null;
  }
  session.activeLocks += 1;
  touchUploadSession(session, Boolean(opts.markFinalized));
  try {
    return await fn(session.filePath, session);
  } finally {
    session.activeLocks = Math.max(0, session.activeLocks - 1);
    touchUploadSession(session);
    if (session.activeLocks === 0 && session.pendingDelete) {
      await deleteUploadSessionNow(session);
    }
  }
}
var COMPLETED_EXPORT_TTL_MS = 15 * 60 * 1e3;
var completedExports = /* @__PURE__ */ new Map();
function sanitizeExportFileName(rawName) {
  const base = String(rawName || "thai-burmese-9x16.mp4").replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64);
  if (!base) return "thai-burmese-9x16.mp4";
  return base.toLowerCase().endsWith(".mp4") ? base : `${base}.mp4`;
}
async function registerCompletedExport(sourceMp4Path, fileName) {
  const id = crypto.randomBytes(12).toString("hex");
  const dirPath = await fs.promises.mkdtemp(path.join(os.tmpdir(), "thai-export-"));
  const safeFileName = sanitizeExportFileName(fileName);
  const destPath = path.join(dirPath, safeFileName);
  try {
    await fs.promises.rename(sourceMp4Path, destPath);
  } catch {
    await fs.promises.copyFile(sourceMp4Path, destPath);
  }
  const stat = await fs.promises.stat(destPath);
  const entry = {
    id,
    filePath: destPath,
    dirPath,
    fileName: safeFileName,
    sizeBytes: stat.size,
    createdAt: Date.now()
  };
  completedExports.set(id, entry);
  return entry;
}
async function sweepExpiredCompletedExports() {
  const now = Date.now();
  for (const [id, entry] of completedExports.entries()) {
    if (now - entry.createdAt > COMPLETED_EXPORT_TTL_MS || !fs.existsSync(entry.filePath)) {
      completedExports.delete(id);
      await fs.promises.rm(entry.dirPath, { recursive: true, force: true }).catch(() => {
      });
    }
  }
}
async function sweepExpiredUploadSessions() {
  const now = Date.now();
  const entries = Array.from(uploadSessions.values());
  for (const session of entries) {
    if (session.activeLocks > 0) continue;
    const ttl = session.finalized ? COMPLETED_UPLOAD_TTL_MS : INCOMPLETE_UPLOAD_TTL_MS;
    const isExpired = now - session.lastAccessedAt > ttl;
    const missingFile = !fs.existsSync(session.filePath);
    if (session.pendingDelete || isExpired || missingFile) {
      await deleteUploadSessionNow(session);
    }
  }
  await sweepExpiredCompletedExports();
}
async function sweepOrphanedTempFiles() {
  try {
    const tmpRoot = os.tmpdir();
    const activePaths = /* @__PURE__ */ new Set([
      ...Array.from(uploadSessions.values()).map((s) => s.filePath),
      ...Array.from(completedExports.values()).map((e) => e.dirPath)
    ]);
    const names = await fs.promises.readdir(tmpRoot);
    const now = Date.now();
    for (const name of names) {
      if (!name.startsWith("thai-studio-upload-") && !name.startsWith("upload-vid-") && !name.startsWith("thai-prep-") && !name.startsWith("thai-studio-") && !name.startsWith("thai-export-")) {
        continue;
      }
      const fullPath = path.join(tmpRoot, name);
      if (activePaths.has(fullPath)) continue;
      try {
        const st = await fs.promises.stat(fullPath);
        if (now - st.mtimeMs > COMPLETED_UPLOAD_TTL_MS) {
          await fs.promises.rm(fullPath, { recursive: true, force: true }).catch(() => {
          });
        }
      } catch {
      }
    }
  } catch {
  }
}
async function probeMediaInfo(mediaPath) {
  try {
    const { stdout } = await execFileAsync(
      "ffprobe",
      [
        "-v",
        "quiet",
        "-print_format",
        "json",
        "-show_streams",
        "-show_format",
        mediaPath
      ],
      FFMPEG_EXEC_OPTS
    );
    const parsed = JSON.parse(stdout || "{}");
    const streams = Array.isArray(parsed.streams) ? parsed.streams : [];
    const hasAudio = streams.some((s) => s.codec_type === "audio");
    const hasVideo = streams.some((s) => s.codec_type === "video");
    const rawFmtDur = Number(parsed.format?.duration);
    const videoStream = streams.find((s) => s.codec_type === "video");
    const rawStreamDur = Number(videoStream?.duration);
    const durationSec = Number.isFinite(rawFmtDur) && rawFmtDur > 0 ? rawFmtDur : Number.isFinite(rawStreamDur) && rawStreamDur > 0 ? rawStreamDur : 0;
    return { hasAudio, hasVideo, durationSec };
  } catch {
    return { hasAudio: false, hasVideo: true, durationSec: 0 };
  }
}
function getGeminiClient() {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error("GEMINI_API_KEY is not configured in environment secrets.");
  }
  return new GoogleGenAI({
    apiKey,
    httpOptions: {
      headers: {
        "User-Agent": "aistudio-build"
      }
    }
  });
}
function parseGeminiError(err) {
  const errObj = err && typeof err === "object" ? err : {};
  const rawMessage = err instanceof Error ? err.message : String(err || "Unknown AI error");
  let parsedCode = typeof errObj.status === "number" ? errObj.status : typeof errObj.code === "number" ? errObj.code : 0;
  let parsedStatus = "";
  let innerMessage = rawMessage;
  const trimmed = rawMessage.trim();
  if (trimmed.startsWith("{")) {
    try {
      const json = JSON.parse(trimmed);
      const inner = json.error ?? json;
      if (typeof inner.code === "number") parsedCode = inner.code;
      if (typeof inner.status === "string") parsedStatus = inner.status;
      if (typeof inner.message === "string" && inner.message.trim()) {
        innerMessage = inner.message.trim();
      }
    } catch {
    }
  }
  if (!parsedCode) {
    const codeMatch = rawMessage.match(/\b(400|401|403|404|429|500|502|503|504)\b/);
    if (codeMatch) parsedCode = Number(codeMatch[1]);
  }
  const isTransient = parsedCode === 429 || parsedCode === 500 || parsedCode === 502 || parsedCode === 503 || parsedCode === 504 || /429|500|502|503|504|UNAVAILABLE|RESOURCE_EXHAUSTED|high demand|overloaded|temporarily|try again|rate limit|quota|ECONNRESET|ETIMEDOUT|fetch failed/i.test(
    `${parsedStatus} ${innerMessage} ${rawMessage}`
  );
  const isUnsupportedInput = !isTransient && (parsedCode === 400 || parsedCode === 404 || /INVALID_ARGUMENT|NOT_FOUND|unsupported|not supported/i.test(
    `${parsedStatus} ${innerMessage} ${rawMessage}`
  ));
  return {
    status: parsedCode || 500,
    statusText: parsedStatus,
    rawMessage: innerMessage,
    isTransient,
    isUnsupportedInput
  };
}
function formatGeminiError(err, fallback = "AI processing failed. Please try again.") {
  const info = parseGeminiError(err);
  if (info.status === 503 || /UNAVAILABLE|high demand|overloaded/i.test(`${info.statusText} ${info.rawMessage}`)) {
    return {
      status: 503,
      message: "Gemini AI is temporarily experiencing high demand (503). Please wait a few seconds and try again."
    };
  }
  if (info.status === 429 || /RESOURCE_EXHAUSTED|rate limit|quota/i.test(`${info.statusText} ${info.rawMessage}`)) {
    return {
      status: 429,
      message: "AI rate limit or quota reached (429). Please wait a moment and try again, or check your API key in Settings > Secrets."
    };
  }
  if (info.status === 403 || /PERMISSION_DENIED|API_KEY_INVALID|API key not valid/i.test(
    `${info.statusText} ${info.rawMessage}`
  )) {
    return {
      status: 403,
      message: "Gemini API key is invalid or lacks permission. Please check your API key in Settings > Secrets."
    };
  }
  return {
    status: info.status >= 400 && info.status < 600 ? info.status : 500,
    message: info.rawMessage || fallback
  };
}
async function mapWithConcurrency(items, concurrency, fn) {
  if (items.length === 0) return [];
  const limit = Math.max(1, Math.min(concurrency, items.length));
  const results = new Array(items.length);
  let nextIdx = 0;
  const workers = Array.from({ length: limit }, async () => {
    while (nextIdx < items.length) {
      const idx = nextIdx++;
      results[idx] = await fn(items[idx], idx);
    }
  });
  await Promise.all(workers);
  return results;
}
var RETRY_BASE_DELAYS_MS = [1200, 2500, 4500, 7500, 1e4];
async function generateGroundedWithFailover(ai, contents, schema, thinkingLevel = ThinkingLevel.MEDIUM, opts) {
  const maxAttempts = Math.max(2, Math.min(6, opts?.maxAttempts ?? 6));
  const candidateModels = ["gemini-4-hydrogen", "gemini-3.1-flash-lite"];
  const unsupportedModels = /* @__PURE__ */ new Set();
  let lastTransientErr = null;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const preferred = candidateModels[attempt % candidateModels.length];
    const model = unsupportedModels.has(preferred) ? candidateModels.find((m) => !unsupportedModels.has(m)) : preferred;
    if (!model) break;
    try {
      const config = model === "gemini-4-hydrogen" ? {
        thinkingConfig: { thinkingLevel },
        responseMimeType: "application/json",
        responseSchema: schema
      } : {
        responseMimeType: "application/json",
        responseSchema: schema
      };
      return await ai.models.generateContent({
        model,
        contents,
        config
      });
    } catch (err) {
      const info = parseGeminiError(err);
      if (model !== "gemini-4-hydrogen" && info.isUnsupportedInput) {
        unsupportedModels.add(model);
        if (attempt < maxAttempts - 1) continue;
        throw lastTransientErr ?? err;
      }
      if (!info.isTransient) {
        throw err;
      }
      lastTransientErr = err;
      if (attempt === maxAttempts - 1) {
        throw err;
      }
      const baseDelay = RETRY_BASE_DELAYS_MS[Math.min(attempt, RETRY_BASE_DELAYS_MS.length - 1)];
      const jitter = Math.floor(Math.random() * 600);
      const delayMs = baseDelay + jitter;
      const nextModel = candidateModels[(attempt + 1) % candidateModels.length];
      console.warn(
        `Gemini ${model} transient error (${info.status}: ${info.rawMessage}). Retrying with ${nextModel} in ${delayMs}ms (attempt ${attempt + 2}/${maxAttempts})`
      );
      opts?.onRetry?.({
        attempt: attempt + 2,
        maxAttempts,
        delayMs,
        model: unsupportedModels.has(nextModel) ? "gemini-4-hydrogen" : nextModel
      });
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  throw lastTransientErr ?? new Error("Gemini AI is temporarily unavailable.");
}
function parseDurationToSeconds(text) {
  if (!text) return 0;
  const parts = text.trim().split(":").map((n) => parseInt(n, 10));
  if (parts.some((n) => Number.isNaN(n))) return 0;
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  if (parts.length === 1) return parts[0];
  return 0;
}
function extractYouTubeVideoId(input) {
  const trimmed = input.trim();
  const patterns = [
    /(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/shorts\/|youtube\.com\/embed\/)([a-zA-Z0-9_-]{11})/,
    /^([a-zA-Z0-9_-]{11})$/
  ];
  for (const p of patterns) {
    const m = trimmed.match(p);
    if (m?.[1]) return m[1];
  }
  return null;
}
function readRunsText(obj) {
  if (!obj || typeof obj !== "object") return "";
  const rec = obj;
  if (rec.simpleText) return rec.simpleText;
  if (Array.isArray(rec.runs)) {
    return rec.runs.map((r) => r.text ?? "").join("");
  }
  return "";
}
var YT_HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
  "Accept-Language": "en-US,en;q=0.9"
};
var cachedInnerTube = null;
async function getInnerTubeConfig(forceRefresh = false) {
  if (!forceRefresh && cachedInnerTube && Date.now() - cachedInnerTube.fetchedAt < 30 * 60 * 1e3) {
    return {
      apiKey: cachedInnerTube.apiKey,
      clientVersion: cachedInnerTube.clientVersion
    };
  }
  const resp = await fetch("https://www.youtube.com/", { headers: YT_HEADERS });
  if (!resp.ok) {
    throw new Error(`YouTube returned HTTP ${resp.status}`);
  }
  const html = await resp.text();
  const apiKey = html.match(/"INNERTUBE_API_KEY":"([^"]+)"/)?.[1];
  const clientVersion = html.match(/"INNERTUBE_CLIENT_VERSION":"([^"]+)"/)?.[1] || "2.20261116.00.00";
  if (!apiKey) {
    throw new Error("Could not initialize YouTube search client.");
  }
  cachedInnerTube = { apiKey, clientVersion, fetchedAt: Date.now() };
  return { apiKey, clientVersion };
}
function readRendererDurationText(v) {
  const direct = readRunsText(v.lengthText);
  if (direct) return direct;
  if (Array.isArray(v.thumbnailOverlays)) {
    for (const ov of v.thumbnailOverlays) {
      const ts = ov?.thumbnailOverlayTimeStatusRenderer?.text;
      const t = readRunsText(ts);
      if (t) return t;
    }
  }
  return "";
}
function extractVideosAndContinuation(root, seen = /* @__PURE__ */ new Set(), forcedLicense) {
  const renderers = [];
  let nextContinuation = null;
  const walk = (node) => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) {
      for (const item of node) walk(item);
      return;
    }
    const obj = node;
    if (obj.videoRenderer && typeof obj.videoRenderer === "object") {
      renderers.push(obj.videoRenderer);
    } else if (obj.gridVideoRenderer && typeof obj.gridVideoRenderer === "object") {
      renderers.push(obj.gridVideoRenderer);
    }
    if (!nextContinuation && obj.continuationItemRenderer) {
      const token = obj.continuationItemRenderer?.continuationEndpoint?.continuationCommand?.token;
      if (typeof token === "string" && token.length > 0) {
        nextContinuation = token;
      }
    }
    for (const val of Object.values(obj)) {
      walk(val);
    }
  };
  walk(root);
  const videos = [];
  for (const v of renderers) {
    const videoId = typeof v.videoId === "string" ? v.videoId : "";
    if (!videoId || seen.has(videoId)) continue;
    const durationText = readRendererDurationText(v);
    const durationSec = parseDurationToSeconds(durationText);
    if (durationSec < 5) continue;
    seen.add(videoId);
    const title = readRunsText(v.title);
    const channel = readRunsText(v.ownerText) || readRunsText(v.longBylineText) || readRunsText(v.shortBylineText) || "YouTube";
    const viewCountText = readRunsText(v.shortViewCountText) || readRunsText(v.viewCountText);
    const publishedTimeText = readRunsText(v.publishedTimeText);
    videos.push({
      videoId,
      title: title || "YouTube Video",
      channel,
      durationText: durationText || "1:30",
      durationSec,
      thumbnail: `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
      viewCountText,
      publishedTimeText,
      ...forcedLicense ? { license: forcedLicense } : {}
    });
  }
  return { videos, nextContinuation };
}
var licenseCache = /* @__PURE__ */ new Map();
function hasCreativeCommonsMetadata(nextData) {
  let found = false;
  const walkMeta = (node) => {
    if (found || !node || typeof node !== "object") return;
    if (Array.isArray(node)) {
      for (const item of node) walkMeta(item);
      return;
    }
    const obj = node;
    if (obj.metadataRowContainerRenderer) {
      const serialized = JSON.stringify(obj.metadataRowContainerRenderer);
      if (/Creative Commons|reuse allowed/i.test(serialized)) {
        found = true;
      }
      return;
    }
    for (const val of Object.values(obj)) {
      walkMeta(val);
    }
  };
  walkMeta(nextData);
  return found;
}
async function detectVideoLicense(videoId, config) {
  const cached = licenseCache.get(videoId);
  if (cached) return cached;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 3500);
    const resp = await fetch(
      `https://www.youtube.com/youtubei/v1/next?key=${config.apiKey}`,
      {
        method: "POST",
        headers: { ...YT_HEADERS, "Content-Type": "application/json" },
        body: JSON.stringify({
          context: {
            client: {
              clientName: "WEB",
              clientVersion: config.clientVersion,
              hl: "en",
              gl: "US"
            }
          },
          videoId
        }),
        signal: controller.signal
      }
    );
    clearTimeout(timer);
    if (!resp.ok) return "standard";
    const data = await resp.json();
    const detected = hasCreativeCommonsMetadata(data) ? "creative_commons" : "standard";
    if (licenseCache.size > 3e3) {
      const firstKey = licenseCache.keys().next().value;
      if (firstKey) licenseCache.delete(firstKey);
    }
    licenseCache.set(videoId, detected);
    return detected;
  } catch {
    return "standard";
  }
}
async function annotateVideoLicenses(videos, config) {
  const concurrency = 10;
  const out = [...videos];
  for (let i = 0; i < out.length; i += concurrency) {
    const slice = out.slice(i, i + concurrency);
    const licenses = await Promise.all(
      slice.map(
        (v) => v.license ? Promise.resolve(v.license) : detectVideoLicense(v.videoId, config)
      )
    );
    for (let j = 0; j < slice.length; j++) {
      out[i + j] = { ...out[i + j], license: licenses[j] };
    }
  }
  return out;
}
function shuffleArray(items) {
  const arr = [...items];
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const tmp = arr[i];
    arr[i] = arr[j];
    arr[j] = tmp;
  }
  return arr;
}
var DISCOVERY_SEARCH_TOPICS = [
  "science explainer",
  "nature documentary",
  "world news today",
  "street food tour",
  "history documentary",
  "space exploration",
  "cooking tutorial",
  "travel vlog",
  "english conversation practice",
  "animation short film",
  "technology explained",
  "wildlife animals"
];
var THAI_DISCOVERY_SEARCH_TOPICS = [
  "\u0E2A\u0E32\u0E23\u0E04\u0E14\u0E35 \u0E27\u0E34\u0E17\u0E22\u0E32\u0E28\u0E32\u0E2A\u0E15\u0E23\u0E4C \u0E19\u0E48\u0E32\u0E17\u0E36\u0E48\u0E07",
  "\u0E2A\u0E32\u0E23\u0E04\u0E14\u0E35 \u0E18\u0E23\u0E23\u0E21\u0E0A\u0E32\u0E15\u0E34 \u0E2A\u0E31\u0E15\u0E27\u0E4C\u0E42\u0E25\u0E01",
  "\u0E40\u0E25\u0E48\u0E32\u0E40\u0E23\u0E37\u0E48\u0E2D\u0E07 \u0E1B\u0E23\u0E30\u0E27\u0E31\u0E15\u0E34\u0E28\u0E32\u0E2A\u0E15\u0E23\u0E4C \u0E42\u0E25\u0E01",
  "\u0E04\u0E27\u0E32\u0E21\u0E23\u0E39\u0E49\u0E23\u0E2D\u0E1A\u0E15\u0E31\u0E27 \u0E27\u0E34\u0E17\u0E22\u0E32\u0E28\u0E32\u0E2A\u0E15\u0E23\u0E4C",
  "\u0E2A\u0E23\u0E38\u0E1B\u0E02\u0E48\u0E32\u0E27 \u0E27\u0E31\u0E19\u0E19\u0E35\u0E49 \u0E25\u0E48\u0E32\u0E2A\u0E38\u0E14",
  "\u0E17\u0E33\u0E2D\u0E32\u0E2B\u0E32\u0E23 \u0E2D\u0E32\u0E2B\u0E32\u0E23\u0E44\u0E17\u0E22 \u0E27\u0E34\u0E18\u0E35\u0E17\u0E33",
  "\u0E17\u0E48\u0E2D\u0E07\u0E40\u0E17\u0E35\u0E48\u0E22\u0E27 \u0E44\u0E17\u0E22 vlog \u0E1E\u0E32\u0E01\u0E34\u0E19",
  "\u0E40\u0E17\u0E04\u0E42\u0E19\u0E42\u0E25\u0E22\u0E35 \u0E2D\u0E18\u0E34\u0E1A\u0E32\u0E22 \u0E07\u0E48\u0E32\u0E22\u0E46",
  "\u0E1D\u0E36\u0E01\u0E1E\u0E39\u0E14\u0E20\u0E32\u0E29\u0E32\u0E44\u0E17\u0E22 \u0E1A\u0E17\u0E2A\u0E19\u0E17\u0E19\u0E32",
  "\u0E1E\u0E2D\u0E14\u0E41\u0E04\u0E2A\u0E15\u0E4C \u0E40\u0E25\u0E48\u0E32\u0E40\u0E23\u0E37\u0E48\u0E2D\u0E07 \u0E20\u0E32\u0E29\u0E32\u0E44\u0E17\u0E22",
  "\u0E2D\u0E32\u0E2B\u0E32\u0E23\u0E02\u0E49\u0E32\u0E07\u0E17\u0E32\u0E07 \u0E23\u0E35\u0E27\u0E34\u0E27 \u0E44\u0E17\u0E22",
  "\u0E2A\u0E32\u0E23\u0E04\u0E14\u0E35 \u0E2D\u0E27\u0E01\u0E32\u0E28 \u0E08\u0E31\u0E01\u0E23\u0E27\u0E32\u0E25"
];
var CREATIVE_COMMONS_DISCOVERY_QUERIES = [
  "creative commons documentary",
  "creative commons nature",
  "creative commons science",
  "creative commons travel",
  "creative commons history",
  "creative commons education",
  "creative commons animation",
  "creative commons"
];
var THAI_CREATIVE_COMMONS_QUERIES = [
  "\u0E2A\u0E32\u0E23\u0E04\u0E14\u0E35 \u0E20\u0E32\u0E29\u0E32\u0E44\u0E17\u0E22",
  "\u0E04\u0E27\u0E32\u0E21\u0E23\u0E39\u0E49 \u0E27\u0E34\u0E17\u0E22\u0E32\u0E28\u0E32\u0E2A\u0E15\u0E23\u0E4C \u0E44\u0E17\u0E22",
  "\u0E17\u0E48\u0E2D\u0E07\u0E40\u0E17\u0E35\u0E48\u0E22\u0E27 \u0E18\u0E23\u0E23\u0E21\u0E0A\u0E32\u0E15\u0E34 \u0E44\u0E17\u0E22",
  "\u0E17\u0E33\u0E2D\u0E32\u0E2B\u0E32\u0E23 \u0E44\u0E17\u0E22",
  "\u0E1B\u0E23\u0E30\u0E27\u0E31\u0E15\u0E34\u0E28\u0E32\u0E2A\u0E15\u0E23\u0E4C \u0E40\u0E25\u0E48\u0E32\u0E40\u0E23\u0E37\u0E48\u0E2D\u0E07",
  "\u0E01\u0E32\u0E23\u0E28\u0E36\u0E01\u0E29\u0E32 \u0E20\u0E32\u0E29\u0E32\u0E44\u0E17\u0E22",
  "\u0E40\u0E17\u0E04\u0E42\u0E19\u0E42\u0E25\u0E22\u0E35 \u0E04\u0E27\u0E32\u0E21\u0E23\u0E39\u0E49",
  "\u0E0A\u0E35\u0E27\u0E34\u0E15\u0E1B\u0E23\u0E30\u0E08\u0E33\u0E27\u0E31\u0E19 \u0E20\u0E32\u0E29\u0E32\u0E44\u0E17\u0E22"
];
var THAI_SCRIPT_REGEX = /[\u0E00-\u0E7F]/;
function isThaiLanguageVideo(v) {
  return THAI_SCRIPT_REGEX.test(v.title) || THAI_SCRIPT_REGEX.test(v.channel);
}
function getYouTubeHeaders(thaiOnly) {
  return {
    ...YT_HEADERS,
    "Accept-Language": thaiOnly ? "th-TH,th;q=0.9,en;q=0.5" : YT_HEADERS["Accept-Language"],
    "Content-Type": "application/json"
  };
}
function getYouTubeClientContext(config, thaiOnly) {
  return {
    client: {
      clientName: "WEB",
      clientVersion: config.clientVersion,
      hl: thaiOnly ? "th" : "en",
      gl: thaiOnly ? "TH" : "US"
    }
  };
}
var cachedRecommendedPools = {
  all: null,
  th: null
};
var recommendedFeedSessions = /* @__PURE__ */ new Map();
function storeRecommendedFeedSession(videos) {
  const now = Date.now();
  for (const [key, entry] of recommendedFeedSessions.entries()) {
    if (now - entry.createdAt > 30 * 60 * 1e3) {
      recommendedFeedSessions.delete(key);
    }
  }
  while (recommendedFeedSessions.size >= 40) {
    const oldestKey = recommendedFeedSessions.keys().next().value;
    if (!oldestKey) break;
    recommendedFeedSessions.delete(oldestKey);
  }
  const feedId = crypto.randomBytes(6).toString("hex");
  recommendedFeedSessions.set(feedId, { videos, createdAt: now });
  return feedId;
}
async function getRecommendedPool(forceRefresh = false, thaiOnly = false) {
  const poolKey = thaiOnly ? "th" : "all";
  const existing = cachedRecommendedPools[poolKey];
  if (!forceRefresh && existing && Date.now() - existing.fetchedAt < 3 * 60 * 1e3) {
    return existing.videos;
  }
  const config = await getInnerTubeConfig();
  const headers = getYouTubeHeaders(thaiOnly);
  const context = getYouTubeClientContext(config, thaiOnly);
  const browseHubs = thaiOnly ? shuffleArray([
    "UCtFRv9O2AHqOZjjynzrv-xg",
    // Learning & Explainers
    "UCYfdidRxbB8Qhf0Nx7ioOYw"
    // News
  ]) : shuffleArray([
    "UCtFRv9O2AHqOZjjynzrv-xg",
    // Learning & Explainers
    "UC4R8DWoMoI7CAwX8_LjQHig",
    // Live & Popular
    "UCEgdi0XIXXZ-qJOFPf4JSKw",
    // Sports
    "UCYfdidRxbB8Qhf0Nx7ioOYw"
    // News
  ]);
  const randomTopics = thaiOnly ? shuffleArray(THAI_DISCOVERY_SEARCH_TOPICS).slice(0, 4) : shuffleArray(DISCOVERY_SEARCH_TOPICS).slice(0, 2);
  const hubListsPromise = Promise.all(
    browseHubs.map(async (browseId) => {
      try {
        const resp = await fetch(
          `https://www.youtube.com/youtubei/v1/browse?key=${config.apiKey}`,
          {
            method: "POST",
            headers,
            body: JSON.stringify({
              context,
              browseId
            })
          }
        );
        if (!resp.ok) return [];
        const data = await resp.json();
        const vids = extractVideosAndContinuation(data).videos;
        return thaiOnly ? vids.filter(isThaiLanguageVideo) : vids;
      } catch {
        return [];
      }
    })
  );
  const topicListsPromise = Promise.all(
    randomTopics.map(async (topicQuery) => {
      try {
        const resp = await fetch(
          `https://www.youtube.com/youtubei/v1/search?key=${config.apiKey}`,
          {
            method: "POST",
            headers,
            body: JSON.stringify({
              context,
              query: topicQuery
            })
          }
        );
        if (!resp.ok) return [];
        const data = await resp.json();
        const vids = extractVideosAndContinuation(data).videos;
        return thaiOnly ? vids.filter(isThaiLanguageVideo) : vids;
      } catch {
        return [];
      }
    })
  );
  const [hubLists, topicLists] = await Promise.all([hubListsPromise, topicListsPromise]);
  const lists = [...topicLists, ...hubLists];
  const seen = /* @__PURE__ */ new Set();
  const combined = [];
  const maxLen = Math.max(...lists.map((l) => l.length), 0);
  for (let idx = 0; idx < maxLen; idx++) {
    for (const list of lists) {
      const item = list[idx];
      if (!item || seen.has(item.videoId)) continue;
      seen.add(item.videoId);
      combined.push(item);
    }
  }
  if (combined.length > 0) {
    cachedRecommendedPools[poolKey] = { videos: combined, fetchedAt: Date.now() };
  }
  return combined;
}
app.get("/api/youtube/search", async (req, res) => {
  try {
    const rawQuery = String(req.query.q ?? "").trim();
    const rawLicense = String(req.query.license ?? "all").trim();
    const licenseFilter = rawLicense === "creative_commons" || rawLicense === "standard" ? rawLicense : "all";
    const thaiOnly = String(req.query.thaiOnly ?? "").trim() === "1" || String(req.query.thaiOnly ?? "").trim() === "true" || String(req.query.lang ?? "").trim() === "th";
    const continuation = String(req.query.continuation ?? "").trim();
    const forceRefresh = String(req.query.refresh ?? "") === "1";
    const directId = rawQuery ? extractYouTubeVideoId(rawQuery) : null;
    const config = await getInnerTubeConfig();
    const ytHeaders = getYouTubeHeaders(thaiOnly);
    const ytContext = getYouTubeClientContext(config, thaiOnly);
    if (directId) {
      const [oembedResp, detectedLicense] = await Promise.all([
        fetch(
          `https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${directId}&format=json`
        ),
        detectVideoLicense(directId, config)
      ]);
      if (!oembedResp.ok) {
        res.status(404).json({ error: "Could not load metadata for this YouTube video." });
        return;
      }
      const oembed = await oembedResp.json();
      const video = {
        videoId: directId,
        title: oembed.title || `YouTube Video (${directId})`,
        channel: oembed.author_name || "YouTube Creator",
        durationText: "3:00",
        durationSec: 180,
        thumbnail: `https://i.ytimg.com/vi/${directId}/hqdefault.jpg`,
        viewCountText: "",
        publishedTimeText: "Direct link",
        license: detectedLicense
      };
      res.json({ videos: [video], nextContinuation: null, mode: "direct" });
      return;
    }
    if (!rawQuery) {
      if (licenseFilter === "creative_commons") {
        const isFirstPage = !continuation || continuation.startsWith("rec:");
        const ccQueries = thaiOnly ? THAI_CREATIVE_COMMONS_QUERIES : CREATIVE_COMMONS_DISCOVERY_QUERIES;
        const randomCcQuery = ccQueries[Math.floor(Math.random() * ccQueries.length)];
        const seen2 = /* @__PURE__ */ new Set();
        const collected2 = [];
        let currentCont2 = !isFirstPage ? continuation : void 0;
        let nextCont2 = null;
        const maxAttempts = thaiOnly ? 3 : 1;
        for (let attempt = 0; attempt < maxAttempts; attempt++) {
          const body = { context: ytContext };
          if (currentCont2) {
            body.continuation = currentCont2;
          } else {
            body.query = randomCcQuery;
            body.params = "EgIwAQ==";
          }
          const resp = await fetch(
            `https://www.youtube.com/youtubei/v1/search?key=${config.apiKey}`,
            {
              method: "POST",
              headers: ytHeaders,
              body: JSON.stringify(body)
            }
          );
          if (!resp.ok) {
            throw new Error(`YouTube returned HTTP ${resp.status}`);
          }
          const data = await resp.json();
          const extracted = extractVideosAndContinuation(data, seen2, "creative_commons");
          nextCont2 = extracted.nextContinuation;
          for (const v of extracted.videos) {
            if (!thaiOnly || isThaiLanguageVideo(v)) {
              collected2.push(v);
              licenseCache.set(v.videoId, "creative_commons");
            }
          }
          if (collected2.length >= 12 || !nextCont2) break;
          currentCont2 = nextCont2;
        }
        const videos = isFirstPage ? shuffleArray(collected2) : collected2;
        res.setHeader("Cache-Control", "no-store");
        res.json({ videos, nextContinuation: nextCont2, mode: "recommended" });
        return;
      }
      const pageSize = 24;
      let feedId = "";
      let sessionPool;
      let startIdx = 0;
      if (continuation.startsWith("rec:")) {
        const parts = continuation.slice(4).split(":");
        if (parts.length === 2) {
          feedId = parts[0];
          const parsed = parseInt(parts[1], 10);
          if (Number.isFinite(parsed) && parsed >= 0) startIdx = parsed;
          sessionPool = recommendedFeedSessions.get(feedId)?.videos;
        }
      }
      if (!sessionPool) {
        const basePool = await getRecommendedPool(forceRefresh, thaiOnly);
        sessionPool = shuffleArray(basePool);
        feedId = storeRecommendedFeedSession(sessionPool);
        startIdx = 0;
      }
      if (licenseFilter === "all") {
        const slice = sessionPool.slice(startIdx, startIdx + pageSize);
        const annotated = await annotateVideoLicenses(slice, config);
        const nextIdx = startIdx + slice.length;
        res.setHeader("Cache-Control", "no-store");
        res.json({
          videos: annotated,
          nextContinuation: nextIdx < sessionPool.length ? `rec:${feedId}:${nextIdx}` : null,
          mode: "recommended"
        });
        return;
      }
      const matched = [];
      let cursor = startIdx;
      for (let step = 0; step < 2 && cursor < sessionPool.length && matched.length < pageSize; step++) {
        const chunk = sessionPool.slice(cursor, cursor + pageSize);
        cursor += chunk.length;
        const annotated = await annotateVideoLicenses(chunk, config);
        for (const item of annotated) {
          if (item.license === "standard") {
            matched.push(item);
          }
        }
      }
      res.setHeader("Cache-Control", "no-store");
      res.json({
        videos: matched,
        nextContinuation: cursor < sessionPool.length ? `rec:${feedId}:${cursor}` : null,
        mode: "recommended"
      });
      return;
    }
    const effectiveSearchQuery = thaiOnly && !THAI_SCRIPT_REGEX.test(rawQuery) ? `${rawQuery} \u0E20\u0E32\u0E29\u0E32\u0E44\u0E17\u0E22` : rawQuery;
    const runSearchPage = async (contToken) => {
      const body = {
        context: ytContext
      };
      if (contToken) {
        body.continuation = contToken;
      } else {
        body.query = effectiveSearchQuery;
        if (licenseFilter === "creative_commons") {
          body.params = "EgIwAQ==";
        }
      }
      const resp = await fetch(
        `https://www.youtube.com/youtubei/v1/search?key=${config.apiKey}`,
        {
          method: "POST",
          headers: ytHeaders,
          body: JSON.stringify(body)
        }
      );
      if (!resp.ok) {
        throw new Error(`YouTube search returned HTTP ${resp.status}`);
      }
      return await resp.json();
    };
    const seen = /* @__PURE__ */ new Set();
    const forcedLicense = licenseFilter === "creative_commons" ? "creative_commons" : void 0;
    if (licenseFilter === "creative_commons") {
      const collected2 = [];
      let currentCont2 = continuation || void 0;
      let nextCont2 = null;
      const maxAttempts = thaiOnly ? 3 : 1;
      for (let attempt = 0; attempt < maxAttempts; attempt++) {
        const data = await runSearchPage(currentCont2);
        const parsed = extractVideosAndContinuation(data, seen, forcedLicense);
        nextCont2 = parsed.nextContinuation;
        for (const v of parsed.videos) {
          if (!thaiOnly || isThaiLanguageVideo(v)) {
            collected2.push(v);
            licenseCache.set(v.videoId, "creative_commons");
          }
        }
        if (collected2.length >= 12 || !nextCont2) break;
        currentCont2 = nextCont2;
      }
      res.setHeader("Cache-Control", "no-store");
      res.json({ videos: collected2, nextContinuation: nextCont2, mode: "search" });
      return;
    }
    if (licenseFilter === "all") {
      const collected2 = [];
      let currentCont2 = continuation || void 0;
      let nextCont2 = null;
      const maxAttempts = thaiOnly ? 3 : 1;
      for (let attempt = 0; attempt < maxAttempts; attempt++) {
        const data = await runSearchPage(currentCont2);
        const parsed = extractVideosAndContinuation(data, seen);
        nextCont2 = parsed.nextContinuation;
        const filtered = thaiOnly ? parsed.videos.filter(isThaiLanguageVideo) : parsed.videos;
        const annotated = await annotateVideoLicenses(filtered, config);
        collected2.push(...annotated);
        if (collected2.length >= 12 || !nextCont2) break;
        currentCont2 = nextCont2;
      }
      res.setHeader("Cache-Control", "no-store");
      res.json({ videos: collected2, nextContinuation: nextCont2, mode: "search" });
      return;
    }
    const collected = [];
    let currentCont = continuation || void 0;
    let nextCont = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      const data = await runSearchPage(currentCont);
      const parsed = extractVideosAndContinuation(data, seen);
      nextCont = parsed.nextContinuation;
      const preFiltered = thaiOnly ? parsed.videos.filter(isThaiLanguageVideo) : parsed.videos;
      const annotated = await annotateVideoLicenses(preFiltered, config);
      for (const v of annotated) {
        if (v.license === "standard") {
          collected.push(v);
        }
      }
      if (collected.length >= 12 || !nextCont) break;
      currentCont = nextCont;
    }
    res.setHeader("Cache-Control", "no-store");
    res.json({ videos: collected, nextContinuation: nextCont, mode: "search" });
  } catch (err) {
    console.error("YouTube search error:", err);
    res.status(500).json({
      error: err instanceof Error ? err.message : "Failed to search YouTube videos."
    });
  }
});
var sceneTranscriptSchema = {
  type: Type.OBJECT,
  properties: {
    hasDialogue: {
      type: Type.BOOLEAN,
      description: "True ONLY if spoken human/character dialogue is audible in this clip. False if silent or music-only."
    },
    summary: {
      type: Type.STRING,
      description: "Brief 3-5 word summary of what is spoken in this scene."
    },
    utterances: {
      type: Type.ARRAY,
      description: "Every spoken sentence/phrase actually heard in this clip in chronological order with exact timestamps relative to the start of this clip (0s to clipDuration).",
      items: {
        type: Type.OBJECT,
        properties: {
          startSec: {
            type: Type.NUMBER,
            description: "Exact start timestamp (seconds) relative to the start of this clip (0s)."
          },
          endSec: {
            type: Type.NUMBER,
            description: "Exact end timestamp (seconds) relative to the start of this clip."
          },
          originalSpokenText: {
            type: Type.STRING,
            description: "Exact verbatim words spoken in the audio at this timestamp."
          },
          thaiScript: {
            type: Type.STRING,
            description: "Verbatim Thai script if spoken in Thai, or faithful Thai translation of the spoken words."
          },
          thaiPhonetic: {
            type: Type.STRING,
            description: "Exact English phonetic pronunciation of the Thai speech (e.g. 'Sa-wat-dee khrap, wan-nee pai nai?')."
          },
          burmese: {
            type: Type.STRING,
            description: "Accurate Burmese translation of what was actually spoken (\u1019\u103C\u1014\u103A\u1019\u102C\u1018\u102C\u101E\u102C\u1015\u103C\u1014\u103A)."
          },
          words: {
            type: Type.ARRAY,
            description: "Word-by-word breakdown matching thaiPhonetic space-separated tokens in exact speaking order, with exact spoken startSec and endSec timestamps relative to the start of this clip.",
            items: {
              type: Type.OBJECT,
              properties: {
                phonetic: { type: Type.STRING },
                thai: { type: Type.STRING },
                burmeseGloss: { type: Type.STRING },
                startSec: {
                  type: Type.NUMBER,
                  description: "Exact timestamp (seconds, 0.1s precision) relative to clip start when this word begins to be spoken."
                },
                endSec: {
                  type: Type.NUMBER,
                  description: "Exact timestamp (seconds, 0.1s precision) relative to clip start when this word finishes being spoken."
                }
              },
              required: ["phonetic", "thai", "burmeseGloss", "startSec", "endSec"]
            }
          }
        },
        required: [
          "startSec",
          "endSec",
          "originalSpokenText",
          "thaiScript",
          "thaiPhonetic",
          "burmese",
          "words"
        ]
      }
    }
  },
  required: ["hasDialogue", "summary", "utterances"]
};
function normalizeTranslationTone(raw) {
  if (raw === "formal" || raw === "dramatic" || raw === "literal") {
    return raw;
  }
  return "casual";
}
function getTranslationToneInstruction(tone) {
  switch (tone) {
    case "formal":
      return `TRANSLATION TONE (Polite / Educational Burmese):
- Use polite, clear, courteous spoken/teaching Burmese (e.g. \u1000\u103B\u103D\u1014\u103A\u1010\u1031\u102C\u103A/\u1000\u103B\u103D\u1014\u103A\u1019, \u1001\u1004\u103A\u1017\u103B\u102C\u1038/\u101B\u103E\u1004\u103A, \u1015\u102B\u1010\u101A\u103A/\u1015\u102B, \u1001\u1004\u103A\u1017\u103B\u102C/\u101B\u103E\u1004\u1037\u103A when appropriate).
- Avoid overly rough slang while remaining natural and easy to follow for learners.`;
    case "dramatic":
      return `TRANSLATION TONE (Expressive / Drama & Comedy Burmese):
- Use vivid, expressive, emotionally punchy Burmese that captures excitement, teasing, surprise, or dramatic flair (e.g. \u101F\u102C, \u1010\u1000\u101A\u103A\u1000\u103C\u102E\u1038\u101C\u102C\u1038, \u1016\u103C\u1005\u103A\u101B\u101C\u1031, \u1021\u1019\u101C\u1031\u1038, etc. when matching the speaker's energy).
- Match the speaker's emotional emphasis naturally.`;
    case "literal":
      return `TRANSLATION TONE (Literal / Learner Accuracy Burmese):
- Translate faithfully and closely to the exact Thai words and grammatical structure so Thai learners can clearly see how each phrase maps to Burmese.
- Keep "burmeseGloss" extra accurate and explicit for key content words.`;
    case "casual":
    default:
      return `TRANSLATION TONE (Natural Spoken Burmese):
- Use natural, everyday conversational Burmese (e.g. \u1010\u101A\u103A, \u101C\u1031, \u1014\u1031\u102C\u103A, \u1015\u1031\u102B\u1037, \u1004\u102B/\u1019\u1004\u103A\u1038/\u101E\u1030 where matching speaker familiarity) just like real people speak in daily life.
- Prefer idiomatic spoken phrasing over stiff textbook prose.`;
  }
}
function getClipPrompt(clipDurationSec, sourceStartSec, sourceEndSec, speechWindows, isSlicedLocalAudio = false, translationTone = "casual") {
  const scopeDesc = isSlicedLocalAudio ? `this ${clipDurationSec.toFixed(1)}-second audio clip` : `this ${clipDurationSec.toFixed(1)}-second clip (from ${sourceStartSec.toFixed(1)}s to ${sourceEndSec.toFixed(1)}s of the video)`;
  const vadSection = speechWindows && speechWindows.length > 0 ? `
WAVEFORM-DETECTED SPEECH WINDOWS (exact seconds relative to 0.0s start of this clip):
${speechWindows.map((w, i) => `  [${i + 1}] ${w.startSec.toFixed(2)}s \u2013 ${w.endSec.toFixed(2)}s`).join("\n")}
- Align every utterance's startSec and endSec closely to when spoken voice is actually audible inside these detected windows (split a window into multiple utterances if there are multiple sentences/phrases, and skip any window that only contains music or sound effects).
` : "";
  return `Listen carefully to the ACTUAL spoken audio in ${scopeDesc}.
${vadSection}
CRITICAL GROUNDING & TIMING RULES:
- ONLY transcribe and translate what is ACTUALLY SPOKEN in the audio of this clip.
- NEVER invent, guess, or fabricate dialogue that is not spoken.
- If there is NO spoken dialogue in this clip (only silence, music, or sound effects), set "hasDialogue": false and return an empty "utterances" array.
- Report ALL "startSec" and "endSec" values (both for utterances AND for each word) relative to the start of THIS clip (strictly between 0.0 and ${clipDurationSec.toFixed(1)} seconds) with sub-second precision (e.g. 0.42, 1.35, 2.84).
- NEVER round timestamps to whole seconds, and NEVER include leading or trailing silent pauses inside an utterance's startSec/endSec. Start right when the voice begins and end right when the voice stops.
- Utterances must be strictly chronological and non-overlapping.

${getTranslationToneInstruction(translationTone)}

For each spoken sentence/utterance in this clip:
- "originalSpokenText": Exact verbatim words spoken in the audio.
- "thaiScript": Verbatim Thai if spoken in Thai, otherwise accurate natural Thai translation of what was spoken.
- "thaiPhonetic": Clear, easy-to-read English phonetic spelling of the Thai pronunciation (e.g. "Sa-wat-dee khrap").
- "burmese": Accurate Burmese translation (\u1019\u103C\u1014\u103A\u1019\u102C\u1018\u102C\u101E\u102C\u1015\u103C\u1014\u103A) matching what was spoken and following the translation tone above.
- "words": Split "thaiPhonetic" into space-separated word tokens in exact spoken order (each item's "phonetic" must match each token in "thaiPhonetic"), with matching Thai word, a 1-2 word Burmese gloss for key content words (empty string for particles), AND exact "startSec" and "endSec" timestamps (relative to 0.0s clip start) matching when each word is actually spoken.`;
}
function normalizeSelectedScenes(rawScenes, maxDuration) {
  const clean = [];
  for (const s of rawScenes) {
    const start = Math.max(0, Math.min(maxDuration - 0.5, Number(s.startSec)));
    const end = Math.max(start + 0.5, Math.min(maxDuration, Number(s.endSec)));
    if (Number.isFinite(start) && Number.isFinite(end) && end > start) {
      clean.push({
        index: clean.length,
        startSec: Number(start.toFixed(2)),
        endSec: Number(end.toFixed(2)),
        durationSec: Number((end - start).toFixed(2)),
        summary: `Scene ${clean.length + 1}`
      });
    }
  }
  return clean;
}
function computeRmsEnvelope10ms(pcmBuffer) {
  const frameSamples = 160;
  const totalSamples = Math.floor(pcmBuffer.length / 2);
  const frameCount = Math.floor(totalSamples / frameSamples);
  const rms = new Float32Array(frameCount);
  for (let f = 0; f < frameCount; f++) {
    let sumSq = 0;
    const base = f * frameSamples * 2;
    for (let i = 0; i < frameSamples; i++) {
      const s = pcmBuffer.readInt16LE(base + i * 2) / 32768;
      sumSq += s * s;
    }
    rms[f] = Math.sqrt(sumSq / frameSamples);
  }
  return rms;
}
function getEnvelopeStats(rms) {
  const n = rms.length;
  const smooth = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const a = rms[Math.max(0, i - 1)];
    const b = rms[i];
    const c = rms[Math.min(n - 1, i + 1)];
    smooth[i] = (a + b * 2 + c) / 4;
  }
  const sorted = Array.from(smooth).sort((a, b) => a - b);
  const noiseFloor = sorted[Math.floor(sorted.length * 0.15)] || 1e-3;
  const speechPeak = sorted[Math.floor(sorted.length * 0.85)] || 0.01;
  const hasClearDynamicRange = speechPeak > Math.max(0.01, noiseFloor * 2.5);
  const speechThreshold = Math.max(
    noiseFloor * 1.85,
    noiseFloor + (speechPeak - noiseFloor) * 0.085
  );
  const onsetThreshold = Math.max(
    noiseFloor * 1.45,
    noiseFloor + (speechPeak - noiseFloor) * 0.045
  );
  return { noiseFloor, speechPeak, speechThreshold, onsetThreshold, hasClearDynamicRange, smooth };
}
function detectSpeechSegments10ms(rms, clipDur) {
  if (rms.length < 20) return [];
  const { speechThreshold, hasClearDynamicRange, smooth } = getEnvelopeStats(rms);
  if (!hasClearDynamicRange) return [];
  const frameDur = 0.01;
  const raw = [];
  let inSpeech = false;
  let startF = 0;
  for (let f = 0; f < smooth.length; f++) {
    const active = smooth[f] >= speechThreshold;
    if (active && !inSpeech) {
      inSpeech = true;
      startF = f;
    } else if (!active && inSpeech) {
      inSpeech = false;
      raw.push({
        startSec: startF * frameDur,
        endSec: Math.min(clipDur, (f + 1) * frameDur)
      });
    }
  }
  if (inSpeech) {
    raw.push({
      startSec: startF * frameDur,
      endSec: clipDur
    });
  }
  const merged = [];
  for (const seg of raw) {
    const prev = merged[merged.length - 1];
    if (prev && seg.startSec - prev.endSec <= 0.32) {
      prev.endSec = seg.endSec;
    } else {
      merged.push({ ...seg });
    }
  }
  return merged.filter((s) => s.endSec - s.startSec >= 0.15).map((s) => ({
    startSec: Number(Math.max(0, s.startSec - 0.07).toFixed(2)),
    endSec: Number(Math.min(clipDur, s.endSec + 0.08).toFixed(2))
  }));
}
function planAudioChunks(rms, speechWindows, clipDur, maxChunkSec = 30) {
  if (clipDur <= maxChunkSec + 5) {
    return [{ startSec: 0, endSec: clipDur }];
  }
  const chunks = [];
  let cursor = 0;
  while (clipDur - cursor > maxChunkSec + 5) {
    const targetSplit = cursor + maxChunkSec;
    const minSplit = cursor + 16;
    const maxSplit = Math.min(clipDur - 5, cursor + maxChunkSec + 6);
    let bestSplit = null;
    let bestDist = Infinity;
    for (let i = 0; i < speechWindows.length - 1; i++) {
      const gapStart = speechWindows[i].endSec;
      const gapEnd = speechWindows[i + 1].startSec;
      const gapMid = (gapStart + gapEnd) / 2;
      if (gapMid >= minSplit && gapMid <= maxSplit) {
        const dist = Math.abs(gapMid - targetSplit);
        if (dist < bestDist) {
          bestDist = dist;
          bestSplit = Number(gapMid.toFixed(2));
        }
      }
    }
    if (bestSplit === null) {
      const fMin = Math.max(0, Math.floor(minSplit / 0.01));
      const fMax = Math.min(rms.length - 1, Math.floor(maxSplit / 0.01));
      let minVal = Infinity;
      let minFrame = Math.floor(targetSplit / 0.01);
      for (let f = fMin; f <= fMax; f++) {
        if (rms[f] < minVal) {
          minVal = rms[f];
          minFrame = f;
        }
      }
      bestSplit = Number((minFrame * 0.01).toFixed(2));
    }
    chunks.push({ startSec: Number(cursor.toFixed(2)), endSec: bestSplit });
    cursor = bestSplit;
  }
  if (clipDur - cursor >= 0.3) {
    chunks.push({ startSec: Number(cursor.toFixed(2)), endSec: Number(clipDur.toFixed(2)) });
  }
  return chunks;
}
function refineUtterancesWithEnvelope(res, rms, clipDur, speechWindows = []) {
  if (!res || res.hasDialogue === false || !Array.isArray(res.utterances) || rms.length < 20) {
    return res;
  }
  const { speechThreshold, onsetThreshold, hasClearDynamicRange, smooth } = getEnvelopeStats(rms);
  if (!hasClearDynamicRange) {
    return res;
  }
  const frameDur = 0.01;
  const utts = [...res.utterances].sort(
    (a, b) => (Number(a.startSec) || 0) - (Number(b.startSec) || 0)
  );
  const walkBackToConsonantOnset = (frame, minFrame) => {
    let f = frame;
    let steps = 0;
    while (f > minFrame && steps < 18 && smooth[f - 1] >= onsetThreshold) {
      f--;
      steps++;
    }
    return f;
  };
  const refined = utts.map((u, idx) => {
    const origStart = Math.max(0, Math.min(clipDur - 0.3, Number(u.startSec) || 0));
    const origEnd = Math.max(origStart + 0.3, Math.min(clipDur, Number(u.endSec) || origStart + 1));
    const prevEndBound = idx > 0 ? Math.max(0, Number(utts[idx - 1].endSec) || 0) : 0;
    const prevEndFrame = Math.floor(prevEndBound / frameDur);
    const nextStartBound = idx < utts.length - 1 ? Math.min(clipDur, Number(utts[idx + 1].startSec) || clipDur) : clipDur;
    const searchStartMin = Math.max(
      prevEndFrame,
      Math.floor((origStart - 1.4) / frameDur)
    );
    const searchStartMax = Math.min(
      smooth.length - 1,
      Math.floor((origEnd - 0.25) / frameDur),
      Math.floor((origStart + 1.6) / frameDur)
    );
    let newStart = origStart;
    const origStartFrame = Math.min(smooth.length - 1, Math.max(0, Math.floor(origStart / frameDur)));
    if (smooth[origStartFrame] < speechThreshold) {
      let foundForward = -1;
      for (let f = origStartFrame; f <= searchStartMax; f++) {
        if (smooth[f] >= speechThreshold) {
          foundForward = f;
          break;
        }
      }
      let foundBackward = -1;
      for (let f = origStartFrame; f >= searchStartMin; f--) {
        if (smooth[f] >= speechThreshold) {
          foundBackward = f;
        } else if (foundBackward !== -1) {
          break;
        }
      }
      if (foundForward !== -1 && foundBackward !== -1) {
        const distF = foundForward - origStartFrame;
        const distB = origStartFrame - foundBackward;
        const rawChosen = distB <= distF && distB <= 110 ? foundBackward : foundForward;
        const onsetF = walkBackToConsonantOnset(rawChosen, searchStartMin);
        newStart = Math.max(prevEndBound, onsetF * frameDur - 0.07);
      } else if (foundForward !== -1) {
        const onsetF = walkBackToConsonantOnset(foundForward, searchStartMin);
        newStart = Math.max(prevEndBound, onsetF * frameDur - 0.07);
      } else if (foundBackward !== -1) {
        const onsetF = walkBackToConsonantOnset(foundBackward, searchStartMin);
        newStart = Math.max(prevEndBound, onsetF * frameDur - 0.07);
      }
    } else {
      const matchedWin = speechWindows.find(
        (w) => origStart >= w.startSec - 0.4 && origStart <= w.endSec + 0.1
      );
      const minWalk = matchedWin ? Math.max(searchStartMin, Math.floor(matchedWin.startSec / frameDur)) : Math.max(searchStartMin, origStartFrame - 60);
      let f = origStartFrame;
      while (f > minWalk && smooth[f - 1] >= speechThreshold) {
        f--;
      }
      const onsetF = walkBackToConsonantOnset(f, searchStartMin);
      if (onsetF <= origStartFrame) {
        newStart = Math.max(prevEndBound, onsetF * frameDur - 0.07);
      }
    }
    const searchEndMin = Math.max(
      Math.floor((newStart + 0.3) / frameDur),
      Math.floor((origEnd - 1.6) / frameDur)
    );
    const searchEndMax = Math.min(
      smooth.length - 1,
      Math.floor(nextStartBound / frameDur),
      Math.floor((origEnd + 1.4) / frameDur)
    );
    let newEnd = origEnd;
    const origEndFrame = Math.min(smooth.length - 1, Math.max(0, Math.floor(origEnd / frameDur)));
    if (smooth[origEndFrame] < speechThreshold) {
      let foundBackward = -1;
      for (let f = origEndFrame; f >= searchEndMin; f--) {
        if (smooth[f] >= speechThreshold) {
          foundBackward = f;
          break;
        }
      }
      let foundForward = -1;
      for (let f = origEndFrame; f <= searchEndMax; f++) {
        if (smooth[f] >= speechThreshold) {
          foundForward = f;
        } else if (foundForward !== -1) {
          break;
        }
      }
      if (foundBackward !== -1 && foundForward !== -1) {
        const distB = origEndFrame - foundBackward;
        const distF = foundForward - origEndFrame;
        const chosen = distF < distB && distF <= 90 ? foundForward : foundBackward;
        newEnd = Math.min(clipDur, chosen * frameDur + 0.08);
      } else if (foundBackward !== -1) {
        newEnd = Math.min(clipDur, foundBackward * frameDur + 0.08);
      } else if (foundForward !== -1) {
        newEnd = Math.min(clipDur, foundForward * frameDur + 0.08);
      }
    } else {
      const matchedWin = speechWindows.find(
        (w) => origEnd >= w.startSec - 0.1 && origEnd <= w.endSec + 0.4
      );
      const maxWalk = matchedWin ? Math.min(searchEndMax, Math.ceil(matchedWin.endSec / frameDur)) : Math.min(searchEndMax, origEndFrame + 60);
      let f = origEndFrame;
      while (f < maxWalk && smooth[f + 1] >= speechThreshold) {
        f++;
      }
      if (f > origEndFrame) {
        newEnd = Math.min(clipDur, f * frameDur + 0.07);
      }
    }
    if (newEnd - newStart < 0.35) {
      return { ...u, startSec: origStart, endSec: origEnd };
    }
    const origSpan = Math.max(0.2, origEnd - origStart);
    const newSpan = Math.max(0.2, newEnd - newStart);
    let adjustedWords = u.words;
    if (Array.isArray(u.words) && u.words.length > 0) {
      const firstS = Number(u.words[0]?.startSec);
      const lastE = Number(u.words[u.words.length - 1]?.endSec);
      const wordsClipRel = Number.isFinite(firstS) && Number.isFinite(lastE) && firstS >= origStart - 0.5 && lastE <= origEnd + 0.5 && lastE > origStart + 0.1;
      if (wordsClipRel) {
        adjustedWords = u.words.map((w) => {
          const ws = Number(w.startSec);
          const we = Number(w.endSec);
          if (!Number.isFinite(ws) || !Number.isFinite(we)) return w;
          const relS = (ws - origStart) / origSpan;
          const relE = (we - origStart) / origSpan;
          return {
            ...w,
            startSec: Number((newStart + Math.max(0, Math.min(1, relS)) * newSpan).toFixed(2)),
            endSec: Number((newStart + Math.max(0, Math.min(1, relE)) * newSpan).toFixed(2))
          };
        });
      }
    }
    return {
      ...u,
      startSec: Number(newStart.toFixed(2)),
      endSec: Number(newEnd.toFixed(2)),
      words: adjustedWords
    };
  });
  return { ...res, utterances: refined };
}
function buildAlignedWords(rawWords, localStart, localEnd, looksAbsolute, sceneStartSec) {
  const lineDur = Math.max(0.35, localEnd - localStart);
  if (rawWords.length === 0) return [];
  const parsedStarts = rawWords.map((w) => {
    if (typeof w.startSec !== "number" || !Number.isFinite(w.startSec)) return null;
    const adjusted = looksAbsolute ? w.startSec - sceneStartSec : w.startSec;
    return adjusted;
  });
  const parsedEnds = rawWords.map((w) => {
    if (typeof w.endSec !== "number" || !Number.isFinite(w.endSec)) return null;
    const adjusted = looksAbsolute ? w.endSec - sceneStartSec : w.endSec;
    return adjusted;
  });
  const allHaveTimes = parsedStarts.every((v) => v !== null) && parsedEnds.every((v) => v !== null);
  let useModelWordTimes = false;
  let offsets = [];
  if (allHaveTimes) {
    const firstStart = parsedStarts[0];
    const lastEnd = parsedEnds[parsedEnds.length - 1];
    const looksUtteranceRelative = localStart > 0.6 && firstStart >= -0.2 && lastEnd <= lineDur + 0.6 && lastEnd < localStart + 0.4;
    const rawPairs = rawWords.map((_, wi) => {
      const s = looksUtteranceRelative ? parsedStarts[wi] : parsedStarts[wi] - localStart;
      const e = looksUtteranceRelative ? parsedEnds[wi] : parsedEnds[wi] - localStart;
      return {
        start: Math.max(0, Math.min(lineDur - 0.05, s)),
        end: Math.max(0.05, Math.min(lineDur, e))
      };
    });
    let monotonic = true;
    for (let i = 0; i < rawPairs.length; i++) {
      if (rawPairs[i].end <= rawPairs[i].start + 0.02) {
        monotonic = false;
        break;
      }
      if (i > 0 && rawPairs[i].start < rawPairs[i - 1].start - 0.15) {
        monotonic = false;
        break;
      }
    }
    const span = rawPairs[rawPairs.length - 1].end - rawPairs[0].start;
    if (monotonic && span >= lineDur * 0.35) {
      useModelWordTimes = true;
      offsets = rawPairs.map((p) => ({ ...p }));
      for (let i = 0; i < offsets.length; i++) {
        if (i > 0 && offsets[i].start < offsets[i - 1].end) {
          const mid = (offsets[i].start + offsets[i - 1].end) / 2;
          offsets[i - 1].end = Math.max(offsets[i - 1].start + 0.06, mid);
          offsets[i].start = offsets[i - 1].end;
        }
        if (offsets[i].end <= offsets[i].start + 0.06) {
          offsets[i].end = Math.min(lineDur, offsets[i].start + 0.08);
        }
      }
    }
  }
  if (!useModelWordTimes) {
    const totalWeight = rawWords.reduce((acc, w) => acc + Math.max(2, w.phonetic.length), 0) || 1;
    let wCursor = 0;
    offsets = rawWords.map((w, wi) => {
      const wDur = Math.max(2, w.phonetic.length) / totalWeight * lineDur;
      const start = wCursor;
      const end = wi === rawWords.length - 1 ? lineDur : wCursor + wDur;
      wCursor = end;
      return { start, end };
    });
  }
  return rawWords.map((w, wi) => ({
    phonetic: w.phonetic,
    thai: w.thai,
    burmeseGloss: w.burmeseGloss || "",
    startOffsetSec: Number(offsets[wi].start.toFixed(2)),
    endOffsetSec: Number(offsets[wi].end.toFixed(2))
  }));
}
function compileSceneTranscripts(scenes, results, forceClipRelative = false) {
  const subtitles = [];
  let cutOffset = 0;
  const updatedScenes = scenes.map((sc, sIdx) => {
    const res = results[sIdx];
    const clipDur = sc.durationSec;
    if (res && res.hasDialogue !== false && Array.isArray(res.utterances)) {
      const looksAbsolute = !forceClipRelative && sc.startSec > 2 && res.utterances.length > 0 && res.utterances.some((u) => u.endSec > clipDur + 1) && res.utterances.every((u) => u.startSec >= sc.startSec - 1 && u.endSec <= sc.endSec + 1.5);
      const normalizedUtts = res.utterances.map((u) => {
        const rawLocalStart = looksAbsolute ? u.startSec - sc.startSec : u.startSec;
        const rawLocalEnd = looksAbsolute ? u.endSec - sc.startSec : u.endSec;
        const localStart = Math.max(0, Math.min(clipDur - 0.3, rawLocalStart));
        const localEnd = Math.max(localStart + 0.35, Math.min(clipDur, rawLocalEnd));
        return { u, localStart, localEnd };
      }).sort((a, b) => a.localStart - b.localStart);
      for (let i = 1; i < normalizedUtts.length; i++) {
        const prev = normalizedUtts[i - 1];
        const curr = normalizedUtts[i];
        if (curr.localStart < prev.localEnd) {
          const mid = Number(((prev.localEnd + curr.localStart) / 2).toFixed(2));
          prev.localEnd = Math.max(prev.localStart + 0.3, mid);
          curr.localStart = prev.localEnd;
          curr.localEnd = Math.max(curr.localStart + 0.3, curr.localEnd);
        }
      }
      for (const { u, localStart, localEnd } of normalizedUtts) {
        const cutStart = Number((cutOffset + localStart).toFixed(2));
        const cutEnd = Number((cutOffset + localEnd).toFixed(2));
        const rawWords = u.words && u.words.length > 0 ? u.words : (u.thaiPhonetic || "").split(/\s+/).filter(Boolean).map((w) => ({ phonetic: w, thai: w, burmeseGloss: "" }));
        const words = buildAlignedWords(rawWords, localStart, localEnd, looksAbsolute, sc.startSec);
        subtitles.push({
          id: `sub-${subtitles.length + 1}`,
          sceneIndex: sIdx,
          startTime: cutStart,
          endTime: cutEnd,
          sourceStartSec: Number((sc.startSec + localStart).toFixed(2)),
          sourceEndSec: Number((sc.startSec + localEnd).toFixed(2)),
          originalSpokenText: u.originalSpokenText,
          thaiPhonetic: u.thaiPhonetic,
          thaiScript: u.thaiScript,
          burmese: u.burmese,
          words
        });
      }
    }
    cutOffset += clipDur;
    return {
      ...sc,
      summary: res?.summary || sc.summary
    };
  });
  subtitles.sort((a, b) => a.startTime - b.startTime);
  return {
    scenes: updatedScenes,
    subtitles,
    targetDurationSec: Number(cutOffset.toFixed(2))
  };
}
var TEXT_SUB_CODECS = /* @__PURE__ */ new Set([
  "subrip",
  "srt",
  "ass",
  "ssa",
  "mov_text",
  "webvtt",
  "text",
  "tx3g",
  "utf8"
]);
function parseSrtTimestamp(raw) {
  const m = raw.trim().match(/^(\d{1,2}):(\d{2}):(\d{2})[,.](\d{1,3})$/);
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  const s = Number(m[3]);
  const ms = Number(m[4].padEnd(3, "0"));
  return h * 3600 + min * 60 + s + ms / 1e3;
}
function cleanSubtitleText(raw) {
  return raw.replace(/\{\\[^}]*\}/g, "").replace(/<[^>]+>/g, "").replace(/\r/g, "").split("\n").map((line) => line.trim()).filter(Boolean).join(" ").replace(/\s+/g, " ").trim();
}
function parseSrtCues(srtContent) {
  const blocks = srtContent.replace(/^\uFEFF/, "").split(/\r?\n\r?\n+/);
  const cues = [];
  for (const block of blocks) {
    const lines = block.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    if (lines.length < 2) continue;
    const timeIdx = lines.findIndex((l) => l.includes("-->"));
    if (timeIdx === -1) continue;
    const parts = lines[timeIdx].split("-->");
    if (parts.length < 2) continue;
    const startSec = parseSrtTimestamp(parts[0].trim().split(/\s+/)[0]);
    const endSec = parseSrtTimestamp(parts[1].trim().split(/\s+/)[0]);
    if (startSec === null || endSec === null || endSec <= startSec) continue;
    const text = cleanSubtitleText(lines.slice(timeIdx + 1).join("\n"));
    if (!text) continue;
    cues.push({ startSec, endSec, text });
  }
  cues.sort((a, b) => a.startSec - b.startSec);
  return cues;
}
async function extractEmbeddedSubtitles(mediaPath, tmpDir) {
  try {
    const { stdout } = await execFileAsync(
      "ffprobe",
      [
        "-v",
        "quiet",
        "-print_format",
        "json",
        "-show_streams",
        mediaPath
      ],
      FFMPEG_EXEC_OPTS
    );
    const info = JSON.parse(stdout || "{}");
    const subStreams = (info.streams || []).filter(
      (s) => s.codec_type === "subtitle" && (!s.codec_name || TEXT_SUB_CODECS.has(s.codec_name.toLowerCase()))
    );
    if (subStreams.length === 0) return null;
    const scoreLang = (lang) => {
      const l = (lang || "").toLowerCase();
      if (l === "th" || l === "tha") return 4;
      if (l === "en" || l === "eng") return 3;
      if (l === "my" || l === "bur" || l === "mya") return 2;
      return 1;
    };
    const sorted = [...subStreams].sort(
      (a, b) => scoreLang(b.tags?.language) - scoreLang(a.tags?.language)
    );
    for (const stream of sorted) {
      const outSrt = path.join(tmpDir, `embedded-${stream.index}.srt`);
      try {
        await execFileAsync(
          "ffmpeg",
          [
            "-y",
            "-vn",
            "-an",
            "-i",
            mediaPath,
            "-map",
            `0:${stream.index}`,
            "-f",
            "srt",
            outSrt
          ],
          FFMPEG_EXEC_OPTS
        );
        const srtText = await fs.promises.readFile(outSrt, "utf-8");
        const cues = parseSrtCues(srtText);
        if (cues.length > 0) {
          return { cues, language: stream.tags?.language };
        }
      } catch {
      }
    }
    return null;
  } catch {
    return null;
  }
}
function getEmbeddedSubtitlesPrompt(clipDurationSec, cues, translationTone = "casual") {
  const cuePayload = cues.map((c, idx) => ({
    index: idx,
    startSec: c.startSec,
    endSec: c.endSec,
    text: c.text
  }));
  return `This ${clipDurationSec.toFixed(1)}-second video clip already has an EMBEDDED SUBTITLE track. Listen to the accompanying audio for speech cadence and translate/transliterate EVERY embedded subtitle cue below into Thai phonetics and Burmese.

EMBEDDED SUBTITLE CUES (JSON):
${JSON.stringify(cuePayload)}

${getTranslationToneInstruction(translationTone)}

CRITICAL RULES FOR EMBEDDED SUBTITLES:
- You MUST set "hasDialogue": true and return EXACTLY ${cues.length} items in "utterances", one for each embedded cue in the exact same order (index 0 to ${cues.length - 1}).
- For each utterance, KEEP the exact "startSec", "endSec", and "originalSpokenText" from the corresponding embedded cue.
- "thaiScript": Exact Thai script of the cue (keep verbatim if already Thai, or natural Thai translation if another language).
- "thaiPhonetic": Clear English phonetic pronunciation of the Thai speech (e.g. "Sa-wat-dee khrap").
- "burmese": Accurate Burmese translation (\u1019\u103C\u1014\u103A\u1019\u102C\u1018\u102C\u101E\u102C\u1015\u103C\u1014\u103A) of the cue following the translation tone above.
- "words": Split "thaiPhonetic" into space-separated word tokens in exact spoken order, with matching Thai word, 1-2 word Burmese gloss for key content words (empty string for particles), AND word-level "startSec" and "endSec" aligned within that cue's [startSec, endSec] range matching the audio.`;
}
function lockUtterancesToEmbeddedCues(rawRes, cues) {
  const rawUtts = Array.isArray(rawRes?.utterances) ? rawRes.utterances : [];
  const locked = cues.map((cue, idx) => {
    const matched = rawUtts[idx];
    const thaiScript = matched?.thaiScript?.trim() || cue.text;
    const thaiPhonetic = matched?.thaiPhonetic?.trim() || cue.text;
    const burmese = matched?.burmese?.trim() || cue.text;
    const rawWords = matched?.words && matched.words.length > 0 ? matched.words.map((w) => {
      const ws = typeof w.startSec === "number" ? w.startSec : void 0;
      const we = typeof w.endSec === "number" ? w.endSec : void 0;
      return {
        ...w,
        startSec: ws !== void 0 && Number.isFinite(ws) ? Math.max(cue.startSec, Math.min(cue.endSec - 0.05, ws)) : void 0,
        endSec: we !== void 0 && Number.isFinite(we) ? Math.max(cue.startSec + 0.05, Math.min(cue.endSec, we)) : void 0
      };
    }) : thaiPhonetic.split(/\s+/).filter(Boolean).map((tok) => ({ phonetic: tok, thai: tok, burmeseGloss: "" }));
    return {
      startSec: cue.startSec,
      endSec: cue.endSec,
      originalSpokenText: cue.text,
      thaiScript,
      thaiPhonetic,
      burmese,
      words: rawWords
    };
  });
  return {
    hasDialogue: true,
    summary: rawRes?.summary || "Embedded subtitles",
    utterances: locked
  };
}
function pcmToWavBuffer(pcmSlice, sampleRate = 16e3) {
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + pcmSlice.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(pcmSlice.length, 40);
  return Buffer.concat([header, pcmSlice]);
}
async function transcribePreparedExtractedScenes(scenes, extractedData, translationTone, onProgress) {
  const ai = getGeminiClient();
  const totalClips = scenes.length;
  onProgress?.({
    stage: "detecting",
    label: "Detecting speech...",
    percent: 44,
    totalClips
  });
  const preparedJobs = extractedData.map((item, idx) => {
    if (item.kind === "embedded") {
      return {
        mode: "embedded",
        scene: item.scene,
        sceneCues: item.sceneCues,
        audioBuf: item.audioBuf
      };
    }
    if (!item.fullPcm) {
      return { mode: "empty" };
    }
    const fullRms = computeRmsEnvelope10ms(item.fullPcm);
    const fullSpeechWindows = detectSpeechSegments10ms(fullRms, item.scene.durationSec);
    const subChunks = planAudioChunks(
      fullRms,
      fullSpeechWindows,
      item.scene.durationSec,
      45
    );
    onProgress?.({
      stage: "detecting",
      label: totalClips > 1 ? `Detecting speech (${idx + 1}/${totalClips})...` : "Detecting speech...",
      percent: Math.round(44 + (idx + 1) / totalClips * 10),
      clipIndex: idx,
      totalClips
    });
    return {
      mode: "audio",
      scene: item.scene,
      fullPcm: item.fullPcm,
      fullRms,
      fullSpeechWindows,
      subChunks
    };
  });
  const totalWorkUnits = Math.max(
    1,
    preparedJobs.reduce((sum, job) => {
      if (job.mode === "embedded") return sum + 1;
      if (job.mode === "audio") return sum + Math.max(1, job.subChunks.length);
      return sum + 1;
    }, 0)
  );
  let completedUnits = 0;
  onProgress?.({
    stage: "generating",
    label: "Generating subtitles...",
    percent: 55,
    totalClips
  });
  const advanceGenProgress = (clipIdx) => {
    completedUnits += 1;
    const pct = Math.min(94, Math.round(55 + completedUnits / totalWorkUnits * 39));
    onProgress?.({
      stage: "generating",
      label: totalClips > 1 ? `Generating subtitles (${Math.min(totalClips, clipIdx + 1)}/${totalClips})...` : "Generating subtitles...",
      percent: pct,
      clipIndex: clipIdx,
      totalClips
    });
  };
  const emitRetryProgress = (clipIdx, attempt, maxAttempts) => {
    const pct = Math.min(94, Math.round(55 + completedUnits / totalWorkUnits * 39));
    onProgress?.({
      stage: "generating",
      label: `AI model busy, retrying automatically (${attempt}/${maxAttempts})...`,
      percent: pct,
      clipIndex: clipIdx,
      totalClips
    });
  };
  const results = await mapWithConcurrency(preparedJobs, 2, async (job, idx) => {
    if (job.mode === "empty") {
      advanceGenProgress(idx);
      return { hasDialogue: false, summary: "No audio", utterances: [] };
    }
    if (job.mode === "embedded") {
      const parts = [];
      if (job.audioBuf) {
        parts.push({
          inlineData: { mimeType: "audio/mp3", data: job.audioBuf.toString("base64") }
        });
      }
      parts.push({
        text: getEmbeddedSubtitlesPrompt(job.scene.durationSec, job.sceneCues, translationTone)
      });
      const resp = await generateGroundedWithFailover(
        ai,
        { parts },
        sceneTranscriptSchema,
        ThinkingLevel.LOW,
        {
          onRetry: ({ attempt, maxAttempts }) => emitRetryProgress(idx, attempt, maxAttempts)
        }
      );
      const rawRes = JSON.parse((resp.text || "{}").trim());
      advanceGenProgress(idx);
      return lockUtterancesToEmbeddedCues(rawRes, job.sceneCues);
    }
    const sc = job.scene;
    const chunkResults = await mapWithConcurrency(job.subChunks, 2, async (ch) => {
      const startFrame = Math.max(0, Math.floor(ch.startSec / 0.01));
      const endFrame = Math.min(job.fullRms.length, Math.ceil(ch.endSec / 0.01));
      const startByte = Math.min(job.fullPcm.length, startFrame * 320);
      const endByte = Math.min(job.fullPcm.length, Math.max(startByte + 640, endFrame * 320));
      const wavBuf = pcmToWavBuffer(job.fullPcm.subarray(startByte, endByte), 16e3);
      const chDur = Math.max(0.2, Number(((endByte - startByte) / 32e3).toFixed(2)));
      const absStart = Number((sc.startSec + startFrame * 0.01).toFixed(2));
      const chRms = job.fullRms.subarray(startFrame, endFrame);
      const chWindows = job.fullSpeechWindows.filter((w) => w.endSec > ch.startSec + 0.05 && w.startSec < ch.endSec - 0.05).map((w) => ({
        startSec: Number(Math.max(0, w.startSec - startFrame * 0.01).toFixed(2)),
        endSec: Number(Math.min(chDur, w.endSec - startFrame * 0.01).toFixed(2))
      }));
      const resp = await generateGroundedWithFailover(
        ai,
        {
          parts: [
            { inlineData: { mimeType: "audio/wav", data: wavBuf.toString("base64") } },
            {
              text: getClipPrompt(
                chDur,
                absStart,
                absStart + chDur,
                chWindows,
                true,
                translationTone
              )
            }
          ]
        },
        sceneTranscriptSchema,
        ThinkingLevel.LOW,
        {
          onRetry: ({ attempt, maxAttempts }) => emitRetryProgress(idx, attempt, maxAttempts)
        }
      );
      const rawChunk = JSON.parse((resp.text || "{}").trim());
      const refinedChunk = refineUtterancesWithEnvelope(rawChunk, chRms, chDur, chWindows);
      advanceGenProgress(idx);
      return { chOffset: Number((startFrame * 0.01).toFixed(2)), refined: refinedChunk };
    });
    const mergedUtts = [];
    let firstSummary = "";
    for (const item of chunkResults) {
      if (item.refined?.summary && !firstSummary) firstSummary = item.refined.summary;
      if (item.refined?.hasDialogue !== false && Array.isArray(item.refined?.utterances)) {
        for (const u of item.refined.utterances) {
          mergedUtts.push({
            ...u,
            startSec: Number((item.chOffset + u.startSec).toFixed(2)),
            endSec: Number((item.chOffset + u.endSec).toFixed(2)),
            words: Array.isArray(u.words) ? u.words.map((w) => ({
              ...w,
              startSec: typeof w.startSec === "number" ? Number((item.chOffset + w.startSec).toFixed(2)) : void 0,
              endSec: typeof w.endSec === "number" ? Number((item.chOffset + w.endSec).toFixed(2)) : void 0
            })) : u.words
          });
        }
      }
    }
    return {
      hasDialogue: mergedUtts.length > 0,
      summary: firstSummary || "Scene dialogue",
      utterances: mergedUtts
    };
  });
  onProgress?.({
    stage: "compiling",
    label: "Compiling subtitles...",
    percent: 96,
    totalClips
  });
  return compileSceneTranscripts(scenes, results, true);
}
async function processUploadedVideo(persistentPath, uploadId, title, durationSec, parsedScenes, translationTone = "casual", onProgress) {
  const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "upload-vid-"));
  try {
    const scenes = normalizeSelectedScenes(parsedScenes, durationSec);
    if (scenes.length === 0) {
      return {
        status: 400,
        body: { error: "Select at least one scene before generating subtitles." }
      };
    }
    const totalClips = scenes.length;
    onProgress?.({
      stage: "extracting",
      label: "Extracting audio...",
      percent: 22,
      totalClips
    });
    const embedded = await extractEmbeddedSubtitles(persistentPath, tmpDir);
    let extractedCount = 0;
    const extractedData = await Promise.all(
      scenes.map(async (sc, idx) => {
        const sceneCues = embedded ? embedded.cues.filter((c) => c.endSec > sc.startSec + 0.05 && c.startSec < sc.endSec - 0.05).map((c) => ({
          startSec: Number(Math.max(0, c.startSec - sc.startSec).toFixed(2)),
          endSec: Number(Math.min(sc.durationSec, c.endSec - sc.startSec).toFixed(2)),
          text: c.text
        })).filter((c) => c.endSec - c.startSec >= 0.15) : [];
        if (sceneCues.length > 0) {
          const segAudioPath = path.join(tmpDir, `scene-${idx}.mp3`);
          let audioBuf = null;
          try {
            await execFileAsync(
              "ffmpeg",
              [
                "-y",
                "-ss",
                String(sc.startSec),
                "-i",
                persistentPath,
                "-t",
                String(sc.durationSec),
                "-vn",
                "-sn",
                "-dn",
                "-ac",
                "1",
                "-ar",
                "16000",
                "-b:a",
                "48k",
                segAudioPath
              ],
              FFMPEG_EXEC_OPTS
            );
            if (fs.existsSync(segAudioPath) && fs.statSync(segAudioPath).size > 0) {
              audioBuf = await fs.promises.readFile(segAudioPath);
            }
          } catch {
            audioBuf = null;
          }
          extractedCount += 1;
          onProgress?.({
            stage: "extracting",
            label: totalClips > 1 ? `Extracting audio (${extractedCount}/${totalClips})...` : "Extracting audio...",
            percent: Math.round(22 + extractedCount / totalClips * 18),
            clipIndex: idx,
            totalClips
          });
          return { kind: "embedded", scene: sc, sceneCues, audioBuf };
        }
        const scenePcmPath = path.join(tmpDir, `scene-${idx}.pcm`);
        let fullPcm = null;
        try {
          await execFileAsync(
            "ffmpeg",
            [
              "-y",
              "-ss",
              String(sc.startSec),
              "-i",
              persistentPath,
              "-t",
              String(sc.durationSec),
              "-vn",
              "-sn",
              "-dn",
              "-af",
              "aresample=async=1:first_pts=0",
              "-f",
              "s16le",
              "-ac",
              "1",
              "-ar",
              "16000",
              scenePcmPath
            ],
            FFMPEG_EXEC_OPTS
          );
          if (fs.existsSync(scenePcmPath) && fs.statSync(scenePcmPath).size > 0) {
            fullPcm = await fs.promises.readFile(scenePcmPath);
          }
        } catch {
          fullPcm = null;
        }
        extractedCount += 1;
        onProgress?.({
          stage: "extracting",
          label: totalClips > 1 ? `Extracting audio (${extractedCount}/${totalClips})...` : "Extracting audio...",
          percent: Math.round(22 + extractedCount / totalClips * 18),
          clipIndex: idx,
          totalClips
        });
        return { kind: "pcm", scene: sc, fullPcm };
      })
    );
    const compiled = await transcribePreparedExtractedScenes(
      scenes,
      extractedData,
      translationTone,
      onProgress
    );
    if (compiled.subtitles.length === 0) {
      return {
        status: 422,
        body: { error: "No spoken dialogue or subtitles were detected inside your selected scenes." }
      };
    }
    const speechRegions = compiled.subtitles.map((s) => ({
      sourceStartSec: s.sourceStartSec,
      sourceEndSec: s.sourceEndSec
    }));
    return {
      status: 200,
      body: {
        uploadId,
        title,
        channel: embedded ? "Local Video \xB7 Embedded Subtitles" : "Local Video",
        sourceDurationSec: durationSec,
        targetDurationSec: compiled.targetDurationSec,
        scenes: compiled.scenes,
        subtitles: compiled.subtitles,
        speechRegions,
        keyframeUrls: []
      }
    };
  } finally {
    await fs.promises.rm(tmpDir, { recursive: true, force: true }).catch(() => {
    });
  }
}
function sanitizeVideoExtension(fileName) {
  const ext = path.extname(fileName || "").toLowerCase();
  if (/^\.[a-z0-9]{2,5}$/.test(ext)) return ext;
  return ".mp4";
}
app.post("/api/upload-init", async (req, res) => {
  try {
    const { fileName, totalSize } = req.body || {};
    let expectedSize;
    if (totalSize !== void 0) {
      const n = Number(totalSize);
      if (!Number.isFinite(n) || n < 0) {
        res.status(400).json({ error: "Invalid totalSize." });
        return;
      }
      if (n > MAX_UPLOAD_BYTES) {
        res.status(413).json({ error: "Video file exceeds the 500 MB server upload limit." });
        return;
      }
      expectedSize = n;
    }
    const uploadId = crypto.randomUUID();
    const ext = sanitizeVideoExtension(fileName);
    const persistentPath = path.join(os.tmpdir(), `thai-studio-upload-${uploadId}${ext}`);
    await fs.promises.writeFile(persistentPath, Buffer.alloc(0));
    registerUploadSession(uploadId, persistentPath, { expectedSize, receivedBytes: 0, finalized: false });
    res.json({ uploadId });
  } catch (err) {
    console.error("Upload init error:", err);
    res.status(500).json({
      error: err instanceof Error ? err.message : "Failed to initialize upload."
    });
  }
});
app.post(
  "/api/upload-chunk",
  express.raw({ type: ["application/octet-stream", "video/*"], limit: "16mb" }),
  async (req, res) => {
    try {
      const uploadId = String(req.headers["x-upload-id"] || "");
      const session = uploadId ? uploadSessions.get(uploadId) : void 0;
      if (!session || session.pendingDelete || !fs.existsSync(session.filePath)) {
        res.status(404).json({ error: "Upload session not found or expired." });
        return;
      }
      const chunk = req.body;
      if (!chunk || chunk.length === 0) {
        res.status(400).json({ error: "Empty upload chunk." });
        return;
      }
      const rawOffsetHeader = req.headers["x-chunk-offset"];
      const declaredOffset = rawOffsetHeader !== void 0 && rawOffsetHeader !== "" ? Number(rawOffsetHeader) : void 0;
      if (declaredOffset !== void 0 && (!Number.isFinite(declaredOffset) || declaredOffset < 0)) {
        res.status(400).json({ error: "Invalid chunk offset header." });
        return;
      }
      const isParallelMode = String(req.headers["x-chunk-mode"] || "") === "parallel" && declaredOffset !== void 0;
      if (isParallelMode && declaredOffset !== void 0) {
        if (declaredOffset + chunk.length > MAX_UPLOAD_BYTES) {
          await deleteUploadSession(session.id);
          res.status(413).json({ error: "Video upload exceeds the 500 MB server limit." });
          return;
        }
        if (session.expectedSize !== void 0 && declaredOffset + chunk.length > session.expectedSize) {
          await deleteUploadSession(session.id);
          res.status(413).json({ error: "Upload exceeded declared file size." });
          return;
        }
        const fh = await fs.promises.open(session.filePath, "r+");
        try {
          await fh.write(chunk, 0, chunk.length, declaredOffset);
        } finally {
          await fh.close();
        }
        if (session.pendingDelete) {
          res.status(404).json({ error: "Upload session expired." });
          return;
        }
        session.writtenOffsets.set(declaredOffset, chunk.length);
        let totalWritten = 0;
        for (const len of session.writtenOffsets.values()) {
          totalWritten += len;
        }
        session.receivedBytes = totalWritten;
        const reachedEnd = session.expectedSize !== void 0 && session.receivedBytes >= session.expectedSize;
        touchUploadSession(session, reachedEnd);
        res.status(200).json({ ok: true, receivedBytes: session.receivedBytes });
        return;
      }
      const result = await new Promise((resolve) => {
        session.writeChain = session.writeChain.then(async () => {
          if (session.pendingDelete || !fs.existsSync(session.filePath)) {
            resolve({
              status: 404,
              body: { error: "Upload session not found or expired." }
            });
            return;
          }
          if (declaredOffset !== void 0) {
            if (declaredOffset < session.receivedBytes && declaredOffset + chunk.length === session.receivedBytes) {
              touchUploadSession(session);
              resolve({
                status: 200,
                body: { ok: true, receivedBytes: session.receivedBytes, duplicate: true }
              });
              return;
            }
            if (declaredOffset !== session.receivedBytes) {
              resolve({
                status: 409,
                body: {
                  error: "Upload chunk offset mismatch.",
                  receivedBytes: session.receivedBytes
                }
              });
              return;
            }
          }
          if (session.receivedBytes + chunk.length > MAX_UPLOAD_BYTES) {
            await deleteUploadSession(session.id);
            resolve({
              status: 413,
              body: { error: "Video upload exceeds the 500 MB server limit." }
            });
            return;
          }
          if (session.expectedSize !== void 0 && session.receivedBytes + chunk.length > session.expectedSize) {
            await deleteUploadSession(session.id);
            resolve({
              status: 413,
              body: { error: "Upload exceeded declared file size." }
            });
            return;
          }
          await fs.promises.appendFile(session.filePath, chunk);
          session.receivedBytes += chunk.length;
          const reachedEnd = session.expectedSize !== void 0 && session.receivedBytes >= session.expectedSize;
          touchUploadSession(session, reachedEnd);
          resolve({
            status: 200,
            body: { ok: true, receivedBytes: session.receivedBytes }
          });
        }).catch((err) => {
          resolve({
            status: 500,
            body: {
              error: err instanceof Error ? err.message : "Failed to write upload chunk."
            }
          });
        });
      });
      res.status(result.status).json(result.body);
    } catch (err) {
      console.error("Upload chunk error:", err);
      res.status(500).json({
        error: err instanceof Error ? err.message : "Failed to write upload chunk."
      });
    }
  }
);
app.post("/api/upload-abort", async (req, res) => {
  try {
    const { uploadId } = req.body || {};
    if (uploadId && typeof uploadId === "string") {
      await deleteUploadSession(uploadId);
    }
    res.json({ ok: true });
  } catch {
    res.json({ ok: true });
  }
});
app.post("/api/process-clip-audio", async (req, res) => {
  const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "clip-audio-"));
  const {
    title = "Uploaded Video",
    durationSec = 120,
    clips = [],
    translationTone,
    stream = false
  } = req.body || {};
  const wantStream = Boolean(stream) || Boolean(req.headers.accept?.includes("application/x-ndjson"));
  const sendNdjson = (payload) => {
    if (!res.writableEnded) {
      res.write(`${JSON.stringify(payload)}
`);
    }
  };
  const emitProgress = (ev) => {
    if (wantStream) {
      sendNdjson({ type: "progress", ...ev });
    }
  };
  try {
    if (!Array.isArray(clips) || clips.length === 0) {
      res.status(400).json({ error: "No audio clips provided." });
      return;
    }
    const totalDuration = Math.max(5, Number(durationSec) || 120);
    const scenes = normalizeSelectedScenes(
      clips.map((c) => ({ startSec: c.startSec, endSec: c.endSec })),
      totalDuration
    );
    if (scenes.length === 0) {
      res.status(400).json({ error: "Select at least one scene before generating subtitles." });
      return;
    }
    if (wantStream) {
      res.setHeader("Content-Type", "application/x-ndjson; charset=utf-8");
      res.setHeader("Cache-Control", "no-cache, no-transform");
      res.setHeader("X-Accel-Buffering", "no");
      res.flushHeaders?.();
    }
    const tone = normalizeTranslationTone(translationTone);
    const totalClips = scenes.length;
    emitProgress({
      stage: "extracting",
      label: "Decoding clip audio...",
      percent: 22,
      totalClips
    });
    let decodedCount = 0;
    const extractedData = await Promise.all(
      scenes.map(async (sc, idx) => {
        const clip = clips[idx];
        const rawBuf = clip?.audioBase64 ? Buffer.from(clip.audioBase64, "base64") : null;
        if (!rawBuf || rawBuf.length < 32) {
          decodedCount += 1;
          return { kind: "pcm", scene: sc, fullPcm: null };
        }
        const ext = clip.mimeType?.includes("wav") ? ".wav" : ".m4a";
        const inPath = path.join(tmpDir, `clip-${idx}${ext}`);
        const outPcmPath = path.join(tmpDir, `clip-${idx}.pcm`);
        await fs.promises.writeFile(inPath, rawBuf);
        let fullPcm = null;
        const trimLead = Math.max(0, Number(clip.trimLeadSec) || 0);
        try {
          await execFileAsync(
            "ffmpeg",
            [
              "-y",
              "-ss",
              trimLead.toFixed(4),
              "-i",
              inPath,
              "-t",
              String(sc.durationSec),
              "-vn",
              "-sn",
              "-dn",
              "-af",
              "aresample=async=1:first_pts=0",
              "-f",
              "s16le",
              "-ac",
              "1",
              "-ar",
              "16000",
              outPcmPath
            ],
            FFMPEG_EXEC_OPTS
          );
          if (fs.existsSync(outPcmPath) && fs.statSync(outPcmPath).size > 0) {
            fullPcm = await fs.promises.readFile(outPcmPath);
          }
        } catch {
          fullPcm = null;
        }
        decodedCount += 1;
        emitProgress({
          stage: "extracting",
          label: totalClips > 1 ? `Preparing audio (${decodedCount}/${totalClips})...` : "Preparing audio...",
          percent: Math.round(22 + decodedCount / totalClips * 18),
          clipIndex: idx,
          totalClips
        });
        return { kind: "pcm", scene: sc, fullPcm };
      })
    );
    const compiled = await transcribePreparedExtractedScenes(
      scenes,
      extractedData,
      tone,
      emitProgress
    );
    if (compiled.subtitles.length === 0) {
      const msg = "No spoken dialogue or subtitles were detected inside your selected scenes.";
      if (wantStream) {
        sendNdjson({ type: "error", status: 422, error: msg });
        res.end();
      } else {
        res.status(422).json({ error: msg });
      }
      return;
    }
    const speechRegions = compiled.subtitles.map((s) => ({
      sourceStartSec: s.sourceStartSec,
      sourceEndSec: s.sourceEndSec
    }));
    const payload = {
      title,
      channel: "Local Video",
      sourceDurationSec: totalDuration,
      targetDurationSec: compiled.targetDurationSec,
      scenes: compiled.scenes,
      subtitles: compiled.subtitles,
      speechRegions,
      keyframeUrls: []
    };
    if (wantStream) {
      emitProgress({
        stage: "compiling",
        label: "Subtitles ready",
        percent: 100,
        totalClips
      });
      sendNdjson({ type: "result", status: 200, data: payload });
      res.end();
      return;
    }
    res.json(payload);
  } catch (err) {
    console.error("Process clip audio error:", err);
    const formatted = formatGeminiError(err, "Failed to process clip audio.");
    if (wantStream && res.headersSent) {
      sendNdjson({ type: "error", status: formatted.status, error: formatted.message });
      res.end();
      return;
    }
    res.status(formatted.status).json({ error: formatted.message });
  } finally {
    await fs.promises.rm(tmpDir, { recursive: true, force: true }).catch(() => {
    });
  }
});
app.post("/api/process-upload", async (req, res) => {
  const {
    uploadId,
    title = "Uploaded Video",
    durationSec = 120,
    selectedScenes = [],
    translationTone,
    stream = false
  } = req.body;
  const wantStream = Boolean(stream) || Boolean(req.headers.accept?.includes("application/x-ndjson"));
  const sendNdjson = (payload) => {
    if (!res.writableEnded) {
      res.write(`${JSON.stringify(payload)}
`);
    }
  };
  try {
    if (!uploadId) {
      res.status(404).json({ error: "Uploaded video file not found. Please try again." });
      return;
    }
    if (wantStream) {
      res.setHeader("Content-Type", "application/x-ndjson; charset=utf-8");
      res.setHeader("Cache-Control", "no-cache, no-transform");
      res.setHeader("X-Accel-Buffering", "no");
      res.flushHeaders?.();
    }
    const tone = normalizeTranslationTone(translationTone);
    const lockedResult = await withUploadSessionLock(
      uploadId,
      async (persistentPath) => processUploadedVideo(
        persistentPath,
        uploadId,
        title,
        Math.max(5, Number(durationSec) || 120),
        selectedScenes,
        tone,
        wantStream ? (ev) => sendNdjson({ type: "progress", ...ev }) : void 0
      ),
      { markFinalized: true }
    );
    if (!lockedResult) {
      if (wantStream) {
        sendNdjson({
          type: "error",
          status: 404,
          error: "Uploaded video file not found. Please try again."
        });
        res.end();
      } else {
        res.status(404).json({ error: "Uploaded video file not found. Please try again." });
      }
      return;
    }
    if (wantStream) {
      if (lockedResult.status !== 200) {
        sendNdjson({
          type: "error",
          status: lockedResult.status,
          error: lockedResult.body.error || "Failed to process uploaded video."
        });
      } else {
        sendNdjson({
          type: "progress",
          stage: "compiling",
          label: "Subtitles ready",
          percent: 100
        });
        sendNdjson({ type: "result", status: 200, data: lockedResult.body });
      }
      res.end();
      return;
    }
    res.status(lockedResult.status).json(lockedResult.body);
  } catch (err) {
    console.error("Process upload error:", err);
    const formatted = formatGeminiError(err, "Failed to process uploaded video.");
    if (wantStream && res.headersSent) {
      sendNdjson({ type: "error", status: formatted.status, error: formatted.message });
      res.end();
      return;
    }
    res.status(formatted.status).json({ error: formatted.message });
  }
});
app.post(
  "/api/upload-raw",
  express.raw({ type: ["video/*", "application/octet-stream"], limit: "250mb" }),
  async (req, res) => {
    try {
      const videoBuf = req.body;
      if (!videoBuf || videoBuf.length === 0) {
        res.status(400).json({ error: "Empty video upload." });
        return;
      }
      if (videoBuf.length > MAX_UPLOAD_BYTES) {
        res.status(413).json({ error: "Video upload exceeds the 500 MB server limit." });
        return;
      }
      const uploadId = crypto.randomUUID();
      const persistentPath = path.join(os.tmpdir(), `thai-studio-upload-${uploadId}.mp4`);
      await fs.promises.writeFile(persistentPath, videoBuf);
      registerUploadSession(uploadId, persistentPath, {
        expectedSize: videoBuf.length,
        receivedBytes: videoBuf.length,
        finalized: true
      });
      res.json({ uploadId });
    } catch (err) {
      console.error("Raw upload error:", err);
      res.status(500).json({
        error: err instanceof Error ? err.message : "Failed to store uploaded video."
      });
    }
  }
);
app.post(
  "/api/upload-video",
  express.raw({ type: ["video/*", "application/octet-stream"], limit: "250mb" }),
  async (req, res) => {
    try {
      const videoBuf = req.body;
      if (!videoBuf || videoBuf.length === 0) {
        res.status(400).json({ error: "Empty video upload." });
        return;
      }
      if (videoBuf.length > MAX_UPLOAD_BYTES) {
        res.status(413).json({ error: "Video upload exceeds the 500 MB server limit." });
        return;
      }
      const title = decodeURIComponent(String(req.headers["x-file-name"] || "Uploaded Video"));
      const durationSec = Math.max(5, Number(req.headers["x-video-duration"]) || 120);
      const rawScenesHeader = String(req.headers["x-selected-scenes"] || "[]");
      const parsedScenes = JSON.parse(rawScenesHeader);
      const tone = normalizeTranslationTone(req.headers["x-translation-tone"]);
      const uploadId = crypto.randomUUID();
      const ext = sanitizeVideoExtension(title);
      const persistentPath = path.join(os.tmpdir(), `thai-studio-upload-${uploadId}${ext}`);
      await fs.promises.writeFile(persistentPath, videoBuf);
      registerUploadSession(uploadId, persistentPath, {
        expectedSize: videoBuf.length,
        receivedBytes: videoBuf.length,
        finalized: true
      });
      const lockedResult = await withUploadSessionLock(
        uploadId,
        async (lockedPath) => processUploadedVideo(lockedPath, uploadId, title, durationSec, parsedScenes, tone)
      );
      if (!lockedResult) {
        res.status(500).json({ error: "Uploaded session unexpectedly expired." });
        return;
      }
      res.status(lockedResult.status).json(lockedResult.body);
    } catch (err) {
      console.error("Upload analysis error:", err);
      res.status(500).json({
        error: err instanceof Error ? err.message : "Failed to transcribe selected scenes."
      });
    }
  }
);
var singleSubtitleSchema = {
  type: Type.OBJECT,
  properties: {
    originalSpokenText: {
      type: Type.STRING,
      description: "Exact verbatim spoken words heard in this subtitle segment."
    },
    thaiScript: {
      type: Type.STRING,
      description: "Accurate Thai script for this line."
    },
    thaiPhonetic: {
      type: Type.STRING,
      description: "Clear, accurate English phonetic pronunciation of the Thai speech (e.g. 'Sa-wat-dee khrap')."
    },
    burmese: {
      type: Type.STRING,
      description: "Natural, accurate Burmese translation (\u1019\u103C\u1014\u103A\u1019\u102C\u1018\u102C\u101E\u102C\u1015\u103C\u1014\u103A) matching the spoken meaning and dialogue context."
    },
    words: {
      type: Type.ARRAY,
      description: "Word-by-word breakdown matching space-separated tokens in thaiPhonetic with Thai word, short Burmese gloss, and word offsets relative to 0.0 start of this line.",
      items: {
        type: Type.OBJECT,
        properties: {
          phonetic: { type: Type.STRING },
          thai: { type: Type.STRING },
          burmeseGloss: { type: Type.STRING },
          startSec: { type: Type.NUMBER },
          endSec: { type: Type.NUMBER }
        },
        required: ["phonetic", "thai", "burmeseGloss", "startSec", "endSec"]
      }
    }
  },
  required: ["originalSpokenText", "thaiScript", "thaiPhonetic", "burmese", "words"]
};
app.post("/api/regenerate-subtitle", async (req, res) => {
  const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "thai-regen-sub-"));
  try {
    const {
      uploadId,
      clipAudioBase64,
      clipMimeType,
      subtitle,
      prevContext,
      nextContext,
      customHint,
      translationTone
    } = req.body || {};
    if (!subtitle) {
      res.status(400).json({ error: "Missing subtitle payload." });
      return;
    }
    const tone = normalizeTranslationTone(translationTone);
    const trimmedHint = typeof customHint === "string" ? customHint.trim().slice(0, 400) : "";
    const startTime = Number(subtitle.startTime) || 0;
    const endTime = Math.max(startTime + 0.35, Number(subtitle.endTime) || startTime + 1.5);
    const lineDur = Math.max(0.35, endTime - startTime);
    const srcStart = Math.max(0, Number(subtitle.sourceStartSec ?? startTime) || 0);
    const srcEnd = Math.max(srcStart + 0.35, Number(subtitle.sourceEndSec ?? srcStart + lineDur) || srcStart + lineDur);
    const contextLines = [];
    if (prevContext && (prevContext.originalSpokenText || prevContext.burmese)) {
      contextLines.push(
        `Previous line: spoken="${prevContext.originalSpokenText || ""}" | thai="${prevContext.thaiScript || ""}" | burmese="${prevContext.burmese || ""}"`
      );
    }
    if (nextContext && (nextContext.originalSpokenText || nextContext.burmese)) {
      contextLines.push(
        `Next line: spoken="${nextContext.originalSpokenText || ""}" | thai="${nextContext.thaiScript || ""}" | burmese="${nextContext.burmese || ""}"`
      );
    }
    const contextBlock = contextLines.length > 0 ? `
SURROUNDING DIALOGUE CONTEXT:
${contextLines.join("\n")}
` : "";
    const userHintBlock = trimmedHint ? `
USER CORRECTION HINT / INSTRUCTION (HIGH PRIORITY \u2014 follow this guidance closely):
"${trimmedHint}"
` : "";
    const prevAttemptBlock = `PREVIOUSLY GENERATED SUBTITLE (flagged by the user for regeneration/refinement \u2014 re-evaluate carefully):
- originalSpokenText: ${subtitle.originalSpokenText || "(none)"}
- thaiScript: ${subtitle.thaiScript || "(none)"}
- thaiPhonetic: ${subtitle.thaiPhonetic || "(none)"}
- burmese: ${subtitle.burmese || "(none)"}`;
    let audioBase64 = null;
    if (clipAudioBase64) {
      const rawBuf = Buffer.from(clipAudioBase64, "base64");
      const ext = clipMimeType?.includes("wav") ? ".wav" : ".m4a";
      const inClip = path.join(tmpDir, `inline-line${ext}`);
      const wavPath = path.join(tmpDir, "line.wav");
      try {
        await fs.promises.writeFile(inClip, rawBuf);
        await execFileAsync(
          "ffmpeg",
          ["-y", "-vn", "-i", inClip, "-ac", "1", "-ar", "16000", wavPath],
          FFMPEG_EXEC_OPTS
        );
        if (fs.existsSync(wavPath) && fs.statSync(wavPath).size > 44) {
          audioBase64 = (await fs.promises.readFile(wavPath)).toString("base64");
        }
      } catch {
        audioBase64 = null;
      }
    } else if (uploadId) {
      audioBase64 = await withUploadSessionLock(uploadId, async (uploadedPath) => {
        const clipStart = Math.max(0, srcStart - 0.18);
        const clipDur = Math.max(0.5, srcEnd - clipStart + 0.18);
        const wavPath = path.join(tmpDir, "line.wav");
        try {
          await execFileAsync(
            "ffmpeg",
            [
              "-y",
              "-ss",
              clipStart.toFixed(3),
              "-i",
              uploadedPath,
              "-t",
              clipDur.toFixed(3),
              "-vn",
              "-sn",
              "-dn",
              "-ac",
              "1",
              "-ar",
              "16000",
              wavPath
            ],
            FFMPEG_EXEC_OPTS
          );
          if (fs.existsSync(wavPath) && fs.statSync(wavPath).size > 44) {
            const buf = await fs.promises.readFile(wavPath);
            return buf.toString("base64");
          }
        } catch {
        }
        return null;
      });
    }
    const hasAudio = Boolean(audioBase64);
    const promptText = `${hasAudio ? `Listen very carefully to the SPOKEN AUDIO of this single ${lineDur.toFixed(2)}-second dialogue line.` : `Re-transcribe/correct and accurately translate this single ${lineDur.toFixed(2)}-second dialogue line using the spoken text and surrounding dialogue context.`}
${contextBlock}${userHintBlock}
${getTranslationToneInstruction(tone)}

${prevAttemptBlock}

TASK:
1. ${hasAudio ? "Re-listen to the audio carefully to catch every spoken syllable, slang, particle, or idiom accurately (do NOT blindly copy mistakes from the previous attempt)." : "Carefully fix any mistranslation, awkward phrasing, or mis-segmented words in the previous attempt."}${trimmedHint ? "\n   Respect the USER CORRECTION HINT above as primary guidance for meaning, names, or phrasing." : ""}
2. Output natural, accurate, idiomatic Burmese translation (\u1019\u103C\u1014\u103A\u1019\u102C\u1018\u102C\u101E\u102C\u1015\u103C\u1014\u103A) matching the chosen tone and conversational context.
3. Provide accurate "thaiScript", clear English "thaiPhonetic" pronunciation (e.g. "Sa-wat-dee khrap"), and a matching word-by-word "words" breakdown aligned within [0.0, ${lineDur.toFixed(2)}] seconds (each word having "phonetic", "thai", 1-2 word "burmeseGloss" for content words or "" for particles, "startSec", and "endSec").`;
    const ai = getGeminiClient();
    const contents = audioBase64 ? {
      parts: [
        { inlineData: { mimeType: "audio/wav", data: audioBase64 } },
        { text: promptText }
      ]
    } : promptText;
    const resp = await generateGroundedWithFailover(
      ai,
      contents,
      singleSubtitleSchema,
      ThinkingLevel.HIGH
    );
    const raw = JSON.parse((resp.text || "{}").trim());
    const thaiPhonetic = (raw.thaiPhonetic || "").trim() || subtitle.thaiPhonetic || "";
    const rawWords = Array.isArray(raw.words) && raw.words.length > 0 ? raw.words : thaiPhonetic.split(/\s+/).filter(Boolean).map((w) => ({ phonetic: w, thai: w, burmeseGloss: "" }));
    const words = buildAlignedWords(rawWords, 0, lineDur, false, 0);
    res.json({
      usedAudio: hasAudio,
      subtitle: {
        originalSpokenText: (raw.originalSpokenText || "").trim() || subtitle.originalSpokenText || "",
        thaiScript: (raw.thaiScript || "").trim() || subtitle.thaiScript || thaiPhonetic,
        thaiPhonetic,
        burmese: (raw.burmese || "").trim() || subtitle.burmese || "",
        words
      }
    });
  } catch (err) {
    console.error("Regenerate subtitle error:", err);
    const formatted = formatGeminiError(err, "Failed to regenerate subtitle with AI.");
    res.status(formatted.status).json({ error: formatted.message });
  } finally {
    await fs.promises.rm(tmpDir, { recursive: true, force: true }).catch(() => {
    });
  }
});
var batchRetranslateSchema = {
  type: Type.OBJECT,
  properties: {
    items: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          id: { type: Type.STRING },
          thaiScript: { type: Type.STRING },
          thaiPhonetic: { type: Type.STRING },
          burmese: { type: Type.STRING },
          words: {
            type: Type.ARRAY,
            items: {
              type: Type.OBJECT,
              properties: {
                phonetic: { type: Type.STRING },
                thai: { type: Type.STRING },
                burmeseGloss: { type: Type.STRING }
              },
              required: ["phonetic", "thai", "burmeseGloss"]
            }
          }
        },
        required: ["id", "thaiScript", "thaiPhonetic", "burmese", "words"]
      }
    }
  },
  required: ["items"]
};
app.post("/api/retranslate-subtitles", async (req, res) => {
  try {
    const { subtitles, translationTone } = req.body || {};
    if (!Array.isArray(subtitles) || subtitles.length === 0) {
      res.status(400).json({ error: "No subtitles provided to re-translate." });
      return;
    }
    const tone = normalizeTranslationTone(translationTone);
    const ai = getGeminiClient();
    const chunkSize = 25;
    const updatesById = /* @__PURE__ */ new Map();
    for (let i = 0; i < subtitles.length; i += chunkSize) {
      const slice = subtitles.slice(i, i + chunkSize);
      const compactLines = slice.map((s) => ({
        id: s.id,
        spoken: s.originalSpokenText || "",
        thaiScript: s.thaiScript || "",
        thaiPhonetic: s.thaiPhonetic || "",
        burmese: s.burmese || ""
      }));
      const prompt = `Re-translate and polish the Burmese subtitles (and word-by-word Burmese glosses) for the dialogue sequence below so they match the selected tone and read cohesively across the whole conversation.

${getTranslationToneInstruction(tone)}

INPUT SUBTITLE LINES (JSON):
${JSON.stringify(compactLines)}

RULES:
- Return an item for EVERY input line with its exact matching "id".
- Keep "thaiScript" and "thaiPhonetic" accurate to the spoken Thai dialogue (fix any obvious phonetic/script issues if found, otherwise keep faithful).
- Rewrite "burmese" (\u1019\u103C\u1014\u103A\u1019\u102C\u1018\u102C\u101E\u102C\u1015\u103C\u1014\u103A) to match the requested translation tone while keeping dialogue meaning accurate and consistent across lines.
- Return "words" matching each space-separated token of "thaiPhonetic" with "phonetic", "thai", and a 1-2 word "burmeseGloss" for content words ("" for particles).`;
      const resp = await generateGroundedWithFailover(
        ai,
        prompt,
        batchRetranslateSchema,
        ThinkingLevel.MEDIUM
      );
      const parsed = JSON.parse((resp.text || "{}").trim());
      for (const item of Array.isArray(parsed.items) ? parsed.items : []) {
        if (!item?.id) continue;
        updatesById.set(item.id, {
          thaiScript: (item.thaiScript || "").trim(),
          thaiPhonetic: (item.thaiPhonetic || "").trim(),
          burmese: (item.burmese || "").trim(),
          words: Array.isArray(item.words) ? item.words : []
        });
      }
    }
    const updated = subtitles.map((sub) => {
      const patch = updatesById.get(sub.id);
      if (!patch) return null;
      const startTime = Number(sub.startTime) || 0;
      const endTime = Math.max(startTime + 0.2, Number(sub.endTime) || startTime + 1.5);
      const lineDur = Math.max(0.2, endTime - startTime);
      const thaiPhonetic = patch.thaiPhonetic || sub.thaiPhonetic || "";
      const rawWords = patch.words.length > 0 ? patch.words : thaiPhonetic.split(/\s+/).filter(Boolean).map((w) => ({ phonetic: w, thai: w, burmeseGloss: "" }));
      const alignedWords = buildAlignedWords(rawWords, 0, lineDur, false, 0);
      return {
        id: sub.id,
        thaiScript: patch.thaiScript || sub.thaiScript || thaiPhonetic,
        thaiPhonetic,
        burmese: patch.burmese || sub.burmese || "",
        words: alignedWords
      };
    }).filter((x) => Boolean(x));
    res.json({ subtitles: updated });
  } catch (err) {
    console.error("Batch retranslate error:", err);
    const formatted = formatGeminiError(err, "Failed to re-translate subtitles.");
    res.status(formatted.status).json({ error: formatted.message });
  }
});
var resyncSubtitlesSchema = {
  type: Type.OBJECT,
  properties: {
    items: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          id: { type: Type.STRING },
          startTime: { type: Type.NUMBER },
          endTime: { type: Type.NUMBER }
        },
        required: ["id", "startTime", "endTime"]
      }
    }
  },
  required: ["items"]
};
app.post("/api/resync-subtitles", async (req, res) => {
  const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "thai-resync-"));
  try {
    const {
      uploadId,
      clipsAudio,
      scenes = [],
      subtitles = []
    } = req.body || {};
    if (!Array.isArray(subtitles) || subtitles.length === 0) {
      res.status(400).json({ error: "No subtitles provided to resync." });
      return;
    }
    const normalizedScenes = (Array.isArray(scenes) ? scenes : []).map((sc) => {
      const s = Math.max(0, Number(sc.startSec) || 0);
      const e = Math.max(s + 0.2, Number(sc.endSec) || s + 1);
      return { startSec: s, endSec: e, durationSec: Number((e - s).toFixed(2)) };
    }).filter((sc) => sc.durationSec >= 0.2);
    const totalCutDur = Math.max(
      1,
      normalizedScenes.reduce((acc, sc) => acc + sc.durationSec, 0) || Math.max(...subtitles.map((s) => Number(s.endTime) || 1), 1)
    );
    const compactSubs = subtitles.map((s, idx) => ({
      index: idx,
      id: s.id,
      currentStartTime: Number((Number(s.startTime) || 0).toFixed(2)),
      currentEndTime: Number((Number(s.endTime) || 0).toFixed(2)),
      spoken: s.originalSpokenText || "",
      thaiScript: s.thaiScript || "",
      thaiPhonetic: s.thaiPhonetic || "",
      burmese: s.burmese || ""
    }));
    const ai = getGeminiClient();
    let audioPrep = null;
    if (Array.isArray(clipsAudio) && clipsAudio.length > 0) {
      const pcmBuffers = [];
      for (let i = 0; i < clipsAudio.length; i++) {
        const clip = clipsAudio[i];
        const dur = Math.max(0.2, Number(clip.durationSec) || 1);
        const ext = clip.mimeType?.includes("wav") ? ".wav" : ".m4a";
        const inClip = path.join(tmpDir, `inline-sc-${i}${ext}`);
        const scPcmPath = path.join(tmpDir, `inline-sc-${i}.pcm`);
        try {
          await fs.promises.writeFile(inClip, Buffer.from(clip.audioBase64, "base64"));
          await execFileAsync(
            "ffmpeg",
            [
              "-y",
              "-ss",
              Math.max(0, Number(clip.trimLeadSec) || 0).toFixed(4),
              "-i",
              inClip,
              "-t",
              dur.toFixed(3),
              "-vn",
              "-sn",
              "-dn",
              "-af",
              "aresample=async=1:first_pts=0",
              "-f",
              "s16le",
              "-ac",
              "1",
              "-ar",
              "16000",
              scPcmPath
            ],
            FFMPEG_EXEC_OPTS
          );
          if (fs.existsSync(scPcmPath)) {
            pcmBuffers.push(await fs.promises.readFile(scPcmPath));
          }
        } catch {
          const silentBytes = Math.max(320, Math.round(dur * 16e3) * 2);
          pcmBuffers.push(Buffer.alloc(silentBytes));
        }
      }
      const cutPcm = Buffer.concat(pcmBuffers);
      if (cutPcm.length >= 640) {
        const cutPcmPath = path.join(tmpDir, "cut-all.pcm");
        const cutMp3Path = path.join(tmpDir, "cut-all.mp3");
        await fs.promises.writeFile(cutPcmPath, cutPcm);
        await execFileAsync(
          "ffmpeg",
          [
            "-y",
            "-f",
            "s16le",
            "-ar",
            "16000",
            "-ac",
            "1",
            "-i",
            cutPcmPath,
            "-b:a",
            "32k",
            cutMp3Path
          ],
          FFMPEG_EXEC_OPTS
        );
        const mp3Buf = await fs.promises.readFile(cutMp3Path);
        const rms = computeRmsEnvelope10ms(cutPcm);
        const speechWindows = detectSpeechSegments10ms(rms, totalCutDur);
        audioPrep = {
          mp3Base64: mp3Buf.toString("base64"),
          rms,
          speechWindows
        };
      }
    } else {
      if (!uploadId) {
        res.status(404).json({ error: "Uploaded video session not found." });
        return;
      }
      audioPrep = await withUploadSessionLock(uploadId, async (uploadedPath) => {
        const pcmBuffers = [];
        const sceneList = normalizedScenes.length > 0 ? normalizedScenes : [{ startSec: 0, endSec: totalCutDur, durationSec: totalCutDur }];
        for (let i = 0; i < sceneList.length; i++) {
          const sc = sceneList[i];
          const scPcmPath = path.join(tmpDir, `sc-${i}.pcm`);
          try {
            await execFileAsync(
              "ffmpeg",
              [
                "-y",
                "-ss",
                sc.startSec.toFixed(3),
                "-i",
                uploadedPath,
                "-t",
                sc.durationSec.toFixed(3),
                "-vn",
                "-sn",
                "-dn",
                "-af",
                "aresample=async=1:first_pts=0",
                "-f",
                "s16le",
                "-ac",
                "1",
                "-ar",
                "16000",
                scPcmPath
              ],
              FFMPEG_EXEC_OPTS
            );
            if (fs.existsSync(scPcmPath)) {
              pcmBuffers.push(await fs.promises.readFile(scPcmPath));
            }
          } catch {
            const silentBytes = Math.max(320, Math.round(sc.durationSec * 16e3) * 2);
            pcmBuffers.push(Buffer.alloc(silentBytes));
          }
        }
        const cutPcm = Buffer.concat(pcmBuffers);
        if (cutPcm.length < 640) {
          return null;
        }
        const cutPcmPath = path.join(tmpDir, "cut-all.pcm");
        const cutMp3Path = path.join(tmpDir, "cut-all.mp3");
        await fs.promises.writeFile(cutPcmPath, cutPcm);
        await execFileAsync(
          "ffmpeg",
          [
            "-y",
            "-f",
            "s16le",
            "-ar",
            "16000",
            "-ac",
            "1",
            "-i",
            cutPcmPath,
            "-b:a",
            "32k",
            cutMp3Path
          ],
          FFMPEG_EXEC_OPTS
        );
        const mp3Buf = await fs.promises.readFile(cutMp3Path);
        const rms = computeRmsEnvelope10ms(cutPcm);
        const speechWindows = detectSpeechSegments10ms(rms, totalCutDur);
        return {
          mp3Base64: mp3Buf.toString("base64"),
          rms,
          speechWindows
        };
      });
    }
    if (!audioPrep) {
      res.status(404).json({ error: "Uploaded video session not found." });
      return;
    }
    const windowsBlock = audioPrep.speechWindows.length > 0 ? `SPEECH ACTIVITY WINDOWS (10ms-precise RMS on [0, ${totalCutDur.toFixed(2)}s]):
${audioPrep.speechWindows.map((w) => `- ${w.startSec.toFixed(2)}s -> ${w.endSec.toFixed(2)}s`).join("\n")}
` : "";
    const prompt = `Listen to this ${totalCutDur.toFixed(2)}-second cut-timeline audio track and re-align the startTime and endTime of EVERY subtitle line below so it matches EXACTLY when that line is spoken in the audio.

${windowsBlock}
EXISTING SUBTITLE LINES (in chronological order, keep EVERY "id" intact):
${JSON.stringify(compactSubs)}

CRITICAL RULES:
- Return an item for EVERY single subtitle "id" in the input list \u2014 do NOT drop, merge, or skip any line.
- Keep timestamps strictly on the [0.00, ${totalCutDur.toFixed(2)}] audio timeline, monotonically increasing, with NO overlaps between consecutive lines.
- Snap each line cleanly onto the start and end of its actual spoken voice in the audio and SPEECH ACTIVITY WINDOWS (give 0.05s onset lead and hold briefly through final syllable).`;
    const resp = await generateGroundedWithFailover(
      ai,
      {
        parts: [
          { inlineData: { mimeType: "audio/mp3", data: audioPrep.mp3Base64 } },
          { text: prompt }
        ]
      },
      resyncSubtitlesSchema,
      ThinkingLevel.MEDIUM
    );
    const parsed = JSON.parse((resp.text || "{}").trim());
    const rawMap = /* @__PURE__ */ new Map();
    for (const item of Array.isArray(parsed.items) ? parsed.items : []) {
      if (!item?.id) continue;
      const s = Math.max(0, Math.min(totalCutDur - 0.25, Number(item.startTime) || 0));
      const e = Math.max(s + 0.25, Math.min(totalCutDur, Number(item.endTime) || s + 1));
      rawMap.set(item.id, { startTime: s, endTime: e });
    }
    const preRefineUtts = subtitles.map((sub) => {
      const hit = rawMap.get(sub.id);
      const startSec = hit ? hit.startTime : Math.max(0, Math.min(totalCutDur - 0.25, sub.startTime));
      const endSec = hit ? hit.endTime : Math.max(startSec + 0.25, Math.min(totalCutDur, sub.endTime));
      return {
        startSec,
        endSec,
        originalSpokenText: sub.id,
        thaiScript: sub.thaiScript || "",
        thaiPhonetic: sub.thaiPhonetic || "",
        burmese: sub.burmese || "",
        words: []
      };
    });
    const refinedRes = refineUtterancesWithEnvelope(
      { hasDialogue: true, summary: "Resync", utterances: preRefineUtts },
      audioPrep.rms,
      totalCutDur,
      audioPrep.speechWindows
    );
    const synced = (refinedRes.utterances || preRefineUtts).map((u) => ({
      id: u.originalSpokenText,
      startTime: Number(Math.max(0, Math.min(totalCutDur - 0.2, u.startSec)).toFixed(2)),
      endTime: Number(Math.max(u.startSec + 0.25, Math.min(totalCutDur, u.endSec)).toFixed(2))
    })).sort((a, b) => a.startTime - b.startTime);
    for (let i = 1; i < synced.length; i++) {
      if (synced[i].startTime < synced[i - 1].endTime + 0.02) {
        const mid = (synced[i - 1].endTime + synced[i].startTime) / 2;
        synced[i - 1].endTime = Number(Math.max(synced[i - 1].startTime + 0.25, mid - 0.01).toFixed(2));
        synced[i].startTime = Number(Math.max(synced[i - 1].endTime + 0.02, synced[i].startTime).toFixed(2));
        synced[i].endTime = Number(Math.max(synced[i].startTime + 0.25, Math.min(totalCutDur, synced[i].endTime)).toFixed(2));
      }
    }
    res.json({ subtitles: synced, usedAudio: true });
  } catch (err) {
    console.error("Resync subtitles error:", err);
    const formatted = formatGeminiError(err, "Failed to resync subtitle timings with AI.");
    res.status(formatted.status).json({ error: formatted.message });
  } finally {
    await fs.promises.rm(tmpDir, { recursive: true, force: true }).catch(() => {
    });
  }
});
function mapCutTimeToSourceServer(scenes, cutTime) {
  if (!Array.isArray(scenes) || scenes.length === 0) {
    return { sceneIndex: 0, sourceSec: Number(Math.max(0, cutTime).toFixed(2)) };
  }
  let acc = 0;
  for (let i = 0; i < scenes.length; i++) {
    const s = scenes[i];
    const dur = Math.max(0.1, Number(s.durationSec) || Number(s.endSec) - Number(s.startSec) || 0.1);
    if (cutTime < acc + dur - 1e-3 || i === scenes.length - 1) {
      const offset = Math.max(0, Math.min(dur, cutTime - acc));
      return {
        sceneIndex: i,
        sourceSec: Number(Math.min(Number(s.endSec), Number(s.startSec) + offset).toFixed(2))
      };
    }
    acc += dur;
  }
  return { sceneIndex: 0, sourceSec: 0 };
}
app.post("/api/transcribe-range", async (req, res) => {
  const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "thai-range-sub-"));
  try {
    const {
      startSec,
      endSec,
      prevContext,
      nextContext,
      translationTone,
      uploadId,
      clipAudioBase64,
      mimeType,
      trimLeadSec,
      clipsAudio,
      scenes = []
    } = req.body || {};
    const rawStart = Number(startSec);
    const rawEnd = Number(endSec);
    if (!Number.isFinite(rawStart) || !Number.isFinite(rawEnd) || rawEnd <= rawStart + 0.2) {
      res.status(400).json({ error: "Select a valid time range (at least 0.25s) to transcribe." });
      return;
    }
    const normalizedScenes = (Array.isArray(scenes) ? scenes : []).map((sc) => {
      const s = Math.max(0, Number(sc.startSec) || 0);
      const e = Math.max(s + 0.2, Number(sc.endSec) || s + 1);
      return { startSec: s, endSec: e, durationSec: Number((e - s).toFixed(2)) };
    }).filter((sc) => sc.durationSec >= 0.2);
    const totalCutDur = normalizedScenes.length > 0 ? normalizedScenes.reduce((acc, sc) => acc + sc.durationSec, 0) : 0;
    const reqStart = Math.max(0, totalCutDur > 0 ? Math.min(totalCutDur - 0.25, rawStart) : rawStart);
    const reqEnd = Math.max(
      reqStart + 0.25,
      totalCutDur > 0 ? Math.min(totalCutDur, rawEnd) : rawEnd
    );
    if (reqEnd - reqStart > 90) {
      res.status(400).json({ error: "Please select a range of 90 seconds or less at a time." });
      return;
    }
    const PAD_SEC = 0.4;
    const paddedCutStart = Math.max(0, Number((reqStart - PAD_SEC).toFixed(2)));
    const paddedCutEnd = Number(
      (totalCutDur > 0 ? Math.min(totalCutDur, reqEnd + PAD_SEC) : reqEnd + PAD_SEC).toFixed(2)
    );
    const padLead = Number((reqStart - paddedCutStart).toFixed(2));
    const reqDur = Number((reqEnd - reqStart).toFixed(2));
    const focusStartInClip = padLead;
    const focusEndInClip = Number((padLead + reqDur).toFixed(2));
    const tone = normalizeTranslationTone(translationTone);
    const contextLines = [];
    if (prevContext && (prevContext.originalSpokenText || prevContext.thaiPhonetic || prevContext.burmese)) {
      contextLines.push(
        `Previous subtitle (just BEFORE ${reqStart.toFixed(2)}s \u2014 match tone/style, do NOT repeat it): spoken="${prevContext.originalSpokenText || ""}" | phonetic="${prevContext.thaiPhonetic || ""}" | thai="${prevContext.thaiScript || ""}" | burmese="${prevContext.burmese || ""}"`
      );
    }
    if (nextContext && (nextContext.originalSpokenText || nextContext.thaiPhonetic || nextContext.burmese)) {
      contextLines.push(
        `Next subtitle (just AFTER ${reqEnd.toFixed(2)}s \u2014 match tone/style, do NOT repeat it): spoken="${nextContext.originalSpokenText || ""}" | phonetic="${nextContext.thaiPhonetic || ""}" | thai="${nextContext.thaiScript || ""}" | burmese="${nextContext.burmese || ""}"`
      );
    }
    const contextBlock = contextLines.length > 0 ? `
SURROUNDING DIALOGUE CONTEXT:
${contextLines.join("\n")}
` : "";
    const ai = getGeminiClient();
    let localAudioPrep = null;
    const targetDur = Math.max(0.4, paddedCutEnd - paddedCutStart);
    if (clipAudioBase64) {
      const ext = mimeType?.includes("wav") ? ".wav" : ".m4a";
      const inClip = path.join(tmpDir, `inline-range${ext}`);
      const pcmPath = path.join(tmpDir, "inline-range.pcm");
      try {
        await fs.promises.writeFile(inClip, Buffer.from(clipAudioBase64, "base64"));
        const lead = Math.max(0, Number(trimLeadSec) || 0);
        await execFileAsync(
          "ffmpeg",
          [
            "-y",
            ...lead > 5e-3 ? ["-ss", lead.toFixed(4)] : [],
            "-i",
            inClip,
            "-t",
            targetDur.toFixed(3),
            "-vn",
            "-sn",
            "-dn",
            "-af",
            "aresample=async=1:first_pts=0",
            "-f",
            "s16le",
            "-ac",
            "1",
            "-ar",
            "16000",
            pcmPath
          ],
          FFMPEG_EXEC_OPTS
        );
        if (fs.existsSync(pcmPath)) {
          const pcmBuf = await fs.promises.readFile(pcmPath);
          if (pcmBuf.length >= 640) {
            const clipDur = Math.max(0.4, Number((pcmBuf.length / 32e3).toFixed(2)));
            const rms = computeRmsEnvelope10ms(pcmBuf);
            const speechWindows = detectSpeechSegments10ms(rms, clipDur);
            const wavBuf = pcmToWavBuffer(pcmBuf, 16e3);
            localAudioPrep = {
              wavBase64: wavBuf.toString("base64"),
              rms,
              speechWindows,
              clipDur
            };
          }
        }
      } catch {
        localAudioPrep = null;
      }
    } else if (Array.isArray(clipsAudio) && clipsAudio.length > 0) {
      const pcmBuffers = [];
      for (let i = 0; i < clipsAudio.length; i++) {
        const clip = clipsAudio[i];
        const dur = Math.max(0.2, Number(clip.durationSec) || 1);
        const ext = clip.mimeType?.includes("wav") ? ".wav" : ".m4a";
        const inClip = path.join(tmpDir, `inline-rng-${i}${ext}`);
        const scPcmPath = path.join(tmpDir, `inline-rng-${i}.pcm`);
        try {
          await fs.promises.writeFile(inClip, Buffer.from(clip.audioBase64, "base64"));
          await execFileAsync(
            "ffmpeg",
            [
              "-y",
              "-ss",
              Math.max(0, Number(clip.trimLeadSec) || 0).toFixed(4),
              "-i",
              inClip,
              "-t",
              dur.toFixed(3),
              "-vn",
              "-sn",
              "-dn",
              "-af",
              "aresample=async=1:first_pts=0",
              "-f",
              "s16le",
              "-ac",
              "1",
              "-ar",
              "16000",
              scPcmPath
            ],
            FFMPEG_EXEC_OPTS
          );
          if (fs.existsSync(scPcmPath)) {
            pcmBuffers.push(await fs.promises.readFile(scPcmPath));
          }
        } catch {
          const silentBytes = Math.max(320, Math.round(dur * 16e3) * 2);
          pcmBuffers.push(Buffer.alloc(silentBytes));
        }
      }
      const cutPcm = Buffer.concat(pcmBuffers);
      if (cutPcm.length >= 640) {
        const clipDur = Math.max(0.4, Number((cutPcm.length / 32e3).toFixed(2)));
        const rms = computeRmsEnvelope10ms(cutPcm);
        const speechWindows = detectSpeechSegments10ms(rms, clipDur);
        const wavBuf = pcmToWavBuffer(cutPcm, 16e3);
        localAudioPrep = {
          wavBase64: wavBuf.toString("base64"),
          rms,
          speechWindows,
          clipDur
        };
      }
    } else {
      if (!uploadId) {
        res.status(404).json({ error: "Uploaded video session not found." });
        return;
      }
      localAudioPrep = await withUploadSessionLock(uploadId, async (uploadedPath) => {
        const slices = [];
        if (normalizedScenes.length > 0) {
          let cutAcc = 0;
          for (const sc of normalizedScenes) {
            const scCutStart = cutAcc;
            const scCutEnd = cutAcc + sc.durationSec;
            const ovStart = Math.max(paddedCutStart, scCutStart);
            const ovEnd = Math.min(paddedCutEnd, scCutEnd);
            if (ovEnd - ovStart > 0.02) {
              slices.push({
                srcStart: Number((sc.startSec + (ovStart - scCutStart)).toFixed(3)),
                dur: Number((ovEnd - ovStart).toFixed(3))
              });
            }
            cutAcc = scCutEnd;
          }
        } else {
          slices.push({
            srcStart: paddedCutStart,
            dur: Number(targetDur.toFixed(3))
          });
        }
        const pcmBuffers = [];
        for (let i = 0; i < slices.length; i++) {
          const sl = slices[i];
          const slPcmPath = path.join(tmpDir, `range-sl-${i}.pcm`);
          try {
            await execFileAsync(
              "ffmpeg",
              [
                "-y",
                "-ss",
                sl.srcStart.toFixed(3),
                "-i",
                uploadedPath,
                "-t",
                sl.dur.toFixed(3),
                "-vn",
                "-sn",
                "-dn",
                "-af",
                "aresample=async=1:first_pts=0",
                "-f",
                "s16le",
                "-ac",
                "1",
                "-ar",
                "16000",
                slPcmPath
              ],
              FFMPEG_EXEC_OPTS
            );
            if (fs.existsSync(slPcmPath)) {
              pcmBuffers.push(await fs.promises.readFile(slPcmPath));
            }
          } catch {
            const silentBytes = Math.max(320, Math.round(sl.dur * 16e3) * 2);
            pcmBuffers.push(Buffer.alloc(silentBytes));
          }
        }
        const pcmBuf = Buffer.concat(pcmBuffers);
        if (pcmBuf.length < 640) return null;
        const clipDur = Math.max(0.4, Number((pcmBuf.length / 32e3).toFixed(2)));
        const rms = computeRmsEnvelope10ms(pcmBuf);
        const speechWindows = detectSpeechSegments10ms(rms, clipDur);
        const wavBuf = pcmToWavBuffer(pcmBuf, 16e3);
        return {
          wavBase64: wavBuf.toString("base64"),
          rms,
          speechWindows,
          clipDur
        };
      });
    }
    if (!localAudioPrep) {
      res.status(404).json({ error: "Uploaded video audio segment could not be extracted." });
      return;
    }
    const vadWindows = localAudioPrep.speechWindows.filter((w) => w.endSec > focusStartInClip - 0.15 && w.startSec < focusEndInClip + 0.15).map((w) => ({
      startSec: Number(Math.max(0, w.startSec).toFixed(2)),
      endSec: Number(Math.min(localAudioPrep.clipDur, w.endSec).toFixed(2))
    }));
    const vadBlock = vadWindows.length > 0 ? `
WAVEFORM-DETECTED SPEECH WINDOWS (seconds relative to 0.0s start of this clip):
${vadWindows.map((w, i) => `  [${i + 1}] ${w.startSec.toFixed(2)}s \u2013 ${w.endSec.toFixed(2)}s`).join("\n")}
` : "";
    const prompt = `Listen carefully to this ${localAudioPrep.clipDur.toFixed(2)}-second audio clip.
The user wants to fill missed subtitle(s) specifically for the TARGET WINDOW [${focusStartInClip.toFixed(2)}s \u2013 ${focusEndInClip.toFixed(2)}s] inside this clip (there is ~${padLead.toFixed(2)}s leading context buffer and trailing buffer around it so boundary syllables stay intact).
${vadBlock}${contextBlock}
CRITICAL RULES:
- ONLY transcribe and translate spoken dialogue actually heard inside (or primarily spanning) the target window [${focusStartInClip.toFixed(2)}s \u2013 ${focusEndInClip.toFixed(2)}s].
- Do NOT repeat or duplicate the Previous/Next surrounding context lines if only their edges appear in the padding buffer.
- If there is NO spoken human dialogue in the target window (only silence, background noise, or music), set "hasDialogue": false and return an empty "utterances" array.
- Report ALL "startSec" and "endSec" values relative to 0.0s start of this audio clip (${localAudioPrep.clipDur.toFixed(2)}s total) with sub-second precision.
- Split into multiple chronological, non-overlapping utterances if multiple distinct sentences are spoken.

${getTranslationToneInstruction(tone)}

For each spoken utterance:
- "originalSpokenText": Exact verbatim words spoken.
- "thaiScript": Verbatim Thai script if spoken in Thai, otherwise natural Thai translation.
- "thaiPhonetic": Clear English phonetic pronunciation of the Thai speech (e.g. "Sa-wat-dee khrap").
- "burmese": Accurate Burmese translation (\u1019\u103C\u1014\u103A\u1019\u102C\u1018\u102C\u101E\u102C\u1015\u103C\u1014\u103A) matching the tone and surrounding context.
- "words": Split "thaiPhonetic" into space-separated word tokens with matching "thai", a 1-2 word "burmeseGloss" for content words ("" for particles), and clip-relative "startSec"/"endSec".`;
    const resp = await generateGroundedWithFailover(
      ai,
      {
        parts: [
          { inlineData: { mimeType: "audio/wav", data: localAudioPrep.wavBase64 } },
          { text: prompt }
        ]
      },
      sceneTranscriptSchema,
      ThinkingLevel.HIGH
    );
    const parsed = JSON.parse((resp.text || "{}").trim());
    const rawRes = refineUtterancesWithEnvelope(
      parsed,
      localAudioPrep.rms,
      localAudioPrep.clipDur,
      localAudioPrep.speechWindows
    );
    if (rawRes.hasDialogue === false || !Array.isArray(rawRes.utterances) || rawRes.utterances.length === 0) {
      res.json({
        hasSpeech: false,
        usedAudio: true,
        message: `No spoken dialogue was detected between ${reqStart.toFixed(1)}s and ${reqEnd.toFixed(1)}s.`,
        subtitles: []
      });
      return;
    }
    const mappedUtts = [];
    for (const u of rawRes.utterances) {
      const hasText = Boolean(
        (u.thaiPhonetic || "").trim() || (u.thaiScript || "").trim() || (u.burmese || "").trim() || (u.originalSpokenText || "").trim()
      );
      if (!hasText) continue;
      const rawCutStart = paddedCutStart + (Number(u.startSec) || 0);
      const rawCutEnd = paddedCutStart + Math.max((Number(u.startSec) || 0) + 0.25, Number(u.endSec) || 0);
      const ovStart = Math.max(reqStart - 0.12, rawCutStart);
      const ovEnd = Math.min(reqEnd + 0.12, rawCutEnd);
      if (ovEnd - ovStart < 0.18) continue;
      const clampedStart = Number(Math.max(reqStart, Math.min(reqEnd - 0.25, rawCutStart)).toFixed(2));
      const clampedEnd = Number(Math.max(clampedStart + 0.25, Math.min(reqEnd, rawCutEnd)).toFixed(2));
      mappedUtts.push({
        cutStart: clampedStart,
        cutEnd: clampedEnd,
        rawCutStart,
        rawCutEnd: Math.max(rawCutStart + 0.25, rawCutEnd),
        u
      });
    }
    mappedUtts.sort((a, b) => a.cutStart - b.cutStart || a.cutEnd - b.cutEnd);
    for (let i = 1; i < mappedUtts.length; i++) {
      const prev = mappedUtts[i - 1];
      const curr = mappedUtts[i];
      if (curr.cutStart < prev.cutEnd + 0.02) {
        const mid = Number(((prev.cutEnd + curr.cutStart) / 2).toFixed(2));
        prev.cutEnd = Number(Math.max(prev.cutStart + 0.25, mid - 0.01).toFixed(2));
        curr.cutStart = Number(Math.max(prev.cutEnd + 0.02, curr.cutStart).toFixed(2));
        curr.cutEnd = Number(Math.max(curr.cutStart + 0.25, Math.min(reqEnd, curr.cutEnd)).toFixed(2));
      }
    }
    const generatedSubtitles = mappedUtts.map((entry, idx) => {
      const { u, cutStart, cutEnd, rawCutStart } = entry;
      const dur = Math.max(0.25, Number((cutEnd - cutStart).toFixed(2)));
      const thaiPhonetic = (u.thaiPhonetic || "").trim() || (u.thaiScript || "").trim();
      const rawWords = Array.isArray(u.words) && u.words.length > 0 ? u.words : thaiPhonetic.split(/\s+/).filter(Boolean).map((w) => ({ phonetic: w, thai: w, burmeseGloss: "" }));
      const rawOriginInClip = rawCutStart - paddedCutStart;
      const firstWordStart = rawWords.find((w) => typeof w.startSec === "number")?.startSec;
      const wordsAreClipOrAbs = typeof firstWordStart === "number" && rawOriginInClip > 0.35 && firstWordStart >= rawOriginInClip - 0.35;
      const clampShift = cutStart - rawCutStart;
      const adjustedRawWords = rawWords.map((w) => {
        if (typeof w.startSec !== "number" || typeof w.endSec !== "number") return w;
        const shift = (wordsAreClipOrAbs ? rawOriginInClip : 0) + clampShift;
        return {
          ...w,
          startSec: Number((w.startSec - shift).toFixed(2)),
          endSec: Number((w.endSec - shift).toFixed(2))
        };
      });
      const words = buildAlignedWords(adjustedRawWords, 0, dur, false, 0);
      const mappedSrcStart = mapCutTimeToSourceServer(normalizedScenes, cutStart);
      const mappedSrcEnd = mapCutTimeToSourceServer(normalizedScenes, cutEnd);
      return {
        id: `sub-range-${Date.now()}-${idx}-${Math.random().toString(36).slice(2, 6)}`,
        sceneIndex: mappedSrcStart.sceneIndex,
        startTime: cutStart,
        endTime: cutEnd,
        sourceStartSec: mappedSrcStart.sourceSec,
        sourceEndSec: mappedSrcEnd.sourceSec,
        originalSpokenText: (u.originalSpokenText || "").trim() || thaiPhonetic,
        thaiPhonetic,
        thaiScript: (u.thaiScript || "").trim() || thaiPhonetic,
        burmese: (u.burmese || "").trim(),
        words,
        isManuallyEdited: false
      };
    });
    if (generatedSubtitles.length === 0) {
      res.json({
        hasSpeech: false,
        usedAudio: true,
        message: `No spoken dialogue was detected between ${reqStart.toFixed(1)}s and ${reqEnd.toFixed(1)}s.`,
        subtitles: []
      });
      return;
    }
    res.json({
      hasSpeech: true,
      usedAudio: true,
      subtitles: generatedSubtitles
    });
  } catch (err) {
    console.error("Transcribe range error:", err);
    const formatted = formatGeminiError(err, "Failed to transcribe range with AI.");
    res.status(formatted.status).json({ error: formatted.message });
  } finally {
    await fs.promises.rm(tmpDir, { recursive: true, force: true }).catch(() => {
    });
  }
});
app.get("/api/upload-exists/:uploadId", (req, res) => {
  const uploadId = String(req.params.uploadId || "");
  const session = uploadId ? uploadSessions.get(uploadId) : void 0;
  const exists = Boolean(session && !session.pendingDelete && fs.existsSync(session.filePath));
  if (session && exists) {
    touchUploadSession(session);
  }
  res.json({ exists });
});
app.post("/api/prepare-export-clip", async (req, res) => {
  const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "thai-prep-"));
  try {
    const { uploadId, scenes = [] } = req.body;
    if (!uploadId) {
      res.status(404).json({ error: "Uploaded video file not found. Please re-upload." });
      return;
    }
    const outBuf = await withUploadSessionLock(
      uploadId,
      async (uploadedPath) => {
        const validScenes = (Array.isArray(scenes) ? scenes : []).map((sc) => {
          const startSec = Math.max(0, Number(sc.startSec) || 0);
          const rawEnd = Number(sc.endSec);
          const rawDur = Number(sc.durationSec);
          const durationSec = Number.isFinite(rawEnd) && rawEnd > startSec ? Math.max(0.1, rawEnd - startSec) : Math.max(0.1, Number.isFinite(rawDur) ? rawDur : 0.1);
          return { startSec, durationSec };
        }).filter(
          (sc) => Number.isFinite(sc.startSec) && Number.isFinite(sc.durationSec) && sc.durationSec > 0.05
        );
        const outClipPath = path.join(tmpDir, "prepared-clip.mp4");
        const totalClipSec = validScenes.reduce((acc, s) => acc + s.durationSec, 0);
        const useAllKeyframe = totalClipSec <= 95;
        const maxDim = useAllKeyframe ? 640 : 540;
        const gopSize = useAllKeyframe ? "1" : "2";
        const crfVal = useAllKeyframe ? "26" : "27";
        const perSceneScale = `scale=w='min(${maxDim},iw)':h='min(${maxDim},ih)':force_original_aspect_ratio=decrease:force_divisible_by=2,setsar=1,setpts=PTS-STARTPTS`;
        const prepExecOpts = { ...FFMPEG_EXEC_OPTS, timeout: 45e3 };
        if (validScenes.length <= 1) {
          const sc = validScenes[0];
          const seekArgs = sc ? ["-ss", String(sc.startSec), "-t", String(sc.durationSec)] : [];
          await execFileAsync(
            "ffmpeg",
            [
              "-y",
              ...seekArgs,
              "-i",
              uploadedPath,
              "-vf",
              `${perSceneScale},fps=24,format=yuv420p`,
              "-c:v",
              "libx264",
              "-preset",
              "ultrafast",
              "-crf",
              crfVal,
              "-g",
              gopSize,
              "-keyint_min",
              gopSize,
              "-bf",
              "0",
              "-profile:v",
              "baseline",
              "-movflags",
              "+faststart",
              "-an",
              outClipPath
            ],
            prepExecOpts
          );
        } else {
          const inputArgs = [];
          const filterParts = [];
          const concatInputs = [];
          for (let i = 0; i < validScenes.length; i++) {
            const sc = validScenes[i];
            inputArgs.push("-ss", String(sc.startSec), "-t", String(sc.durationSec), "-i", uploadedPath);
            filterParts.push(`[${i}:v]${perSceneScale}[v${i}]`);
            concatInputs.push(`[v${i}]`);
          }
          const filterComplex = `${filterParts.join(";")};${concatInputs.join("")}concat=n=${validScenes.length}:v=1:a=0,fps=24,format=yuv420p[outv]`;
          await execFileAsync(
            "ffmpeg",
            [
              "-y",
              ...inputArgs,
              "-filter_complex",
              filterComplex,
              "-map",
              "[outv]",
              "-c:v",
              "libx264",
              "-preset",
              "ultrafast",
              "-crf",
              crfVal,
              "-g",
              gopSize,
              "-keyint_min",
              gopSize,
              "-bf",
              "0",
              "-profile:v",
              "baseline",
              "-movflags",
              "+faststart",
              "-an",
              outClipPath
            ],
            prepExecOpts
          );
        }
        if (!fs.existsSync(outClipPath)) {
          return null;
        }
        const stat = fs.statSync(outClipPath);
        if (stat.size < 512 || stat.size > 26 * 1024 * 1024) {
          return null;
        }
        return fs.promises.readFile(outClipPath);
      },
      { markFinalized: true }
    );
    if (outBuf === null) {
      const sessionStillThere = Boolean(uploadSessions.get(uploadId));
      if (!sessionStillThere) {
        res.status(404).json({ error: "Uploaded video file not found. Please re-upload." });
      } else {
        res.status(413).json({ error: "Prepared clip skipped; using direct local decoding." });
      }
      return;
    }
    res.setHeader("Content-Type", "video/mp4");
    res.setHeader("Cache-Control", "no-store");
    res.send(outBuf);
  } catch (err) {
    console.error("Prepare export clip error:", err);
    res.status(500).json({
      error: err instanceof Error ? err.message : "Failed to prepare export video clip."
    });
  } finally {
    await fs.promises.rm(tmpDir, { recursive: true, force: true }).catch(() => {
    });
  }
});
function buildVoiceAudioFilters(voiceSettings) {
  const audioFilters = [];
  let hasNonCleanEffect = false;
  if (voiceSettings) {
    if (voiceSettings.vocalIsolation) {
      hasNonCleanEffect = true;
      const isoAmt = Math.max(
        0.1,
        Math.min(1, (Number(voiceSettings.vocalIsolationStrength) || 65) / 100)
      );
      const sideLevel = Math.max(0.12, 1 - isoAmt * 0.85).toFixed(2);
      const nrDb = Math.round(6 + isoAmt * 22);
      const nfDb = Math.round(-44 + isoAmt * 18);
      audioFilters.push(`stereotools=mlev=1.0:slev=${sideLevel}`);
      audioFilters.push("highpass=f=95");
      audioFilters.push(`afftdn=nr=${nrDb}:nf=${nfDb}`);
    }
    const pitchSemi = Math.max(-12, Math.min(12, Number(voiceSettings.pitchSemitones) || 0));
    const pitchFactor = Math.pow(2, pitchSemi / 12);
    const speed = Math.max(0.25, Math.min(2.5, Number(voiceSettings.speed) || 1));
    if (Math.abs(pitchFactor - 1) > 5e-3 || Math.abs(speed - 1) > 5e-3) {
      audioFilters.push(`rubberband=pitch=${pitchFactor.toFixed(4)}:tempo=${speed.toFixed(3)}`);
    }
    const tone = Math.max(-10, Math.min(10, Number(voiceSettings.tone) || 0));
    if (tone !== 0) {
      hasNonCleanEffect = true;
      const bassDb = tone < 0 ? Math.abs(tone) * 1.3 : -tone * 0.45;
      const trebleDb = tone > 0 ? tone * 1.3 : -Math.abs(tone) * 0.35;
      audioFilters.push(`bass=g=${bassDb.toFixed(2)}:f=220:t=q:w=0.707`);
      audioFilters.push(`treble=g=${trebleDb.toFixed(2)}:f=3200:t=q:w=0.707`);
    }
    const robot = Math.max(0, Math.min(100, Number(voiceSettings.robot) || 0));
    if (robot > 0) {
      hasNonCleanEffect = true;
      const r = robot / 100;
      const dryGain = (1 - r * 0.85).toFixed(4);
      const ringGain = (r * 1.15).toFixed(4);
      audioFilters.push(`aeval='val(0)*(${dryGain}+sin(2*PI*58*t)*${ringGain}):c=same'`);
    }
    const echo = Math.max(0, Math.min(100, Number(voiceSettings.echo) || 0));
    if (echo > 0) {
      hasNonCleanEffect = true;
      const e = echo / 100;
      const dMs = Math.round((0.08 + e * 0.16) * 1e3);
      const fb = 0.15 + e * 0.45;
      const wet = e * 0.65;
      const d1 = dMs;
      const d2 = dMs * 2;
      const d3 = dMs * 3;
      const d4 = dMs * 4;
      const k1 = wet;
      const k2 = k1 * fb;
      const k3 = k2 * fb;
      const k4 = k3 * fb;
      audioFilters.push(
        `aecho=1.0:1.0:${d1}|${d2}|${d3}|${d4}:${k1.toFixed(3)}|${k2.toFixed(3)}|${k3.toFixed(3)}|${k4.toFixed(3)}`
      );
    }
    if (voiceSettings.spectralPhaseShift) {
      hasNonCleanEffect = true;
      const phaseAmt = Math.max(
        0.1,
        Math.min(1, (Number(voiceSettings.spectralPhaseStrength) || 50) / 100)
      );
      const qVal = (0.6 + phaseAmt * 3.4).toFixed(2);
      const freqScale = 0.88 + phaseAmt * 0.24;
      for (const baseFreq of [260, 620, 1280, 2450, 4400, 7600]) {
        const scaledFreq = Math.round(baseFreq * freqScale);
        audioFilters.push(`allpass=f=${scaledFreq}:t=q:w=${qVal}`);
      }
    }
    if (voiceSettings.adversarialNoise) {
      hasNonCleanEffect = true;
      const advAmt = Math.max(0.05, Math.min(1, (Number(voiceSettings.adversarialStrength) || 35) / 100));
      const vibratoDepth = (0.015 + advAmt * 0.045).toFixed(3);
      const eps = (advAmt * 0.024).toFixed(5);
      audioFilters.push(`vibrato=f=13:d=${vibratoDepth}`);
      audioFilters.push(
        `aeval='val(0)+(${eps}*(0.14+min(0.86,abs(val(0))*2.1)))*(0.45*sin(2*PI*6840*t)+0.35*sin(2*PI*11230*t)+0.2*sin(2*PI*14750*t+sin(2*PI*37*t))):c=same'`
      );
    }
    if (hasNonCleanEffect) {
      audioFilters.push("alimiter=limit=0.98:attack=5:release=50");
    }
  }
  audioFilters.push("apad");
  return audioFilters;
}
app.post("/api/mux-mp4", async (req, res) => {
  const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "thai-studio-"));
  const {
    videoBase64,
    renderedVideoUploadId,
    videoFormat = "mp4",
    uploadId,
    scenes = [],
    voiceSettings,
    targetDurationSec,
    forceCfrFromFrames,
    recordedDurationSec
  } = req.body || {};
  try {
    const inputVideoPath = path.join(tmpDir, `input.${videoFormat === "webm" ? "webm" : "mp4"}`);
    const outputMp4Path = path.join(tmpDir, "output.mp4");
    let hasInputVideo = false;
    if (renderedVideoUploadId) {
      const copied = await withUploadSessionLock(renderedVideoUploadId, async (renderedPath) => {
        await fs.promises.copyFile(renderedPath, inputVideoPath);
        return true;
      });
      hasInputVideo = Boolean(copied);
    }
    if (!hasInputVideo && videoBase64) {
      await fs.promises.writeFile(inputVideoPath, Buffer.from(videoBase64, "base64"));
      hasInputVideo = true;
    }
    if (!hasInputVideo || !fs.existsSync(inputVideoPath) || fs.statSync(inputVideoPath).size < 256) {
      res.status(400).json({ error: "Missing rendered video payload." });
      return;
    }
    const canStreamCopyVideo = videoFormat === "mp4" && !forceCfrFromFrames && recordedDurationSec === void 0;
    const videoFilterParts = [];
    const safeTargetDur = Number(targetDurationSec);
    if (forceCfrFromFrames) {
      videoFilterParts.push("setpts=N/(24*TB)");
    } else if (Number.isFinite(safeTargetDur) && safeTargetDur > 0.2 && recordedDurationSec !== void 0) {
      const renderedProbe = await probeMediaInfo(inputVideoPath);
      const actualDur = renderedProbe.durationSec > 0.2 ? renderedProbe.durationSec : Number(recordedDurationSec);
      if (Number.isFinite(actualDur) && actualDur > 0.2) {
        const ptsScale = safeTargetDur / actualDur;
        if (Math.abs(ptsScale - 1) > 0.02 && ptsScale > 0.1 && ptsScale < 10) {
          videoFilterParts.push(`setpts=PTS*${ptsScale.toFixed(6)}`);
        }
      }
    }
    videoFilterParts.push("fps=24", "setsar=1");
    const videoReencodeArgs = [
      "-vf",
      videoFilterParts.join(","),
      "-c:v",
      "libx264",
      "-preset",
      "superfast",
      "-crf",
      "21",
      "-pix_fmt",
      "yuv420p",
      "-profile:v",
      "main",
      "-level",
      "4.0",
      "-r",
      "24",
      "-vsync",
      "cfr"
    ];
    const videoCopyArgs = ["-c:v", "copy"];
    const runVideoOnlyMux = async () => {
      if (canStreamCopyVideo) {
        try {
          await execFileAsync(
            "ffmpeg",
            [
              "-y",
              "-i",
              inputVideoPath,
              ...videoCopyArgs,
              "-movflags",
              "+faststart",
              "-an",
              outputMp4Path
            ],
            FFMPEG_EXEC_OPTS
          );
          if (fs.existsSync(outputMp4Path) && fs.statSync(outputMp4Path).size > 512) {
            return;
          }
        } catch {
        }
      }
      await execFileAsync(
        "ffmpeg",
        [
          "-y",
          "-i",
          inputVideoPath,
          ...videoReencodeArgs,
          "-movflags",
          "+faststart",
          "-an",
          outputMp4Path
        ],
        FFMPEG_EXEC_OPTS
      );
    };
    const normalizedScenes = (Array.isArray(scenes) ? scenes : []).map((sc) => {
      const startSec = Math.max(0, Number(sc.startSec) || 0);
      const rawEnd = Number(sc.endSec);
      const rawDur = Number(sc.durationSec);
      const durationSec = Number.isFinite(rawEnd) && rawEnd > startSec ? Math.max(0.1, rawEnd - startSec) : Math.max(0.1, Number.isFinite(rawDur) ? rawDur : 0.1);
      return { startSec, durationSec };
    }).filter((sc) => Number.isFinite(sc.startSec) && Number.isFinite(sc.durationSec));
    let muxedWithAudio = false;
    if (uploadId && normalizedScenes.length > 0) {
      await withUploadSessionLock(
        uploadId,
        async (uploadedPath) => {
          const sourceProbe = await probeMediaInfo(uploadedPath);
          if (!sourceProbe.hasAudio) {
            return;
          }
          const segResults = new Array(normalizedScenes.length).fill(null);
          const extractOne = async (i) => {
            const sc = normalizedScenes[i];
            const segOut = path.join(tmpDir, `seg-${i}.wav`);
            let extracted = false;
            try {
              await execFileAsync(
                "ffmpeg",
                [
                  "-y",
                  "-vn",
                  "-ss",
                  String(sc.startSec),
                  "-t",
                  String(sc.durationSec),
                  "-i",
                  uploadedPath,
                  "-af",
                  `aresample=44100:async=1,apad,atrim=0:${sc.durationSec.toFixed(4)}`,
                  "-ac",
                  "2",
                  "-ar",
                  "44100",
                  segOut
                ],
                FFMPEG_EXEC_OPTS
              );
              extracted = fs.existsSync(segOut) && fs.statSync(segOut).size > 44;
            } catch {
              extracted = false;
            }
            if (!extracted) {
              try {
                await execFileAsync(
                  "ffmpeg",
                  [
                    "-y",
                    "-f",
                    "lavfi",
                    "-i",
                    "anullsrc=r=44100:cl=stereo",
                    "-t",
                    sc.durationSec.toFixed(4),
                    "-ac",
                    "2",
                    "-ar",
                    "44100",
                    segOut
                  ],
                  FFMPEG_EXEC_OPTS
                );
                extracted = fs.existsSync(segOut) && fs.statSync(segOut).size > 44;
              } catch {
                extracted = false;
              }
            }
            if (extracted) {
              segResults[i] = segOut;
            }
          };
          for (let batchStart = 0; batchStart < normalizedScenes.length; batchStart += 4) {
            const batch = [];
            for (let idx = batchStart; idx < Math.min(normalizedScenes.length, batchStart + 4); idx++) {
              batch.push(extractOne(idx));
            }
            await Promise.all(batch);
          }
          const segFiles = segResults.filter((s) => Boolean(s));
          if (segFiles.length === 0) {
            return;
          }
          let origWavPath = segFiles[0];
          if (segFiles.length > 1) {
            origWavPath = path.join(tmpDir, "original-cuts.wav");
            const concatInputArgs = [];
            const concatLabels = [];
            for (let i = 0; i < segFiles.length; i++) {
              concatInputArgs.push("-i", segFiles[i]);
              concatLabels.push(`[${i}:a]`);
            }
            await execFileAsync(
              "ffmpeg",
              [
                "-y",
                ...concatInputArgs,
                "-filter_complex",
                `${concatLabels.join("")}concat=n=${segFiles.length}:v=0:a=1[outa]`,
                "-map",
                "[outa]",
                "-ac",
                "2",
                "-ar",
                "44100",
                origWavPath
              ],
              FFMPEG_EXEC_OPTS
            );
          }
          const audioFilters = buildVoiceAudioFilters(voiceSettings);
          const buildMuxWithAudioArgs = (vArgs) => [
            "-y",
            "-i",
            inputVideoPath,
            "-i",
            origWavPath,
            "-map",
            "0:v:0",
            "-map",
            "1:a:0",
            ...vArgs,
            "-af",
            audioFilters.join(","),
            "-c:a",
            "aac",
            "-b:a",
            "192k",
            "-ar",
            "44100",
            "-ac",
            "2",
            "-movflags",
            "+faststart",
            "-shortest",
            outputMp4Path
          ];
          if (canStreamCopyVideo) {
            try {
              await execFileAsync("ffmpeg", buildMuxWithAudioArgs(videoCopyArgs), FFMPEG_EXEC_OPTS);
              if (fs.existsSync(outputMp4Path) && fs.statSync(outputMp4Path).size > 512) {
                muxedWithAudio = true;
                return;
              }
            } catch {
            }
          }
          await execFileAsync("ffmpeg", buildMuxWithAudioArgs(videoReencodeArgs), FFMPEG_EXEC_OPTS);
          muxedWithAudio = true;
        },
        { markFinalized: true }
      );
    }
    if (!muxedWithAudio) {
      await runVideoOnlyMux();
    }
    const wantDownloadUrl = Boolean(req.body?.returnDownloadUrl);
    const requestedFileName = req.body?.fileName;
    if (wantDownloadUrl) {
      const entry = await registerCompletedExport(outputMp4Path, requestedFileName);
      res.json({
        exportId: entry.id,
        downloadUrl: `/api/download-export/${encodeURIComponent(entry.id)}`,
        fileName: entry.fileName,
        sizeBytes: entry.sizeBytes
      });
      return;
    }
    const outBuffer = await fs.promises.readFile(outputMp4Path);
    res.setHeader("Content-Type", "video/mp4");
    res.setHeader("Content-Disposition", `attachment; filename="${sanitizeExportFileName(requestedFileName)}"`);
    res.send(outBuffer);
  } catch (err) {
    console.error("Mux MP4 error:", err);
    res.status(500).json({
      error: err instanceof Error ? err.message : "Failed to encode 9:16 MP4."
    });
  } finally {
    if (renderedVideoUploadId) {
      await deleteUploadSession(renderedVideoUploadId);
    }
    await fs.promises.rm(tmpDir, { recursive: true, force: true }).catch(() => {
    });
  }
});
function buildTopVideoFfmpegFilter(editSettings, width, topVideoH) {
  const fitMode = editSettings?.fitMode === "contain" ? "contain" : "cover";
  const zoom = Math.max(0.5, Math.min(3, Number(editSettings?.zoom) || 1));
  const panXRatio = Math.max(-0.5, Math.min(0.5, (Number(editSettings?.panX) || 0) / 100));
  const panYRatio = Math.max(-0.5, Math.min(0.5, (Number(editSettings?.panY) || 0) / 100));
  const rotateDeg = Number(editSettings?.rotateDeg) || 0;
  const flipH = Boolean(editSettings?.flipH);
  const flipV = Boolean(editSettings?.flipV);
  const targetW = Math.max(2, Math.round(width * zoom / 2) * 2);
  const targetH = Math.max(2, Math.round(topVideoH * zoom / 2) * 2);
  const ratioFlag = fitMode === "contain" ? "decrease" : "increase";
  const parts = [
    `scale=w=${targetW}:h=${targetH}:force_original_aspect_ratio=${ratioFlag}:force_divisible_by=2`,
    "setsar=1"
  ];
  const brightnessPct = editSettings?.brightness ?? 100;
  const contrastPct = editSettings?.contrast ?? 100;
  const satPct = editSettings?.saturation ?? 100;
  const hueDeg = editSettings?.hueDeg ?? 0;
  const grayscalePct = editSettings?.grayscale ?? 0;
  const sepiaPct = editSettings?.sepia ?? 0;
  const blurPx = editSettings?.blurPx ?? 0;
  const vignettePct = editSettings?.vignette ?? 0;
  if (Math.abs(brightnessPct - 100) >= 1 || Math.abs(contrastPct - 100) >= 1) {
    const b = Math.max(0.1, Math.min(3, brightnessPct / 100)).toFixed(3);
    const c = Math.max(0.2, Math.min(3, contrastPct / 100)).toFixed(3);
    const expr = `clip((clip(val*${b},0,255)-127.5)*${c}+127.5,0,255)`;
    parts.push(`format=rgb24,lutrgb=r='${expr}':g='${expr}':b='${expr}',format=yuv420p`);
  }
  if (Math.abs(satPct - 100) >= 1) {
    const sat = Math.max(0, Math.min(3, satPct / 100));
    parts.push(`eq=saturation=${sat.toFixed(3)}`);
  }
  if (Math.abs(hueDeg) >= 1) {
    parts.push(`hue=h=${hueDeg.toFixed(1)}`);
  }
  if (sepiaPct >= 1) {
    const s = Math.max(0, Math.min(1, sepiaPct / 100));
    const rr = (1 - s + 0.393 * s).toFixed(3);
    const rg = (0.769 * s).toFixed(3);
    const rb = (0.189 * s).toFixed(3);
    const gr = (0.349 * s).toFixed(3);
    const gg = (1 - s + 0.686 * s).toFixed(3);
    const gb = (0.168 * s).toFixed(3);
    const br = (0.272 * s).toFixed(3);
    const bg = (0.534 * s).toFixed(3);
    const bb = (1 - s + 0.131 * s).toFixed(3);
    parts.push(
      `format=rgb24,colorchannelmixer=${rr}:${rg}:${rb}:0:${gr}:${gg}:${gb}:0:${br}:${bg}:${bb}:0,format=yuv420p`
    );
  }
  if (grayscalePct >= 1) {
    const graySat = Math.max(0, Math.min(1, 1 - grayscalePct / 100));
    parts.push(`hue=s=${graySat.toFixed(3)}`);
  }
  if (blurPx >= 0.4) {
    parts.push(`gblur=sigma=${Math.min(8, blurPx).toFixed(2)}`);
  }
  if (Math.abs(rotateDeg) >= 0.5) {
    const rad = (rotateDeg * Math.PI / 180).toFixed(5);
    parts.push(`rotate=${rad}:ow='rotw(${rad})':oh='roth(${rad})':fillcolor=0x111111`);
  }
  if (flipH) parts.push("hflip");
  if (flipV) parts.push("vflip");
  const shiftX = Math.round(panXRatio * width);
  const shiftY = Math.round(panYRatio * topVideoH);
  const padMarginX = 2 * Math.abs(shiftX);
  const padMarginY = 2 * Math.abs(shiftY);
  parts.push(
    `pad=w='max(iw,${width})+${padMarginX}':h='max(ih,${topVideoH})+${padMarginY}':x='(ow-iw)/2':y='(oh-ih)/2':color=0x111111`
  );
  parts.push(
    `crop=w=${width}:h=${topVideoH}:x='(iw-${width})/2-(${shiftX})':y='(ih-${topVideoH})/2-(${shiftY})'`
  );
  if (editSettings?.adversarialNoise) {
    const strength = Math.max(2, Math.min(12, Math.round((Number(editSettings.adversarialStrength) || 12) / 3)));
    parts.push(`noise=alls=${strength}:allf=t+u`);
  }
  if (vignettePct >= 1) {
    const alpha = Math.max(0, Math.min(0.85, vignettePct / 100 * 0.85));
    const transmission = Math.max(0.08, 1 - alpha);
    const angle = Math.max(0.08, Math.min(1.15, Math.acos(Math.pow(transmission, 0.25)))).toFixed(3);
    parts.push(`vignette=angle=${angle}`);
  }
  parts.push("setpts=PTS-STARTPTS");
  return parts.join(",");
}
app.post("/api/export-fast-mp4", async (req, res) => {
  const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "thai-studio-"));
  const ffmpegAbort = new AbortController();
  const onClientClose = () => {
    if (!res.writableEnded) {
      ffmpegAbort.abort();
    }
  };
  res.on("close", onClientClose);
  const {
    uploadId,
    scenes = [],
    voiceSettings,
    editSettings,
    width = 720,
    height = 1280,
    topVideoH: rawTopVideoH,
    subtitleBase64,
    subtitleUploadId,
    subtitleFormat = "mp4",
    subtitleFps = 15,
    subtitleForceCfr = false,
    subtitleRecordedDurationSec,
    targetDurationSec,
    fileName
  } = req.body || {};
  try {
    if (!uploadId) {
      res.status(404).json({ error: "Uploaded video file not found. Please re-upload." });
      return;
    }
    const outW = Math.max(360, Math.min(1080, Math.round((Number(width) || 720) / 2) * 2));
    const outH = Math.max(640, Math.min(1920, Math.round((Number(height) || 1280) / 2) * 2));
    let subtitlePath = null;
    if (subtitleUploadId) {
      const candidateSub = path.join(tmpDir, `sub.${subtitleFormat === "webm" ? "webm" : "mp4"}`);
      const copied = await withUploadSessionLock(subtitleUploadId, async (p) => {
        await fs.promises.copyFile(p, candidateSub);
        return true;
      });
      if (copied && fs.existsSync(candidateSub) && fs.statSync(candidateSub).size > 256) {
        subtitlePath = candidateSub;
      }
    } else if (subtitleBase64) {
      const candidateSub = path.join(tmpDir, `sub.${subtitleFormat === "webm" ? "webm" : "mp4"}`);
      await fs.promises.writeFile(candidateSub, Buffer.from(subtitleBase64, "base64"));
      if (fs.existsSync(candidateSub) && fs.statSync(candidateSub).size > 256) {
        subtitlePath = candidateSub;
      }
    }
    const hasSubStrip = Boolean(subtitlePath);
    const topVideoH = hasSubStrip ? Math.max(240, Math.min(outH - 240, Math.round((Number(rawTopVideoH) || Math.round(outH * 0.35)) / 2) * 2)) : outH;
    const listH = outH - topVideoH;
    const speed = Math.max(0.5, Math.min(2.5, Number(voiceSettings?.speed) || 1));
    const outputMp4Path = path.join(tmpDir, "output.mp4");
    const execOpts = { ...FFMPEG_EXEC_OPTS, signal: ffmpegAbort.signal, timeout: 11e4 };
    const normalizedScenes = (Array.isArray(scenes) ? scenes : []).map((sc) => {
      const startSec = Math.max(0, Number(sc.startSec) || 0);
      const rawEnd = Number(sc.endSec);
      const rawDur = Number(sc.durationSec);
      const durationSec = Number.isFinite(rawEnd) && rawEnd > startSec ? Math.max(0.1, rawEnd - startSec) : Math.max(0.1, Number.isFinite(rawDur) ? rawDur : 0.1);
      return { startSec, durationSec };
    }).filter((sc) => Number.isFinite(sc.startSec) && Number.isFinite(sc.durationSec));
    const entry = await withUploadSessionLock(
      uploadId,
      async (uploadedPath) => {
        const sourceProbe = await probeMediaInfo(uploadedPath);
        const topFilter = buildTopVideoFfmpegFilter(editSettings, outW, topVideoH);
        const ffmpegInputs = [];
        const filterChains = [];
        const sceneCount = Math.max(1, normalizedScenes.length);
        if (normalizedScenes.length === 0) {
          ffmpegInputs.push("-i", uploadedPath);
          const speedExpr = Math.abs(speed - 1) > 0.01 ? `,setpts=PTS/${speed.toFixed(4)}` : "";
          filterChains.push(`[0:v]fps=24,${topFilter}${speedExpr},fps=24,format=yuv420p[topv]`);
        } else if (normalizedScenes.length === 1) {
          const sc = normalizedScenes[0];
          ffmpegInputs.push(
            "-ss",
            String(sc.startSec),
            "-t",
            (sc.durationSec + 0.15).toFixed(4),
            "-i",
            uploadedPath
          );
          const speedExpr = Math.abs(speed - 1) > 0.01 ? `,setpts=PTS/${speed.toFixed(4)}` : "";
          filterChains.push(
            `[0:v]fps=24,${topFilter},tpad=stop_mode=clone:stop_duration=0.25,trim=duration=${sc.durationSec.toFixed(4)},setpts=PTS-STARTPTS${speedExpr},fps=24,format=yuv420p[topv]`
          );
        } else {
          const concatLabels = [];
          for (let i = 0; i < normalizedScenes.length; i++) {
            const sc = normalizedScenes[i];
            ffmpegInputs.push(
              "-ss",
              String(sc.startSec),
              "-t",
              (sc.durationSec + 0.15).toFixed(4),
              "-i",
              uploadedPath
            );
            filterChains.push(
              `[${i}:v]fps=24,${topFilter},tpad=stop_mode=clone:stop_duration=0.25,trim=duration=${sc.durationSec.toFixed(4)},setpts=PTS-STARTPTS[v${i}]`
            );
            concatLabels.push(`[v${i}]`);
          }
          const speedExpr = Math.abs(speed - 1) > 0.01 ? `,setpts=PTS/${speed.toFixed(4)}` : "";
          filterChains.push(
            `${concatLabels.join("")}concat=n=${normalizedScenes.length}:v=1:a=0${speedExpr},fps=24,format=yuv420p[topv]`
          );
        }
        let nextInputIdx = sceneCount;
        let finalVideoLabel = "[topv]";
        if (hasSubStrip && subtitlePath) {
          const subIdx = nextInputIdx++;
          ffmpegInputs.push("-i", subtitlePath);
          const subParts = [];
          const safeTargetDur = Number(targetDurationSec);
          const safeSubFps = Math.max(8, Math.min(30, Number(subtitleFps) || 15));
          if (subtitleForceCfr) {
            subParts.push(`setpts=N/(${safeSubFps}*TB)`);
          } else if (Number.isFinite(safeTargetDur) && safeTargetDur > 0.2 && subtitleRecordedDurationSec !== void 0) {
            const subProbe = await probeMediaInfo(subtitlePath);
            const actualDur = subProbe.durationSec > 0.2 ? subProbe.durationSec : Number(subtitleRecordedDurationSec);
            if (Number.isFinite(actualDur) && actualDur > 0.2) {
              const ptsScale = safeTargetDur / actualDur;
              if (Math.abs(ptsScale - 1) > 0.02 && ptsScale > 0.1 && ptsScale < 10) {
                subParts.push(`setpts=PTS*${ptsScale.toFixed(6)}`);
              }
            }
          }
          subParts.push(`scale=${outW}:${listH}`, "setsar=1", "fps=24", "format=yuv420p");
          filterChains.push(`[${subIdx}:v]${subParts.join(",")}[subv]`);
          filterChains.push(`[topv][subv]vstack=inputs=2:shortest=1[outv]`);
          finalVideoLabel = "[outv]";
        }
        let origWavPath = null;
        if (sourceProbe.hasAudio && normalizedScenes.length > 0) {
          const segResults = new Array(normalizedScenes.length).fill(null);
          const extractOne = async (i) => {
            const sc = normalizedScenes[i];
            const segOut = path.join(tmpDir, `seg-${i}.wav`);
            let extracted = false;
            try {
              await execFileAsync(
                "ffmpeg",
                [
                  "-y",
                  "-vn",
                  "-ss",
                  String(sc.startSec),
                  "-t",
                  String(sc.durationSec),
                  "-i",
                  uploadedPath,
                  "-af",
                  `aresample=44100:async=1,apad,atrim=0:${sc.durationSec.toFixed(4)}`,
                  "-ac",
                  "2",
                  "-ar",
                  "44100",
                  segOut
                ],
                execOpts
              );
              extracted = fs.existsSync(segOut) && fs.statSync(segOut).size > 44;
            } catch {
              extracted = false;
            }
            if (!extracted && !ffmpegAbort.signal.aborted) {
              try {
                await execFileAsync(
                  "ffmpeg",
                  [
                    "-y",
                    "-f",
                    "lavfi",
                    "-i",
                    "anullsrc=r=44100:cl=stereo",
                    "-t",
                    sc.durationSec.toFixed(4),
                    "-ac",
                    "2",
                    "-ar",
                    "44100",
                    segOut
                  ],
                  execOpts
                );
                extracted = fs.existsSync(segOut) && fs.statSync(segOut).size > 44;
              } catch {
                extracted = false;
              }
            }
            if (extracted) segResults[i] = segOut;
          };
          for (let batchStart = 0; batchStart < normalizedScenes.length; batchStart += 4) {
            if (ffmpegAbort.signal.aborted) break;
            const batch = [];
            for (let idx = batchStart; idx < Math.min(normalizedScenes.length, batchStart + 4); idx++) {
              batch.push(extractOne(idx));
            }
            await Promise.all(batch);
          }
          const segFiles = segResults.filter((s) => Boolean(s));
          if (segFiles.length === 1) {
            origWavPath = segFiles[0];
          } else if (segFiles.length > 1) {
            const mergedWav = path.join(tmpDir, "original-cuts.wav");
            const concatInputArgs = [];
            const concatLabels = [];
            for (let i = 0; i < segFiles.length; i++) {
              concatInputArgs.push("-i", segFiles[i]);
              concatLabels.push(`[${i}:a]`);
            }
            await execFileAsync(
              "ffmpeg",
              [
                "-y",
                ...concatInputArgs,
                "-filter_complex",
                `${concatLabels.join("")}concat=n=${segFiles.length}:v=0:a=1[outa]`,
                "-map",
                "[outa]",
                "-ac",
                "2",
                "-ar",
                "44100",
                mergedWav
              ],
              execOpts
            );
            origWavPath = mergedWav;
          }
        }
        const audioArgs = [];
        if (origWavPath) {
          const audioIdx = nextInputIdx++;
          ffmpegInputs.push("-i", origWavPath);
          const audioFilters = buildVoiceAudioFilters(voiceSettings);
          audioArgs.push(
            "-map",
            `${audioIdx}:a:0`,
            "-af",
            audioFilters.join(","),
            "-c:a",
            "aac",
            "-b:a",
            "128k",
            "-ar",
            "44100",
            "-ac",
            "2",
            "-shortest"
          );
        } else {
          audioArgs.push("-an");
        }
        await execFileAsync(
          "ffmpeg",
          [
            "-y",
            ...ffmpegInputs,
            "-filter_complex",
            filterChains.join(";"),
            "-map",
            finalVideoLabel,
            ...audioArgs,
            "-c:v",
            "libx264",
            "-preset",
            "superfast",
            "-crf",
            "25",
            "-maxrate",
            "1800k",
            "-bufsize",
            "3600k",
            "-pix_fmt",
            "yuv420p",
            "-profile:v",
            "main",
            "-level",
            "4.0",
            "-r",
            "24",
            "-vsync",
            "cfr",
            "-movflags",
            "+faststart",
            outputMp4Path
          ],
          execOpts
        );
        if (!fs.existsSync(outputMp4Path) || fs.statSync(outputMp4Path).size < 512) {
          return null;
        }
        return registerCompletedExport(outputMp4Path, fileName);
      },
      { markFinalized: true }
    );
    if (ffmpegAbort.signal.aborted) {
      return;
    }
    if (!entry) {
      res.status(404).json({ error: "Uploaded video file not found or export failed." });
      return;
    }
    res.json({
      exportId: entry.id,
      downloadUrl: `/api/download-export/${encodeURIComponent(entry.id)}`,
      fileName: entry.fileName,
      sizeBytes: entry.sizeBytes
    });
  } catch (err) {
    if (ffmpegAbort.signal.aborted) {
      return;
    }
    console.error("Fast export MP4 error:", err);
    res.status(500).json({
      error: err instanceof Error ? err.message : "Failed to export 9:16 MP4."
    });
  } finally {
    res.off("close", onClientClose);
    if (subtitleUploadId) {
      await deleteUploadSession(subtitleUploadId);
    }
    await fs.promises.rm(tmpDir, { recursive: true, force: true }).catch(() => {
    });
  }
});
app.get("/api/download-export/:exportId", (req, res) => {
  const exportId = String(req.params.exportId || "");
  if (!/^[a-zA-Z0-9_-]{8,64}$/.test(exportId)) {
    res.status(400).json({ error: "Invalid export ID." });
    return;
  }
  const entry = completedExports.get(exportId);
  if (!entry || !fs.existsSync(entry.filePath)) {
    completedExports.delete(exportId);
    res.status(404).json({ error: "Exported video expired or not found. Please export again." });
    return;
  }
  entry.createdAt = Date.now();
  const totalSize = entry.sizeBytes;
  const rangeHeader = typeof req.headers.range === "string" ? req.headers.range.trim() : "";
  res.setHeader("Accept-Ranges", "bytes");
  res.setHeader("Content-Type", "video/mp4");
  res.setHeader("Content-Disposition", `attachment; filename="${entry.fileName}"`);
  res.setHeader("Cache-Control", "no-store");
  if (rangeHeader) {
    const match = /^bytes=(\d*)-(\d*)$/i.exec(rangeHeader);
    if (!match) {
      res.status(416).setHeader("Content-Range", `bytes */${totalSize}`).end();
      return;
    }
    const start = match[1] ? Number(match[1]) : 0;
    const requestedEnd = match[2] ? Number(match[2]) : totalSize - 1;
    if (!Number.isFinite(start) || !Number.isFinite(requestedEnd) || start < 0 || start >= totalSize || requestedEnd < start) {
      res.status(416).setHeader("Content-Range", `bytes */${totalSize}`).end();
      return;
    }
    const end = Math.min(totalSize - 1, requestedEnd);
    const chunkLength = end - start + 1;
    res.status(206);
    res.setHeader("Content-Range", `bytes ${start}-${end}/${totalSize}`);
    res.setHeader("Content-Length", String(chunkLength));
    const stream2 = fs.createReadStream(entry.filePath, { start, end });
    stream2.on("error", () => {
      if (!res.headersSent) {
        res.status(500).json({ error: "Failed to stream exported video chunk." });
      } else {
        res.end();
      }
    });
    stream2.pipe(res);
    return;
  }
  res.setHeader("Content-Length", String(totalSize));
  const stream = fs.createReadStream(entry.filePath);
  stream.on("error", () => {
    if (!res.headersSent) {
      res.status(500).json({ error: "Failed to stream exported video." });
    } else {
      res.end();
    }
  });
  stream.pipe(res);
});
app.use("/api", (_req, res) => {
  res.status(404).json({ error: "API endpoint not found." });
});
app.use(
  (err, req, res, next) => {
    if (req.path.startsWith("/api/")) {
      const status = typeof err?.status === "number" ? err.status : 500;
      const message = err instanceof Error ? err.message : "Unexpected server error.";
      res.status(status).json({ error: message });
      return;
    }
    next(err);
  }
);
async function startServer() {
  await sweepOrphanedTempFiles();
  setInterval(() => {
    sweepExpiredUploadSessions().catch(() => {
    });
  }, UPLOAD_SWEEP_INTERVAL_MS).unref();
  if (process.env.NODE_ENV !== "production") {
    const { createServer: createViteServer } = await import("vite");
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa"
    });
    app.use(vite.middlewares);
  } else {
    app.use(express.static(path.resolve("dist")));
    app.get("*", (_req, res) => {
      res.sendFile(path.resolve("dist", "index.html"));
    });
  }
  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}
startServer();
