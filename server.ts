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
  VoiceSettings,
  YouTubeLicenseFilter,
  YouTubeVideo,
} from "./src/types.ts";

const execFileAsync = promisify(execFile);

const app = express();
const PORT = 3000;

app.use(express.json({ limit: "100mb" }));

// Temporary store for uploaded local videos so audio can be extracted & muxed cleanly
const uploadedFiles = new Map<string, string>();

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
  schema: Record<string, unknown>
) {
  try {
    return await withRetry(() =>
      ai.models.generateContent({
        model: "gemini-4-hydrogen",
        contents,
        config: {
          thinkingConfig: { thinkingLevel: ThinkingLevel.MEDIUM },
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

let cachedRecommendedPool: { videos: YouTubeVideo[]; fetchedAt: number } | null = null;

async function getRecommendedPool(): Promise<YouTubeVideo[]> {
  if (
    cachedRecommendedPool &&
    Date.now() - cachedRecommendedPool.fetchedAt < 10 * 60 * 1000
  ) {
    return cachedRecommendedPool.videos;
  }

  const config = await getInnerTubeConfig();
  const browseHubs = [
    "UCtFRv9O2AHqOZjjynzrv-xg", // Learning & Explainers
    "UC4R8DWoMoI7CAwX8_LjQHig", // Live & Popular
    "UCEgdi0XIXXZ-qJOFPf4JSKw", // Sports
    "UCLA_DiR1FfKNvjuUpBHmylQ", // NASA (public domain / CC & educational)
    "UCYfdidRxbB8Qhf0Nx7ioOYw", // News
  ];

  const lists = await Promise.all(
    browseHubs.map(async (browseId) => {
      try {
        const resp = await fetch(
          `https://www.youtube.com/youtubei/v1/browse?key=${config.apiKey}`,
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
              browseId,
            }),
          }
        );
        if (!resp.ok) return [] as YouTubeVideo[];
        const data = await resp.json();
        return extractVideosAndContinuation(data).videos;
      } catch {
        return [] as YouTubeVideo[];
      }
    })
  );

  // Interleave round-robin across hubs so recommended feed is balanced and diverse
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
    cachedRecommendedPool = { videos: combined, fetchedAt: Date.now() };
  }
  return combined;
}

// Recommended YouTube videos (when q is empty) & unlimited paginated search with license filtering
app.get("/api/youtube/search", async (req, res) => {
  try {
    const rawQuery = String(req.query.q ?? "").trim();
    const rawLicense = String(req.query.license ?? "all").trim();
    const licenseFilter: YouTubeLicenseFilter =
      rawLicense === "creative_commons" || rawLicense === "standard"
        ? rawLicense
        : "all";
    const continuation = String(req.query.continuation ?? "").trim();
    const directId = rawQuery ? extractYouTubeVideoId(rawQuery) : null;

    const config = await getInnerTubeConfig();

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

    // Empty query => Recommended YouTube feed (no hardcoded default search)
    if (!rawQuery) {
      if (licenseFilter === "creative_commons") {
        const body: Record<string, unknown> = {
          context: {
            client: {
              clientName: "WEB",
              clientVersion: config.clientVersion,
              hl: "en",
              gl: "US",
            },
          },
        };
        if (continuation && !continuation.startsWith("rec:")) {
          body.continuation = continuation;
        } else {
          body.query = "creative commons";
          body.params = "EgIwAQ==";
        }
        const resp = await fetch(
          `https://www.youtube.com/youtubei/v1/search?key=${config.apiKey}`,
          {
            method: "POST",
            headers: { ...YT_HEADERS, "Content-Type": "application/json" },
            body: JSON.stringify(body),
          }
        );
        if (!resp.ok) {
          throw new Error(`YouTube returned HTTP ${resp.status}`);
        }
        const data = await resp.json();
        const { videos, nextContinuation } = extractVideosAndContinuation(
          data,
          new Set<string>(),
          "creative_commons"
        );
        for (const v of videos) {
          licenseCache.set(v.videoId, "creative_commons");
        }
        res.json({ videos, nextContinuation, mode: "recommended" });
        return;
      }

      const pool = await getRecommendedPool();
      const pageSize = 24;
      let startIdx = 0;
      if (continuation.startsWith("rec:")) {
        const parsed = parseInt(continuation.slice(4), 10);
        if (Number.isFinite(parsed) && parsed >= 0) startIdx = parsed;
      }

      if (licenseFilter === "all") {
        const slice = pool.slice(startIdx, startIdx + pageSize);
        const annotated = await annotateVideoLicenses(slice, config);
        const nextIdx = startIdx + slice.length;
        res.json({
          videos: annotated,
          nextContinuation: nextIdx < pool.length ? `rec:${nextIdx}` : null,
          mode: "recommended",
        });
        return;
      }

      // licenseFilter === "standard": fast chunk filter (max 2 chunks per request)
      const matched: YouTubeVideo[] = [];
      let cursor = startIdx;
      for (let step = 0; step < 2 && cursor < pool.length && matched.length < pageSize; step++) {
        const chunk = pool.slice(cursor, cursor + pageSize);
        cursor += chunk.length;
        const annotated = await annotateVideoLicenses(chunk, config);
        for (const item of annotated) {
          if (item.license === "standard") {
            matched.push(item);
          }
        }
      }

      res.json({
        videos: matched,
        nextContinuation: cursor < pool.length ? `rec:${cursor}` : null,
        mode: "recommended",
      });
      return;
    }

    // Active keyword search via YouTube InnerTube API with continuation pagination (no 20-video cap)
    const runSearchPage = async (contToken?: string) => {
      const body: Record<string, unknown> = {
        context: {
          client: {
            clientName: "WEB",
            clientVersion: config.clientVersion,
            hl: "en",
            gl: "US",
          },
        },
      };
      if (contToken) {
        body.continuation = contToken;
      } else {
        body.query = rawQuery;
        if (licenseFilter === "creative_commons") {
          body.params = "EgIwAQ==";
        }
      }

      const resp = await fetch(
        `https://www.youtube.com/youtubei/v1/search?key=${config.apiKey}`,
        {
          method: "POST",
          headers: { ...YT_HEADERS, "Content-Type": "application/json" },
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
      const data = await runSearchPage(continuation || undefined);
      const { videos, nextContinuation } = extractVideosAndContinuation(
        data,
        seen,
        forcedLicense
      );
      for (const v of videos) {
        licenseCache.set(v.videoId, "creative_commons");
      }
      res.json({ videos, nextContinuation, mode: "search" });
      return;
    }

    if (licenseFilter === "all") {
      const data = await runSearchPage(continuation || undefined);
      const { videos, nextContinuation } = extractVideosAndContinuation(data, seen);
      const annotated = await annotateVideoLicenses(videos, config);
      res.json({ videos: annotated, nextContinuation, mode: "search" });
      return;
    }

    // licenseFilter === "standard": fetch & filter out Creative Commons, advancing up to 2 continuation pages if sparse
    const collected: YouTubeVideo[] = [];
    let currentCont: string | undefined = continuation || undefined;
    let nextCont: string | null = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      const data = await runSearchPage(currentCont);
      const parsed = extractVideosAndContinuation(data, seen);
      nextCont = parsed.nextContinuation;
      const annotated = await annotateVideoLicenses(parsed.videos, config);
      for (const v of annotated) {
        if (v.license === "standard") {
          collected.push(v);
        }
      }
      if (collected.length >= 12 || !nextCont) break;
      currentCont = nextCont;
    }

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

function getClipPrompt(
  clipDurationSec: number,
  sourceStartSec: number,
  sourceEndSec: number,
  speechWindows?: { startSec: number; endSec: number }[],
  isSlicedLocalAudio = false
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

For each spoken sentence/utterance in this clip:
- "originalSpokenText": Exact verbatim words spoken in the audio.
- "thaiScript": Verbatim Thai if spoken in Thai, otherwise accurate natural Thai translation of what was spoken.
- "thaiPhonetic": Clear, easy-to-read English phonetic spelling of the Thai pronunciation (e.g. "Sa-wat-dee khrap").
- "burmese": Accurate Burmese translation (မြန်မာဘာသာပြန်) matching what was spoken.
- "words": Split "thaiPhonetic" into space-separated word tokens in exact spoken order (each item's "phonetic" must match each token in "thaiPhonetic"), with matching Thai word, a 1-2 word Burmese gloss for key content words (empty string for particles), AND exact "startSec" and "endSec" timestamps (relative to 0.0s clip start) matching when each word is actually spoken.`;
}

function normalizeSelectedScenes(
  rawScenes: { startSec: number; endSec: number }[],
  maxDuration: number
): SpeakingScene[] {
  const clean: SpeakingScene[] = [];
  for (const s of rawScenes) {
    const start = Math.max(0, Math.min(maxDuration - 0.5, Number(s.startSec)));
    const end = Math.max(start + 1, Math.min(maxDuration, Number(s.endSec)));
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
    noiseFloor * 2.1,
    noiseFloor + (speechPeak - noiseFloor) * 0.13
  );
  return { noiseFloor, speechPeak, speechThreshold, hasClearDynamicRange, smooth };
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
      startSec: Number(Math.max(0, s.startSec - 0.04).toFixed(2)),
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

  const { speechThreshold, hasClearDynamicRange, smooth } = getEnvelopeStats(rms);
  if (!hasClearDynamicRange) {
    return res;
  }

  const frameDur = 0.01; // 10ms
  const utts = [...res.utterances].sort(
    (a, b) => (Number(a.startSec) || 0) - (Number(b.startSec) || 0)
  );

  const refined = utts.map((u, idx) => {
    const origStart = Math.max(0, Math.min(clipDur - 0.3, Number(u.startSec) || 0));
    const origEnd = Math.max(origStart + 0.3, Math.min(clipDur, Number(u.endSec) || origStart + 1));

    const prevEndBound = idx > 0 ? Math.max(0, Number(utts[idx - 1].endSec) || 0) : 0;
    const nextStartBound =
      idx < utts.length - 1 ? Math.min(clipDur, Number(utts[idx + 1].startSec) || clipDur) : clipDur;

    // Search up to ±1.6s when Gemini's boundary lands in silence (bounded by neighbor utterances)
    const searchStartMin = Math.max(
      Math.floor(prevEndBound / frameDur),
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
        const chosen = distB <= distF && distB <= 110 ? foundBackward : foundForward;
        newStart = Math.max(0, chosen * frameDur - 0.04);
      } else if (foundForward !== -1) {
        newStart = Math.max(0, foundForward * frameDur - 0.04);
      } else if (foundBackward !== -1) {
        newStart = Math.max(0, foundBackward * frameDur - 0.04);
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
      if (f < origStartFrame) {
        newStart = Math.max(0, f * frameDur - 0.03);
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
    const { stdout } = await execFileAsync("ffprobe", [
      "-v",
      "quiet",
      "-print_format",
      "json",
      "-show_streams",
      mediaPath,
    ]);
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
        await execFileAsync("ffmpeg", [
          "-y",
          "-i",
          mediaPath,
          "-map",
          `0:${stream.index}`,
          "-f",
          "srt",
          outSrt,
        ]);
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
  cues: EmbeddedCue[]
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

CRITICAL RULES FOR EMBEDDED SUBTITLES:
- You MUST set "hasDialogue": true and return EXACTLY ${cues.length} items in "utterances", one for each embedded cue in the exact same order (index 0 to ${cues.length - 1}).
- For each utterance, KEEP the exact "startSec", "endSec", and "originalSpokenText" from the corresponding embedded cue.
- "thaiScript": Exact Thai script of the cue (keep verbatim if already Thai, or natural Thai translation if another language).
- "thaiPhonetic": Clear English phonetic pronunciation of the Thai speech (e.g. "Sa-wat-dee khrap").
- "burmese": Accurate Burmese translation (မြန်မာဘာသာပြန်) of the cue.
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
  parsedScenes: { startSec: number; endSec: number }[]
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
            await execFileAsync("ffmpeg", [
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
            ]);
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
          parts.push({ text: getEmbeddedSubtitlesPrompt(sc.durationSec, sceneCues) });

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
          await execFileAsync("ffmpeg", [
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
          ]);
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
                    text: getClipPrompt(chDur, absStart, absStart + chDur, chWindows, true),
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
    const { fileName } = (req.body || {}) as { fileName?: string };
    const uploadId = crypto.randomUUID();
    const ext = sanitizeVideoExtension(fileName);
    const persistentPath = path.join(os.tmpdir(), `thai-studio-upload-${uploadId}${ext}`);
    await fs.promises.writeFile(persistentPath, Buffer.alloc(0));
    uploadedFiles.set(uploadId, persistentPath);
    res.json({ uploadId });
  } catch (err) {
    console.error("Upload init error:", err);
    res.status(500).json({
      error: err instanceof Error ? err.message : "Failed to initialize upload.",
    });
  }
});

// Append binary chunk to an initialized upload
app.post(
  "/api/upload-chunk",
  express.raw({ type: ["application/octet-stream", "video/*"], limit: "16mb" }),
  async (req, res) => {
    try {
      const uploadId = String(req.headers["x-upload-id"] || "");
      const persistentPath = uploadId ? uploadedFiles.get(uploadId) : undefined;
      if (!persistentPath) {
        res.status(404).json({ error: "Upload session not found or expired." });
        return;
      }
      const chunk = req.body as Buffer;
      if (!chunk || chunk.length === 0) {
        res.status(400).json({ error: "Empty upload chunk." });
        return;
      }
      await fs.promises.appendFile(persistentPath, chunk);
      const stat = await fs.promises.stat(persistentPath);
      res.json({ ok: true, receivedBytes: stat.size });
    } catch (err) {
      console.error("Upload chunk error:", err);
      res.status(500).json({
        error: err instanceof Error ? err.message : "Failed to write upload chunk.",
      });
    }
  }
);

// Process an already-uploaded video file (detects embedded subtitles first, else transcribes audio)
app.post("/api/process-upload", async (req, res) => {
  try {
    const {
      uploadId,
      title = "Uploaded Video",
      durationSec = 120,
      selectedScenes = [],
    } = req.body as {
      uploadId?: string;
      title?: string;
      durationSec?: number;
      selectedScenes?: { startSec: number; endSec: number }[];
    };

    const persistentPath = uploadId ? uploadedFiles.get(uploadId) : undefined;
    if (!uploadId || !persistentPath || !fs.existsSync(persistentPath)) {
      res.status(404).json({ error: "Uploaded video file not found. Please try again." });
      return;
    }

    const result = await processUploadedVideo(
      persistentPath,
      uploadId,
      title,
      Math.max(5, Number(durationSec) || 120),
      selectedScenes
    );
    res.status(result.status).json(result.body);
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
      const uploadId = crypto.randomUUID();
      const persistentPath = path.join(os.tmpdir(), `thai-studio-upload-${uploadId}.mp4`);
      await fs.promises.writeFile(persistentPath, videoBuf);
      uploadedFiles.set(uploadId, persistentPath);
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

      const title = decodeURIComponent(String(req.headers["x-file-name"] || "Uploaded Video"));
      const durationSec = Math.max(5, Number(req.headers["x-video-duration"]) || 120);
      const rawScenesHeader = String(req.headers["x-selected-scenes"] || "[]");
      const parsedScenes = JSON.parse(rawScenesHeader) as { startSec: number; endSec: number }[];

      const uploadId = crypto.randomUUID();
      const ext = sanitizeVideoExtension(title);
      const persistentPath = path.join(os.tmpdir(), `thai-studio-upload-${uploadId}${ext}`);
      await fs.promises.writeFile(persistentPath, videoBuf);
      uploadedFiles.set(uploadId, persistentPath);

      const result = await processUploadedVideo(
        persistentPath,
        uploadId,
        title,
        durationSec,
        parsedScenes
      );
      res.status(result.status).json(result.body);
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
    } = req.body as {
      videoId?: string;
      title?: string;
      channel?: string;
      durationSec?: number;
      selectedScenes?: { startSec: number; endSec: number }[];
    };

    if (!videoId) {
      res.status(400).json({ error: "Missing YouTube videoId." });
      return;
    }

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
                { text: getClipPrompt(sc.durationSec, sc.startSec, sc.endSec) },
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

// Mux exported 9:16 H.264/WebM video + original audio from uploaded scenes into MP4
app.post("/api/mux-mp4", async (req, res) => {
  const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "thai-studio-"));
  try {
    const {
      videoBase64,
      renderedVideoUploadId,
      videoFormat = "mp4",
      uploadId,
      scenes = [],
      voiceSettings,
    } = req.body as {
      videoBase64?: string;
      renderedVideoUploadId?: string;
      videoFormat?: "mp4" | "webm";
      uploadId?: string;
      scenes?: SpeakingScene[];
      voiceSettings?: VoiceSettings;
    };

    const renderedPath = renderedVideoUploadId ? uploadedFiles.get(renderedVideoUploadId) : undefined;
    if (!videoBase64 && (!renderedPath || !fs.existsSync(renderedPath))) {
      res.status(400).json({ error: "Missing rendered video payload." });
      return;
    }

    const inputVideoPath = path.join(tmpDir, `input.${videoFormat}`);
    const outputMp4Path = path.join(tmpDir, "output.mp4");
    if (renderedPath && fs.existsSync(renderedPath)) {
      await fs.promises.copyFile(renderedPath, inputVideoPath);
      uploadedFiles.delete(renderedVideoUploadId!);
      await fs.promises.rm(renderedPath, { force: true }).catch(() => {});
    } else if (videoBase64) {
      await fs.promises.writeFile(inputVideoPath, Buffer.from(videoBase64, "base64"));
    }

    const uploadedPath = uploadId ? uploadedFiles.get(uploadId) : undefined;
    const hasOriginalUploadAudio = uploadedPath && fs.existsSync(uploadedPath) && scenes.length > 0;

    const videoCodecArgs =
      videoFormat === "mp4"
        ? ["-c:v", "copy"]
        : ["-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p"];

    if (hasOriginalUploadAudio && uploadedPath) {
      const segFiles: string[] = [];
      for (let i = 0; i < scenes.length; i++) {
        const sc = scenes[i];
        const segOut = path.join(tmpDir, `seg-${i}.wav`);
        try {
          await execFileAsync("ffmpeg", [
            "-y",
            "-vn",
            "-i",
            uploadedPath,
            "-ss",
            String(sc.startSec),
            "-t",
            String(sc.durationSec),
            "-ac",
            "2",
            "-ar",
            "44100",
            segOut,
          ]);
          segFiles.push(segOut);
        } catch {
          // ignore if video had no audio stream
        }
      }

      if (segFiles.length > 0) {
        const concatListPath = path.join(tmpDir, "concat.txt");
        await fs.promises.writeFile(
          concatListPath,
          segFiles.map((f) => `file '${f.replace(/'/g, "'\\''")}'`).join("\n")
        );
        const origWavPath = path.join(tmpDir, "original-cuts.wav");
        await execFileAsync("ffmpeg", [
          "-y",
          "-f",
          "concat",
          "-safe",
          "0",
          "-i",
          concatListPath,
          "-c",
          "copy",
          origWavPath,
        ]);

        const audioFilters: string[] = [];
        if (voiceSettings) {
          const pitchSemi = Math.max(-12, Math.min(12, Number(voiceSettings.pitchSemitones) || 0));
          const pitchFactor = Math.pow(2, pitchSemi / 12);
          const speed = Math.max(0.25, Math.min(2.5, Number(voiceSettings.speed) || 1));
          if (Math.abs(pitchFactor - 1) > 0.005 || Math.abs(speed - 1) > 0.005) {
            audioFilters.push(`rubberband=pitch=${pitchFactor.toFixed(4)}:tempo=${speed.toFixed(3)}`);
          }
          const tone = Math.max(-10, Math.min(10, Number(voiceSettings.tone) || 0));
          if (tone !== 0) {
            const bassDb = tone < 0 ? Math.abs(tone) * 1.1 : -tone * 0.4;
            const trebleDb = tone > 0 ? tone * 1.1 : -Math.abs(tone) * 0.3;
            audioFilters.push(`bass=g=${bassDb.toFixed(1)}:f=220`);
            audioFilters.push(`treble=g=${trebleDb.toFixed(1)}:f=3200`);
          }
          const robot = Math.max(0, Math.min(100, Number(voiceSettings.robot) || 0));
          if (robot > 0) {
            audioFilters.push(`tremolo=f=58:d=${((robot / 100) * 0.9).toFixed(2)}`);
          }
          const echo = Math.max(0, Math.min(100, Number(voiceSettings.echo) || 0));
          if (echo > 0) {
            const delayMs = Math.round(70 + echo * 1.5);
            const decay = ((echo / 100) * 0.55).toFixed(2);
            audioFilters.push(`aecho=0.8:0.7:${delayMs}:${decay}`);
          }
        }

        await execFileAsync("ffmpeg", [
          "-y",
          "-i",
          inputVideoPath,
          "-i",
          origWavPath,
          ...videoCodecArgs,
          ...(audioFilters.length > 0 ? ["-af", audioFilters.join(",")] : []),
          "-c:a",
          "aac",
          "-b:a",
          "192k",
          "-movflags",
          "+faststart",
          "-shortest",
          outputMp4Path,
        ]);
      } else {
        await execFileAsync("ffmpeg", [
          "-y",
          "-i",
          inputVideoPath,
          ...videoCodecArgs,
          "-movflags",
          "+faststart",
          outputMp4Path,
        ]);
      }
    } else {
      await execFileAsync("ffmpeg", [
        "-y",
        "-i",
        inputVideoPath,
        ...videoCodecArgs,
        "-movflags",
        "+faststart",
        outputMp4Path,
      ]);
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
