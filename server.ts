import "dotenv/config";
import express from "express";
import fs from "fs";
import path from "path";
import os from "os";
import crypto from "crypto";
import { execFile } from "child_process";
import { promisify } from "util";
import { GoogleGenAI, Type, ThinkingLevel } from "@google/genai";
import type {
  SpeakingScene,
  SubtitleItem,
  TranslationTone,
  VoiceSettings,
  YouTubeLicenseFilter,
  YouTubeVideo,
} from "./src/types.ts";

const execFileAsync = promisify(execFile);
const FFMPEG_EXEC_OPTS = { maxBuffer: 16 * 1024 * 1024 };

const app = express();
const PORT = 3000;

app.use(express.json({ limit: "100mb" }));

// Temporary store for uploaded local videos with TTL expiration, size validation, and active-operation locking
const MAX_UPLOAD_BYTES = 500 * 1024 * 1024;
const INCOMPLETE_UPLOAD_TTL_MS = 20 * 60 * 1000;
const COMPLETED_UPLOAD_TTL_MS = 2 * 60 * 60 * 1000;
const UPLOAD_SWEEP_INTERVAL_MS = 5 * 60 * 1000;

interface UploadSession {
  id: string;
  filePath: string;
  createdAt: number;
  lastAccessedAt: number;
  expectedSize?: number;
  receivedBytes: number;
  finalized: boolean;
  activeLocks: number;
  pendingDelete: boolean;
  writeChain: Promise<void>;
}

const uploadSessions = new Map<string, UploadSession>();

function registerUploadSession(
  uploadId: string,
  filePath: string,
  opts: { expectedSize?: number; receivedBytes?: number; finalized?: boolean } = {}
): UploadSession {
  const now = Date.now();
  const session: UploadSession = {
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
  };
  uploadSessions.set(uploadId, session);
  return session;
}

function touchUploadSession(session: UploadSession, markFinalized = false): void {
  session.lastAccessedAt = Date.now();
  if (markFinalized) {
    session.finalized = true;
  }
}

async function deleteUploadSessionNow(session: UploadSession): Promise<void> {
  if (uploadSessions.get(session.id) === session) {
    uploadSessions.delete(session.id);
  }
  await fs.promises.rm(session.filePath, { force: true }).catch(() => {});
}

async function deleteUploadSession(uploadId: string): Promise<boolean> {
  const session = uploadSessions.get(uploadId);
  if (!session) return false;
  if (session.activeLocks > 0) {
    session.pendingDelete = true;
    return true;
  }
  await deleteUploadSessionNow(session);
  return true;
}

async function withUploadSessionLock<T>(
  uploadId: string,
  fn: (filePath: string, session: UploadSession) => Promise<T>,
  opts: { markFinalized?: boolean } = {}
): Promise<T | null> {
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

async function sweepExpiredUploadSessions(): Promise<void> {
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
}

async function sweepOrphanedTempFiles(): Promise<void> {
  try {
    const tmpRoot = os.tmpdir();
    const activePaths = new Set(Array.from(uploadSessions.values()).map((s) => s.filePath));
    const names = await fs.promises.readdir(tmpRoot);
    const now = Date.now();
    for (const name of names) {
      if (
        !name.startsWith("thai-studio-upload-") &&
        !name.startsWith("upload-vid-") &&
        !name.startsWith("thai-prep-") &&
        !name.startsWith("thai-studio-")
      ) {
        continue;
      }
      const fullPath = path.join(tmpRoot, name);
      if (activePaths.has(fullPath)) continue;
      try {
        const st = await fs.promises.stat(fullPath);
        if (now - st.mtimeMs > COMPLETED_UPLOAD_TTL_MS) {
          await fs.promises.rm(fullPath, { recursive: true, force: true }).catch(() => {});
        }
      } catch {
        // ignore stat/rm race
      }
    }
  } catch {
    // ignore readdir failure
  }
}

async function probeMediaInfo(
  mediaPath: string
): Promise<{ hasAudio: boolean; hasVideo: boolean; durationSec: number }> {
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
        mediaPath,
      ],
      FFMPEG_EXEC_OPTS
    );
    const parsed = JSON.parse(stdout || "{}") as {
      streams?: { codec_type?: string; duration?: string }[];
      format?: { duration?: string };
    };
    const streams = Array.isArray(parsed.streams) ? parsed.streams : [];
    const hasAudio = streams.some((s) => s.codec_type === "audio");
    const hasVideo = streams.some((s) => s.codec_type === "video");
    const rawFmtDur = Number(parsed.format?.duration);
    const videoStream = streams.find((s) => s.codec_type === "video");
    const rawStreamDur = Number(videoStream?.duration);
    const durationSec =
      Number.isFinite(rawFmtDur) && rawFmtDur > 0
        ? rawFmtDur
        : Number.isFinite(rawStreamDur) && rawStreamDur > 0
          ? rawStreamDur
          : 0;
    return { hasAudio, hasVideo, durationSec };
  } catch {
    return { hasAudio: false, hasVideo: true, durationSec: 0 };
  }
}

function getGeminiClient(): GoogleGenAI {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error("GEMINI_API_KEY is not configured in environment secrets.");
  }
  return new GoogleGenAI({
    apiKey,
    httpOptions: {
      headers: {
        "User-Agent": "aistudio-build",
      },
    },
  });
}

async function withRetry<T>(fn: () => Promise<T>, maxAttempts = 2): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      const msg = err instanceof Error ? err.message : String(err);
      const isTransient = /503|UNAVAILABLE|high demand|overloaded/i.test(msg);
      if (!isTransient || attempt === maxAttempts - 1) {
        throw err;
      }
      await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
    }
  }
  throw lastErr;
}

async function generateGroundedWithFailover(
  ai: GoogleGenAI,
  contents: Parameters<GoogleGenAI["models"]["generateContent"]>[0]["contents"],
  schema: Record<string, unknown>,
  thinkingLevel: ThinkingLevel = ThinkingLevel.MEDIUM
) {
  try {
    return await withRetry(() =>
      ai.models.generateContent({
        model: "gemini-4-hydrogen",
        contents,
        config: {
          thinkingConfig: { thinkingLevel },
          responseMimeType: "application/json",
          responseSchema: schema,
        },
      })
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const shouldFailover = /429|503|RESOURCE_EXHAUSTED|UNAVAILABLE|quota|overloaded/i.test(msg);
    if (!shouldFailover) throw err;
    console.warn("Primary model unavailable/quota-limited, failing over to gemini-3.1-flash-lite");
    return await withRetry(() =>
      ai.models.generateContent({
        model: "gemini-3.1-flash-lite",
        contents,
        config: {
          responseMimeType: "application/json",
          responseSchema: schema,
        },
      })
    );
  }
}

function parseDurationToSeconds(text: string): number {
  if (!text) return 0;
  const parts = text.trim().split(":").map((n) => parseInt(n, 10));
  if (parts.some((n) => Number.isNaN(n))) return 0;
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  if (parts.length === 1) return parts[0];
  return 0;
}

function extractYouTubeVideoId(input: string): string | null {
  const trimmed = input.trim();
  const patterns = [
    /(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/shorts\/|youtube\.com\/embed\/)([a-zA-Z0-9_-]{11})/,
    /^([a-zA-Z0-9_-]{11})$/,
  ];
  for (const p of patterns) {
    const m = trimmed.match(p);
    if (m?.[1]) return m[1];
  }
  return null;
}

function readRunsText(obj: unknown): string {
  if (!obj || typeof obj !== "object") return "";
  const rec = obj as { simpleText?: string; runs?: { text?: string }[] };
  if (rec.simpleText) return rec.simpleText;
  if (Array.isArray(rec.runs)) {
    return rec.runs.map((r) => r.text ?? "").join("");
  }
  return "";
}

const YT_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
  "Accept-Language": "en-US,en;q=0.9",
};

let cachedInnerTube: { apiKey: string; clientVersion: string; fetchedAt: number } | null = null;

async function getInnerTubeConfig(forceRefresh = false): Promise<{
  apiKey: string;
  clientVersion: string;
}> {
  if (
    !forceRefresh &&
    cachedInnerTube &&
    Date.now() - cachedInnerTube.fetchedAt < 30 * 60 * 1000
  ) {
    return {
      apiKey: cachedInnerTube.apiKey,
      clientVersion: cachedInnerTube.clientVersion,
    };
  }
  const resp = await fetch("https://www.youtube.com/", { headers: YT_HEADERS });
  if (!resp.ok) {
    throw new Error(`YouTube returned HTTP ${resp.status}`);
  }
  const html = await resp.text();
  const apiKey = html.match(/"INNERTUBE_API_KEY":"([^"]+)"/)?.[1];
  const clientVersion =
    html.match(/"INNERTUBE_CLIENT_VERSION":"([^"]+)"/)?.[1] || "2.20261116.00.00";
  if (!apiKey) {
    throw new Error("Could not initialize YouTube search client.");
  }
  cachedInnerTube = { apiKey, clientVersion, fetchedAt: Date.now() };
  return { apiKey, clientVersion };
}

function readRendererDurationText(v: Record<string, unknown>): string {
  const direct = readRunsText(v.lengthText);
  if (direct) return direct;
  if (Array.isArray(v.thumbnailOverlays)) {
    for (const ov of v.thumbnailOverlays) {
      const ts = (ov as { thumbnailOverlayTimeStatusRenderer?: { text?: unknown } })
        ?.thumbnailOverlayTimeStatusRenderer?.text;
      const t = readRunsText(ts);
      if (t) return t;
    }
  }
  return "";
}

function extractVideosAndContinuation(
  root: unknown,
  seen = new Set<string>(),
  forcedLicense?: "creative_commons" | "standard"
): { videos: YouTubeVideo[]; nextContinuation: string | null } {
  const renderers: Record<string, unknown>[] = [];
  let nextContinuation: string | null = null;

  const walk = (node: unknown) => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) {
      for (const item of node) walk(item);
      return;
    }
    const obj = node as Record<string, unknown>;
    if (obj.videoRenderer && typeof obj.videoRenderer === "object") {
      renderers.push(obj.videoRenderer as Record<string, unknown>);
    } else if (obj.gridVideoRenderer && typeof obj.gridVideoRenderer === "object") {
      renderers.push(obj.gridVideoRenderer as Record<string, unknown>);
    }
    if (!nextContinuation && obj.continuationItemRenderer) {
      const token = (
        obj.continuationItemRenderer as {
          continuationEndpoint?: { continuationCommand?: { token?: string } };
        }
      )?.continuationEndpoint?.continuationCommand?.token;
      if (typeof token === "string" && token.length > 0) {
        nextContinuation = token;
      }
    }
    for (const val of Object.values(obj)) {
      walk(val);
    }
  };

  walk(root);

  const videos: YouTubeVideo[] = [];
  for (const v of renderers) {
    const videoId = typeof v.videoId === "string" ? v.videoId : "";
    if (!videoId || seen.has(videoId)) continue;

    const durationText = readRendererDurationText(v);
    const durationSec = parseDurationToSeconds(durationText);
    if (durationSec < 5) continue;

    seen.add(videoId);
    const title = readRunsText(v.title);
    const channel =
      readRunsText(v.ownerText) ||
      readRunsText(v.longBylineText) ||
      readRunsText(v.shortBylineText) ||
      "YouTube";
    const viewCountText =
      readRunsText(v.shortViewCountText) || readRunsText(v.viewCountText);
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
      ...(forcedLicense ? { license: forcedLicense } : {}),
    });
  }

  return { videos, nextContinuation };
}

const licenseCache = new Map<string, "creative_commons" | "standard">();

function hasCreativeCommonsMetadata(nextData: unknown): boolean {
  let found = false;
  const walkMeta = (node: unknown) => {
    if (found || !node || typeof node !== "object") return;
    if (Array.isArray(node)) {
      for (const item of node) walkMeta(item);
      return;
    }
    const obj = node as Record<string, unknown>;
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

async function detectVideoLicense(
  videoId: string,
  config: { apiKey: string; clientVersion: string }
): Promise<"creative_commons" | "standard"> {
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
              gl: "US",
            },
          },
          videoId,
        }),
        signal: controller.signal,
      }
    );
    clearTimeout(timer);
    if (!resp.ok) return "standard";
    const data = await resp.json();
    const detected: "creative_commons" | "standard" = hasCreativeCommonsMetadata(data)
      ? "creative_commons"
      : "standard";
    if (licenseCache.size > 3000) {
      const firstKey = licenseCache.keys().next().value;
      if (firstKey) licenseCache.delete(firstKey);
    }
    licenseCache.set(videoId, detected);
    return detected;
  } catch {
    return "standard";
  }
}

async function annotateVideoLicenses(
  videos: YouTubeVideo[],
  config: { apiKey: string; clientVersion: string }
): Promise<YouTubeVideo[]> {
  const concurrency = 10;
  const out = [...videos];
  for (let i = 0; i < out.length; i += concurrency) {
    const slice = out.slice(i, i + concurrency);
    const licenses = await Promise.all(
      slice.map((v) =>
        v.license ? Promise.resolve(v.license) : detectVideoLicense(v.videoId, config)
      )
    );
    for (let j = 0; j < slice.length; j++) {
      out[i + j] = { ...out[i + j], license: licenses[j] };
    }
  }
  return out;
}

function shuffleArray<T>(items: T[]): T[] {
  const arr = [...items];
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const tmp = arr[i];
    arr[i] = arr[j];
    arr[j] = tmp;
  }
  return arr;
}

const DISCOVERY_SEARCH_TOPICS = [
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
  "wildlife animals",
];

const THAI_DISCOVERY_SEARCH_TOPICS = [
  "สารคดี วิทยาศาสตร์ น่าทึ่ง",
  "สารคดี ธรรมชาติ สัตว์โลก",
  "เล่าเรื่อง ประวัติศาสตร์ โลก",
  "ความรู้รอบตัว วิทยาศาสตร์",
  "สรุปข่าว วันนี้ ล่าสุด",
  "ทำอาหาร อาหารไทย วิธีทำ",
  "ท่องเที่ยว ไทย vlog พากิน",
  "เทคโนโลยี อธิบาย ง่ายๆ",
  "ฝึกพูดภาษาไทย บทสนทนา",
  "พอดแคสต์ เล่าเรื่อง ภาษาไทย",
  "อาหารข้างทาง รีวิว ไทย",
  "สารคดี อวกาศ จักรวาล",
];

const CREATIVE_COMMONS_DISCOVERY_QUERIES = [
  "creative commons documentary",
  "creative commons nature",
  "creative commons science",
  "creative commons travel",
  "creative commons history",
  "creative commons education",
  "creative commons animation",
  "creative commons",
];

const THAI_CREATIVE_COMMONS_QUERIES = [
  "สารคดี ภาษาไทย",
  "ความรู้ วิทยาศาสตร์ ไทย",
  "ท่องเที่ยว ธรรมชาติ ไทย",
  "ทำอาหาร ไทย",
  "ประวัติศาสตร์ เล่าเรื่อง",
  "การศึกษา ภาษาไทย",
  "เทคโนโลยี ความรู้",
  "ชีวิตประจำวัน ภาษาไทย",
];

const THAI_SCRIPT_REGEX = /[\u0E00-\u0E7F]/;

function isThaiLanguageVideo(v: YouTubeVideo): boolean {
  return THAI_SCRIPT_REGEX.test(v.title) || THAI_SCRIPT_REGEX.test(v.channel);
}

function getYouTubeHeaders(thaiOnly: boolean): Record<string, string> {
  return {
    ...YT_HEADERS,
    "Accept-Language": thaiOnly ? "th-TH,th;q=0.9,en;q=0.5" : YT_HEADERS["Accept-Language"],
    "Content-Type": "application/json",
  };
}

function getYouTubeClientContext(
  config: { clientVersion: string },
  thaiOnly: boolean
) {
  return {
    client: {
      clientName: "WEB",
      clientVersion: config.clientVersion,
      hl: thaiOnly ? "th" : "en",
      gl: thaiOnly ? "TH" : "US",
    },
  };
}

const cachedRecommendedPools: Record<
  "all" | "th",
  { videos: YouTubeVideo[]; fetchedAt: number } | null
> = {
  all: null,
  th: null,
};
const recommendedFeedSessions = new Map<string, { videos: YouTubeVideo[]; createdAt: number }>();

function storeRecommendedFeedSession(videos: YouTubeVideo[]): string {
  const now = Date.now();
  for (const [key, entry] of recommendedFeedSessions.entries()) {
    if (now - entry.createdAt > 30 * 60 * 1000) {
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

async function getRecommendedPool(
  forceRefresh = false,
  thaiOnly = false
): Promise<YouTubeVideo[]> {
  const poolKey = thaiOnly ? "th" : "all";
  const existing = cachedRecommendedPools[poolKey];
  if (!forceRefresh && existing && Date.now() - existing.fetchedAt < 3 * 60 * 1000) {
    return existing.videos;
  }

  const config = await getInnerTubeConfig();
  const headers = getYouTubeHeaders(thaiOnly);
  const context = getYouTubeClientContext(config, thaiOnly);

  const browseHubs = thaiOnly
    ? shuffleArray([
        "UCtFRv9O2AHqOZjjynzrv-xg", // Learning & Explainers
        "UCYfdidRxbB8Qhf0Nx7ioOYw", // News
      ])
    : shuffleArray([
        "UCtFRv9O2AHqOZjjynzrv-xg", // Learning & Explainers
        "UC4R8DWoMoI7CAwX8_LjQHig", // Live & Popular
        "UCEgdi0XIXXZ-qJOFPf4JSKw", // Sports
        "UCYfdidRxbB8Qhf0Nx7ioOYw", // News
      ]);

  const randomTopics = thaiOnly
    ? shuffleArray(THAI_DISCOVERY_SEARCH_TOPICS).slice(0, 4)
    : shuffleArray(DISCOVERY_SEARCH_TOPICS).slice(0, 2);

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
              browseId,
            }),
          }
        );
        if (!resp.ok) return [] as YouTubeVideo[];
        const data = await resp.json();
        const vids = extractVideosAndContinuation(data).videos;
        return thaiOnly ? vids.filter(isThaiLanguageVideo) : vids;
      } catch {
        return [] as YouTubeVideo[];
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
              query: topicQuery,
            }),
          }
        );
        if (!resp.ok) return [] as YouTubeVideo[];
        const data = await resp.json();
        const vids = extractVideosAndContinuation(data).videos;
        return thaiOnly ? vids.filter(isThaiLanguageVideo) : vids;
      } catch {
        return [] as YouTubeVideo[];
      }
    })
  );

  const [hubLists, topicLists] = await Promise.all([hubListsPromise, topicListsPromise]);
  const lists = [...topicLists, ...hubLists];

  // Interleave round-robin across hubs & topics so recommended feed is balanced and diverse
  const seen = new Set<string>();
  const combined: YouTubeVideo[] = [];
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

// Recommended YouTube videos (when q is empty) & unlimited paginated search with license & Thai-language filtering
app.get("/api/youtube/search", async (req, res) => {
  try {
    const rawQuery = String(req.query.q ?? "").trim();
    const rawLicense = String(req.query.license ?? "all").trim();
    const licenseFilter: YouTubeLicenseFilter =
      rawLicense === "creative_commons" || rawLicense === "standard"
        ? rawLicense
        : "all";
    const thaiOnly =
      String(req.query.thaiOnly ?? "").trim() === "1" ||
      String(req.query.thaiOnly ?? "").trim() === "true" ||
      String(req.query.lang ?? "").trim() === "th";
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
        detectVideoLicense(directId, config),
      ]);
      if (!oembedResp.ok) {
        res.status(404).json({ error: "Could not load metadata for this YouTube video." });
        return;
      }
      const oembed = (await oembedResp.json()) as { title?: string; author_name?: string };
      const video: YouTubeVideo = {
        videoId: directId,
        title: oembed.title || `YouTube Video (${directId})`,
        channel: oembed.author_name || "YouTube Creator",
        durationText: "3:00",
        durationSec: 180,
        thumbnail: `https://i.ytimg.com/vi/${directId}/hqdefault.jpg`,
        viewCountText: "",
        publishedTimeText: "Direct link",
        license: detectedLicense,
      };
      res.json({ videos: [video], nextContinuation: null, mode: "direct" });
      return;
    }

    // Empty query => Recommended YouTube feed (freshly shuffled per visit/refresh)
    if (!rawQuery) {
      if (licenseFilter === "creative_commons") {
        const isFirstPage = !continuation || continuation.startsWith("rec:");
        const ccQueries = thaiOnly
          ? THAI_CREATIVE_COMMONS_QUERIES
          : CREATIVE_COMMONS_DISCOVERY_QUERIES;
        const randomCcQuery = ccQueries[Math.floor(Math.random() * ccQueries.length)];
        const seen = new Set<string>();
        const collected: YouTubeVideo[] = [];
        let currentCont: string | undefined = !isFirstPage ? continuation : undefined;
        let nextCont: string | null = null;
        const maxAttempts = thaiOnly ? 3 : 1;

        for (let attempt = 0; attempt < maxAttempts; attempt++) {
          const body: Record<string, unknown> = { context: ytContext };
          if (currentCont) {
            body.continuation = currentCont;
          } else {
            body.query = randomCcQuery;
            body.params = "EgIwAQ==";
          }
          const resp = await fetch(
            `https://www.youtube.com/youtubei/v1/search?key=${config.apiKey}`,
            {
              method: "POST",
              headers: ytHeaders,
              body: JSON.stringify(body),
            }
          );
          if (!resp.ok) {
            throw new Error(`YouTube returned HTTP ${resp.status}`);
          }
          const data = await resp.json();
          const extracted = extractVideosAndContinuation(data, seen, "creative_commons");
          nextCont = extracted.nextContinuation;
          for (const v of extracted.videos) {
            if (!thaiOnly || isThaiLanguageVideo(v)) {
              collected.push(v);
              licenseCache.set(v.videoId, "creative_commons");
            }
          }
          if (collected.length >= 12 || !nextCont) break;
          currentCont = nextCont;
        }

        const videos = isFirstPage ? shuffleArray(collected) : collected;
        res.setHeader("Cache-Control", "no-store");
        res.json({ videos, nextContinuation: nextCont, mode: "recommended" });
        return;
      }

      const pageSize = 24;
      let feedId = "";
      let sessionPool: YouTubeVideo[] | undefined;
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
          mode: "recommended",
        });
        return;
      }

      // licenseFilter === "standard": fast chunk filter (max 2 chunks per request)
      const matched: YouTubeVideo[] = [];
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
        mode: "recommended",
      });
      return;
    }

    // Active keyword search via YouTube InnerTube API with continuation pagination (no 20-video cap)
    const effectiveSearchQuery =
      thaiOnly && !THAI_SCRIPT_REGEX.test(rawQuery) ? `${rawQuery} ภาษาไทย` : rawQuery;

    const runSearchPage = async (contToken?: string) => {
      const body: Record<string, unknown> = {
        context: ytContext,
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
          body: JSON.stringify(body),
        }
      );
      if (!resp.ok) {
        throw new Error(`YouTube search returned HTTP ${resp.status}`);
      }
      return await resp.json();
    };

    const seen = new Set<string>();
    const forcedLicense =
      licenseFilter === "creative_commons" ? "creative_commons" : undefined;

    if (licenseFilter === "creative_commons") {
      const collected: YouTubeVideo[] = [];
      let currentCont: string | undefined = continuation || undefined;
      let nextCont: string | null = null;
      const maxAttempts = thaiOnly ? 3 : 1;
      for (let attempt = 0; attempt < maxAttempts; attempt++) {
        const data = await runSearchPage(currentCont);
        const parsed = extractVideosAndContinuation(data, seen, forcedLicense);
        nextCont = parsed.nextContinuation;
        for (const v of parsed.videos) {
          if (!thaiOnly || isThaiLanguageVideo(v)) {
            collected.push(v);
            licenseCache.set(v.videoId, "creative_commons");
          }
        }
        if (collected.length >= 12 || !nextCont) break;
        currentCont = nextCont;
      }
      res.setHeader("Cache-Control", "no-store");
      res.json({ videos: collected, nextContinuation: nextCont, mode: "search" });
      return;
    }

    if (licenseFilter === "all") {
      const collected: YouTubeVideo[] = [];
      let currentCont: string | undefined = continuation || undefined;
      let nextCont: string | null = null;
      const maxAttempts = thaiOnly ? 3 : 1;
      for (let attempt = 0; attempt < maxAttempts; attempt++) {
        const data = await runSearchPage(currentCont);
        const parsed = extractVideosAndContinuation(data, seen);
        nextCont = parsed.nextContinuation;
        const filtered = thaiOnly
          ? parsed.videos.filter(isThaiLanguageVideo)
          : parsed.videos;
        const annotated = await annotateVideoLicenses(filtered, config);
        collected.push(...annotated);
        if (collected.length >= 12 || !nextCont) break;
        currentCont = nextCont;
      }
      res.setHeader("Cache-Control", "no-store");
      res.json({ videos: collected, nextContinuation: nextCont, mode: "search" });
      return;
    }

    // licenseFilter === "standard": fetch & filter out Creative Commons, advancing up to 3 continuation pages if sparse
    const collected: YouTubeVideo[] = [];
    let currentCont: string | undefined = continuation || undefined;
    let nextCont: string | null = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      const data = await runSearchPage(currentCont);
      const parsed = extractVideosAndContinuation(data, seen);
      nextCont = parsed.nextContinuation;
      const preFiltered = thaiOnly
        ? parsed.videos.filter(isThaiLanguageVideo)
        : parsed.videos;
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
      error: err instanceof Error ? err.message : "Failed to search YouTube videos.",
    });
  }
});

const sceneTranscriptSchema = {
  type: Type.OBJECT,
  properties: {
    hasDialogue: {
      type: Type.BOOLEAN,
      description:
        "True ONLY if spoken human/character dialogue is audible in this clip. False if silent or music-only.",
    },
    summary: {
      type: Type.STRING,
      description: "Brief 3-5 word summary of what is spoken in this scene.",
    },
    utterances: {
      type: Type.ARRAY,
      description:
        "Every spoken sentence/phrase actually heard in this clip in chronological order with exact timestamps relative to the start of this clip (0s to clipDuration).",
      items: {
        type: Type.OBJECT,
        properties: {
          startSec: {
            type: Type.NUMBER,
            description: "Exact start timestamp (seconds) relative to the start of this clip (0s).",
          },
          endSec: {
            type: Type.NUMBER,
            description: "Exact end timestamp (seconds) relative to the start of this clip.",
          },
          originalSpokenText: {
            type: Type.STRING,
            description: "Exact verbatim words spoken in the audio at this timestamp.",
          },
          thaiScript: {
            type: Type.STRING,
            description: "Verbatim Thai script if spoken in Thai, or faithful Thai translation of the spoken words.",
          },
          thaiPhonetic: {
            type: Type.STRING,
            description:
              "Exact English phonetic pronunciation of the Thai speech (e.g. 'Sa-wat-dee khrap, wan-nee pai nai?').",
          },
          burmese: {
            type: Type.STRING,
            description: "Accurate Burmese translation of what was actually spoken (မြန်မာဘာသာပြန်).",
          },
          words: {
            type: Type.ARRAY,
            description:
              "Word-by-word breakdown matching thaiPhonetic space-separated tokens in exact speaking order, with exact spoken startSec and endSec timestamps relative to the start of this clip.",
            items: {
              type: Type.OBJECT,
              properties: {
                phonetic: { type: Type.STRING },
                thai: { type: Type.STRING },
                burmeseGloss: { type: Type.STRING },
                startSec: {
                  type: Type.NUMBER,
                  description:
                    "Exact timestamp (seconds, 0.1s precision) relative to clip start when this word begins to be spoken.",
                },
                endSec: {
                  type: Type.NUMBER,
                  description:
                    "Exact timestamp (seconds, 0.1s precision) relative to clip start when this word finishes being spoken.",
                },
              },
              required: ["phonetic", "thai", "burmeseGloss", "startSec", "endSec"],
            },
          },
        },
        required: [
          "startSec",
          "endSec",
          "originalSpokenText",
          "thaiScript",
          "thaiPhonetic",
          "burmese",
          "words",
        ],
      },
    },
  },
  required: ["hasDialogue", "summary", "utterances"],
};

interface RawSceneWord {
  phonetic: string;
  thai: string;
  burmeseGloss?: string;
  startSec?: number;
  endSec?: number;
}

interface RawSceneUtterances {
  hasDialogue?: boolean;
  summary?: string;
  utterances?: {
    startSec: number;
    endSec: number;
    originalSpokenText: string;
    thaiScript: string;
    thaiPhonetic: string;
    burmese: string;
    words: RawSceneWord[];
  }[];
}

function normalizeTranslationTone(raw?: unknown): TranslationTone {
  if (raw === "formal" || raw === "dramatic" || raw === "literal") {
    return raw;
  }
  return "casual";
}

function getTranslationToneInstruction(tone: TranslationTone): string {
  switch (tone) {
    case "formal":
      return `TRANSLATION TONE (Polite / Educational Burmese):
- Use polite, clear, courteous spoken/teaching Burmese (e.g. ကျွန်တော်/ကျွန်မ, ခင်ဗျား/ရှင်, ပါတယ်/ပါ, ခင်ဗျာ/ရှင့် when appropriate).
- Avoid overly rough slang while remaining natural and easy to follow for learners.`;
    case "dramatic":
      return `TRANSLATION TONE (Expressive / Drama & Comedy Burmese):
- Use vivid, expressive, emotionally punchy Burmese that captures excitement, teasing, surprise, or dramatic flair (e.g. ဟာ, တကယ်ကြီးလား, ဖြစ်ရလေ, အမလေး, etc. when matching the speaker's energy).
- Match the speaker's emotional emphasis naturally.`;
    case "literal":
      return `TRANSLATION TONE (Literal / Learner Accuracy Burmese):
- Translate faithfully and closely to the exact Thai words and grammatical structure so Thai learners can clearly see how each phrase maps to Burmese.
- Keep "burmeseGloss" extra accurate and explicit for key content words.`;
    case "casual":
    default:
      return `TRANSLATION TONE (Natural Spoken Burmese):
- Use natural, everyday conversational Burmese (e.g. တယ်, လေ, နော်, ပေါ့, ငါ/မင်း/သူ where matching speaker familiarity) just like real people speak in daily life.
- Prefer idiomatic spoken phrasing over stiff textbook prose.`;
  }
}

function getClipPrompt(
  clipDurationSec: number,
  sourceStartSec: number,
  sourceEndSec: number,
  speechWindows?: { startSec: number; endSec: number }[],
  isSlicedLocalAudio = false,
  translationTone: TranslationTone = "casual"
): string {
  const scopeDesc = isSlicedLocalAudio
    ? `this ${clipDurationSec.toFixed(1)}-second audio clip`
    : `this ${clipDurationSec.toFixed(1)}-second clip (from ${sourceStartSec.toFixed(1)}s to ${sourceEndSec.toFixed(1)}s of the video)`;

  const vadSection =
    speechWindows && speechWindows.length > 0
      ? `\nWAVEFORM-DETECTED SPEECH WINDOWS (exact seconds relative to 0.0s start of this clip):\n${speechWindows
          .map((w, i) => `  [${i + 1}] ${w.startSec.toFixed(2)}s – ${w.endSec.toFixed(2)}s`)
          .join("\n")}\n- Align every utterance's startSec and endSec closely to when spoken voice is actually audible inside these detected windows (split a window into multiple utterances if there are multiple sentences/phrases, and skip any window that only contains music or sound effects).\n`
      : "";

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
- "burmese": Accurate Burmese translation (မြန်မာဘာသာပြန်) matching what was spoken and following the translation tone above.
- "words": Split "thaiPhonetic" into space-separated word tokens in exact spoken order (each item's "phonetic" must match each token in "thaiPhonetic"), with matching Thai word, a 1-2 word Burmese gloss for key content words (empty string for particles), AND exact "startSec" and "endSec" timestamps (relative to 0.0s clip start) matching when each word is actually spoken.`;
}

function normalizeSelectedScenes(
  rawScenes: { startSec: number; endSec: number }[],
  maxDuration: number
): SpeakingScene[] {
  const clean: SpeakingScene[] = [];
  for (const s of rawScenes) {
    const start = Math.max(0, Math.min(maxDuration - 0.5, Number(s.startSec)));
    const end = Math.max(start + 0.5, Math.min(maxDuration, Number(s.endSec)));
    if (Number.isFinite(start) && Number.isFinite(end) && end > start) {
      clean.push({
        index: clean.length,
        startSec: Number(start.toFixed(2)),
        endSec: Number(end.toFixed(2)),
        durationSec: Number((end - start).toFixed(2)),
        summary: `Scene ${clean.length + 1}`,
      });
    }
  }
  return clean;
}

// Compute 10ms-frame RMS energy envelope from 16kHz mono signed 16-bit LE PCM
function computeRmsEnvelope10ms(pcmBuffer: Buffer): Float32Array {
  const frameSamples = 160; // 10ms @ 16kHz
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

interface SpeechWindow {
  startSec: number;
  endSec: number;
}

function getEnvelopeStats(rms: Float32Array): {
  noiseFloor: number;
  speechPeak: number;
  speechThreshold: number;
  onsetThreshold: number;
  hasClearDynamicRange: boolean;
  smooth: Float32Array;
} {
  const n = rms.length;
  const smooth = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const a = rms[Math.max(0, i - 1)];
    const b = rms[i];
    const c = rms[Math.min(n - 1, i + 1)];
    smooth[i] = (a + b * 2 + c) / 4;
  }
  const sorted = Array.from(smooth).sort((a, b) => a - b);
  const noiseFloor = sorted[Math.floor(sorted.length * 0.15)] || 0.001;
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

function detectSpeechSegments10ms(rms: Float32Array, clipDur: number): SpeechWindow[] {
  if (rms.length < 20) return [];
  const { speechThreshold, hasClearDynamicRange, smooth } = getEnvelopeStats(rms);
  if (!hasClearDynamicRange) return [];

  const frameDur = 0.01;
  const raw: SpeechWindow[] = [];
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
        endSec: Math.min(clipDur, (f + 1) * frameDur),
      });
    }
  }
  if (inSpeech) {
    raw.push({
      startSec: startF * frameDur,
      endSec: clipDur,
    });
  }

  // Merge small micro-pauses <= 0.32s within a spoken phrase
  const merged: SpeechWindow[] = [];
  for (const seg of raw) {
    const prev = merged[merged.length - 1];
    if (prev && seg.startSec - prev.endSec <= 0.32) {
      prev.endSec = seg.endSec;
    } else {
      merged.push({ ...seg });
    }
  }

  // Keep segments >= 0.15s and add tiny onset/offset breathing room
  return merged
    .filter((s) => s.endSec - s.startSec >= 0.15)
    .map((s) => ({
      startSec: Number(Math.max(0, s.startSec - 0.07).toFixed(2)),
      endSec: Number(Math.min(clipDur, s.endSec + 0.08).toFixed(2)),
    }));
}

function planAudioChunks(
  rms: Float32Array,
  speechWindows: SpeechWindow[],
  clipDur: number,
  maxChunkSec = 30
): { startSec: number; endSec: number }[] {
  if (clipDur <= maxChunkSec + 5) {
    return [{ startSec: 0, endSec: clipDur }];
  }

  const chunks: { startSec: number; endSec: number }[] = [];
  let cursor = 0;

  while (clipDur - cursor > maxChunkSec + 5) {
    const targetSplit = cursor + maxChunkSec;
    const minSplit = cursor + 16;
    const maxSplit = Math.min(clipDur - 5, cursor + maxChunkSec + 6);

    // Prefer a silence gap between detected speech windows near targetSplit
    let bestSplit: number | null = null;
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

    // Fallback: lowest-energy 10ms frame in [minSplit .. maxSplit]
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

function refineUtterancesWithEnvelope(
  res: RawSceneUtterances,
  rms: Float32Array,
  clipDur: number,
  speechWindows: SpeechWindow[] = []
): RawSceneUtterances {
  if (!res || res.hasDialogue === false || !Array.isArray(res.utterances) || rms.length < 20) {
    return res;
  }

  const { speechThreshold, onsetThreshold, hasClearDynamicRange, smooth } = getEnvelopeStats(rms);
  if (!hasClearDynamicRange) {
    return res;
  }

  const frameDur = 0.01; // 10ms
  const utts = [...res.utterances].sort(
    (a, b) => (Number(a.startSec) || 0) - (Number(b.startSec) || 0)
  );

  const walkBackToConsonantOnset = (frame: number, minFrame: number) => {
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
    const nextStartBound =
      idx < utts.length - 1 ? Math.min(clipDur, Number(utts[idx + 1].startSec) || clipDur) : clipDur;

    // Search up to ±1.6s when Gemini's boundary lands in silence (bounded by neighbor utterances)
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
      // Check forward first, then slightly backward if speech actually started earlier
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
      // Already inside speech: walk backward to true voice onset (max 0.6s, or up to VAD window start)
      const matchedWin = speechWindows.find(
        (w) => origStart >= w.startSec - 0.4 && origStart <= w.endSec + 0.1
      );
      const minWalk = matchedWin
        ? Math.max(searchStartMin, Math.floor(matchedWin.startSec / frameDur))
        : Math.max(searchStartMin, origStartFrame - 60);
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
      const maxWalk = matchedWin
        ? Math.min(searchEndMax, Math.ceil(matchedWin.endSec / frameDur))
        : Math.min(searchEndMax, origEndFrame + 60);
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

    // Re-scale word timestamps cleanly if they were clip-relative so they match refined [newStart, newEnd]
    const origSpan = Math.max(0.2, origEnd - origStart);
    const newSpan = Math.max(0.2, newEnd - newStart);
    let adjustedWords = u.words;
    if (Array.isArray(u.words) && u.words.length > 0) {
      const firstS = Number(u.words[0]?.startSec);
      const lastE = Number(u.words[u.words.length - 1]?.endSec);
      const wordsClipRel =
        Number.isFinite(firstS) &&
        Number.isFinite(lastE) &&
        firstS >= origStart - 0.5 &&
        lastE <= origEnd + 0.5 &&
        lastE > origStart + 0.1;
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
            endSec: Number((newStart + Math.max(0, Math.min(1, relE)) * newSpan).toFixed(2)),
          };
        });
      }
    }

    return {
      ...u,
      startSec: Number(newStart.toFixed(2)),
      endSec: Number(newEnd.toFixed(2)),
      words: adjustedWords,
    };
  });

  return { ...res, utterances: refined };
}

function buildAlignedWords(
  rawWords: RawSceneWord[],
  localStart: number,
  localEnd: number,
  looksAbsolute: boolean,
  sceneStartSec: number
): {
  phonetic: string;
  thai: string;
  burmeseGloss: string;
  startOffsetSec: number;
  endOffsetSec: number;
}[] {
  const lineDur = Math.max(0.35, localEnd - localStart);
  if (rawWords.length === 0) return [];

  // Check if Gemini provided usable word timestamps
  const parsedStarts: (number | null)[] = rawWords.map((w) => {
    if (typeof w.startSec !== "number" || !Number.isFinite(w.startSec)) return null;
    const adjusted = looksAbsolute ? w.startSec - sceneStartSec : w.startSec;
    return adjusted;
  });
  const parsedEnds: (number | null)[] = rawWords.map((w) => {
    if (typeof w.endSec !== "number" || !Number.isFinite(w.endSec)) return null;
    const adjusted = looksAbsolute ? w.endSec - sceneStartSec : w.endSec;
    return adjusted;
  });

  const allHaveTimes = parsedStarts.every((v) => v !== null) && parsedEnds.every((v) => v !== null);
  let useModelWordTimes = false;
  let offsets: { start: number; end: number }[] = [];

  if (allHaveTimes) {
    const firstStart = parsedStarts[0]!;
    const lastEnd = parsedEnds[parsedEnds.length - 1]!;
    // Detect whether word times are relative to utterance [0..lineDur] or relative to clip [localStart..localEnd]
    const looksUtteranceRelative =
      localStart > 0.6 && firstStart >= -0.2 && lastEnd <= lineDur + 0.6 && lastEnd < localStart + 0.4;

    const rawPairs = rawWords.map((_, wi) => {
      const s = looksUtteranceRelative ? parsedStarts[wi]! : parsedStarts[wi]! - localStart;
      const e = looksUtteranceRelative ? parsedEnds[wi]! : parsedEnds[wi]! - localStart;
      return {
        start: Math.max(0, Math.min(lineDur - 0.05, s)),
        end: Math.max(0.05, Math.min(lineDur, e)),
      };
    });

    // Verify they are roughly monotonic and span at least 40% of the utterance
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
      // Normalize cleanly so adjacent words don't overlap and gaps are preserved cleanly
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
    const totalWeight =
      rawWords.reduce((acc, w) => acc + Math.max(2, w.phonetic.length), 0) || 1;
    let wCursor = 0;
    offsets = rawWords.map((w, wi) => {
      const wDur = (Math.max(2, w.phonetic.length) / totalWeight) * lineDur;
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
    endOffsetSec: Number(offsets[wi].end.toFixed(2)),
  }));
}

function compileSceneTranscripts(
  scenes: SpeakingScene[],
  results: RawSceneUtterances[],
  forceClipRelative = false
): { scenes: SpeakingScene[]; subtitles: SubtitleItem[]; targetDurationSec: number } {
  const subtitles: SubtitleItem[] = [];
  let cutOffset = 0;

  const updatedScenes = scenes.map((sc, sIdx) => {
    const res = results[sIdx];
    const clipDur = sc.durationSec;

    if (res && res.hasDialogue !== false && Array.isArray(res.utterances)) {
      // Only treat timestamps as absolute source times when NOT sliced locally AND at least one exceeds clipDur
      const looksAbsolute =
        !forceClipRelative &&
        sc.startSec > 2 &&
        res.utterances.length > 0 &&
        res.utterances.some((u) => u.endSec > clipDur + 1.0) &&
        res.utterances.every((u) => u.startSec >= sc.startSec - 1 && u.endSec <= sc.endSec + 1.5);

      // Sort chronologically and clamp to clip boundaries
      const normalizedUtts = res.utterances
        .map((u) => {
          const rawLocalStart = looksAbsolute ? u.startSec - sc.startSec : u.startSec;
          const rawLocalEnd = looksAbsolute ? u.endSec - sc.startSec : u.endSec;
          const localStart = Math.max(0, Math.min(clipDur - 0.3, rawLocalStart));
          const localEnd = Math.max(localStart + 0.35, Math.min(clipDur, rawLocalEnd));
          return { u, localStart, localEnd };
        })
        .sort((a, b) => a.localStart - b.localStart);

      // Resolve any overlapping utterances within the same scene cleanly
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

        const rawWords: RawSceneWord[] =
          u.words && u.words.length > 0
            ? u.words
            : (u.thaiPhonetic || "")
                .split(/\s+/)
                .filter(Boolean)
                .map((w) => ({ phonetic: w, thai: w, burmeseGloss: "" }));

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
          words,
        });
      }
    }

    cutOffset += clipDur;
    return {
      ...sc,
      summary: res?.summary || sc.summary,
    };
  });

  subtitles.sort((a, b) => a.startTime - b.startTime);

  return {
    scenes: updatedScenes,
    subtitles,
    targetDurationSec: Number(cutOffset.toFixed(2)),
  };
}

// Store raw uploaded video file immediately for direct Voice Changer MP4 export
interface EmbeddedCue {
  startSec: number;
  endSec: number;
  text: string;
}

const TEXT_SUB_CODECS = new Set([
  "subrip",
  "srt",
  "ass",
  "ssa",
  "mov_text",
  "webvtt",
  "text",
  "tx3g",
  "utf8",
]);

function parseSrtTimestamp(raw: string): number | null {
  const m = raw.trim().match(/^(\d{1,2}):(\d{2}):(\d{2})[,.](\d{1,3})$/);
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  const s = Number(m[3]);
  const ms = Number(m[4].padEnd(3, "0"));
  return h * 3600 + min * 60 + s + ms / 1000;
}

function cleanSubtitleText(raw: string): string {
  return raw
    .replace(/\{\\[^}]*\}/g, "")
    .replace(/<[^>]+>/g, "")
    .replace(/\r/g, "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

function parseSrtCues(srtContent: string): EmbeddedCue[] {
  const blocks = srtContent.replace(/^\uFEFF/, "").split(/\r?\n\r?\n+/);
  const cues: EmbeddedCue[] = [];
  for (const block of blocks) {
    const lines = block
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean);
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

async function extractEmbeddedSubtitles(
  mediaPath: string,
  tmpDir: string
): Promise<{ cues: EmbeddedCue[]; language?: string } | null> {
  try {
    const { stdout } = await execFileAsync(
      "ffprobe",
      [
        "-v",
        "quiet",
        "-print_format",
        "json",
        "-show_streams",
        mediaPath,
      ],
      FFMPEG_EXEC_OPTS
    );
    const info = JSON.parse(stdout || "{}") as {
      streams?: {
        index: number;
        codec_type?: string;
        codec_name?: string;
        tags?: { language?: string; title?: string };
      }[];
    };
    const subStreams = (info.streams || []).filter(
      (s) =>
        s.codec_type === "subtitle" &&
        (!s.codec_name || TEXT_SUB_CODECS.has(s.codec_name.toLowerCase()))
    );
    if (subStreams.length === 0) return null;

    const scoreLang = (lang?: string) => {
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
            "-i",
            mediaPath,
            "-map",
            `0:${stream.index}`,
            "-f",
            "srt",
            outSrt,
          ],
          FFMPEG_EXEC_OPTS
        );
        const srtText = await fs.promises.readFile(outSrt, "utf-8");
        const cues = parseSrtCues(srtText);
        if (cues.length > 0) {
          return { cues, language: stream.tags?.language };
        }
      } catch {
        // Try next stream if this codec cannot be decoded to SRT
      }
    }
    return null;
  } catch {
    return null;
  }
}

function getEmbeddedSubtitlesPrompt(
  clipDurationSec: number,
  cues: EmbeddedCue[],
  translationTone: TranslationTone = "casual"
): string {
  const cuePayload = cues.map((c, idx) => ({
    index: idx,
    startSec: c.startSec,
    endSec: c.endSec,
    text: c.text,
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
- "burmese": Accurate Burmese translation (မြန်မာဘာသာပြန်) of the cue following the translation tone above.
- "words": Split "thaiPhonetic" into space-separated word tokens in exact spoken order, with matching Thai word, 1-2 word Burmese gloss for key content words (empty string for particles), AND word-level "startSec" and "endSec" aligned within that cue's [startSec, endSec] range matching the audio.`;
}

function lockUtterancesToEmbeddedCues(
  rawRes: RawSceneUtterances,
  cues: EmbeddedCue[]
): RawSceneUtterances {
  const rawUtts = Array.isArray(rawRes?.utterances) ? rawRes.utterances : [];
  const locked = cues.map((cue, idx) => {
    const matched = rawUtts[idx];
    const thaiScript = matched?.thaiScript?.trim() || cue.text;
    const thaiPhonetic = matched?.thaiPhonetic?.trim() || cue.text;
    const burmese = matched?.burmese?.trim() || cue.text;

    const rawWords: RawSceneWord[] =
      matched?.words && matched.words.length > 0
        ? matched.words.map((w) => {
            const ws = typeof w.startSec === "number" ? w.startSec : undefined;
            const we = typeof w.endSec === "number" ? w.endSec : undefined;
            return {
              ...w,
              startSec:
                ws !== undefined && Number.isFinite(ws)
                  ? Math.max(cue.startSec, Math.min(cue.endSec - 0.05, ws))
                  : undefined,
              endSec:
                we !== undefined && Number.isFinite(we)
                  ? Math.max(cue.startSec + 0.05, Math.min(cue.endSec, we))
                  : undefined,
            };
          })
        : thaiPhonetic
            .split(/\s+/)
            .filter(Boolean)
            .map((tok) => ({ phonetic: tok, thai: tok, burmeseGloss: "" }));

    return {
      startSec: cue.startSec,
      endSec: cue.endSec,
      originalSpokenText: cue.text,
      thaiScript,
      thaiPhonetic,
      burmese,
      words: rawWords,
    };
  });

  return {
    hasDialogue: true,
    summary: rawRes?.summary || "Embedded subtitles",
    utterances: locked,
  };
}

async function processUploadedVideo(
  persistentPath: string,
  uploadId: string,
  title: string,
  durationSec: number,
  parsedScenes: { startSec: number; endSec: number }[],
  translationTone: TranslationTone = "casual"
) {
  const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "upload-vid-"));
  try {
    const scenes = normalizeSelectedScenes(parsedScenes, durationSec);
    if (scenes.length === 0) {
      return {
        status: 400 as const,
        body: { error: "Select at least one scene before generating subtitles." },
      };
    }

    const ai = getGeminiClient();
    const embedded = await extractEmbeddedSubtitles(persistentPath, tmpDir);

    const results = await Promise.all(
      scenes.map(async (sc, idx) => {
        const sceneCues = embedded
          ? embedded.cues
              .filter((c) => c.endSec > sc.startSec + 0.05 && c.startSec < sc.endSec - 0.05)
              .map((c) => ({
                startSec: Number(Math.max(0, c.startSec - sc.startSec).toFixed(2)),
                endSec: Number(Math.min(sc.durationSec, c.endSec - sc.startSec).toFixed(2)),
                text: c.text,
              }))
              .filter((c) => c.endSec - c.startSec >= 0.15)
          : [];

        if (sceneCues.length > 0) {
          const segAudioPath = path.join(tmpDir, `scene-${idx}.mp3`);
          let hasAudio = false;
          try {
            await execFileAsync(
              "ffmpeg",
              [
                "-y",
                "-vn",
                "-i",
                persistentPath,
                "-ss",
                String(sc.startSec),
                "-t",
                String(sc.durationSec),
                "-ac",
                "1",
                "-ar",
                "16000",
                "-b:a",
                "48k",
                segAudioPath,
              ],
              FFMPEG_EXEC_OPTS
            );
            hasAudio = fs.existsSync(segAudioPath) && fs.statSync(segAudioPath).size > 0;
          } catch {
            hasAudio = false;
          }

          const parts: Array<
            { inlineData: { mimeType: string; data: string } } | { text: string }
          > = [];
          if (hasAudio) {
            const audioBuf = await fs.promises.readFile(segAudioPath);
            parts.push({ inlineData: { mimeType: "audio/mp3", data: audioBuf.toString("base64") } });
          }
          parts.push({
            text: getEmbeddedSubtitlesPrompt(sc.durationSec, sceneCues, translationTone),
          });

          const resp = await generateGroundedWithFailover(
            ai,
            { parts },
            sceneTranscriptSchema
          );
          const rawRes = JSON.parse((resp.text || "{}").trim()) as RawSceneUtterances;
          return lockUtterancesToEmbeddedCues(rawRes, sceneCues);
        }

        // Extract full scene 16kHz mono PCM first so VAD & chunk boundaries are 10ms-exact
        const scenePcmPath = path.join(tmpDir, `scene-${idx}.pcm`);
        let hasPcm = false;
        try {
          await execFileAsync(
            "ffmpeg",
            [
              "-y",
              "-vn",
              "-i",
              persistentPath,
              "-ss",
              String(sc.startSec),
              "-t",
              String(sc.durationSec),
              "-f",
              "s16le",
              "-ac",
              "1",
              "-ar",
              "16000",
              scenePcmPath,
            ],
            FFMPEG_EXEC_OPTS
          );
          hasPcm = fs.existsSync(scenePcmPath) && fs.statSync(scenePcmPath).size > 0;
        } catch {
          hasPcm = false;
        }

        if (!hasPcm) {
          return { hasDialogue: false, summary: "No audio", utterances: [] } as RawSceneUtterances;
        }

        const fullPcm = await fs.promises.readFile(scenePcmPath);
        const fullRms = computeRmsEnvelope10ms(fullPcm);
        const fullSpeechWindows = detectSpeechSegments10ms(fullRms, sc.durationSec);
        const subChunks = planAudioChunks(fullRms, fullSpeechWindows, sc.durationSec, 30);

        const pcmToWav = (pcmSlice: Buffer, sampleRate = 16000): Buffer => {
          const header = Buffer.alloc(44);
          header.write("RIFF", 0);
          header.writeUInt32LE(36 + pcmSlice.length, 4);
          header.write("WAVE", 8);
          header.write("fmt ", 12);
          header.writeUInt32LE(16, 16); // PCM chunk size
          header.writeUInt16LE(1, 20); // PCM format
          header.writeUInt16LE(1, 22); // mono
          header.writeUInt32LE(sampleRate, 24);
          header.writeUInt32LE(sampleRate * 2, 28); // byte rate
          header.writeUInt16LE(2, 32); // block align
          header.writeUInt16LE(16, 34); // bits per sample
          header.write("data", 36);
          header.writeUInt32LE(pcmSlice.length, 40);
          return Buffer.concat([header, pcmSlice]);
        };

        const chunkResults = await Promise.all(
          subChunks.map(async (ch) => {
            const startFrame = Math.max(0, Math.floor(ch.startSec / 0.01));
            const endFrame = Math.min(fullRms.length, Math.ceil(ch.endSec / 0.01));
            const startByte = Math.min(fullPcm.length, startFrame * 320); // 160 samples * 2 bytes per 10ms frame
            const endByte = Math.min(fullPcm.length, Math.max(startByte + 640, endFrame * 320));
            const wavBuf = pcmToWav(fullPcm.subarray(startByte, endByte), 16000);

            const chDur = Math.max(0.2, Number(((endByte - startByte) / 32000).toFixed(2)));
            const absStart = Number((sc.startSec + startFrame * 0.01).toFixed(2));
            const chRms = fullRms.subarray(startFrame, endFrame);
            const chWindows = fullSpeechWindows
              .filter((w) => w.endSec > ch.startSec + 0.05 && w.startSec < ch.endSec - 0.05)
              .map((w) => ({
                startSec: Number(Math.max(0, w.startSec - startFrame * 0.01).toFixed(2)),
                endSec: Number(Math.min(chDur, w.endSec - startFrame * 0.01).toFixed(2)),
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
                    ),
                  },
                ],
              },
              sceneTranscriptSchema
            );

            const rawChunk = JSON.parse((resp.text || "{}").trim()) as RawSceneUtterances;
            const refinedChunk = refineUtterancesWithEnvelope(rawChunk, chRms, chDur, chWindows);
            return { chOffset: Number((startFrame * 0.01).toFixed(2)), refined: refinedChunk };
          })
        );

        const mergedUtts: NonNullable<RawSceneUtterances["utterances"]> = [];
        let firstSummary = "";
        for (const item of chunkResults) {
          if (item.refined?.summary && !firstSummary) firstSummary = item.refined.summary;
          if (item.refined?.hasDialogue !== false && Array.isArray(item.refined?.utterances)) {
            for (const u of item.refined.utterances) {
              mergedUtts.push({
                ...u,
                startSec: Number((item.chOffset + u.startSec).toFixed(2)),
                endSec: Number((item.chOffset + u.endSec).toFixed(2)),
                words: Array.isArray(u.words)
                  ? u.words.map((w) => ({
                      ...w,
                      startSec:
                        typeof w.startSec === "number"
                          ? Number((item.chOffset + w.startSec).toFixed(2))
                          : undefined,
                      endSec:
                        typeof w.endSec === "number"
                          ? Number((item.chOffset + w.endSec).toFixed(2))
                          : undefined,
                    }))
                  : u.words,
              });
            }
          }
        }

        return {
          hasDialogue: mergedUtts.length > 0,
          summary: firstSummary || "Scene dialogue",
          utterances: mergedUtts,
        } as RawSceneUtterances;
      })
    );

    const compiled = compileSceneTranscripts(scenes, results, true);
    if (compiled.subtitles.length === 0) {
      return {
        status: 422 as const,
        body: { error: "No spoken dialogue or subtitles were detected inside your selected scenes." },
      };
    }

    return {
      status: 200 as const,
      body: {
        sourceType: "local",
        uploadId,
        title,
        channel: embedded ? "Local Video · Embedded Subtitles" : "Local Video",
        sourceDurationSec: durationSec,
        targetDurationSec: compiled.targetDurationSec,
        scenes: compiled.scenes,
        subtitles: compiled.subtitles,
        keyframeUrls: [],
      },
    };
  } finally {
    await fs.promises.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}

function sanitizeVideoExtension(fileName?: string): string {
  const ext = path.extname(fileName || "").toLowerCase();
  if (/^\.[a-z0-9]{2,5}$/.test(ext)) return ext;
  return ".mp4";
}

// Initialize a chunked upload (avoids 32MB Cloud Run single-request payload limits)
app.post("/api/upload-init", async (req, res) => {
  try {
    const { fileName, totalSize } = (req.body || {}) as {
      fileName?: string;
      totalSize?: number;
    };
    let expectedSize: number | undefined;
    if (totalSize !== undefined) {
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
      error: err instanceof Error ? err.message : "Failed to initialize upload.",
    });
  }
});

// Append binary chunk to an initialized upload (with cumulative limit + idempotent offset support)
app.post(
  "/api/upload-chunk",
  express.raw({ type: ["application/octet-stream", "video/*"], limit: "16mb" }),
  async (req, res) => {
    try {
      const uploadId = String(req.headers["x-upload-id"] || "");
      const session = uploadId ? uploadSessions.get(uploadId) : undefined;
      if (!session || session.pendingDelete || !fs.existsSync(session.filePath)) {
        res.status(404).json({ error: "Upload session not found or expired." });
        return;
      }
      const chunk = req.body as Buffer;
      if (!chunk || chunk.length === 0) {
        res.status(400).json({ error: "Empty upload chunk." });
        return;
      }

      const rawOffsetHeader = req.headers["x-chunk-offset"];
      const declaredOffset =
        rawOffsetHeader !== undefined && rawOffsetHeader !== ""
          ? Number(rawOffsetHeader)
          : undefined;
      if (
        declaredOffset !== undefined &&
        (!Number.isFinite(declaredOffset) || declaredOffset < 0)
      ) {
        res.status(400).json({ error: "Invalid chunk offset header." });
        return;
      }

      const result = await new Promise<{
        status: number;
        body: Record<string, unknown>;
      }>((resolve) => {
        session.writeChain = session.writeChain
          .then(async () => {
            if (session.pendingDelete || !fs.existsSync(session.filePath)) {
              resolve({
                status: 404,
                body: { error: "Upload session not found or expired." },
              });
              return;
            }

            if (declaredOffset !== undefined) {
              // Idempotent retry handling when previous chunk response was dropped
              if (
                declaredOffset < session.receivedBytes &&
                declaredOffset + chunk.length === session.receivedBytes
              ) {
                touchUploadSession(session);
                resolve({
                  status: 200,
                  body: { ok: true, receivedBytes: session.receivedBytes, duplicate: true },
                });
                return;
              }
              if (declaredOffset !== session.receivedBytes) {
                resolve({
                  status: 409,
                  body: {
                    error: "Upload chunk offset mismatch.",
                    receivedBytes: session.receivedBytes,
                  },
                });
                return;
              }
            }

            if (session.receivedBytes + chunk.length > MAX_UPLOAD_BYTES) {
              await deleteUploadSession(session.id);
              resolve({
                status: 413,
                body: { error: "Video upload exceeds the 500 MB server limit." },
              });
              return;
            }

            if (
              session.expectedSize !== undefined &&
              session.receivedBytes + chunk.length > session.expectedSize
            ) {
              await deleteUploadSession(session.id);
              resolve({
                status: 413,
                body: { error: "Upload exceeded declared file size." },
              });
              return;
            }

            await fs.promises.appendFile(session.filePath, chunk);
            session.receivedBytes += chunk.length;
            const reachedEnd =
              session.expectedSize !== undefined && session.receivedBytes >= session.expectedSize;
            touchUploadSession(session, reachedEnd);
            resolve({
              status: 200,
              body: { ok: true, receivedBytes: session.receivedBytes },
            });
          })
          .catch((err) => {
            resolve({
              status: 500,
              body: {
                error: err instanceof Error ? err.message : "Failed to write upload chunk.",
              },
            });
          });
      });

      res.status(result.status).json(result.body);
    } catch (err) {
      console.error("Upload chunk error:", err);
      res.status(500).json({
        error: err instanceof Error ? err.message : "Failed to write upload chunk.",
      });
    }
  }
);

// Immediately clean up abandoned/failed upload sessions
app.post("/api/upload-abort", async (req, res) => {
  try {
    const { uploadId } = (req.body || {}) as { uploadId?: string };
    if (uploadId && typeof uploadId === "string") {
      await deleteUploadSession(uploadId);
    }
    res.json({ ok: true });
  } catch {
    res.json({ ok: true });
  }
});

// Process an already-uploaded video file (detects embedded subtitles first, else transcribes audio)
app.post("/api/process-upload", async (req, res) => {
  try {
    const {
      uploadId,
      title = "Uploaded Video",
      durationSec = 120,
      selectedScenes = [],
      translationTone,
    } = req.body as {
      uploadId?: string;
      title?: string;
      durationSec?: number;
      selectedScenes?: { startSec: number; endSec: number }[];
      translationTone?: TranslationTone;
    };

    if (!uploadId) {
      res.status(404).json({ error: "Uploaded video file not found. Please try again." });
      return;
    }

    const tone = normalizeTranslationTone(translationTone);
    const lockedResult = await withUploadSessionLock(
      uploadId,
      async (persistentPath) =>
        processUploadedVideo(
          persistentPath,
          uploadId,
          title,
          Math.max(5, Number(durationSec) || 120),
          selectedScenes,
          tone
        ),
      { markFinalized: true }
    );

    if (!lockedResult) {
      res.status(404).json({ error: "Uploaded video file not found. Please try again." });
      return;
    }

    res.status(lockedResult.status).json(lockedResult.body);
  } catch (err) {
    console.error("Process upload error:", err);
    res.status(500).json({
      error: err instanceof Error ? err.message : "Failed to process uploaded video.",
    });
  }
});

// Store raw uploaded video file immediately for direct Voice Changer MP4 export
app.post(
  "/api/upload-raw",
  express.raw({ type: ["video/*", "application/octet-stream"], limit: "250mb" }),
  async (req, res) => {
    try {
      const videoBuf = req.body as Buffer;
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
        finalized: true,
      });
      res.json({ uploadId });
    } catch (err) {
      console.error("Raw upload error:", err);
      res.status(500).json({
        error: err instanceof Error ? err.message : "Failed to store uploaded video.",
      });
    }
  }
);

// Single-request upload fallback for smaller videos (also supports embedded subtitles)
app.post(
  "/api/upload-video",
  express.raw({ type: ["video/*", "application/octet-stream"], limit: "250mb" }),
  async (req, res) => {
    try {
      const videoBuf = req.body as Buffer;
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
      const parsedScenes = JSON.parse(rawScenesHeader) as { startSec: number; endSec: number }[];
      const tone = normalizeTranslationTone(req.headers["x-translation-tone"]);

      const uploadId = crypto.randomUUID();
      const ext = sanitizeVideoExtension(title);
      const persistentPath = path.join(os.tmpdir(), `thai-studio-upload-${uploadId}${ext}`);
      await fs.promises.writeFile(persistentPath, videoBuf);
      registerUploadSession(uploadId, persistentPath, {
        expectedSize: videoBuf.length,
        receivedBytes: videoBuf.length,
        finalized: true,
      });

      const lockedResult = await withUploadSessionLock(uploadId, async (lockedPath) =>
        processUploadedVideo(lockedPath, uploadId, title, durationSec, parsedScenes, tone)
      );
      if (!lockedResult) {
        res.status(500).json({ error: "Uploaded session unexpectedly expired." });
        return;
      }
      res.status(lockedResult.status).json(lockedResult.body);
    } catch (err) {
      console.error("Upload analysis error:", err);
      res.status(500).json({
        error: err instanceof Error ? err.message : "Failed to transcribe selected scenes.",
      });
    }
  }
);

// Transcribe ONLY the user-selected multiple scenes from a YouTube video
app.post("/api/process-video", async (req, res) => {
  try {
    const {
      videoId,
      title,
      channel,
      durationSec = 180,
      selectedScenes = [],
      translationTone,
    } = req.body as {
      videoId?: string;
      title?: string;
      channel?: string;
      durationSec?: number;
      selectedScenes?: { startSec: number; endSec: number }[];
      translationTone?: TranslationTone;
    };

    if (!videoId) {
      res.status(400).json({ error: "Missing YouTube videoId." });
      return;
    }

    const tone = normalizeTranslationTone(translationTone);
    const scenes = normalizeSelectedScenes(selectedScenes, Math.max(10, Number(durationSec) || 600));
    if (scenes.length === 0) {
      res.status(400).json({ error: "Please select at least one scene before generating subtitles." });
      return;
    }

    const ai = getGeminiClient();

    // Analyze each user-selected scene individually with exact startOffset / endOffset
    const results = await Promise.all(
      scenes.map(async (sc) => {
        const resp = await generateGroundedWithFailover(
          ai,
          [
            {
              role: "user",
              parts: [
                {
                  fileData: {
                    fileUri: `https://www.youtube.com/watch?v=${videoId}`,
                  },
                  videoMetadata: {
                    startOffset: `${sc.startSec}s`,
                    endOffset: `${sc.endSec}s`,
                    fps: 0.5,
                  },
                },
                {
                  text: getClipPrompt(
                    sc.durationSec,
                    sc.startSec,
                    sc.endSec,
                    undefined,
                    false,
                    tone
                  ),
                },
              ],
            },
          ],
          sceneTranscriptSchema
        );
        return JSON.parse((resp.text || "{}").trim()) as RawSceneUtterances;
      })
    );

    const compiled = compileSceneTranscripts(scenes, results);
    if (compiled.subtitles.length === 0) {
      res.status(422).json({
        error: "No spoken dialogue was detected inside your selected scenes.",
      });
      return;
    }

    const keyframeUrls = [
      `/api/image-proxy?url=${encodeURIComponent(`https://i.ytimg.com/vi/${videoId}/maxresdefault.jpg`)}`,
      `/api/image-proxy?url=${encodeURIComponent(`https://i.ytimg.com/vi/${videoId}/1.jpg`)}`,
      `/api/image-proxy?url=${encodeURIComponent(`https://i.ytimg.com/vi/${videoId}/2.jpg`)}`,
      `/api/image-proxy?url=${encodeURIComponent(`https://i.ytimg.com/vi/${videoId}/3.jpg`)}`,
      `/api/image-proxy?url=${encodeURIComponent(`https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`)}`,
    ];

    res.json({
      sourceType: "youtube",
      videoId,
      title: title || "YouTube Video",
      channel: channel || "YouTube",
      sourceDurationSec: durationSec,
      targetDurationSec: compiled.targetDurationSec,
      scenes: compiled.scenes,
      subtitles: compiled.subtitles,
      keyframeUrls,
    });
  } catch (err) {
    console.error("Process video error:", err);
    res.status(500).json({
      error: err instanceof Error ? err.message : "Failed to transcribe selected scenes.",
    });
  }
});

const singleSubtitleSchema = {
  type: Type.OBJECT,
  properties: {
    originalSpokenText: {
      type: Type.STRING,
      description: "Exact verbatim spoken words heard in this subtitle segment.",
    },
    thaiScript: {
      type: Type.STRING,
      description: "Accurate Thai script for this line.",
    },
    thaiPhonetic: {
      type: Type.STRING,
      description:
        "Clear, accurate English phonetic pronunciation of the Thai speech (e.g. 'Sa-wat-dee khrap').",
    },
    burmese: {
      type: Type.STRING,
      description:
        "Natural, accurate Burmese translation (မြန်မာဘာသာပြန်) matching the spoken meaning and dialogue context.",
    },
    words: {
      type: Type.ARRAY,
      description:
        "Word-by-word breakdown matching space-separated tokens in thaiPhonetic with Thai word, short Burmese gloss, and word offsets relative to 0.0 start of this line.",
      items: {
        type: Type.OBJECT,
        properties: {
          phonetic: { type: Type.STRING },
          thai: { type: Type.STRING },
          burmeseGloss: { type: Type.STRING },
          startSec: { type: Type.NUMBER },
          endSec: { type: Type.NUMBER },
        },
        required: ["phonetic", "thai", "burmeseGloss", "startSec", "endSec"],
      },
    },
  },
  required: ["originalSpokenText", "thaiScript", "thaiPhonetic", "burmese", "words"],
};

interface RegenerateContextLine {
  originalSpokenText?: string;
  thaiScript?: string;
  thaiPhonetic?: string;
  burmese?: string;
}

app.post("/api/regenerate-subtitle", async (req, res) => {
  const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "thai-regen-sub-"));
  try {
    const {
      sourceType,
      videoId,
      uploadId,
      subtitle,
      prevContext,
      nextContext,
      customHint,
      translationTone,
    } = (req.body || {}) as {
      sourceType?: "local" | "youtube";
      videoId?: string;
      uploadId?: string;
      subtitle?: {
        id?: string;
        startTime?: number;
        endTime?: number;
        sourceStartSec?: number;
        sourceEndSec?: number;
        originalSpokenText?: string;
        thaiScript?: string;
        thaiPhonetic?: string;
        burmese?: string;
      };
      prevContext?: RegenerateContextLine | null;
      nextContext?: RegenerateContextLine | null;
      customHint?: string;
      translationTone?: TranslationTone;
    };

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

    const contextLines: string[] = [];
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
    const contextBlock =
      contextLines.length > 0
        ? `\nSURROUNDING DIALOGUE CONTEXT:\n${contextLines.join("\n")}\n`
        : "";

    const userHintBlock = trimmedHint
      ? `\nUSER CORRECTION HINT / INSTRUCTION (HIGH PRIORITY — follow this guidance closely):\n"${trimmedHint}"\n`
      : "";

    const prevAttemptBlock = `PREVIOUSLY GENERATED SUBTITLE (flagged by the user for regeneration/refinement — re-evaluate carefully):
- originalSpokenText: ${subtitle.originalSpokenText || "(none)"}
- thaiScript: ${subtitle.thaiScript || "(none)"}
- thaiPhonetic: ${subtitle.thaiPhonetic || "(none)"}
- burmese: ${subtitle.burmese || "(none)"}`;

    let audioBase64: string | null = null;
    if (sourceType === "local" && uploadId) {
      audioBase64 = await withUploadSessionLock(uploadId, async (uploadedPath) => {
        const clipStart = Math.max(0, srcStart - 0.18);
        const clipDur = Math.max(0.5, srcEnd - clipStart + 0.18);
        const wavPath = path.join(tmpDir, "line.wav");
        try {
          await execFileAsync(
            "ffmpeg",
            [
              "-y",
              "-vn",
              "-ss",
              clipStart.toFixed(3),
              "-t",
              clipDur.toFixed(3),
              "-i",
              uploadedPath,
              "-ac",
              "1",
              "-ar",
              "16000",
              wavPath,
            ],
            FFMPEG_EXEC_OPTS
          );
          if (fs.existsSync(wavPath) && fs.statSync(wavPath).size > 44) {
            const buf = await fs.promises.readFile(wavPath);
            return buf.toString("base64");
          }
        } catch {
          // Fall back cleanly if segment audio extraction fails
        }
        return null;
      });
    }

    const useYouTubeAudio = sourceType === "youtube" && Boolean(videoId);
    const hasAudio = Boolean(audioBase64) || useYouTubeAudio;

    const promptText = `${
      hasAudio
        ? `Listen very carefully to the SPOKEN AUDIO of this single ${lineDur.toFixed(2)}-second dialogue line.`
        : `Re-transcribe/correct and accurately translate this single ${lineDur.toFixed(2)}-second dialogue line using the spoken text and surrounding dialogue context.`
    }
${contextBlock}${userHintBlock}
${getTranslationToneInstruction(tone)}

${prevAttemptBlock}

TASK:
1. ${
      hasAudio
        ? "Re-listen to the audio carefully to catch every spoken syllable, slang, particle, or idiom accurately (do NOT blindly copy mistakes from the previous attempt)."
        : "Carefully fix any mistranslation, awkward phrasing, or mis-segmented words in the previous attempt."
    }${trimmedHint ? "\n   Respect the USER CORRECTION HINT above as primary guidance for meaning, names, or phrasing." : ""}
2. Output natural, accurate, idiomatic Burmese translation (မြန်မာဘာသာပြန်) matching the chosen tone and conversational context.
3. Provide accurate "thaiScript", clear English "thaiPhonetic" pronunciation (e.g. "Sa-wat-dee khrap"), and a matching word-by-word "words" breakdown aligned within [0.0, ${lineDur.toFixed(2)}] seconds (each word having "phonetic", "thai", 1-2 word "burmeseGloss" for content words or "" for particles, "startSec", and "endSec").`;

    const ai = getGeminiClient();
    let contents: Parameters<typeof generateGroundedWithFailover>[1];
    if (audioBase64) {
      contents = {
        parts: [
          { inlineData: { mimeType: "audio/wav", data: audioBase64 } },
          { text: promptText },
        ],
      };
    } else if (useYouTubeAudio && videoId) {
      const metaStart = Math.max(0, Math.floor(srcStart - 0.8));
      const metaEnd = Math.max(metaStart + 2, Math.ceil(srcEnd + 0.8));
      contents = [
        {
          role: "user",
          parts: [
            {
              fileData: {
                fileUri: `https://www.youtube.com/watch?v=${videoId}`,
              },
              videoMetadata: {
                startOffset: `${metaStart}s`,
                endOffset: `${metaEnd}s`,
                fps: 0.5,
              },
            },
            { text: promptText },
          ],
        },
      ];
    } else {
      contents = promptText;
    }

    const resp = await generateGroundedWithFailover(
      ai,
      contents,
      singleSubtitleSchema,
      ThinkingLevel.HIGH
    );

    const raw = JSON.parse((resp.text || "{}").trim()) as {
      originalSpokenText?: string;
      thaiScript?: string;
      thaiPhonetic?: string;
      burmese?: string;
      words?: RawSceneWord[];
    };

    const thaiPhonetic = (raw.thaiPhonetic || "").trim() || subtitle.thaiPhonetic || "";
    const rawWords: RawSceneWord[] =
      Array.isArray(raw.words) && raw.words.length > 0
        ? raw.words
        : thaiPhonetic
            .split(/\s+/)
            .filter(Boolean)
            .map((w) => ({ phonetic: w, thai: w, burmeseGloss: "" }));

    const words = buildAlignedWords(rawWords, 0, lineDur, false, 0);

    res.json({
      usedAudio: hasAudio,
      subtitle: {
        originalSpokenText:
          (raw.originalSpokenText || "").trim() || subtitle.originalSpokenText || "",
        thaiScript: (raw.thaiScript || "").trim() || subtitle.thaiScript || thaiPhonetic,
        thaiPhonetic,
        burmese: (raw.burmese || "").trim() || subtitle.burmese || "",
        words,
      },
    });
  } catch (err) {
    console.error("Regenerate subtitle error:", err);
    res.status(500).json({
      error: err instanceof Error ? err.message : "Failed to regenerate subtitle with AI.",
    });
  } finally {
    await fs.promises.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
});

const batchRetranslateSchema = {
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
                burmeseGloss: { type: Type.STRING },
              },
              required: ["phonetic", "thai", "burmeseGloss"],
            },
          },
        },
        required: ["id", "thaiScript", "thaiPhonetic", "burmese", "words"],
      },
    },
  },
  required: ["items"],
};

app.post("/api/retranslate-subtitles", async (req, res) => {
  try {
    const { subtitles, translationTone } = (req.body || {}) as {
      subtitles?: Array<{
        id: string;
        startTime?: number;
        endTime?: number;
        originalSpokenText?: string;
        thaiScript?: string;
        thaiPhonetic?: string;
        burmese?: string;
      }>;
      translationTone?: TranslationTone;
    };

    if (!Array.isArray(subtitles) || subtitles.length === 0) {
      res.status(400).json({ error: "No subtitles provided to re-translate." });
      return;
    }

    const tone = normalizeTranslationTone(translationTone);
    const ai = getGeminiClient();

    // Process in chunks of 25 lines so prompts stay fast and strictly aligned
    const chunkSize = 25;
    const updatesById = new Map<
      string,
      {
        thaiScript: string;
        thaiPhonetic: string;
        burmese: string;
        words: RawSceneWord[];
      }
    >();

    for (let i = 0; i < subtitles.length; i += chunkSize) {
      const slice = subtitles.slice(i, i + chunkSize);
      const compactLines = slice.map((s) => ({
        id: s.id,
        spoken: s.originalSpokenText || "",
        thaiScript: s.thaiScript || "",
        thaiPhonetic: s.thaiPhonetic || "",
        burmese: s.burmese || "",
      }));

      const prompt = `Re-translate and polish the Burmese subtitles (and word-by-word Burmese glosses) for the dialogue sequence below so they match the selected tone and read cohesively across the whole conversation.

${getTranslationToneInstruction(tone)}

INPUT SUBTITLE LINES (JSON):
${JSON.stringify(compactLines)}

RULES:
- Return an item for EVERY input line with its exact matching "id".
- Keep "thaiScript" and "thaiPhonetic" accurate to the spoken Thai dialogue (fix any obvious phonetic/script issues if found, otherwise keep faithful).
- Rewrite "burmese" (မြန်မာဘာသာပြန်) to match the requested translation tone while keeping dialogue meaning accurate and consistent across lines.
- Return "words" matching each space-separated token of "thaiPhonetic" with "phonetic", "thai", and a 1-2 word "burmeseGloss" for content words ("" for particles).`;

      const resp = await generateGroundedWithFailover(
        ai,
        prompt,
        batchRetranslateSchema,
        ThinkingLevel.MEDIUM
      );

      const parsed = JSON.parse((resp.text || "{}").trim()) as {
        items?: Array<{
          id?: string;
          thaiScript?: string;
          thaiPhonetic?: string;
          burmese?: string;
          words?: RawSceneWord[];
        }>;
      };

      for (const item of Array.isArray(parsed.items) ? parsed.items : []) {
        if (!item?.id) continue;
        updatesById.set(item.id, {
          thaiScript: (item.thaiScript || "").trim(),
          thaiPhonetic: (item.thaiPhonetic || "").trim(),
          burmese: (item.burmese || "").trim(),
          words: Array.isArray(item.words) ? item.words : [],
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
      const rawWords =
        patch.words.length > 0
          ? patch.words
          : thaiPhonetic
              .split(/\s+/)
              .filter(Boolean)
              .map((w) => ({ phonetic: w, thai: w, burmeseGloss: "" }));
      const alignedWords = buildAlignedWords(rawWords, 0, lineDur, false, 0);
      return {
        id: sub.id,
        thaiScript: patch.thaiScript || sub.thaiScript || thaiPhonetic,
        thaiPhonetic,
        burmese: patch.burmese || sub.burmese || "",
        words: alignedWords,
      };
    }).filter((x): x is NonNullable<typeof x> => Boolean(x));

    res.json({ subtitles: updated });
  } catch (err) {
    console.error("Batch retranslate error:", err);
    res.status(500).json({
      error: err instanceof Error ? err.message : "Failed to re-translate subtitles.",
    });
  }
});

const resyncSubtitlesSchema = {
  type: Type.OBJECT,
  properties: {
    items: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          id: { type: Type.STRING },
          startTime: { type: Type.NUMBER },
          endTime: { type: Type.NUMBER },
        },
        required: ["id", "startTime", "endTime"],
      },
    },
  },
  required: ["items"],
};

app.post("/api/resync-subtitles", async (req, res) => {
  const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "thai-resync-"));
  try {
    const {
      sourceType,
      videoId,
      uploadId,
      scenes = [],
      subtitles = [],
    } = (req.body || {}) as {
      sourceType?: "local" | "youtube";
      videoId?: string;
      uploadId?: string;
      scenes?: { startSec: number; endSec: number; durationSec?: number }[];
      subtitles?: Array<{
        id: string;
        startTime: number;
        endTime: number;
        originalSpokenText?: string;
        thaiScript?: string;
        thaiPhonetic?: string;
        burmese?: string;
      }>;
    };

    if (!Array.isArray(subtitles) || subtitles.length === 0) {
      res.status(400).json({ error: "No subtitles provided to resync." });
      return;
    }

    const normalizedScenes = (Array.isArray(scenes) ? scenes : [])
      .map((sc) => {
        const s = Math.max(0, Number(sc.startSec) || 0);
        const e = Math.max(s + 0.2, Number(sc.endSec) || s + 1);
        return { startSec: s, endSec: e, durationSec: Number((e - s).toFixed(2)) };
      })
      .filter((sc) => sc.durationSec >= 0.2);

    const totalCutDur = Math.max(
      1,
      normalizedScenes.reduce((acc, sc) => acc + sc.durationSec, 0) ||
        Math.max(...subtitles.map((s) => Number(s.endTime) || 1), 1)
    );

    const compactSubs = subtitles.map((s, idx) => ({
      index: idx,
      id: s.id,
      currentStartTime: Number((Number(s.startTime) || 0).toFixed(2)),
      currentEndTime: Number((Number(s.endTime) || 0).toFixed(2)),
      spoken: s.originalSpokenText || "",
      thaiScript: s.thaiScript || "",
      thaiPhonetic: s.thaiPhonetic || "",
      burmese: s.burmese || "",
    }));

    const ai = getGeminiClient();

    if (sourceType === "local") {
      if (!uploadId) {
        res.status(404).json({ error: "Uploaded video session not found." });
        return;
      }

      const audioPrep = await withUploadSessionLock(uploadId, async (uploadedPath) => {
        const pcmBuffers: Buffer[] = [];
        const sceneList =
          normalizedScenes.length > 0
            ? normalizedScenes
            : [{ startSec: 0, endSec: totalCutDur, durationSec: totalCutDur }];

        for (let i = 0; i < sceneList.length; i++) {
          const sc = sceneList[i];
          const scPcmPath = path.join(tmpDir, `sc-${i}.pcm`);
          try {
            await execFileAsync(
              "ffmpeg",
              [
                "-y",
                "-vn",
                "-i",
                uploadedPath,
                "-ss",
                sc.startSec.toFixed(3),
                "-t",
                sc.durationSec.toFixed(3),
                "-f",
                "s16le",
                "-ac",
                "1",
                "-ar",
                "16000",
                scPcmPath,
              ],
              FFMPEG_EXEC_OPTS
            );
            if (fs.existsSync(scPcmPath)) {
              pcmBuffers.push(await fs.promises.readFile(scPcmPath));
            }
          } catch {
            // Append silent frame buffer matching scene duration if audio track is missing in segment
            const silentBytes = Math.max(320, Math.round(sc.durationSec * 16000) * 2);
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
            cutMp3Path,
          ],
          FFMPEG_EXEC_OPTS
        );

        const mp3Buf = await fs.promises.readFile(cutMp3Path);
        const rms = computeRmsEnvelope10ms(cutPcm);
        const speechWindows = detectSpeechSegments10ms(rms, totalCutDur);
        return {
          mp3Base64: mp3Buf.toString("base64"),
          rms,
          speechWindows,
        };
      });

      if (!audioPrep) {
        res.status(404).json({ error: "Uploaded video session not found." });
        return;
      }

      const windowsBlock =
        audioPrep.speechWindows.length > 0
          ? `SPEECH ACTIVITY WINDOWS (10ms-precise RMS on [0, ${totalCutDur.toFixed(2)}s]):\n${audioPrep.speechWindows
              .map((w) => `- ${w.startSec.toFixed(2)}s -> ${w.endSec.toFixed(2)}s`)
              .join("\n")}\n`
          : "";

      const prompt = `Listen to this ${totalCutDur.toFixed(2)}-second cut-timeline audio track and re-align the startTime and endTime of EVERY subtitle line below so it matches EXACTLY when that line is spoken in the audio.

${windowsBlock}
EXISTING SUBTITLE LINES (in chronological order, keep EVERY "id" intact):
${JSON.stringify(compactSubs)}

CRITICAL RULES:
- Return an item for EVERY single subtitle "id" in the input list — do NOT drop, merge, or skip any line.
- Keep timestamps strictly on the [0.00, ${totalCutDur.toFixed(2)}] audio timeline, monotonically increasing, with NO overlaps between consecutive lines.
- Snap each line cleanly onto the start and end of its actual spoken voice in the audio and SPEECH ACTIVITY WINDOWS (give 0.05s onset lead and hold briefly through final syllable).`;

      const resp = await generateGroundedWithFailover(
        ai,
        {
          parts: [
            { inlineData: { mimeType: "audio/mp3", data: audioPrep.mp3Base64 } },
            { text: prompt },
          ],
        },
        resyncSubtitlesSchema,
        ThinkingLevel.MEDIUM
      );

      const parsed = JSON.parse((resp.text || "{}").trim()) as {
        items?: Array<{ id?: string; startTime?: number; endTime?: number }>;
      };

      const rawMap = new Map<string, { startTime: number; endTime: number }>();
      for (const item of Array.isArray(parsed.items) ? parsed.items : []) {
        if (!item?.id) continue;
        const s = Math.max(0, Math.min(totalCutDur - 0.25, Number(item.startTime) || 0));
        const e = Math.max(s + 0.25, Math.min(totalCutDur, Number(item.endTime) || s + 1));
        rawMap.set(item.id, { startTime: s, endTime: e });
      }

      const preRefineUtts = subtitles.map((sub) => {
        const hit = rawMap.get(sub.id);
        const startSec = hit ? hit.startTime : Math.max(0, Math.min(totalCutDur - 0.25, sub.startTime));
        const endSec = hit
          ? hit.endTime
          : Math.max(startSec + 0.25, Math.min(totalCutDur, sub.endTime));
        return {
          startSec,
          endSec,
          originalSpokenText: sub.id,
          thaiScript: sub.thaiScript || "",
          thaiPhonetic: sub.thaiPhonetic || "",
          burmese: sub.burmese || "",
          words: [],
        };
      });

      const refinedRes = refineUtterancesWithEnvelope(
        { hasDialogue: true, summary: "Resync", utterances: preRefineUtts },
        audioPrep.rms,
        totalCutDur,
        audioPrep.speechWindows
      );

      const synced = (refinedRes.utterances || preRefineUtts)
        .map((u) => ({
          id: u.originalSpokenText,
          startTime: Number(Math.max(0, Math.min(totalCutDur - 0.2, u.startSec)).toFixed(2)),
          endTime: Number(Math.max(u.startSec + 0.25, Math.min(totalCutDur, u.endSec)).toFixed(2)),
        }))
        .sort((a, b) => a.startTime - b.startTime);

      for (let i = 1; i < synced.length; i++) {
        if (synced[i].startTime < synced[i - 1].endTime + 0.02) {
          const mid = (synced[i - 1].endTime + synced[i].startTime) / 2;
          synced[i - 1].endTime = Number(Math.max(synced[i - 1].startTime + 0.25, mid - 0.01).toFixed(2));
          synced[i].startTime = Number(Math.max(synced[i - 1].endTime + 0.02, synced[i].startTime).toFixed(2));
          synced[i].endTime = Number(Math.max(synced[i].startTime + 0.25, Math.min(totalCutDur, synced[i].endTime)).toFixed(2));
        }
      }

      res.json({ subtitles: synced, usedAudio: true });
      return;
    }

    if (sourceType === "youtube" && videoId) {
      let cutCursor = 0;
      const sceneTable = normalizedScenes.map((sc, idx) => {
        const entry = {
          sceneIndex: idx,
          youtubeStartSec: sc.startSec,
          youtubeEndSec: sc.endSec,
          cutStartSec: Number(cutCursor.toFixed(2)),
          cutEndSec: Number((cutCursor + sc.durationSec).toFixed(2)),
        };
        cutCursor += sc.durationSec;
        return entry;
      });
      const minYt = sceneTable.length > 0 ? Math.max(0, Math.floor(Math.min(...sceneTable.map((s) => s.youtubeStartSec)))) : 0;
      const maxYt = sceneTable.length > 0 ? Math.ceil(Math.max(...sceneTable.map((s) => s.youtubeEndSec))) : Math.ceil(totalCutDur);

      const prompt = `Listen to the spoken dialogue in this YouTube video clip and re-align the cut-timeline "startTime" and "endTime" (in seconds from 0.00 to ${totalCutDur.toFixed(2)}) for EVERY subtitle line below so each line accurately matches when it is spoken.

SCENE CUT TIMELINE MAPPING (YouTube time -> Cut Timeline seconds):
${JSON.stringify(sceneTable)}

EXISTING SUBTITLE LINES (keep EVERY "id" intact):
${JSON.stringify(compactSubs)}

RULES:
- Return an item for EVERY single subtitle "id" in the input list.
- All returned "startTime" and "endTime" MUST be in cut-timeline seconds [0.00, ${totalCutDur.toFixed(2)}], monotonically increasing, with NO overlaps.`;

      const resp = await generateGroundedWithFailover(
        ai,
        [
          {
            role: "user",
            parts: [
              {
                fileData: { fileUri: `https://www.youtube.com/watch?v=${videoId}` },
                videoMetadata: {
                  startOffset: `${minYt}s`,
                  endOffset: `${Math.max(minYt + 2, maxYt)}s`,
                  fps: 0.5,
                },
              },
              { text: prompt },
            ],
          },
        ],
        resyncSubtitlesSchema,
        ThinkingLevel.MEDIUM
      );

      const parsed = JSON.parse((resp.text || "{}").trim()) as {
        items?: Array<{ id?: string; startTime?: number; endTime?: number }>;
      };

      const rawMap = new Map<string, { startTime: number; endTime: number }>();
      for (const item of Array.isArray(parsed.items) ? parsed.items : []) {
        if (!item?.id) continue;
        const s = Math.max(0, Math.min(totalCutDur - 0.25, Number(item.startTime) || 0));
        const e = Math.max(s + 0.25, Math.min(totalCutDur, Number(item.endTime) || s + 1));
        rawMap.set(item.id, { startTime: s, endTime: e });
      }

      const synced = subtitles
        .map((sub) => {
          const hit = rawMap.get(sub.id);
          const s = hit ? hit.startTime : Math.max(0, Math.min(totalCutDur - 0.25, sub.startTime));
          const e = hit ? hit.endTime : Math.max(s + 0.25, Math.min(totalCutDur, sub.endTime));
          return {
            id: sub.id,
            startTime: Number(s.toFixed(2)),
            endTime: Number(e.toFixed(2)),
          };
        })
        .sort((a, b) => a.startTime - b.startTime);

      for (let i = 1; i < synced.length; i++) {
        if (synced[i].startTime < synced[i - 1].endTime + 0.02) {
          const mid = (synced[i - 1].endTime + synced[i].startTime) / 2;
          synced[i - 1].endTime = Number(Math.max(synced[i - 1].startTime + 0.25, mid - 0.01).toFixed(2));
          synced[i].startTime = Number(Math.max(synced[i - 1].endTime + 0.02, synced[i].startTime).toFixed(2));
          synced[i].endTime = Number(Math.max(synced[i].startTime + 0.25, Math.min(totalCutDur, synced[i].endTime)).toFixed(2));
        }
      }

      res.json({ subtitles: synced, usedAudio: true });
      return;
    }

    res.status(400).json({ error: "No audio or video source available to AI-resync subtitles." });
  } catch (err) {
    console.error("Resync subtitles error:", err);
    res.status(500).json({
      error: err instanceof Error ? err.message : "Failed to resync subtitle timings with AI.",
    });
  } finally {
    await fs.promises.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
});

// Proxy YouTube storyboard/thumbnail images cleanly with CORS for canvas export
app.get("/api/image-proxy", async (req, res) => {
  try {
    const target = String(req.query.url ?? "");
    if (!target.startsWith("https://i.ytimg.com/")) {
      res.status(400).send("Invalid image URL");
      return;
    }
    const resp = await fetch(target);
    if (!resp.ok) {
      const fallbackUrl = target.replace("maxresdefault.jpg", "hqdefault.jpg");
      const fallbackResp = await fetch(fallbackUrl);
      if (!fallbackResp.ok) {
        res.status(404).send("Image not found");
        return;
      }
      const buf = Buffer.from(await fallbackResp.arrayBuffer());
      res.setHeader("Content-Type", "image/jpeg");
      res.setHeader("Cache-Control", "public, max-age=3600");
      res.send(buf);
      return;
    }
    const buf = Buffer.from(await resp.arrayBuffer());
    res.setHeader("Content-Type", resp.headers.get("content-type") || "image/jpeg");
    res.setHeader("Cache-Control", "public, max-age=3600");
    res.send(buf);
  } catch {
    res.status(500).send("Proxy error");
  }
});

// Check whether an uploadId still exists on disk (e.g. after server restarts)
app.get("/api/upload-exists/:uploadId", (req, res) => {
  const uploadId = String(req.params.uploadId || "");
  const session = uploadId ? uploadSessions.get(uploadId) : undefined;
  const exists = Boolean(session && !session.pendingDelete && fs.existsSync(session.filePath));
  if (session && exists) {
    touchUploadSession(session);
  }
  res.json({ exists });
});

// Pre-extract selected scenes into a lightweight, all-keyframe (GOP=1) H.264 MP4
// so browser canvas export seeks instantaneously with zero blink/black frames
app.post("/api/prepare-export-clip", async (req, res) => {
  const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "thai-prep-"));
  try {
    const { uploadId, scenes = [] } = req.body as {
      uploadId?: string;
      scenes?: SpeakingScene[];
    };

    if (!uploadId) {
      res.status(404).json({ error: "Uploaded video file not found. Please re-upload." });
      return;
    }

    const outBuf = await withUploadSessionLock(
      uploadId,
      async (uploadedPath) => {
        const validScenes = (Array.isArray(scenes) ? scenes : [])
          .map((sc) => {
            const startSec = Math.max(0, Number(sc.startSec) || 0);
            const rawEnd = Number(sc.endSec);
            const rawDur = Number(sc.durationSec);
            const durationSec =
              Number.isFinite(rawEnd) && rawEnd > startSec
                ? Math.max(0.1, rawEnd - startSec)
                : Math.max(0.1, Number.isFinite(rawDur) ? rawDur : 0.1);
            return { startSec, durationSec };
          })
          .filter(
            (sc) =>
              Number.isFinite(sc.startSec) &&
              Number.isFinite(sc.durationSec) &&
              sc.durationSec > 0.05
          );

        const outClipPath = path.join(tmpDir, "prepared-clip.mp4");
        const perSceneScale =
          "scale=w='min(960,iw)':h='min(960,ih)':force_original_aspect_ratio=decrease:force_divisible_by=2,setsar=1,setpts=PTS-STARTPTS";

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
              "21",
              "-g",
              "1",
              "-keyint_min",
              "1",
              "-bf",
              "0",
              "-profile:v",
              "baseline",
              "-movflags",
              "+faststart",
              "-an",
              outClipPath,
            ],
            FFMPEG_EXEC_OPTS
          );
        } else {
          const inputArgs: string[] = [];
          const filterParts: string[] = [];
          const concatInputs: string[] = [];
          for (let i = 0; i < validScenes.length; i++) {
            const sc = validScenes[i];
            inputArgs.push("-ss", String(sc.startSec), "-t", String(sc.durationSec), "-i", uploadedPath);
            filterParts.push(`[${i}:v]${perSceneScale}[v${i}]`);
            concatInputs.push(`[v${i}]`);
          }
          // Apply fps=24 AFTER concat so multi-cut scenes join continuously without per-cut frame rounding drift
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
              "21",
              "-g",
              "1",
              "-keyint_min",
              "1",
              "-bf",
              "0",
              "-profile:v",
              "baseline",
              "-movflags",
              "+faststart",
              "-an",
              outClipPath,
            ],
            FFMPEG_EXEC_OPTS
          );
        }

        if (!fs.existsSync(outClipPath) || fs.statSync(outClipPath).size < 512) {
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
        res.status(422).json({ error: "Could not prepare video stream from file." });
      }
      return;
    }

    res.setHeader("Content-Type", "video/mp4");
    res.setHeader("Cache-Control", "no-store");
    res.send(outBuf);
  } catch (err) {
    console.error("Prepare export clip error:", err);
    res.status(500).json({
      error: err instanceof Error ? err.message : "Failed to prepare export video clip.",
    });
  } finally {
    await fs.promises.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
});

function buildVoiceAudioFilters(voiceSettings?: VoiceSettings): string[] {
  const audioFilters: string[] = [];
  let hasNonCleanEffect = false;

  if (voiceSettings) {
    // Vocal Isolation & Background Suppression — applied first on original stereo signal
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
    if (Math.abs(pitchFactor - 1) > 0.005 || Math.abs(speed - 1) > 0.005) {
      audioFilters.push(`rubberband=pitch=${pitchFactor.toFixed(4)}:tempo=${speed.toFixed(3)}`);
    }

    // Tone shaping — matched exactly to webAudioVoice.ts lowshelf(220Hz) & highshelf(3200Hz)
    const tone = Math.max(-10, Math.min(10, Number(voiceSettings.tone) || 0));
    if (tone !== 0) {
      hasNonCleanEffect = true;
      const bassDb = tone < 0 ? Math.abs(tone) * 1.3 : -tone * 0.45;
      const trebleDb = tone > 0 ? tone * 1.3 : -Math.abs(tone) * 0.35;
      audioFilters.push(`bass=g=${bassDb.toFixed(2)}:f=220:t=q:w=0.707`);
      audioFilters.push(`treble=g=${trebleDb.toFixed(2)}:f=3200:t=q:w=0.707`);
    }

    // Robot — matched to webAudioVoice.ts 58Hz bipolar ring modulator: x*(1 - 0.85r + 1.15r*sin(2pi*58*t))
    const robot = Math.max(0, Math.min(100, Number(voiceSettings.robot) || 0));
    if (robot > 0) {
      hasNonCleanEffect = true;
      const r = robot / 100;
      const dryGain = (1 - r * 0.85).toFixed(4);
      const ringGain = (r * 1.15).toFixed(4);
      audioFilters.push(`aeval='val(0)*(${dryGain}+sin(2*PI*58*t)*${ringGain}):c=same'`);
    }

    // Echo — matched to webAudioVoice.ts DelayNode feedback loop (80..240ms delay, 0.15..0.60 fb, 0..0.65 wet)
    const echo = Math.max(0, Math.min(100, Number(voiceSettings.echo) || 0));
    if (echo > 0) {
      hasNonCleanEffect = true;
      const e = echo / 100;
      const dMs = Math.round((0.08 + e * 0.16) * 1000);
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

    // Spectral Phase Shifting — 6-band cascaded all-pass filters matched to webAudioVoice.ts
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

    // Audio Adversarial Perturbations — subtle micro-phase dispersion + speech-masked high-frequency spectral perturbation
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

// Mux exported 9:16 H.264/WebM video + original audio from uploaded scenes into MP4
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
    recordedDurationSec,
  } = (req.body || {}) as {
    videoBase64?: string;
    renderedVideoUploadId?: string;
    videoFormat?: "mp4" | "webm";
    uploadId?: string;
    scenes?: SpeakingScene[];
    voiceSettings?: VoiceSettings;
    targetDurationSec?: number;
    expectedFrameCount?: number;
    forceCfrFromFrames?: boolean;
    recordedDurationSec?: number;
  };

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

    // Normalize rendered video timestamps (especially MediaRecorder wall-clock drift vs target CFR timeline)
    const videoFilterParts: string[] = [];
    const safeTargetDur = Number(targetDurationSec);
    if (forceCfrFromFrames) {
      // Manual requestFrame() pushed one frame per 1/24s timeline tick
      videoFilterParts.push("setpts=N/(24*TB)");
    } else if (
      Number.isFinite(safeTargetDur) &&
      safeTargetDur > 0.2 &&
      recordedDurationSec !== undefined
    ) {
      const renderedProbe = await probeMediaInfo(inputVideoPath);
      const actualDur =
        renderedProbe.durationSec > 0.2
          ? renderedProbe.durationSec
          : Number(recordedDurationSec);
      if (Number.isFinite(actualDur) && actualDur > 0.2) {
        const ptsScale = safeTargetDur / actualDur;
        if (Math.abs(ptsScale - 1) > 0.02 && ptsScale > 0.1 && ptsScale < 10) {
          videoFilterParts.push(`setpts=PTS*${ptsScale.toFixed(6)}`);
        }
      }
    }
    videoFilterParts.push("fps=24", "setsar=1");

    // Always normalize output video to standard 24fps CFR yuv420p H.264 Main@L4.0
    // so mobile gallery players, Android/iOS, and social apps never show black/blinking frames
    const videoCodecArgs = [
      "-vf",
      videoFilterParts.join(","),
      "-c:v",
      "libx264",
      "-preset",
      "veryfast",
      "-crf",
      "20",
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
    ];

    const runVideoOnlyMux = async () => {
      await execFileAsync(
        "ffmpeg",
        [
          "-y",
          "-i",
          inputVideoPath,
          ...videoCodecArgs,
          "-movflags",
          "+faststart",
          "-an",
          outputMp4Path,
        ],
        FFMPEG_EXEC_OPTS
      );
    };

    const normalizedScenes = (Array.isArray(scenes) ? scenes : [])
      .map((sc) => {
        const startSec = Math.max(0, Number(sc.startSec) || 0);
        const rawEnd = Number(sc.endSec);
        const rawDur = Number(sc.durationSec);
        const durationSec =
          Number.isFinite(rawEnd) && rawEnd > startSec
            ? Math.max(0.1, rawEnd - startSec)
            : Math.max(0.1, Number.isFinite(rawDur) ? rawDur : 0.1);
        return { startSec, durationSec };
      })
      .filter((sc) => Number.isFinite(sc.startSec) && Number.isFinite(sc.durationSec));

    let muxedWithAudio = false;
    if (uploadId && normalizedScenes.length > 0) {
      await withUploadSessionLock(
        uploadId,
        async (uploadedPath) => {
          const sourceProbe = await probeMediaInfo(uploadedPath);
          if (!sourceProbe.hasAudio) {
            return;
          }

          const segFiles: string[] = [];
          for (let i = 0; i < normalizedScenes.length; i++) {
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
                  segOut,
                ],
                FFMPEG_EXEC_OPTS
              );
              extracted = fs.existsSync(segOut) && fs.statSync(segOut).size > 44;
            } catch {
              extracted = false;
            }

            if (!extracted) {
              // Pad exact silence duration so subsequent scenes never shift out of sync
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
                    segOut,
                  ],
                  FFMPEG_EXEC_OPTS
                );
                extracted = fs.existsSync(segOut) && fs.statSync(segOut).size > 44;
              } catch {
                extracted = false;
              }
            }

            if (extracted) {
              segFiles.push(segOut);
            }
          }

          if (segFiles.length === 0) {
            return;
          }

          let origWavPath = segFiles[0];
          if (segFiles.length > 1) {
            origWavPath = path.join(tmpDir, "original-cuts.wav");
            const concatInputArgs: string[] = [];
            const concatLabels: string[] = [];
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
                origWavPath,
              ],
              FFMPEG_EXEC_OPTS
            );
          }

          const audioFilters = buildVoiceAudioFilters(voiceSettings);

          await execFileAsync(
            "ffmpeg",
            [
              "-y",
              "-i",
              inputVideoPath,
              "-i",
              origWavPath,
              "-map",
              "0:v:0",
              "-map",
              "1:a:0",
              ...videoCodecArgs,
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
              outputMp4Path,
            ],
            FFMPEG_EXEC_OPTS
          );
          muxedWithAudio = true;
        },
        { markFinalized: true }
      );
    }

    if (!muxedWithAudio) {
      await runVideoOnlyMux();
    }

    const outBuffer = await fs.promises.readFile(outputMp4Path);
    res.setHeader("Content-Type", "video/mp4");
    res.setHeader("Content-Disposition", 'attachment; filename="thai-burmese-9x16.mp4"');
    res.send(outBuffer);
  } catch (err) {
    console.error("Mux MP4 error:", err);
    res.status(500).json({
      error: err instanceof Error ? err.message : "Failed to encode 9:16 MP4.",
    });
  } finally {
    if (renderedVideoUploadId) {
      await deleteUploadSession(renderedVideoUploadId);
    }
    await fs.promises.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
});

// Ensure unknown /api/* routes and Express middleware errors always return JSON (never HTML)
app.use("/api", (_req, res) => {
  res.status(404).json({ error: "API endpoint not found." });
});

app.use(
  (
    err: unknown,
    req: express.Request,
    res: express.Response,
    next: express.NextFunction
  ) => {
    if (req.path.startsWith("/api/")) {
      const status =
        typeof (err as { status?: number })?.status === "number"
          ? (err as { status: number }).status
          : 500;
      const message =
        err instanceof Error ? err.message : "Unexpected server error.";
      res.status(status).json({ error: message });
      return;
    }
    next(err);
  }
);

async function startServer() {
  await sweepOrphanedTempFiles();
  setInterval(() => {
    sweepExpiredUploadSessions().catch(() => {});
  }, UPLOAD_SWEEP_INTERVAL_MS).unref();

  if (process.env.NODE_ENV !== "production") {
    const { createServer: createViteServer } = await import("vite");
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
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
