import "dotenv/config";
import express from "express";
import http from "http";
import fs from "fs";
import path from "path";
import os from "os";
import crypto from "crypto";
import { execFile } from "child_process";
import { promisify } from "util";
import { GoogleGenAI, Type, ThinkingLevel } from "@google/genai";
import type {
  SpeakingScene,
  SubtitleGenerationConfig,
  SubtitleItem,
  TranslationTone,
  VideoEditSettings,
  VoiceSettings,
  YouTubeLicenseFilter,
  YouTubeVideo,
} from "./src/types.ts";
import { buildTranslatorSystemInstruction } from "./server/thaiBurmeseTranslatorTraining.ts";

const execFileAsync = promisify(execFile);
const FFMPEG_EXEC_OPTS = { maxBuffer: 16 * 1024 * 1024 };

const app = express();
const PORT = Number(process.env.PORT) || 3000;

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
  writtenOffsets: Map<number, number>;
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
    writtenOffsets: new Map<number, number>(),
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

interface CompletedExportEntry {
  id: string;
  filePath: string;
  dirPath: string;
  fileName: string;
  sizeBytes: number;
  createdAt: number;
}

const COMPLETED_EXPORT_TTL_MS = 15 * 60 * 1000;
const completedExports = new Map<string, CompletedExportEntry>();

function sanitizeExportFileName(rawName?: string): string {
  const base = String(rawName || "thai-burmese-9x16.mp4")
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
  if (!base) return "thai-burmese-9x16.mp4";
  return base.toLowerCase().endsWith(".mp4") ? base : `${base}.mp4`;
}

async function registerCompletedExport(
  sourceMp4Path: string,
  fileName?: string
): Promise<CompletedExportEntry> {
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
  const entry: CompletedExportEntry = {
    id,
    filePath: destPath,
    dirPath,
    fileName: safeFileName,
    sizeBytes: stat.size,
    createdAt: Date.now(),
  };
  completedExports.set(id, entry);
  return entry;
}

async function sweepExpiredCompletedExports(): Promise<void> {
  const now = Date.now();
  for (const [id, entry] of completedExports.entries()) {
    if (now - entry.createdAt > COMPLETED_EXPORT_TTL_MS || !fs.existsSync(entry.filePath)) {
      completedExports.delete(id);
      await fs.promises.rm(entry.dirPath, { recursive: true, force: true }).catch(() => {});
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
  await sweepExpiredCompletedExports();
}

async function sweepOrphanedTempFiles(): Promise<void> {
  try {
    const tmpRoot = os.tmpdir();
    const activePaths = new Set<string>([
      ...Array.from(uploadSessions.values()).map((s) => s.filePath),
      ...Array.from(completedExports.values()).map((e) => e.dirPath),
    ]);
    const names = await fs.promises.readdir(tmpRoot);
    const now = Date.now();
    for (const name of names) {
      if (
        !name.startsWith("thai-studio-upload-") &&
        !name.startsWith("upload-vid-") &&
        !name.startsWith("thai-prep-") &&
        !name.startsWith("thai-studio-") &&
        !name.startsWith("thai-export-")
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

interface ParsedGeminiError {
  status: number;
  statusText: string;
  rawMessage: string;
  isTransient: boolean;
  isQuota429: boolean;
  retryAfterMs?: number;
  isUnsupportedInput: boolean;
}

function parseRetryDelayMs(value: unknown): number | undefined {
  if (typeof value === "string") {
    const m = value.trim().match(/^(\d+(?:\.\d+)?)s$/i);
    if (m) return Math.ceil(Number(m[1]) * 1000);
  }
  return undefined;
}

function parseGeminiError(err: unknown): ParsedGeminiError {
  const errObj = (err && typeof err === "object" ? err : {}) as {
    status?: number;
    code?: number;
    message?: string;
  };
  const rawMessage = err instanceof Error ? err.message : String(err || "Unknown AI error");
  let parsedCode = typeof errObj.status === "number" ? errObj.status : typeof errObj.code === "number" ? errObj.code : 0;
  let parsedStatus = "";
  let innerMessage = rawMessage;
  let retryAfterMs: number | undefined;

  const trimmed = rawMessage.trim();
  const jsonStart = trimmed.indexOf("{");
  if (jsonStart >= 0) {
    try {
      const json = JSON.parse(trimmed.slice(jsonStart)) as {
        error?: {
          code?: number;
          message?: string;
          status?: string;
          details?: Array<{ retryDelay?: string }>;
        };
        code?: number;
        message?: string;
        status?: string;
        details?: Array<{ retryDelay?: string }>;
      };
      const inner = json.error ?? json;
      if (typeof inner.code === "number") parsedCode = inner.code;
      if (typeof inner.status === "string") parsedStatus = inner.status;
      if (typeof inner.message === "string" && inner.message.trim()) {
        innerMessage = inner.message.trim();
      }
      if (Array.isArray(inner.details)) {
        for (const d of inner.details) {
          const ms = parseRetryDelayMs(d?.retryDelay);
          if (ms && ms > 0) {
            retryAfterMs = ms;
            break;
          }
        }
      }
    } catch {
      // Keep rawMessage
    }
  }

  if (!retryAfterMs) {
    const retryMatch = `${innerMessage} ${rawMessage}`.match(
      /retry\s+in\s+(\d+(?:\.\d+)?)\s*s/i
    );
    if (retryMatch) {
      retryAfterMs = Math.ceil(Number(retryMatch[1]) * 1000);
    }
  }

  if (!parsedCode) {
    const codeMatch = rawMessage.match(/\b(400|401|403|404|429|500|502|503|504)\b/);
    if (codeMatch) parsedCode = Number(codeMatch[1]);
  }

  const isQuota429 =
    parsedCode === 429 ||
    /429|RESOURCE_EXHAUSTED|rate limit|quota/i.test(
      `${parsedStatus} ${innerMessage} ${rawMessage}`
    );

  const isTransient =
    isQuota429 ||
    parsedCode === 500 ||
    parsedCode === 502 ||
    parsedCode === 503 ||
    parsedCode === 504 ||
    /500|502|503|504|UNAVAILABLE|high demand|overloaded|temporarily|try again|ECONNRESET|ETIMEDOUT|fetch failed/i.test(
      `${parsedStatus} ${innerMessage} ${rawMessage}`
    );

  const isUnsupportedInput =
    !isTransient &&
    (parsedCode === 400 ||
      parsedCode === 404 ||
      /INVALID_ARGUMENT|NOT_FOUND|unsupported|not supported/i.test(
        `${parsedStatus} ${innerMessage} ${rawMessage}`
      ));

  return {
    status: parsedCode || 500,
    statusText: parsedStatus,
    rawMessage: innerMessage,
    isTransient,
    isQuota429,
    retryAfterMs,
    isUnsupportedInput,
  };
}

function formatGeminiError(
  err: unknown,
  fallback = "AI processing failed. Please try again."
): { status: number; message: string } {
  const info = parseGeminiError(err);
  if (
    info.status === 503 ||
    /UNAVAILABLE|high demand|overloaded/i.test(`${info.statusText} ${info.rawMessage}`)
  ) {
    return {
      status: 503,
      message:
        "Gemini AI is temporarily experiencing high demand (503). Please wait a few seconds and try again.",
    };
  }
  if (
    info.status === 429 ||
    /RESOURCE_EXHAUSTED|rate limit|quota/i.test(`${info.statusText} ${info.rawMessage}`)
  ) {
    return {
      status: 429,
      message:
        "AI rate limit or quota reached (429). Please wait a moment and try again, or check your API key in Settings > Secrets.",
    };
  }
  if (
    info.status === 403 ||
    /PERMISSION_DENIED|API_KEY_INVALID|API key not valid/i.test(
      `${info.statusText} ${info.rawMessage}`
    )
  ) {
    return {
      status: 403,
      message:
        "Gemini API key is invalid or lacks permission. Please check your API key in Settings > Secrets.",
    };
  }
  return {
    status: info.status >= 400 && info.status < 600 ? info.status : 500,
    message: info.rawMessage || fallback,
  };
}

async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  if (items.length === 0) return [];
  const limit = Math.max(1, Math.min(concurrency, items.length));
  const results = new Array<R>(items.length);
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

const RETRY_BASE_DELAYS_MS = [1200, 2500, 4500, 7500, 10000];
const modelRateLimitCooldownUntil = new Map<string, number>();

async function generateGroundedWithFailover(
  ai: GoogleGenAI,
  contents: Parameters<GoogleGenAI["models"]["generateContent"]>[0]["contents"],
  schema: Record<string, unknown>,
  thinkingLevel: ThinkingLevel = ThinkingLevel.MEDIUM,
  opts?: {
    maxAttempts?: number;
    systemInstruction?: string;
    onRetry?: (info: {
      attempt: number;
      maxAttempts: number;
      delayMs: number;
      model: string;
      isQuota429?: boolean;
    }) => void;
  }
) {
  const maxAttempts = Math.max(2, Math.min(6, opts?.maxAttempts ?? 6));
  const candidateModels = ["gemini-4-hydrogen", "gemini-3.1-flash-lite"] as const;
  const unsupportedModels = new Set<string>();
  let lastTransientErr: unknown = null;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const now = Date.now();
    const available = candidateModels.filter((m) => !unsupportedModels.has(m));
    if (available.length === 0) break;

    // Prefer a model not currently in a 429 quota cooldown window
    const preferred = candidateModels[attempt % candidateModels.length];
    const readyModels = available.filter(
      (m) => (modelRateLimitCooldownUntil.get(m) ?? 0) <= now
    );
    let model: (typeof candidateModels)[number];
    if (readyModels.length > 0) {
      model = readyModels.includes(preferred) ? preferred : readyModels[0];
    } else {
      // All candidate models are cooling down: pick the one with the earliest expiry
      model = [...available].sort(
        (a, b) =>
          (modelRateLimitCooldownUntil.get(a) ?? 0) -
          (modelRateLimitCooldownUntil.get(b) ?? 0)
      )[0];
      const waitMs = Math.min(
        62000,
        Math.max(1000, (modelRateLimitCooldownUntil.get(model) ?? now) - now + 500)
      );
      console.warn(
        `All Gemini models in 429 cooldown. Waiting ${Math.ceil(waitMs / 1000)}s before retrying ${model} (attempt ${attempt + 1}/${maxAttempts})`
      );
      opts?.onRetry?.({
        attempt: attempt + 1,
        maxAttempts,
        delayMs: waitMs,
        model,
        isQuota429: true,
      });
      await new Promise((r) => setTimeout(r, waitMs));
    }

    try {
      const systemInstructionPart = opts?.systemInstruction
        ? { systemInstruction: opts.systemInstruction }
        : {};
      const config =
        model === "gemini-4-hydrogen"
          ? {
              ...systemInstructionPart,
              thinkingConfig: { thinkingLevel },
              responseMimeType: "application/json",
              responseSchema: schema,
            }
          : {
              ...systemInstructionPart,
              responseMimeType: "application/json",
              responseSchema: schema,
            };

      return await ai.models.generateContent({
        model,
        contents,
        config,
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

      if (info.isQuota429) {
        // Put this model into cooldown for its reported retryDelay (default 15s, capped at 62s)
        const cooldownMs = Math.min(62000, Math.max(5000, info.retryAfterMs ?? 15000));
        modelRateLimitCooldownUntil.set(model, Date.now() + cooldownMs);
      }

      if (attempt === maxAttempts - 1) {
        throw err;
      }

      const otherReady = candidateModels.find(
        (m) =>
          m !== model &&
          !unsupportedModels.has(m) &&
          (modelRateLimitCooldownUntil.get(m) ?? 0) <= Date.now()
      );

      let delayMs: number;
      let nextModel: (typeof candidateModels)[number];
      if (info.isQuota429 && otherReady) {
        // Immediately fail over to the alternate model (separate quota bucket)
        delayMs = 400;
        nextModel = otherReady;
      } else if (info.isQuota429) {
        const soonest = [...candidateModels]
          .filter((m) => !unsupportedModels.has(m))
          .sort(
            (a, b) =>
              (modelRateLimitCooldownUntil.get(a) ?? 0) -
              (modelRateLimitCooldownUntil.get(b) ?? 0)
          )[0];
        nextModel = soonest ?? "gemini-4-hydrogen";
        const remaining = (modelRateLimitCooldownUntil.get(nextModel) ?? 0) - Date.now();
        delayMs = Math.min(62000, Math.max(2000, remaining + 600));
      } else {
        const baseDelay =
          RETRY_BASE_DELAYS_MS[Math.min(attempt, RETRY_BASE_DELAYS_MS.length - 1)];
        const jitter = Math.floor(Math.random() * 600);
        delayMs = baseDelay + jitter;
        const rawNext = candidateModels[(attempt + 1) % candidateModels.length];
        nextModel = unsupportedModels.has(rawNext) ? "gemini-4-hydrogen" : rawNext;
      }

      console.warn(
        `Gemini ${model} transient error (${info.status}: ${info.rawMessage}). Retrying with ${nextModel} in ${delayMs}ms (attempt ${attempt + 2}/${maxAttempts})`
      );
      opts?.onRetry?.({
        attempt: attempt + 2,
        maxAttempts,
        delayMs,
        model: nextModel,
        isQuota429: info.isQuota429,
      });
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }

  throw lastTransientErr ?? new Error("Gemini AI is temporarily unavailable.");
}

async function enhanceSpeechWavBuffer(wavBuf: Buffer): Promise<Buffer> {
  if (!wavBuf || wavBuf.length <= 44) return wavBuf;
  const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "speech-enh-"));
  try {
    const inPath = path.join(tmpDir, "in.wav");
    const outPath = path.join(tmpDir, "out.wav");
    await fs.promises.writeFile(inPath, wavBuf);
    await execFileAsync(
      "ffmpeg",
      [
        "-y",
        "-i",
        inPath,
        "-vn",
        "-af",
        "highpass=f=85,lowpass=f=7600,dynaudnorm=f=150:g=15:m=8",
        "-ac",
        "1",
        "-ar",
        "16000",
        "-c:a",
        "pcm_s16le",
        outPath,
      ],
      FFMPEG_EXEC_OPTS
    );
    if (fs.existsSync(outPath) && fs.statSync(outPath).size > 44) {
      return await fs.promises.readFile(outPath);
    }
    return wavBuf;
  } catch {
    return wavBuf;
  } finally {
    await fs.promises.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}

const DEDICATED_TRANSCRIBE_MODEL = "gemini-3.5-transcribe";

function buildDedicatedTranscribePrompt(sourceLangCode?: string): string {
  const src = (sourceLangCode || "th").toLowerCase();
  if (src === "th") {
    return [
      "Transcribe ONLY the actual spoken human dialogue in this audio verbatim in natural Thai script.",
      "Rules:",
      "- Keep colloquial Thai words, slang, contractions, and final particles (ครับ/ค่ะ/นะ/สิ/เลย/เหรอ/ว่ะ/จ้า) exactly as spoken.",
      "- Start a new line whenever a different speaker starts talking or at a clear sentence pause.",
      "- Do NOT translate, do NOT explain, do NOT add timestamps, and do NOT invent words if there is only silence, music, or sound effects (return empty string if no speech).",
    ].join("\n");
  }
  if (src === "auto") {
    return [
      "Transcribe ONLY the actual spoken human dialogue in this audio verbatim in the original spoken language script.",
      "Start a new line when the speaker changes or at natural sentence breaks.",
      "Do NOT translate, summarize, or hallucinate text if there is only music or silence.",
    ].join("\n");
  }
  return [
    `Transcribe ONLY the actual spoken human dialogue in this audio verbatim in its original script (language code: ${src}).`,
    "Start a new line when the speaker changes or at natural sentence breaks.",
    "Do NOT translate, summarize, or invent words if there is only music or silence.",
  ].join("\n");
}

async function transcribeAudioVerbatimWithDedicatedModel(
  ai: GoogleGenAI,
  wavBase64: string,
  sourceLangCode?: string
): Promise<string | null> {
  if (!wavBase64 || wavBase64.length < 64) return null;
  const cooldownUntil = modelRateLimitCooldownUntil.get(DEDICATED_TRANSCRIBE_MODEL) ?? 0;
  if (cooldownUntil > Date.now()) {
    return null;
  }

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const resp = await ai.models.generateContent({
        model: DEDICATED_TRANSCRIBE_MODEL,
        contents: {
          parts: [
            { inlineData: { mimeType: "audio/wav", data: wavBase64 } },
            { text: buildDedicatedTranscribePrompt(sourceLangCode) },
          ],
        },
      });
      const text = (resp.text || "").trim();
      if (!text) return null;
      // Ignore pure non-speech placeholder replies
      if (/^(\[?(no speech|silence|music|none|n\/a)\]?\.?)$/i.test(text)) {
        return null;
      }
      return text.slice(0, 8000);
    } catch (err) {
      const info = parseGeminiError(err);
      if (info.isQuota429) {
        const cooldownMs = Math.min(62000, Math.max(10000, info.retryAfterMs ?? 20000));
        modelRateLimitCooldownUntil.set(DEDICATED_TRANSCRIBE_MODEL, Date.now() + cooldownMs);
        console.warn(
          `Dedicated transcribe model (${DEDICATED_TRANSCRIBE_MODEL}) rate-limited; falling back to Pass 2 audio directly.`
        );
        return null;
      }
      if (info.isUnsupportedInput || !info.isTransient) {
        console.warn(
          `Dedicated transcribe model (${DEDICATED_TRANSCRIBE_MODEL}) unavailable (${info.status}); falling back to Pass 2 audio.`
        );
        return null;
      }
      if (attempt === 0) {
        await new Promise((r) => setTimeout(r, 900));
        continue;
      }
      return null;
    }
  }
  return null;
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
    dialogueContext: {
      type: Type.OBJECT,
      description:
        "Analyze the scene BEFORE translating utterances: topic/domain, who is speaking to whom & their relationship, and the emotional/situational mood.",
      properties: {
        topic: {
          type: Type.STRING,
          description: "What subject, domain, or story topic is being discussed in this clip.",
        },
        speakersAndRelationship: {
          type: Type.STRING,
          description:
            "Who the speakers are (e.g. gender/age/role) and their relationship (e.g. close friends, couple, older brother & younger sister, boss & staff, host & viewers).",
        },
        situationAndTone: {
          type: Type.STRING,
          description:
            "Current situational context and emotional mood (e.g. playful teasing, heated argument, comforting, polite workplace request, energetic vlog review).",
        },
      },
      required: ["topic", "speakersAndRelationship", "situationAndTone"],
    },
    utterances: {
      type: Type.ARRAY,
      description:
        "Every spoken sentence/phrase actually heard in this clip in chronological order with exact timestamps relative to the start of this clip (0s to clipDuration).",
      items: {
        type: Type.OBJECT,
        properties: {
          speaker: {
            type: Type.STRING,
            description:
              "Speaker identifier for this utterance (e.g. 'S1', 'S2', 'S3'). Must change whenever a different voice/speaker talks — NEVER combine two different speakers in one utterance.",
          },
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
          "speaker",
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
  required: ["hasDialogue", "summary", "dialogueContext", "utterances"],
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
  dialogueContext?: {
    topic?: string;
    speakersAndRelationship?: string;
    situationAndTone?: string;
  };
  utterances?: {
    speaker?: string;
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

const LANGUAGE_NAME_MAP: Record<string, string> = {
  auto: "Auto-Detected Spoken Language",
  th: "Thai (ไทย)",
  my: "Burmese (မြန်မာ)",
  en: "English",
  zh: "Chinese / Mandarin (中文)",
  ja: "Japanese (日本語)",
  ko: "Korean (한국어)",
  vi: "Vietnamese (Tiếng Việt)",
  lo: "Lao (ລາວ)",
  km: "Khmer (ខ្មែរ)",
  id: "Indonesian / Malay (Bahasa)",
  hi: "Hindi (हिन्दी)",
  es: "Spanish (Español)",
  fr: "French (Français)",
  none: "None (Transcribe Only)",
};

function normalizeSubtitleGenerationConfig(
  raw?: unknown,
  fallbackTone: TranslationTone = "casual"
): SubtitleGenerationConfig {
  const obj = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const validSources = new Set([
    "auto",
    "th",
    "my",
    "en",
    "zh",
    "ja",
    "ko",
    "vi",
    "lo",
    "km",
    "id",
    "hi",
    "es",
    "fr",
  ]);
  const validTargets = new Set([
    "my",
    "en",
    "th",
    "zh",
    "ja",
    "ko",
    "vi",
    "id",
    "hi",
    "es",
    "fr",
    "none",
  ]);
  const validFormats = new Set([
    "bilingual_phonetic",
    "bilingual_native",
    "translation_only",
    "original_only",
  ]);
  const validPhonetics = new Set([
    "latin",
    "burmese_phonetic",
    "ipa_tones",
    "native_only",
  ]);
  const validTones = new Set([
    "casual",
    "formal",
    "dramatic",
    "literal",
    "concise",
    "poetic",
  ]);
  const validGenres = new Set([
    "general",
    "movie_drama",
    "vlog_social",
    "education",
    "news_doc",
    "music_lyrics",
  ]);
  const validPacing = new Set(["balanced", "short_reels", "full_sentence"]);

  const sourceLanguage = (
    typeof obj.sourceLanguage === "string" && validSources.has(obj.sourceLanguage)
      ? obj.sourceLanguage
      : "th"
  ) as SubtitleGenerationConfig["sourceLanguage"];
  const targetLanguage = (
    typeof obj.targetLanguage === "string" && validTargets.has(obj.targetLanguage)
      ? obj.targetLanguage
      : "my"
  ) as SubtitleGenerationConfig["targetLanguage"];
  const subtitleFormat = (
    typeof obj.subtitleFormat === "string" && validFormats.has(obj.subtitleFormat)
      ? obj.subtitleFormat
      : "bilingual_phonetic"
  ) as SubtitleGenerationConfig["subtitleFormat"];
  const phoneticStyle = (
    typeof obj.phoneticStyle === "string" && validPhonetics.has(obj.phoneticStyle)
      ? obj.phoneticStyle
      : "latin"
  ) as SubtitleGenerationConfig["phoneticStyle"];
  const translationTone = (
    typeof obj.translationTone === "string" && validTones.has(obj.translationTone)
      ? obj.translationTone
      : fallbackTone
  ) as SubtitleGenerationConfig["translationTone"];
  const contentGenre = (
    typeof obj.contentGenre === "string" && validGenres.has(obj.contentGenre)
      ? obj.contentGenre
      : "general"
  ) as SubtitleGenerationConfig["contentGenre"];
  const pacingMode = (
    typeof obj.pacingMode === "string" && validPacing.has(obj.pacingMode)
      ? obj.pacingMode
      : "balanced"
  ) as SubtitleGenerationConfig["pacingMode"];

  return {
    sourceLanguage,
    targetLanguage,
    subtitleFormat,
    phoneticStyle,
    translationTone,
    contentGenre,
    pacingMode,
    includeWordGloss:
      typeof obj.includeWordGloss === "boolean" ? obj.includeWordGloss : true,
    includeNativeScript:
      typeof obj.includeNativeScript === "boolean" ? obj.includeNativeScript : true,
    includeNonSpeech:
      typeof obj.includeNonSpeech === "boolean" ? obj.includeNonSpeech : false,
    customInstructions:
      typeof obj.customInstructions === "string"
        ? obj.customInstructions.trim().slice(0, 600)
        : "",
  };
}

function getTranslationToneInstruction(
  tone: SubtitleGenerationConfig["translationTone"],
  targetLangCode = "my"
): string {
  const targetName = LANGUAGE_NAME_MAP[targetLangCode] || "Burmese (မြန်မာ)";
  const isBurmese = targetLangCode === "my";

  switch (tone) {
    case "formal":
      return isBurmese
        ? `TRANSLATION TONE (Polite / Educational Burmese):
- Use polite, clear, courteous spoken/teaching Burmese (e.g. ကျွန်တော်/ကျွန်မ, ခင်ဗျား/ရှင်, ပါတယ်/ပါ, ခင်ဗျာ/ရှင့် when appropriate).
- Avoid overly rough slang while remaining natural and easy to follow for learners.`
        : `TRANSLATION TONE (Polite / Educational ${targetName}):
- Use polite, clear, well-structured ${targetName} suitable for learners and formal contexts.
- Avoid harsh slang while remaining natural and easy to understand.`;
    case "dramatic":
      return isBurmese
        ? `TRANSLATION TONE (Expressive / Drama & Comedy Burmese):
- Use vivid, expressive, emotionally punchy Burmese that captures excitement, teasing, surprise, or dramatic flair (e.g. ဟာ, တကယ်ကြီးလား, ဖြစ်ရလေ, အမလေး, etc. when matching the speaker's energy).
- Match the speaker's emotional emphasis naturally.`
        : `TRANSLATION TONE (Expressive / Drama & Comedy ${targetName}):
- Use vivid, emotionally punchy ${targetName} that preserves the speaker's excitement, humor, tension, or surprise.
- Match the speaker's emotional energy naturally.`;
    case "literal":
      return `TRANSLATION TONE (Literal / Learner Accuracy in ${targetName}):
- Translate faithfully and closely to the exact spoken words and grammatical structure so learners can clearly see how each phrase maps to ${targetName}.
- Keep per-word glosses extra accurate and explicit for key content words.`;
    case "concise":
      return `TRANSLATION TONE (Short & Punchy for Reels / Shorts in ${targetName}):
- Keep translations crisp, concise, and fast to read on mobile screens without losing core meaning.
- Trim unnecessary filler words while preserving natural spoken flow.`;
    case "poetic":
      return `TRANSLATION TONE (Lyrical / Emotional Storytelling in ${targetName}):
- Translate with warmth, smooth rhythm, and emotional resonance suited to songs, stories, or heartfelt narration.
- Preserve figurative meaning rather than stiff word-by-word phrasing.`;
    case "casual":
    default:
      return isBurmese
        ? `TRANSLATION TONE (Natural Spoken Burmese):
- Use natural, everyday conversational Burmese (e.g. တယ်, လေ, နော်, ပေါ့, ငါ/မင်း/သူ where matching speaker familiarity) just like real people speak in daily life.
- Prefer idiomatic spoken phrasing over stiff textbook prose.`
        : `TRANSLATION TONE (Natural Spoken ${targetName}):
- Use natural, everyday conversational ${targetName} as native speakers actually talk in daily life.
- Prefer idiomatic spoken phrasing over stiff textbook prose.`;
  }
}

function getAdvancedStylePromptBlock(cfg: SubtitleGenerationConfig): string {
  const sourceName =
    cfg.sourceLanguage === "auto"
      ? "auto-detected spoken language (identify whatever language is actually spoken in the audio)"
      : LANGUAGE_NAME_MAP[cfg.sourceLanguage] || cfg.sourceLanguage;
  const targetName =
    cfg.targetLanguage === "none"
      ? "None (transcription only)"
      : LANGUAGE_NAME_MAP[cfg.targetLanguage] || cfg.targetLanguage;

  const genreHint: Record<SubtitleGenerationConfig["contentGenre"], string> = {
    general: "General conversation / everyday video.",
    movie_drama: "Movie or drama dialogue — preserve character attitude, relationships, and emotional nuance.",
    vlog_social: "Vlog / TikTok / social media — keep phrasing lively, modern, and relatable.",
    education: "Educational / language-learning lesson — prioritize clarity, pronunciation precision, and helpful glosses.",
    news_doc: "News / documentary — maintain factual accuracy, proper nouns, and clear formal clarity.",
    music_lyrics: "Song / music lyrics — respect lyrical phrasing, rhythm, and poetic imagery.",
  };

  const pacingHint: Record<SubtitleGenerationConfig["pacingMode"], string> = {
    balanced: "Segment utterances into natural spoken phrases (typically 4–10 words).",
    short_reels: "Split dialogue into SHORT, punchy cards (typically 2–6 words per utterance) optimized for fast-paced Reels/Shorts reading.",
    full_sentence: "Group speech into complete, coherent sentences where natural pauses occur so learners see full sentence structure.",
  };

  const nonSpeechRule = cfg.includeNonSpeech
    ? "- When a clear, meaningful non-speech sound occurs (e.g. [laughter], [sigh], [applause]), you may include a brief bracketed tag."
    : "- Skip pure music, silence, or background sound effects (do NOT add [music] or [laughter] tags).";

  const customRule = cfg.customInstructions.trim()
    ? `\nCUSTOM USER INSTRUCTIONS (follow carefully while staying grounded in the actual audio):\n${cfg.customInstructions.trim()}\n`
    : "";

  const phoneticDesc = (() => {
    switch (cfg.phoneticStyle) {
      case "burmese_phonetic":
        return "easy-to-read Burmese script phonetic pronunciation guide (မြန်မာအသံထွက်, e.g. 'ဆဝါဒီ ခပ်') so Burmese readers can pronounce the spoken words directly";
      case "ipa_tones":
        return "romanized phonetic spelling WITH clear tone marks / diacritics (e.g. 'sà-wàt-dii khráp')";
      case "native_only":
        return "exact native script of the spoken language (no romanization)";
      case "latin":
      default:
        return "clear, easy-to-read English/Latin phonetic pronunciation (e.g. 'Sa-wat-dee khrap', or verbatim text if already Latin-script English/Spanish/French)";
    }
  })();

  let fieldMapping = "";
  if (cfg.subtitleFormat === "translation_only" && cfg.targetLanguage !== "none") {
    fieldMapping = `OUTPUT FIELD MAPPING (Translation-Only Mode — ${sourceName} → ${targetName}):
- "originalSpokenText": Exact verbatim words spoken in the audio.
- "thaiScript": ${cfg.includeNativeScript ? "Exact verbatim native script of what was spoken." : 'Empty string "" (or brief original spoken text).'}
- "thaiPhonetic": Accurate, natural ${targetName} translation of what was spoken (this field is rendered as the primary subtitle line).
- "burmese": Empty string "" (leave blank in Translation-Only mode to avoid duplicate lines).
- "words": Split "thaiPhonetic" into space-separated tokens in exact reading order (each item's "phonetic" must match each token in "thaiPhonetic"), "thai" set to the matching token, "burmeseGloss" set to empty string "", AND exact "startSec"/"endSec" timestamps matching when that part is spoken.`;
  } else if (cfg.subtitleFormat === "original_only" || cfg.targetLanguage === "none") {
    const primaryDesc =
      cfg.phoneticStyle === "native_only"
        ? "Exact verbatim native script of what was spoken."
        : `Clear ${phoneticDesc} of what was spoken.`;
    fieldMapping = `OUTPUT FIELD MAPPING (Original Transcription Only — ${sourceName}):
- "originalSpokenText": Exact verbatim words spoken in the audio.
- "thaiScript": Exact verbatim native script of what was spoken.
- "thaiPhonetic": ${primaryDesc} (rendered as the primary subtitle line).
- "burmese": Empty string "" (no translation requested).
- "words": Split "thaiPhonetic" into space-separated word tokens in exact spoken order (each item's "phonetic" matches each token in "thaiPhonetic"), "thai" set to the matching native word, "burmeseGloss" set to empty string "", AND exact "startSec"/"endSec" timestamps.`;
  } else if (cfg.subtitleFormat === "bilingual_native") {
    fieldMapping = `OUTPUT FIELD MAPPING (Native Script + Translation Mode — ${sourceName} → ${targetName}):
- "originalSpokenText": Exact verbatim words spoken in the audio.
- "thaiPhonetic": Exact verbatim spoken text in its NATIVE script (this is rendered as the primary synced top line).
- "thaiScript": ${cfg.includeNativeScript ? `Optional romanized/phonetic reading (${phoneticDesc}) if helpful, otherwise empty string "".` : 'Empty string "".'}
- "burmese": Accurate ${targetName} translation following the tone instructions above.
- "words": Split "thaiPhonetic" into space-separated word tokens in exact spoken order (each item's "phonetic" matches each token in "thaiPhonetic"), "thai" set to the same native word token, "burmeseGloss" set to ${cfg.includeWordGloss ? `a concise 1–2 word ${targetName} meaning for key content words (empty string "" for small particles)` : 'empty string ""'}, AND exact "startSec"/"endSec" timestamps.`;
  } else {
    // bilingual_phonetic (default)
    fieldMapping = `OUTPUT FIELD MAPPING (Phonetic + Translation Mode — ${sourceName} → ${targetName}):
- "originalSpokenText": Exact verbatim words spoken in the audio.
- "thaiScript": ${cfg.includeNativeScript ? `Exact verbatim native script of the spoken ${sourceName} words.` : 'Empty string "".'}
- "thaiPhonetic": ${phoneticDesc} of the spoken utterance (rendered as the primary synced top line).
- "burmese": Accurate ${targetName} translation matching what was spoken and following the translation tone above.
- "words": Split "thaiPhonetic" into space-separated word tokens in exact spoken order (each item's "phonetic" must match each token in "thaiPhonetic"), "thai" set to the matching native spoken word, "burmeseGloss" set to ${cfg.includeWordGloss ? `a concise 1–2 word ${targetName} gloss for key content words (empty string "" for particles)` : 'empty string ""'}, AND exact "startSec"/"endSec" timestamps matching when each word is actually spoken.`;
  }

  return `LANGUAGE & STYLE CONFIGURATION:
- Spoken Audio Language: ${sourceName}
- Target Translation Language: ${targetName}
- Content Context / Genre: ${genreHint[cfg.contentGenre]}
- Pacing / Line Length: ${pacingHint[cfg.pacingMode]}
${nonSpeechRule}
${customRule}
${getTranslationToneInstruction(cfg.translationTone, cfg.targetLanguage === "none" ? "en" : cfg.targetLanguage)}

${fieldMapping}`;
}

function getClipPrompt(
  clipDurationSec: number,
  sourceStartSec: number,
  sourceEndSec: number,
  speechWindows?: { startSec: number; endSec: number }[],
  isSlicedLocalAudio = false,
  translationTone: TranslationTone = "casual",
  genConfig?: SubtitleGenerationConfig,
  verbatimTranscript?: string | null
): string {
  const effectiveCfg =
    genConfig ?? normalizeSubtitleGenerationConfig(undefined, translationTone);
  const scopeDesc = isSlicedLocalAudio
    ? `this ${clipDurationSec.toFixed(1)}-second audio clip`
    : `this ${clipDurationSec.toFixed(1)}-second clip (from ${sourceStartSec.toFixed(1)}s to ${sourceEndSec.toFixed(1)}s of the video)`;

  const vadSection =
    speechWindows && speechWindows.length > 0
      ? `\nWAVEFORM-DETECTED SPEECH WINDOWS (exact seconds relative to 0.0s start of this clip):\n${speechWindows
          .map((w, i) => `  [${i + 1}] ${w.startSec.toFixed(2)}s – ${w.endSec.toFixed(2)}s`)
          .join("\n")}\n- NOTE: A single speech window often contains MULTIPLE consecutive speakers talking back-to-back with zero gap OR multiple distinct clauses by one speaker. ALWAYS subdivide a window into separate utterances at EVERY speaker change and EVERY natural clause/sentence boundary. Skip any window containing only music or sound effects.\n`
      : "";

  const asrAnchorSection = verbatimTranscript?.trim()
    ? `\nPASS-1 VERBATIM SPEECH TRANSCRIPT (from dedicated speech-recognition engine — HIGH-ACCURACY WORD ANCHOR):\n"""\n${verbatimTranscript.trim()}\n"""\n- Use this Pass-1 verbatim transcript as your PRIMARY anchor for the exact spoken words so you do not mishear, drop, or hallucinate dialogue.\n- Still listen closely to the accompanying audio to verify speaker turns ("S1", "S2", ...), exact sub-second startSec/endSec timestamps, vocal emotion/gender, and any subtle particles.\n`
    : "";

  return `Listen carefully to the ACTUAL spoken audio in ${scopeDesc}.
${vadSection}${asrAnchorSection}
CRITICAL GROUNDING, SPEAKER-SEPARATION & TIMING RULES:
- ONLY transcribe and translate what is ACTUALLY SPOKEN in the audio of this clip.
- NEVER invent, guess, or fabricate dialogue that is not spoken.
- If there is NO spoken dialogue in this clip (only silence, music, or sound effects), set "hasDialogue": false and return an empty "utterances" array.
- CONTEXT-FIRST TRANSLATION: First fill "dialogueContext" (topic, speakersAndRelationship, situationAndTone) by listening to the whole clip, then translate EVERY utterance in natural Burmese that matches that exact topic, speaker relationship (pronouns/kinship/politeness), and situational emotion.
- SPEAKER TURN DISCIPLINE: Always identify the "speaker" ("S1", "S2", "S3", ...) for every utterance. Whenever a different person speaks — even immediately with 0.0s pause or a brief 1–2 word reply — you MUST create a separate utterance object. NEVER merge two consecutive speakers into one subtitle line!
- PHRASE & CLAUSE DISCIPLINE: Segment continuous speech systematically at sentence-final particles, natural pauses, and clause boundaries so each utterance is a clean, self-contained spoken thought (never cram multiple distinct turns or sentences into one long subtitle).
- Report ALL "startSec" and "endSec" values (both for utterances AND for each word) relative to the start of THIS clip (strictly between 0.0 and ${clipDurationSec.toFixed(1)} seconds) with sub-second precision (e.g. 0.42, 1.35, 2.84).
- NEVER round timestamps to whole seconds, and NEVER include leading or trailing silent pauses inside an utterance's startSec/endSec. Start right when that speaker's voice begins and end right when that speaker's turn/phrase stops.
- Utterances must be strictly chronological and non-overlapping.

${getAdvancedStylePromptBlock(effectiveCfg)}`;
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

  const merged: SpeechWindow[] = [];
  for (const seg of raw) {
    const prev = merged[merged.length - 1];
    if (prev && seg.startSec - prev.endSec <= 0.32) {
      prev.endSec = seg.endSec;
    } else {
      merged.push({ ...seg });
    }
  }

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
    const origStart = Math.max(0, Math.min(clipDur - 0.22, Number(u.startSec) || 0));
    const origEnd = Math.max(origStart + 0.22, Math.min(clipDur, Number(u.endSec) || origStart + 1));

    const prevEndBound = idx > 0 ? Math.max(0, Number(utts[idx - 1].endSec) || 0) : 0;
    const prevEndFrame = Math.floor(prevEndBound / frameDur);
    const nextStartBound =
      idx < utts.length - 1 ? Math.min(clipDur, Number(utts[idx + 1].startSec) || clipDur) : clipDur;
    const hasTightPrevTurn = idx > 0 && origStart - prevEndBound <= 0.18;
    const hasTightNextTurn = idx < utts.length - 1 && nextStartBound - origEnd <= 0.18;

    // Search up to ±1.6s when Gemini's boundary lands in silence (bounded by neighbor utterances)
    const searchStartMin = Math.max(
      prevEndFrame,
      Math.floor((origStart - 1.4) / frameDur)
    );
    const searchStartMax = Math.min(
      smooth.length - 1,
      Math.floor((origEnd - 0.2) / frameDur),
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
    } else if (!hasTightPrevTurn) {
      // Already inside speech with clear preceding pause: walk backward to true voice onset
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
      Math.floor((newStart + 0.22) / frameDur),
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
        newEnd = Math.min(clipDur, nextStartBound, chosen * frameDur + 0.08);
      } else if (foundBackward !== -1) {
        newEnd = Math.min(clipDur, nextStartBound, foundBackward * frameDur + 0.08);
      } else if (foundForward !== -1) {
        newEnd = Math.min(clipDur, nextStartBound, foundForward * frameDur + 0.08);
      }
    } else if (!hasTightNextTurn) {
      // Only extend end forward when there is a real pause before the next utterance (never bleed into next speaker)
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
        newEnd = Math.min(clipDur, nextStartBound, f * frameDur + 0.07);
      }
    }

    if (newEnd - newStart < 0.22) {
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
          const localStart = Math.max(0, Math.min(clipDur - 0.22, rawLocalStart));
          const localEnd = Math.max(localStart + 0.22, Math.min(clipDur, rawLocalEnd));
          return { u, localStart, localEnd };
        })
        .sort((a, b) => a.localStart - b.localStart);

      // Resolve any overlapping utterances within the same scene cleanly
      for (let i = 1; i < normalizedUtts.length; i++) {
        const prev = normalizedUtts[i - 1];
        const curr = normalizedUtts[i];
        if (curr.localStart < prev.localEnd) {
          const mid = Number(((prev.localEnd + curr.localStart) / 2).toFixed(2));
          prev.localEnd = Math.max(prev.localStart + 0.2, mid);
          curr.localStart = prev.localEnd;
          curr.localEnd = Math.max(curr.localStart + 0.2, curr.localEnd);
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
  rawLines?: string[];
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
  const cleaned = raw.trim();
  const hms = cleaned.match(/^(\d{1,2}):(\d{2}):(\d{2})(?:[,.](\d{1,3}))?$/);
  if (hms) {
    const h = Number(hms[1]);
    const min = Number(hms[2]);
    const s = Number(hms[3]);
    const ms = hms[4] ? Number(hms[4].padEnd(3, "0")) : 0;
    return h * 3600 + min * 60 + s + ms / 1000;
  }
  const msShort = cleaned.match(/^(\d{1,3}):(\d{2})(?:[,.](\d{1,3}))?$/);
  if (msShort) {
    const min = Number(msShort[1]);
    const s = Number(msShort[2]);
    const ms = msShort[3] ? Number(msShort[3].padEnd(3, "0")) : 0;
    return min * 60 + s + ms / 1000;
  }
  return null;
}

function cleanSubtitleLine(raw: string): string {
  return raw
    .replace(/\{\\[^}]*\}/g, "")
    .replace(/<[^>]+>/g, "")
    .replace(/\r/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function cleanSubtitleText(raw: string): string {
  return raw
    .replace(/\r/g, "")
    .split("\n")
    .map((line) => cleanSubtitleLine(line))
    .filter(Boolean)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

function parseSrtCues(srtContent: string): EmbeddedCue[] {
  const normalized = srtContent.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const blocks = normalized.split(/\n{2,}/);
  const cues: EmbeddedCue[] = [];
  for (const block of blocks) {
    const lines = block
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);
    if (lines.length < 2) continue;
    const firstUpper = lines[0].toUpperCase();
    if (
      firstUpper.startsWith("WEBVTT") ||
      firstUpper.startsWith("NOTE") ||
      firstUpper.startsWith("STYLE") ||
      firstUpper.startsWith("REGION")
    ) {
      if (!lines.some((l) => l.includes("-->"))) continue;
    }
    const timeIdx = lines.findIndex((l) => l.includes("-->"));
    if (timeIdx === -1) continue;
    const parts = lines[timeIdx].split("-->");
    if (parts.length < 2) continue;
    const startSec = parseSrtTimestamp(parts[0].trim().split(/\s+/)[0]);
    const endSec = parseSrtTimestamp(parts[1].trim().split(/\s+/)[0]);
    if (startSec === null || endSec === null || endSec <= startSec) continue;
    const rawLines = lines
      .slice(timeIdx + 1)
      .map((l) => cleanSubtitleLine(l))
      .filter(Boolean);
    const text = rawLines.join(" ").replace(/\s+/g, " ").trim();
    if (!text) continue;
    cues.push({
      startSec: Number(startSec.toFixed(3)),
      endSec: Number(endSec.toFixed(3)),
      text,
      rawLines,
    });
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
            "-vn",
            "-an",
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
  translationTone: TranslationTone = "casual",
  genConfig?: SubtitleGenerationConfig
): string {
  const effectiveCfg =
    genConfig ?? normalizeSubtitleGenerationConfig(undefined, translationTone);
  const cuePayload = cues.map((c, idx) => ({
    index: idx,
    startSec: c.startSec,
    endSec: c.endSec,
    text: c.text,
  }));
  return `This ${clipDurationSec.toFixed(1)}-second video clip already has an EMBEDDED SUBTITLE track. Listen to the accompanying audio for speech cadence and process EVERY embedded subtitle cue below according to the Language & Style Configuration.

EMBEDDED SUBTITLE CUES (JSON):
${JSON.stringify(cuePayload)}

CRITICAL RULES FOR EMBEDDED SUBTITLES:
- You MUST set "hasDialogue": true and return EXACTLY ${cues.length} items in "utterances", one for each embedded cue in the exact same order (index 0 to ${cues.length - 1}).
- For each utterance, KEEP the exact "startSec", "endSec", and "originalSpokenText" from the corresponding embedded cue.
- Word-level "startSec" and "endSec" must stay aligned within that cue's [startSec, endSec] range matching the audio.

${getAdvancedStylePromptBlock(effectiveCfg)}`;
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

interface ProcessProgressEvent {
  stage: "extracting" | "detecting" | "generating" | "compiling";
  label: string;
  percent: number;
  clipIndex?: number;
  totalClips?: number;
}

type PreparedExtractedScene =
  | {
      kind: "embedded";
      scene: SpeakingScene;
      sceneCues: EmbeddedCue[];
      audioBuf: Buffer | null;
    }
  | {
      kind: "pcm";
      scene: SpeakingScene;
      fullPcm: Buffer | null;
    };

function pcmToWavBuffer(pcmSlice: Buffer, sampleRate = 16000): Buffer {
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

async function transcribePreparedExtractedScenes(
  scenes: SpeakingScene[],
  extractedData: PreparedExtractedScene[],
  translationTone: TranslationTone,
  onProgress?: (ev: ProcessProgressEvent) => void,
  genConfig?: SubtitleGenerationConfig
) {
  const ai = getGeminiClient();
  const totalClips = scenes.length;

  type PreparedSceneJob =
    | {
        mode: "embedded";
        scene: SpeakingScene;
        sceneCues: EmbeddedCue[];
        audioBuf: Buffer | null;
      }
    | {
        mode: "empty";
      }
    | {
        mode: "audio";
        scene: SpeakingScene;
        fullPcm: Buffer;
        fullRms: Float32Array;
        fullSpeechWindows: { startSec: number; endSec: number }[];
        subChunks: { startSec: number; endSec: number }[];
      };

  // Phase 2: Detect speech segments & plan audio chunks (40% -> 54%)
  onProgress?.({
    stage: "detecting",
    label: "Detecting speech...",
    percent: 44,
    totalClips,
  });

  const preparedJobs: PreparedSceneJob[] = extractedData.map((item, idx) => {
    if (item.kind === "embedded") {
      return {
        mode: "embedded",
        scene: item.scene,
        sceneCues: item.sceneCues,
        audioBuf: item.audioBuf,
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
      label:
        totalClips > 1
          ? `Detecting speech (${idx + 1}/${totalClips})...`
          : "Detecting speech...",
      percent: Math.round(44 + ((idx + 1) / totalClips) * 10),
      clipIndex: idx,
      totalClips,
    });
    return {
      mode: "audio",
      scene: item.scene,
      fullPcm: item.fullPcm,
      fullRms,
      fullSpeechWindows,
      subChunks,
    };
  });

  // Phase 3: Generate subtitles with Gemini (55% -> 94%)
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
    totalClips,
  });

  const advanceGenProgress = (clipIdx: number) => {
    completedUnits += 1;
    const pct = Math.min(94, Math.round(55 + (completedUnits / totalWorkUnits) * 39));
    onProgress?.({
      stage: "generating",
      label:
        totalClips > 1
          ? `Generating subtitles (${Math.min(totalClips, clipIdx + 1)}/${totalClips})...`
          : "Generating subtitles...",
      percent: pct,
      clipIndex: clipIdx,
      totalClips,
    });
  };

  const emitRetryProgress = (
    clipIdx: number,
    attempt: number,
    maxAttempts: number,
    delayMs?: number,
    isQuota429?: boolean
  ) => {
    const pct = Math.min(94, Math.round(55 + (completedUnits / totalWorkUnits) * 39));
    const waitSec = delayMs && delayMs >= 3000 ? Math.ceil(delayMs / 1000) : 0;
    const label =
      isQuota429 && waitSec > 0
        ? `AI rate limit cooling down, resuming in ${waitSec}s (${attempt}/${maxAttempts})...`
        : `AI model busy, retrying automatically (${attempt}/${maxAttempts})...`;
    onProgress?.({
      stage: "generating",
      label,
      percent: pct,
      clipIndex: clipIdx,
      totalClips,
    });
  };

  const results = await mapWithConcurrency(preparedJobs, 2, async (job, idx) => {
    if (job.mode === "empty") {
      advanceGenProgress(idx);
      return { hasDialogue: false, summary: "No audio", utterances: [] } as RawSceneUtterances;
    }

    if (job.mode === "embedded") {
      const parts: Array<
        { inlineData: { mimeType: string; data: string } } | { text: string }
      > = [];
      if (job.audioBuf) {
        parts.push({
          inlineData: { mimeType: "audio/mp3", data: job.audioBuf.toString("base64") },
        });
      }
      parts.push({
        text: getEmbeddedSubtitlesPrompt(
          job.scene.durationSec,
          job.sceneCues,
          translationTone,
          genConfig
        ),
      });
      const resp = await generateGroundedWithFailover(
        ai,
        { parts },
        sceneTranscriptSchema,
        ThinkingLevel.LOW,
        {
          systemInstruction: buildTranslatorSystemInstruction({
            includeAudioSegmentation: false,
            sourceLangCode: genConfig?.sourceLanguage,
            targetLangCode: genConfig?.targetLanguage,
          }),
          onRetry: ({ attempt, maxAttempts, delayMs, isQuota429 }) =>
            emitRetryProgress(idx, attempt, maxAttempts, delayMs, isQuota429),
        }
      );
      const rawRes = JSON.parse((resp.text || "{}").trim()) as RawSceneUtterances;
      advanceGenProgress(idx);
      return lockUtterancesToEmbeddedCues(rawRes, job.sceneCues);
    }

    const sc = job.scene;
    // Keep inner sub-chunk concurrency at 1 so total in-flight Gemini calls never exceed 2 (prevents TPM bursts)
    const chunkResults = await mapWithConcurrency(job.subChunks, 1, async (ch) => {
      const startFrame = Math.max(0, Math.floor(ch.startSec / 0.01));
      const endFrame = Math.min(job.fullRms.length, Math.ceil(ch.endSec / 0.01));
      const startByte = Math.min(job.fullPcm.length, startFrame * 320);
      const endByte = Math.min(job.fullPcm.length, Math.max(startByte + 640, endFrame * 320));
      const rawWavBuf = pcmToWavBuffer(job.fullPcm.subarray(startByte, endByte), 16000);
      // Enhance speech clarity for ASR while preserving raw RMS envelope for timing alignment
      const speechWavBuf = await enhanceSpeechWavBuffer(rawWavBuf);
      const speechWavBase64 = speechWavBuf.toString("base64");

      const chDur = Math.max(0.2, Number(((endByte - startByte) / 32000).toFixed(2)));
      const absStart = Number((sc.startSec + startFrame * 0.01).toFixed(2));
      const chRms = job.fullRms.subarray(startFrame, endFrame);
      const chWindows = job.fullSpeechWindows
        .filter((w) => w.endSec > ch.startSec + 0.05 && w.startSec < ch.endSec - 0.05)
        .map((w) => ({
          startSec: Number(Math.max(0, w.startSec - startFrame * 0.01).toFixed(2)),
          endSec: Number(Math.min(chDur, w.endSec - startFrame * 0.01).toFixed(2)),
        }));

      // Pass 1: Dedicated speech-to-text engine (gemini-3.5-transcribe) for high-accuracy verbatim words
      const pctPass1 = Math.min(93, Math.round(55 + (completedUnits / totalWorkUnits) * 39));
      onProgress?.({
        stage: "generating",
        label:
          totalClips > 1
            ? `Pass 1/2: Transcribing speech (${Math.min(totalClips, idx + 1)}/${totalClips})...`
            : "Pass 1/2: Transcribing speech...",
        percent: pctPass1,
        clipIndex: idx,
        totalClips,
      });
      const verbatimTranscript = await transcribeAudioVerbatimWithDedicatedModel(
        ai,
        speechWavBase64,
        genConfig?.sourceLanguage
      );

      // Pass 2: Speaker alignment, sub-second timing & 10-Module Burmese translation anchored on Pass 1
      onProgress?.({
        stage: "generating",
        label:
          totalClips > 1
            ? `Pass 2/2: Translating & aligning (${Math.min(totalClips, idx + 1)}/${totalClips})...`
            : "Pass 2/2: Translating & aligning...",
        percent: Math.min(94, pctPass1 + 2),
        clipIndex: idx,
        totalClips,
      });

      const resp = await generateGroundedWithFailover(
        ai,
        {
          parts: [
            { inlineData: { mimeType: "audio/wav", data: speechWavBase64 } },
            {
              text: getClipPrompt(
                chDur,
                absStart,
                absStart + chDur,
                chWindows,
                true,
                translationTone,
                genConfig,
                verbatimTranscript
              ),
            },
          ],
        },
        sceneTranscriptSchema,
        ThinkingLevel.MEDIUM,
        {
          systemInstruction: buildTranslatorSystemInstruction({
            includeAudioSegmentation: true,
            sourceLangCode: genConfig?.sourceLanguage,
            targetLangCode: genConfig?.targetLanguage,
          }),
          onRetry: ({ attempt, maxAttempts, delayMs, isQuota429 }) =>
            emitRetryProgress(idx, attempt, maxAttempts, delayMs, isQuota429),
        }
      );

      const rawChunk = JSON.parse((resp.text || "{}").trim()) as RawSceneUtterances;
      const refinedChunk = refineUtterancesWithEnvelope(rawChunk, chRms, chDur, chWindows);
      advanceGenProgress(idx);
      return { chOffset: Number((startFrame * 0.01).toFixed(2)), refined: refinedChunk };
    });

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
  });

  onProgress?.({
    stage: "compiling",
    label: "Compiling subtitles...",
    percent: 96,
    totalClips,
  });

  return compileSceneTranscripts(scenes, results, true);
}

async function processUploadedVideo(
  persistentPath: string,
  uploadId: string,
  title: string,
  durationSec: number,
  parsedScenes: { startSec: number; endSec: number }[],
  translationTone: TranslationTone = "casual",
  onProgress?: (ev: ProcessProgressEvent) => void,
  genConfig?: SubtitleGenerationConfig
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

    const totalClips = scenes.length;
    onProgress?.({
      stage: "extracting",
      label: "Extracting audio...",
      percent: 22,
      totalClips,
    });

    const embedded = await extractEmbeddedSubtitles(persistentPath, tmpDir);

    // Phase 1: Extract audio streams for each scene using fast input seeking (-ss before -i)
    let extractedCount = 0;
    const extractedData: PreparedExtractedScene[] = await Promise.all(
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
          let audioBuf: Buffer | null = null;
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
                segAudioPath,
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
            label:
              totalClips > 1
                ? `Extracting audio (${extractedCount}/${totalClips})...`
                : "Extracting audio...",
            percent: Math.round(22 + (extractedCount / totalClips) * 18),
            clipIndex: idx,
            totalClips,
          });
          return { kind: "embedded" as const, scene: sc, sceneCues, audioBuf };
        }

        const scenePcmPath = path.join(tmpDir, `scene-${idx}.pcm`);
        let fullPcm: Buffer | null = null;
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
              scenePcmPath,
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
          label:
            totalClips > 1
              ? `Extracting audio (${extractedCount}/${totalClips})...`
              : "Extracting audio...",
          percent: Math.round(22 + (extractedCount / totalClips) * 18),
          clipIndex: idx,
          totalClips,
        });
        return { kind: "pcm" as const, scene: sc, fullPcm };
      })
    );

    const compiled = await transcribePreparedExtractedScenes(
      scenes,
      extractedData,
      translationTone,
      onProgress,
      genConfig
    );
    if (compiled.subtitles.length === 0) {
      return {
        status: 422 as const,
        body: { error: "No spoken dialogue or subtitles were detected inside your selected scenes." },
      };
    }

    const speechRegions = compiled.subtitles.map((s) => ({
      sourceStartSec: s.sourceStartSec,
      sourceEndSec: s.sourceEndSec,
    }));

    return {
      status: 200 as const,
      body: {
        uploadId,
        title,
        channel: embedded ? "Local Video · Embedded Subtitles" : "Local Video",
        sourceDurationSec: durationSec,
        targetDurationSec: compiled.targetDurationSec,
        scenes: compiled.scenes,
        subtitles: compiled.subtitles,
        speechRegions,
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

// Append binary chunk to an initialized upload (supports concurrent random-offset pwrite + sequential fallback)
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

      const isParallelMode =
        String(req.headers["x-chunk-mode"] || "") === "parallel" && declaredOffset !== undefined;

      if (isParallelMode && declaredOffset !== undefined) {
        if (declaredOffset + chunk.length > MAX_UPLOAD_BYTES) {
          await deleteUploadSession(session.id);
          res.status(413).json({ error: "Video upload exceeds the 500 MB server limit." });
          return;
        }
        if (
          session.expectedSize !== undefined &&
          declaredOffset + chunk.length > session.expectedSize
        ) {
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
        const reachedEnd =
          session.expectedSize !== undefined && session.receivedBytes >= session.expectedSize;
        touchUploadSession(session, reachedEnd);
        res.status(200).json({ ok: true, receivedBytes: session.receivedBytes });
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

// Fast path: transcribe pre-sliced client-extracted audio clips without uploading full multi-hundred-MB video files
app.post("/api/process-clip-audio", async (req, res) => {
  const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "clip-audio-"));
  const {
    title = "Uploaded Video",
    durationSec = 120,
    clips = [],
    translationTone,
    generationConfig,
    stream = false,
  } = (req.body || {}) as {
    title?: string;
    durationSec?: number;
    clips?: Array<{
      startSec: number;
      endSec: number;
      trimLeadSec?: number;
      durationSec?: number;
      audioBase64: string;
      mimeType?: string;
    }>;
    translationTone?: TranslationTone;
    generationConfig?: Partial<SubtitleGenerationConfig>;
    stream?: boolean;
  };

  const wantStream = Boolean(stream) || Boolean(req.headers.accept?.includes("application/x-ndjson"));
  const sendNdjson = (payload: Record<string, unknown>) => {
    if (!res.writableEnded) {
      res.write(`${JSON.stringify(payload)}\n`);
    }
  };
  const emitProgress = (ev: ProcessProgressEvent) => {
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
    const normalizedGenConfig = normalizeSubtitleGenerationConfig(
      generationConfig,
      tone
    );
    const totalClips = scenes.length;
    emitProgress({
      stage: "extracting",
      label: "Decoding clip audio...",
      percent: 22,
      totalClips,
    });

    let decodedCount = 0;
    const extractedData: PreparedExtractedScene[] = await Promise.all(
      scenes.map(async (sc, idx) => {
        const clip = clips[idx];
        const rawBuf = clip?.audioBase64 ? Buffer.from(clip.audioBase64, "base64") : null;
        if (!rawBuf || rawBuf.length < 32) {
          decodedCount += 1;
          return { kind: "pcm" as const, scene: sc, fullPcm: null };
        }
        const ext = clip.mimeType?.includes("wav") ? ".wav" : ".m4a";
        const inPath = path.join(tmpDir, `clip-${idx}${ext}`);
        const outPcmPath = path.join(tmpDir, `clip-${idx}.pcm`);
        await fs.promises.writeFile(inPath, rawBuf);
        let fullPcm: Buffer | null = null;
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
              outPcmPath,
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
          label:
            totalClips > 1
              ? `Preparing audio (${decodedCount}/${totalClips})...`
              : "Preparing audio...",
          percent: Math.round(22 + (decodedCount / totalClips) * 18),
          clipIndex: idx,
          totalClips,
        });
        return { kind: "pcm" as const, scene: sc, fullPcm };
      })
    );

    const compiled = await transcribePreparedExtractedScenes(
      scenes,
      extractedData,
      tone,
      emitProgress,
      normalizedGenConfig
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
      sourceEndSec: s.sourceEndSec,
    }));

    const payload = {
      title,
      channel: "Local Video",
      sourceDurationSec: totalDuration,
      targetDurationSec: compiled.targetDurationSec,
      scenes: compiled.scenes,
      subtitles: compiled.subtitles,
      speechRegions,
      keyframeUrls: [],
    };

    if (wantStream) {
      emitProgress({
        stage: "compiling",
        label: "Subtitles ready",
        percent: 100,
        totalClips,
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
    await fs.promises.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
});

function buildRawUtterancesFromImportedCues(cues: EmbeddedCue[]): RawSceneUtterances {
  const hasMyanmar = (s: string) => /[\u1000-\u109F]/.test(s);
  const hasThai = (s: string) => /[\u0E00-\u0E7F]/.test(s);

  const utterances = cues.map((cue) => {
    const lines = (cue.rawLines && cue.rawLines.length > 0 ? cue.rawLines : [cue.text]).filter(Boolean);
    let thaiScript = "";
    let thaiPhonetic = "";
    let burmese = "";

    if (lines.length >= 2) {
      for (const ln of lines) {
        if (hasMyanmar(ln) && !burmese) {
          burmese = ln;
        } else if (hasThai(ln) && !thaiScript) {
          thaiScript = ln;
        } else if (!thaiPhonetic) {
          thaiPhonetic = ln;
        } else {
          burmese = burmese ? `${burmese} ${ln}` : ln;
        }
      }
      if (!thaiPhonetic) thaiPhonetic = thaiScript || burmese || cue.text;
      if (!thaiScript) thaiScript = thaiPhonetic;
      if (!burmese) burmese = cue.text;
    } else {
      const single = lines[0] || cue.text;
      if (hasMyanmar(single)) {
        burmese = single;
        thaiScript = single;
        thaiPhonetic = single;
      } else if (hasThai(single)) {
        thaiScript = single;
        thaiPhonetic = single;
        burmese = single;
      } else {
        thaiScript = single;
        thaiPhonetic = single;
        burmese = single;
      }
    }

    const words: RawSceneWord[] = thaiPhonetic
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
      words,
    };
  });

  return {
    hasDialogue: utterances.length > 0,
    summary: "Imported SRT/VTT subtitles",
    utterances,
  };
}

// Import external .SRT or .VTT subtitles (CapCut, Whisper, YouTube CC, etc.) with exact timestamps
// and optional batched AI translation into Burmese + Thai phonetic using the 10-module translator.
app.post("/api/import-subtitles", async (req, res) => {
  const {
    title = "Uploaded Video",
    durationSec = 120,
    selectedScenes = [],
    srtContent = "",
    mode = "translate",
    translationTone,
    generationConfig,
    stream = false,
  } = (req.body || {}) as {
    title?: string;
    durationSec?: number;
    selectedScenes?: { startSec: number; endSec: number }[];
    srtContent?: string;
    mode?: "translate" | "raw";
    translationTone?: TranslationTone;
    generationConfig?: Partial<SubtitleGenerationConfig>;
    stream?: boolean;
  };

  const wantStream = Boolean(stream) || Boolean(req.headers.accept?.includes("application/x-ndjson"));
  const sendNdjson = (payload: Record<string, unknown>) => {
    if (!res.writableEnded) {
      res.write(`${JSON.stringify(payload)}\n`);
    }
  };
  const emitProgress = (ev: ProcessProgressEvent) => {
    if (wantStream) {
      sendNdjson({ type: "progress", ...ev });
    }
  };

  try {
    if (typeof srtContent !== "string" || !srtContent.trim()) {
      res.status(400).json({ error: "Please select or paste a valid .SRT or .VTT subtitle file." });
      return;
    }

    const parsedCues = parseSrtCues(srtContent);
    if (parsedCues.length === 0) {
      res.status(400).json({
        error:
          "No valid timestamped subtitle cues were found in this file. Please upload a standard .srt or .vtt file.",
      });
      return;
    }

    const maxCueEnd = parsedCues.reduce((m, c) => Math.max(m, c.endSec), 0);
    const totalDuration = Math.max(5, Number(durationSec) || 0, Math.ceil(maxCueEnd));
    const rawScenes =
      Array.isArray(selectedScenes) && selectedScenes.length > 0
        ? selectedScenes
        : [{ startSec: 0, endSec: totalDuration }];
    const scenes = normalizeSelectedScenes(rawScenes, totalDuration);

    if (scenes.length === 0) {
      res.status(400).json({ error: "Select at least one scene before importing subtitles." });
      return;
    }

    if (wantStream) {
      res.setHeader("Content-Type", "application/x-ndjson; charset=utf-8");
      res.setHeader("Cache-Control", "no-cache, no-transform");
      res.setHeader("X-Accel-Buffering", "no");
      res.flushHeaders?.();
    }

    const tone = normalizeTranslationTone(translationTone);
    const normalizedGenConfig = normalizeSubtitleGenerationConfig(generationConfig, tone);
    const totalClips = scenes.length;

    emitProgress({
      stage: "detecting",
      label: `Parsed ${parsedCues.length} cues from SRT/VTT...`,
      percent: 15,
      totalClips,
    });

    // Slice cues cleanly to match each active timeline scene
    const sceneCueLists: EmbeddedCue[][] = scenes.map((sc) =>
      parsedCues
        .filter((c) => c.endSec > sc.startSec + 0.05 && c.startSec < sc.endSec - 0.05)
        .map((c) => ({
          startSec: Number(Math.max(0, c.startSec - sc.startSec).toFixed(3)),
          endSec: Number(Math.min(sc.durationSec, c.endSec - sc.startSec).toFixed(3)),
          text: c.text,
          rawLines: c.rawLines,
        }))
        .filter((c) => c.endSec > c.startSec + 0.04)
    );

    const totalMatchedCues = sceneCueLists.reduce((acc, list) => acc + list.length, 0);
    if (totalMatchedCues === 0) {
      const msg =
        "None of the SRT/VTT cue timestamps fall inside your selected timeline clip range(s).";
      if (wantStream) {
        sendNdjson({ type: "error", status: 422, error: msg });
        res.end();
      } else {
        res.status(422).json({ error: msg });
      }
      return;
    }

    let sceneResults: RawSceneUtterances[];

    if (mode === "raw") {
      sceneResults = sceneCueLists.map((cues) => buildRawUtterancesFromImportedCues(cues));
      emitProgress({
        stage: "compiling",
        label: "Loading imported subtitles...",
        percent: 90,
        totalClips,
      });
    } else {
      const ai = getGeminiClient();
      const BATCH_SIZE = 25;
      const totalBatches = Math.max(
        1,
        sceneCueLists.reduce((acc, list) => acc + Math.ceil(list.length / BATCH_SIZE), 0)
      );
      let completedBatches = 0;

      sceneResults = [];
      for (let scIdx = 0; scIdx < scenes.length; scIdx++) {
        const sc = scenes[scIdx];
        const cues = sceneCueLists[scIdx];
        if (cues.length === 0) {
          sceneResults.push({ hasDialogue: false, summary: "No cues in clip", utterances: [] });
          continue;
        }

        const mergedUtterances: NonNullable<RawSceneUtterances["utterances"]> = [];
        for (let offset = 0; offset < cues.length; offset += BATCH_SIZE) {
          const batch = cues.slice(offset, offset + BATCH_SIZE);
          const pct = Math.min(92, Math.round(20 + (completedBatches / totalBatches) * 72));
          emitProgress({
            stage: "generating",
            label: `Translating SRT cues (${Math.min(offset + batch.length, cues.length)}/${cues.length})...`,
            percent: pct,
            clipIndex: scIdx,
            totalClips,
          });

          const resp = await generateGroundedWithFailover(
            ai,
            getEmbeddedSubtitlesPrompt(sc.durationSec, batch, tone, normalizedGenConfig),
            sceneTranscriptSchema,
            ThinkingLevel.LOW,
            {
              systemInstruction: buildTranslatorSystemInstruction({
                includeAudioSegmentation: false,
                sourceLangCode: normalizedGenConfig.sourceLanguage,
                targetLangCode: normalizedGenConfig.targetLanguage,
              }),
              onRetry: ({ attempt, maxAttempts, delayMs, isQuota429 }) => {
                const waitSec = delayMs >= 3000 ? Math.ceil(delayMs / 1000) : 0;
                emitProgress({
                  stage: "generating",
                  label:
                    isQuota429 && waitSec > 0
                      ? `AI rate limit cooling down, resuming in ${waitSec}s (${attempt}/${maxAttempts})...`
                      : `AI model busy, retrying (${attempt}/${maxAttempts})...`,
                  percent: pct,
                  clipIndex: scIdx,
                  totalClips,
                });
              },
            }
          );

          const rawRes = JSON.parse((resp.text || "{}").trim()) as RawSceneUtterances;
          const locked = lockUtterancesToEmbeddedCues(rawRes, batch);
          if (Array.isArray(locked.utterances)) {
            mergedUtterances.push(...locked.utterances);
          }
          completedBatches += 1;
        }

        sceneResults.push({
          hasDialogue: mergedUtterances.length > 0,
          summary: "Imported SRT/VTT subtitles",
          utterances: mergedUtterances,
        });
      }
    }

    emitProgress({
      stage: "compiling",
      label: "Compiling subtitles...",
      percent: 96,
      totalClips,
    });

    const compiled = compileSceneTranscripts(scenes, sceneResults, true);
    const speechRegions = compiled.subtitles.map((s) => ({
      sourceStartSec: s.sourceStartSec,
      sourceEndSec: s.sourceEndSec,
    }));

    const payload = {
      title,
      channel: "Imported SRT/VTT",
      sourceDurationSec: totalDuration,
      targetDurationSec: compiled.targetDurationSec,
      scenes: compiled.scenes,
      subtitles: compiled.subtitles,
      speechRegions,
      keyframeUrls: [],
    };

    if (wantStream) {
      emitProgress({
        stage: "compiling",
        label: "Imported subtitles ready",
        percent: 100,
        totalClips,
      });
      sendNdjson({ type: "result", status: 200, data: payload });
      res.end();
      return;
    }

    res.json(payload);
  } catch (err) {
    console.error("Import subtitles error:", err);
    const formatted = formatGeminiError(err, "Failed to import SRT/VTT subtitles.");
    if (wantStream && res.headersSent) {
      sendNdjson({ type: "error", status: formatted.status, error: formatted.message });
      res.end();
      return;
    }
    res.status(formatted.status).json({ error: formatted.message });
  }
});

// Export audio-only (.mp3 or .wav) from fast client-extracted clips or an uploaded video file
app.post("/api/export-audio", async (req, res) => {
  const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "export-audio-"));
  try {
    const {
      uploadId,
      clips = [],
      selectedScenes = [],
      durationSec = 120,
      title = "audio",
      format = "mp3",
    } = (req.body || {}) as {
      uploadId?: string;
      clips?: Array<{
        startSec: number;
        endSec: number;
        trimLeadSec?: number;
        durationSec?: number;
        audioBase64: string;
        mimeType?: string;
      }>;
      selectedScenes?: { startSec: number; endSec: number }[];
      durationSec?: number;
      title?: string;
      format?: "mp3" | "wav";
    };

    const outFormat: "mp3" | "wav" = format === "wav" ? "wav" : "mp3";
    const safeSlug =
      String(title || "audio")
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, "")
        .slice(0, 48) || "audio";
    const outPath = path.join(tmpDir, `exported-audio.${outFormat}`);

    const encodeOutputFromInput = async (
      inputArgs: string[],
      extraFilter?: string[]
    ) => {
      const codecArgs =
        outFormat === "wav"
          ? ["-c:a", "pcm_s16le", "-ac", "1", "-ar", "16000"]
          : ["-c:a", "libmp3lame", "-b:a", "128k", "-ac", "2", "-ar", "44100"];
      await execFileAsync(
        "ffmpeg",
        [
          "-y",
          ...inputArgs,
          "-vn",
          "-sn",
          "-dn",
          ...(extraFilter ?? []),
          ...codecArgs,
          outPath,
        ],
        { ...FFMPEG_EXEC_OPTS, timeout: 110_000 }
      );
    };

    const segPaths: string[] = [];

    if (Array.isArray(clips) && clips.length > 0) {
      const totalDuration = Math.max(1, Number(durationSec) || 120);
      const scenes = normalizeSelectedScenes(
        clips.map((c) => ({ startSec: c.startSec, endSec: c.endSec })),
        totalDuration
      );
      if (scenes.length === 0) {
        res.status(400).json({ error: "No valid clips provided for audio export." });
        return;
      }

      for (let i = 0; i < scenes.length; i++) {
        const sc = scenes[i];
        const clip = clips[i];
        if (!clip?.audioBase64) continue;
        const rawBuf = Buffer.from(clip.audioBase64, "base64");
        if (rawBuf.length < 32) continue;
        const ext = clip.mimeType?.includes("wav") ? ".wav" : ".m4a";
        const inPath = path.join(tmpDir, `clip-${i}${ext}`);
        const segPath = path.join(tmpDir, `seg-${i}.wav`);
        await fs.promises.writeFile(inPath, rawBuf);
        const trimLead = Math.max(0, Number(clip.trimLeadSec) || 0);
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
            "-c:a",
            "pcm_s16le",
            "-ac",
            "2",
            "-ar",
            "44100",
            segPath,
          ],
          { ...FFMPEG_EXEC_OPTS, timeout: 90_000 }
        );
        if (fs.existsSync(segPath) && fs.statSync(segPath).size > 44) {
          segPaths.push(segPath);
        }
      }
    } else if (uploadId && typeof uploadId === "string") {
      const extracted = await withUploadSessionLock(
        uploadId,
        async (uploadedPath) => {
          const totalDuration = Math.max(1, Number(durationSec) || 120);
          const rawScenes =
            Array.isArray(selectedScenes) && selectedScenes.length > 0
              ? selectedScenes
              : [{ startSec: 0, endSec: totalDuration }];
          const scenes = normalizeSelectedScenes(rawScenes, totalDuration);
          if (scenes.length === 0) return [];
          const outSegs: string[] = [];
          for (let i = 0; i < scenes.length; i++) {
            const sc = scenes[i];
            const segPath = path.join(tmpDir, `up-seg-${i}.wav`);
            await execFileAsync(
              "ffmpeg",
              [
                "-y",
                "-ss",
                sc.startSec.toFixed(3),
                "-i",
                uploadedPath,
                "-t",
                String(sc.durationSec),
                "-vn",
                "-sn",
                "-dn",
                "-af",
                "aresample=async=1:first_pts=0",
                "-c:a",
                "pcm_s16le",
                "-ac",
                "2",
                "-ar",
                "44100",
                segPath,
              ],
              { ...FFMPEG_EXEC_OPTS, timeout: 90_000 }
            );
            if (fs.existsSync(segPath) && fs.statSync(segPath).size > 44) {
              outSegs.push(segPath);
            }
          }
          return outSegs;
        },
        { markFinalized: true }
      );
      if (!extracted) {
        res.status(404).json({ error: "Uploaded video file not found. Please try again." });
        return;
      }
      segPaths.push(...extracted);
    } else {
      res.status(400).json({ error: "No video or audio clips provided for audio export." });
      return;
    }

    if (segPaths.length === 0) {
      res.status(422).json({ error: "No audio track was found in this video." });
      return;
    }

    if (segPaths.length === 1) {
      await encodeOutputFromInput(["-i", segPaths[0]]);
    } else {
      const concatListPath = path.join(tmpDir, "concat.txt");
      const concatBody = segPaths
        .map((p) => `file '${p.replace(/'/g, "'\\''")}'`)
        .join("\n");
      await fs.promises.writeFile(concatListPath, concatBody, "utf8");
      await encodeOutputFromInput(["-f", "concat", "-safe", "0", "-i", concatListPath]);
    }

    if (!fs.existsSync(outPath) || fs.statSync(outPath).size === 0) {
      res.status(500).json({ error: "Failed to encode audio file." });
      return;
    }

    const audioBuf = await fs.promises.readFile(outPath);
    res.setHeader(
      "Content-Type",
      outFormat === "wav" ? "audio/wav" : "audio/mpeg"
    );
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${safeSlug}-audio.${outFormat}"`
    );
    res.setHeader("Content-Length", String(audioBuf.length));
    res.send(audioBuf);
  } catch (err) {
    console.error("Export audio error:", err);
    if (!res.headersSent) {
      res.status(500).json({ error: "Failed to export audio from this video." });
    }
  } finally {
    await fs.promises.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
});

// Process an already-uploaded video file (detects embedded subtitles first, else transcribes audio)
app.post("/api/process-upload", async (req, res) => {
  const {
    uploadId,
    title = "Uploaded Video",
    durationSec = 120,
    selectedScenes = [],
    translationTone,
    generationConfig,
    stream = false,
  } = req.body as {
    uploadId?: string;
    title?: string;
    durationSec?: number;
    selectedScenes?: { startSec: number; endSec: number }[];
    translationTone?: TranslationTone;
    generationConfig?: Partial<SubtitleGenerationConfig>;
    stream?: boolean;
  };

  const wantStream = Boolean(stream) || Boolean(req.headers.accept?.includes("application/x-ndjson"));
  const sendNdjson = (payload: Record<string, unknown>) => {
    if (!res.writableEnded) {
      res.write(`${JSON.stringify(payload)}\n`);
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
    const normalizedGenConfig = normalizeSubtitleGenerationConfig(
      generationConfig,
      tone
    );
    const lockedResult = await withUploadSessionLock(
      uploadId,
      async (persistentPath) =>
        processUploadedVideo(
          persistentPath,
          uploadId,
          title,
          Math.max(5, Number(durationSec) || 120),
          selectedScenes,
          tone,
          wantStream ? (ev) => sendNdjson({ type: "progress", ...ev }) : undefined,
          normalizedGenConfig
        ),
      { markFinalized: true }
    );

    if (!lockedResult) {
      if (wantStream) {
        sendNdjson({
          type: "error",
          status: 404,
          error: "Uploaded video file not found. Please try again.",
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
          error: (lockedResult.body as { error?: string }).error || "Failed to process uploaded video.",
        });
      } else {
        sendNdjson({
          type: "progress",
          stage: "compiling",
          label: "Subtitles ready",
          percent: 100,
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
      uploadId,
      clipAudioBase64,
      clipMimeType,
      subtitle,
      prevContext,
      nextContext,
      customHint,
      translationTone,
    } = (req.body || {}) as {
      uploadId?: string;
      clipAudioBase64?: string;
      clipMimeType?: string;
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

    const hasAudio = Boolean(audioBase64);
    const ai = getGeminiClient();

    let enhancedAudioBase64 = audioBase64;
    let pass1Verbatim: string | null = null;
    if (audioBase64) {
      const enhancedBuf = await enhanceSpeechWavBuffer(Buffer.from(audioBase64, "base64"));
      enhancedAudioBase64 = enhancedBuf.toString("base64");
      pass1Verbatim = await transcribeAudioVerbatimWithDedicatedModel(ai, enhancedAudioBase64, "th");
    }

    const pass1AnchorBlock = pass1Verbatim
      ? `\nPASS-1 VERBATIM SPEECH TRANSCRIPT (from dedicated speech engine — use as primary word anchor while verifying against the audio):\n"""\n${pass1Verbatim}\n"""\n`
      : "";

    const promptText = `${
      hasAudio
        ? `Listen very carefully to the SPOKEN AUDIO of this single ${lineDur.toFixed(2)}-second dialogue line.`
        : `Re-transcribe/correct and accurately translate this single ${lineDur.toFixed(2)}-second dialogue line using the spoken text and surrounding dialogue context.`
    }
${contextBlock}${userHintBlock}${pass1AnchorBlock}
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

    const contents: Parameters<typeof generateGroundedWithFailover>[1] = enhancedAudioBase64
      ? {
          parts: [
            { inlineData: { mimeType: "audio/wav", data: enhancedAudioBase64 } },
            { text: promptText },
          ],
        }
      : promptText;

    const resp = await generateGroundedWithFailover(
      ai,
      contents,
      singleSubtitleSchema,
      ThinkingLevel.HIGH,
      {
        systemInstruction: buildTranslatorSystemInstruction({
          includeAudioSegmentation: false,
          sourceLangCode: "th",
          targetLangCode: "my",
        }),
      }
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
    const formatted = formatGeminiError(err, "Failed to regenerate subtitle with AI.");
    res.status(formatted.status).json({ error: formatted.message });
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

First analyze the whole sequence: what topic is being discussed, who is talking to whom & their relationship (gender, age, closeness, politeness), and the emotional/situational mood — then reflect that consistently in Burmese pronouns, kinship terms, vocabulary, and particles.

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
        ThinkingLevel.MEDIUM,
        {
          systemInstruction: buildTranslatorSystemInstruction({
            includeAudioSegmentation: false,
            sourceLangCode: "th",
            targetLangCode: "my",
          }),
        }
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
    const formatted = formatGeminiError(err, "Failed to re-translate subtitles.");
    res.status(formatted.status).json({ error: formatted.message });
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
      uploadId,
      clipsAudio,
      scenes = [],
      subtitles = [],
    } = (req.body || {}) as {
      uploadId?: string;
      clipsAudio?: Array<{
        trimLeadSec?: number;
        durationSec: number;
        audioBase64: string;
        mimeType?: string;
      }>;
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

    let audioPrep: {
      mp3Base64: string;
      rms: Float32Array;
      speechWindows: SpeechWindow[];
    } | null = null;

    if (Array.isArray(clipsAudio) && clipsAudio.length > 0) {
        const pcmBuffers: Buffer[] = [];
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
                scPcmPath,
              ],
              FFMPEG_EXEC_OPTS
            );
            if (fs.existsSync(scPcmPath)) {
              pcmBuffers.push(await fs.promises.readFile(scPcmPath));
            }
          } catch {
            const silentBytes = Math.max(320, Math.round(dur * 16000) * 2);
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
              cutMp3Path,
            ],
            FFMPEG_EXEC_OPTS
          );
          const mp3Buf = await fs.promises.readFile(cutMp3Path);
          const rms = computeRmsEnvelope10ms(cutPcm);
          const speechWindows = detectSpeechSegments10ms(rms, totalCutDur);
          audioPrep = {
            mp3Base64: mp3Buf.toString("base64"),
            rms,
            speechWindows,
          };
        }
      } else {
        if (!uploadId) {
          res.status(404).json({ error: "Uploaded video session not found." });
          return;
        }

        audioPrep = await withUploadSessionLock(uploadId, async (uploadedPath) => {
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
      }

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
  } catch (err) {
    console.error("Resync subtitles error:", err);
    const formatted = formatGeminiError(err, "Failed to resync subtitle timings with AI.");
    res.status(formatted.status).json({ error: formatted.message });
  } finally {
    await fs.promises.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
});

function mapCutTimeToSourceServer(
  scenes: Array<{ startSec: number; endSec: number; durationSec?: number }>,
  cutTime: number
): { sceneIndex: number; sourceSec: number } {
  if (!Array.isArray(scenes) || scenes.length === 0) {
    return { sceneIndex: 0, sourceSec: Number(Math.max(0, cutTime).toFixed(2)) };
  }
  let acc = 0;
  for (let i = 0; i < scenes.length; i++) {
    const s = scenes[i];
    const dur = Math.max(0.1, Number(s.durationSec) || Number(s.endSec) - Number(s.startSec) || 0.1);
    if (cutTime < acc + dur - 0.001 || i === scenes.length - 1) {
      const offset = Math.max(0, Math.min(dur, cutTime - acc));
      return {
        sceneIndex: i,
        sourceSec: Number(Math.min(Number(s.endSec), Number(s.startSec) + offset).toFixed(2)),
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
      scenes = [],
    } = (req.body || {}) as {
      startSec?: number;
      endSec?: number;
      prevContext?: RegenerateContextLine | null;
      nextContext?: RegenerateContextLine | null;
      translationTone?: TranslationTone;
      uploadId?: string;
      clipAudioBase64?: string;
      mimeType?: string;
      trimLeadSec?: number;
      clipsAudio?: Array<{
        trimLeadSec?: number;
        durationSec: number;
        audioBase64: string;
        mimeType?: string;
      }>;
      scenes?: { startSec: number; endSec: number; durationSec?: number }[];
    };

    const rawStart = Number(startSec);
    const rawEnd = Number(endSec);
    if (!Number.isFinite(rawStart) || !Number.isFinite(rawEnd) || rawEnd <= rawStart + 0.2) {
      res.status(400).json({ error: "Select a valid time range (at least 0.25s) to transcribe." });
      return;
    }

    const normalizedScenes = (Array.isArray(scenes) ? scenes : [])
      .map((sc) => {
        const s = Math.max(0, Number(sc.startSec) || 0);
        const e = Math.max(s + 0.2, Number(sc.endSec) || s + 1);
        return { startSec: s, endSec: e, durationSec: Number((e - s).toFixed(2)) };
      })
      .filter((sc) => sc.durationSec >= 0.2);

    const totalCutDur =
      normalizedScenes.length > 0
        ? normalizedScenes.reduce((acc, sc) => acc + sc.durationSec, 0)
        : 0;

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
    const contextLines: string[] = [];
    if (
      prevContext &&
      (prevContext.originalSpokenText || prevContext.thaiPhonetic || prevContext.burmese)
    ) {
      contextLines.push(
        `Previous subtitle (just BEFORE ${reqStart.toFixed(2)}s — match tone/style, do NOT repeat it): spoken="${prevContext.originalSpokenText || ""}" | phonetic="${prevContext.thaiPhonetic || ""}" | thai="${prevContext.thaiScript || ""}" | burmese="${prevContext.burmese || ""}"`
      );
    }
    if (
      nextContext &&
      (nextContext.originalSpokenText || nextContext.thaiPhonetic || nextContext.burmese)
    ) {
      contextLines.push(
        `Next subtitle (just AFTER ${reqEnd.toFixed(2)}s — match tone/style, do NOT repeat it): spoken="${nextContext.originalSpokenText || ""}" | phonetic="${nextContext.thaiPhonetic || ""}" | thai="${nextContext.thaiScript || ""}" | burmese="${nextContext.burmese || ""}"`
      );
    }
    const contextBlock =
      contextLines.length > 0
        ? `\nSURROUNDING DIALOGUE CONTEXT:\n${contextLines.join("\n")}\n`
        : "";

    const ai = getGeminiClient();

    interface LocalRangeAudioPrep {
      wavBase64: string;
      rms: Float32Array;
      speechWindows: SpeechWindow[];
      clipDur: number;
    }

    let localAudioPrep: LocalRangeAudioPrep | null = null;
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
              ...(lead > 0.005 ? ["-ss", lead.toFixed(4)] : []),
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
              pcmPath,
            ],
            FFMPEG_EXEC_OPTS
          );
          if (fs.existsSync(pcmPath)) {
            const pcmBuf = await fs.promises.readFile(pcmPath);
            if (pcmBuf.length >= 640) {
              const clipDur = Math.max(0.4, Number((pcmBuf.length / 32000).toFixed(2)));
              const rms = computeRmsEnvelope10ms(pcmBuf);
              const speechWindows = detectSpeechSegments10ms(rms, clipDur);
              const wavBuf = pcmToWavBuffer(pcmBuf, 16000);
              localAudioPrep = {
                wavBase64: wavBuf.toString("base64"),
                rms,
                speechWindows,
                clipDur,
              };
            }
          }
        } catch {
          localAudioPrep = null;
        }
      } else if (Array.isArray(clipsAudio) && clipsAudio.length > 0) {
        const pcmBuffers: Buffer[] = [];
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
                scPcmPath,
              ],
              FFMPEG_EXEC_OPTS
            );
            if (fs.existsSync(scPcmPath)) {
              pcmBuffers.push(await fs.promises.readFile(scPcmPath));
            }
          } catch {
            const silentBytes = Math.max(320, Math.round(dur * 16000) * 2);
            pcmBuffers.push(Buffer.alloc(silentBytes));
          }
        }
        const cutPcm = Buffer.concat(pcmBuffers);
        if (cutPcm.length >= 640) {
          const clipDur = Math.max(0.4, Number((cutPcm.length / 32000).toFixed(2)));
          const rms = computeRmsEnvelope10ms(cutPcm);
          const speechWindows = detectSpeechSegments10ms(rms, clipDur);
          const wavBuf = pcmToWavBuffer(cutPcm, 16000);
          localAudioPrep = {
            wavBase64: wavBuf.toString("base64"),
            rms,
            speechWindows,
            clipDur,
          };
        }
      } else {
        if (!uploadId) {
          res.status(404).json({ error: "Uploaded video session not found." });
          return;
        }
        localAudioPrep = await withUploadSessionLock(uploadId, async (uploadedPath) => {
          const slices: Array<{ srcStart: number; dur: number }> = [];
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
                  dur: Number((ovEnd - ovStart).toFixed(3)),
                });
              }
              cutAcc = scCutEnd;
            }
          } else {
            slices.push({
              srcStart: paddedCutStart,
              dur: Number(targetDur.toFixed(3)),
            });
          }

          const pcmBuffers: Buffer[] = [];
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
                  slPcmPath,
                ],
                FFMPEG_EXEC_OPTS
              );
              if (fs.existsSync(slPcmPath)) {
                pcmBuffers.push(await fs.promises.readFile(slPcmPath));
              }
            } catch {
              const silentBytes = Math.max(320, Math.round(sl.dur * 16000) * 2);
              pcmBuffers.push(Buffer.alloc(silentBytes));
            }
          }

          const pcmBuf = Buffer.concat(pcmBuffers);
          if (pcmBuf.length < 640) return null;
          const clipDur = Math.max(0.4, Number((pcmBuf.length / 32000).toFixed(2)));
          const rms = computeRmsEnvelope10ms(pcmBuf);
          const speechWindows = detectSpeechSegments10ms(rms, clipDur);
          const wavBuf = pcmToWavBuffer(pcmBuf, 16000);
          return {
            wavBase64: wavBuf.toString("base64"),
            rms,
            speechWindows,
            clipDur,
          };
        });
      }

    if (!localAudioPrep) {
      res.status(404).json({ error: "Uploaded video audio segment could not be extracted." });
      return;
    }

    const vadWindows = localAudioPrep.speechWindows
      .filter((w) => w.endSec > focusStartInClip - 0.15 && w.startSec < focusEndInClip + 0.15)
      .map((w) => ({
        startSec: Number(Math.max(0, w.startSec).toFixed(2)),
        endSec: Number(Math.min(localAudioPrep.clipDur, w.endSec).toFixed(2)),
      }));

      const vadBlock =
        vadWindows.length > 0
          ? `\nWAVEFORM-DETECTED SPEECH WINDOWS (seconds relative to 0.0s start of this clip):\n${vadWindows
              .map((w, i) => `  [${i + 1}] ${w.startSec.toFixed(2)}s – ${w.endSec.toFixed(2)}s`)
              .join("\n")}\n`
          : "";

      const enhancedRangeBuf = await enhanceSpeechWavBuffer(
        Buffer.from(localAudioPrep.wavBase64, "base64")
      );
      const enhancedRangeBase64 = enhancedRangeBuf.toString("base64");
      const rangePass1Verbatim = await transcribeAudioVerbatimWithDedicatedModel(
        ai,
        enhancedRangeBase64,
        "th"
      );
      const rangePass1Block = rangePass1Verbatim
        ? `\nPASS-1 VERBATIM SPEECH TRANSCRIPT (from dedicated speech engine — use as primary word anchor while checking exact target window bounds):\n"""\n${rangePass1Verbatim}\n"""\n`
        : "";

      const prompt = `Listen carefully to this ${localAudioPrep.clipDur.toFixed(2)}-second audio clip.
The user wants to fill missed subtitle(s) specifically for the TARGET WINDOW [${focusStartInClip.toFixed(2)}s – ${focusEndInClip.toFixed(2)}s] inside this clip (there is ~${padLead.toFixed(2)}s leading context buffer and trailing buffer around it so boundary syllables stay intact).
${vadBlock}${rangePass1Block}${contextBlock}
CRITICAL RULES:
- ONLY transcribe and translate spoken dialogue actually heard inside (or primarily spanning) the target window [${focusStartInClip.toFixed(2)}s – ${focusEndInClip.toFixed(2)}s].
- Do NOT repeat or duplicate the Previous/Next surrounding context lines if only their edges appear in the padding buffer.
- If there is NO spoken human dialogue in the target window (only silence, background noise, or music), set "hasDialogue": false and return an empty "utterances" array.
- Report ALL "startSec" and "endSec" values relative to 0.0s start of this audio clip (${localAudioPrep.clipDur.toFixed(2)}s total) with sub-second precision.
- SPEAKER & PHRASE SEPARATION: Identify "speaker" ("S1", "S2", ...) for every utterance. Whenever a different speaker talks — even back-to-back with zero gap — or when distinct sentences/clauses are spoken, ALWAYS split into separate chronological, non-overlapping utterances. NEVER merge two speakers into one subtitle.

${getTranslationToneInstruction(tone)}

For each spoken utterance:
- "speaker": Speaker label ("S1", "S2", ...) matching the active voice.
- "originalSpokenText": Exact verbatim words spoken.
- "thaiScript": Verbatim Thai script if spoken in Thai, otherwise natural Thai translation.
- "thaiPhonetic": Clear English phonetic pronunciation of the Thai speech (e.g. "Sa-wat-dee khrap").
- "burmese": Accurate Burmese translation (မြန်မာဘာသာပြန်) matching the tone and surrounding context.
- "words": Split "thaiPhonetic" into space-separated word tokens with matching "thai", a 1-2 word "burmeseGloss" for content words ("" for particles), and clip-relative "startSec"/"endSec".`;

      const resp = await generateGroundedWithFailover(
        ai,
        {
          parts: [
            { inlineData: { mimeType: "audio/wav", data: enhancedRangeBase64 } },
            { text: prompt },
          ],
        },
        sceneTranscriptSchema,
        ThinkingLevel.HIGH,
        {
          systemInstruction: buildTranslatorSystemInstruction({
            includeAudioSegmentation: true,
            sourceLangCode: "th",
            targetLangCode: "my",
          }),
        }
      );
    const parsed = JSON.parse((resp.text || "{}").trim()) as RawSceneUtterances;
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
        subtitles: [],
      });
      return;
    }

    interface MappedRangeUtt {
      cutStart: number;
      cutEnd: number;
      rawCutStart: number;
      rawCutEnd: number;
      u: NonNullable<RawSceneUtterances["utterances"]>[number];
    }

    const mappedUtts: MappedRangeUtt[] = [];
    for (const u of rawRes.utterances) {
      const hasText = Boolean(
        (u.thaiPhonetic || "").trim() ||
          (u.thaiScript || "").trim() ||
          (u.burmese || "").trim() ||
          (u.originalSpokenText || "").trim()
      );
      if (!hasText) continue;

      const rawCutStart = paddedCutStart + (Number(u.startSec) || 0);
      const rawCutEnd =
        paddedCutStart + Math.max((Number(u.startSec) || 0) + 0.25, Number(u.endSec) || 0);

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
        u,
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

    const generatedSubtitles: SubtitleItem[] = mappedUtts.map((entry, idx) => {
      const { u, cutStart, cutEnd, rawCutStart } = entry;
      const dur = Math.max(0.25, Number((cutEnd - cutStart).toFixed(2)));
      const thaiPhonetic = (u.thaiPhonetic || "").trim() || (u.thaiScript || "").trim();
      const rawWords: RawSceneWord[] =
        Array.isArray(u.words) && u.words.length > 0
          ? u.words
          : thaiPhonetic
              .split(/\s+/)
              .filter(Boolean)
              .map((w) => ({ phonetic: w, thai: w, burmeseGloss: "" }));

      // Shift Gemini word timestamps to be relative to cutStart when clip-relative
      const rawOriginInClip = rawCutStart - paddedCutStart;
      const firstWordStart = rawWords.find((w) => typeof w.startSec === "number")?.startSec;
      const wordsAreClipOrAbs =
        typeof firstWordStart === "number" &&
        rawOriginInClip > 0.35 &&
        firstWordStart >= rawOriginInClip - 0.35;
      const clampShift = cutStart - rawCutStart;
      const adjustedRawWords = rawWords.map((w) => {
        if (typeof w.startSec !== "number" || typeof w.endSec !== "number") return w;
        const shift = (wordsAreClipOrAbs ? rawOriginInClip : 0) + clampShift;
        return {
          ...w,
          startSec: Number((w.startSec - shift).toFixed(2)),
          endSec: Number((w.endSec - shift).toFixed(2)),
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
        isManuallyEdited: false,
      };
    });

    if (generatedSubtitles.length === 0) {
      res.json({
        hasSpeech: false,
        usedAudio: true,
        message: `No spoken dialogue was detected between ${reqStart.toFixed(1)}s and ${reqEnd.toFixed(1)}s.`,
        subtitles: [],
      });
      return;
    }

    res.json({
      hasSpeech: true,
      usedAudio: true,
      subtitles: generatedSubtitles,
    });
  } catch (err) {
    console.error("Transcribe range error:", err);
    const formatted = formatGeminiError(err, "Failed to transcribe range with AI.");
    res.status(formatted.status).json({ error: formatted.message });
  } finally {
    await fs.promises.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
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
        const totalClipSec = validScenes.reduce((acc, s) => acc + s.durationSec, 0);
        // Use GOP=1 (instant every-frame browser seeking) at compact 640px/CRF26 for <=95s clips,
        // and GOP=2 at 540px/CRF27 for longer clips so file size stays well under Cloud Run's 32MB cap.
        const useAllKeyframe = totalClipSec <= 95;
        const maxDim = useAllKeyframe ? 640 : 540;
        const gopSize = useAllKeyframe ? "1" : "2";
        const crfVal = useAllKeyframe ? "26" : "27";
        const perSceneScale = `scale=w='min(${maxDim},iw)':h='min(${maxDim},ih)':force_original_aspect_ratio=decrease:force_divisible_by=2,setsar=1,setpts=PTS-STARTPTS`;
        const prepExecOpts = { ...FFMPEG_EXEC_OPTS, timeout: 45_000 };

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
              outClipPath,
            ],
            prepExecOpts
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
              outClipPath,
            ],
            prepExecOpts
          );
        }

        if (!fs.existsSync(outClipPath)) {
          return null;
        }
        const stat = fs.statSync(outClipPath);
        // Stay safely under Cloud Run's 32 MB HTTP response limit; client falls back to local decoding cleanly
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

    // WebCodecs + mp4-muxer already produces a clean 24fps CFR H.264 MP4 — stream copy (-c:v copy)
    // avoids a redundant 30-60s full libx264 re-encode on the server!
    const canStreamCopyVideo =
      videoFormat === "mp4" && !forceCfrFromFrames && recordedDurationSec === undefined;

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
      "cfr",
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
              outputMp4Path,
            ],
            FFMPEG_EXEC_OPTS
          );
          if (fs.existsSync(outputMp4Path) && fs.statSync(outputMp4Path).size > 512) {
            return;
          }
        } catch {
          // Fall back to full re-encode below
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
        const mediaType = sc.mediaType === "image" ? "image" : "video";
        const scUploadId =
          typeof sc.uploadId === "string" && sc.uploadId.trim() ? sc.uploadId.trim() : uploadId;
        return { startSec, durationSec, mediaType, uploadId: scUploadId };
      })
      .filter((sc) => Number.isFinite(sc.startSec) && Number.isFinite(sc.durationSec));

    let muxedWithAudio = false;
    const hasAnyAudioUpload =
      Boolean(uploadId) || normalizedScenes.some((sc) => sc.mediaType !== "image" && Boolean(sc.uploadId));
    if (hasAnyAudioUpload && normalizedScenes.length > 0) {
      const segResults: (string | null)[] = new Array(normalizedScenes.length).fill(null);
      const hasAudioByUploadId = new Map<string, boolean>();
      let hasAnyRealAudio = false;

      const writeSilenceSegment = async (segOut: string, durationSec: number): Promise<boolean> => {
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
              durationSec.toFixed(4),
              "-ac",
              "2",
              "-ar",
              "44100",
              segOut,
            ],
            FFMPEG_EXEC_OPTS
          );
          return fs.existsSync(segOut) && fs.statSync(segOut).size > 44;
        } catch {
          return false;
        }
      };

      const extractOne = async (i: number) => {
        const sc = normalizedScenes[i];
        const segOut = path.join(tmpDir, `seg-${i}.wav`);
        let extracted = false;

        if (sc.mediaType !== "image" && sc.uploadId) {
          await withUploadSessionLock(
            sc.uploadId,
            async (uploadedPath) => {
              let hasAudio = hasAudioByUploadId.get(sc.uploadId!);
              if (hasAudio === undefined) {
                const sourceProbe = await probeMediaInfo(uploadedPath);
                hasAudio = sourceProbe.hasAudio;
                hasAudioByUploadId.set(sc.uploadId!, hasAudio);
              }
              if (!hasAudio) return;

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
                if (extracted) hasAnyRealAudio = true;
              } catch {
                extracted = false;
              }
            },
            { markFinalized: true }
          );
        }

        if (!extracted) {
          extracted = await writeSilenceSegment(segOut, sc.durationSec);
        }

        if (extracted) {
          segResults[i] = segOut;
        }
      };

      for (let batchStart = 0; batchStart < normalizedScenes.length; batchStart += 4) {
        const batch: Promise<void>[] = [];
        for (
          let idx = batchStart;
          idx < Math.min(normalizedScenes.length, batchStart + 4);
          idx++
        ) {
          batch.push(extractOne(idx));
        }
        await Promise.all(batch);
      }

      const segFiles = segResults.filter((s): s is string => Boolean(s));
      if (segFiles.length > 0 && hasAnyRealAudio) {
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
        const buildMuxWithAudioArgs = (vArgs: string[]) => [
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
          outputMp4Path,
        ];

        let muxDone = false;
        if (canStreamCopyVideo) {
          try {
            await execFileAsync("ffmpeg", buildMuxWithAudioArgs(videoCopyArgs), FFMPEG_EXEC_OPTS);
            if (fs.existsSync(outputMp4Path) && fs.statSync(outputMp4Path).size > 512) {
              muxDone = true;
              muxedWithAudio = true;
            }
          } catch {
            // Fall back to re-encode below
          }
        }

        if (!muxDone) {
          await execFileAsync("ffmpeg", buildMuxWithAudioArgs(videoReencodeArgs), FFMPEG_EXEC_OPTS);
          muxedWithAudio = true;
        }
      }
    }

    if (!muxedWithAudio) {
      await runVideoOnlyMux();
    }

    const wantDownloadUrl = Boolean((req.body as { returnDownloadUrl?: boolean })?.returnDownloadUrl);
    const requestedFileName = (req.body as { fileName?: string })?.fileName;
    if (wantDownloadUrl) {
      const entry = await registerCompletedExport(outputMp4Path, requestedFileName);
      res.json({
        exportId: entry.id,
        downloadUrl: `/api/download-export/${encodeURIComponent(entry.id)}`,
        fileName: entry.fileName,
        sizeBytes: entry.sizeBytes,
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
      error: err instanceof Error ? err.message : "Failed to encode 9:16 MP4.",
    });
  } finally {
    if (renderedVideoUploadId) {
      await deleteUploadSession(renderedVideoUploadId);
    }
    await fs.promises.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
});

function buildTopVideoFfmpegFilter(
  editSettings: Partial<VideoEditSettings> | undefined,
  width: number,
  topVideoH: number
): string {
  const fitMode = editSettings?.fitMode === "contain" ? "contain" : "cover";
  const zoom = Math.max(0.5, Math.min(3, Number(editSettings?.zoom) || 1));
  const panXRatio = Math.max(-0.5, Math.min(0.5, (Number(editSettings?.panX) || 0) / 100));
  const panYRatio = Math.max(-0.5, Math.min(0.5, (Number(editSettings?.panY) || 0) / 100));
  const rotateDeg = Number(editSettings?.rotateDeg) || 0;
  const flipH = Boolean(editSettings?.flipH);
  const flipV = Boolean(editSettings?.flipV);

  const targetW = Math.max(2, Math.round((width * zoom) / 2) * 2);
  const targetH = Math.max(2, Math.round((topVideoH * zoom) / 2) * 2);
  const ratioFlag = fitMode === "contain" ? "decrease" : "increase";

  const parts: string[] = [
    `scale=w=${targetW}:h=${targetH}:force_original_aspect_ratio=${ratioFlag}:force_divisible_by=2`,
    "setsar=1",
  ];

  // Apply CSS-equivalent color/blur filters BEFORE rotate/pad/crop so #111111 matte stays pure #111111
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
    // Exact CSS Filter Effects order & math: multiplicative brightness then contrast around 127.5
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

  // Apply rotate before hflip/vflip to match CSS/Canvas transform order (scale(flip) * rotate(deg))
  if (Math.abs(rotateDeg) >= 0.5) {
    const rad = ((rotateDeg * Math.PI) / 180).toFixed(5);
    parts.push(`rotate=${rad}:ow='rotw(${rad})':oh='roth(${rad})':fillcolor=0x111111`);
  }
  if (flipH) parts.push("hflip");
  if (flipV) parts.push("vflip");

  // Pad with pan-offset margins so zoom<=1, contain, and extreme pan match Canvas #111111 matte 1:1
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

  // Viewport overlays applied AFTER crop so noise and vignette center cleanly on the final frame
  if (editSettings?.adversarialNoise) {
    const strength = Math.max(2, Math.min(12, Math.round((Number(editSettings.adversarialStrength) || 12) / 3)));
    parts.push(`noise=alls=${strength}:allf=t+u`);
  }
  if (vignettePct >= 1) {
    const alpha = Math.max(0, Math.min(0.85, (vignettePct / 100) * 0.85));
    const transmission = Math.max(0.08, 1 - alpha);
    const angle = Math.max(0.08, Math.min(1.15, Math.acos(Math.pow(transmission, 0.25)))).toFixed(3);
    parts.push(`vignette=angle=${angle}`);
  }

  parts.push("setpts=PTS-STARTPTS");
  return parts.join(",");
}

// Fast single-pass native FFmpeg 9:16 exporter for local videos:
// Cuts & frames top video directly on server + optionally vstacks lightweight subtitle strip + muxes audio.
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
    fileName,
  } = (req.body || {}) as {
    uploadId?: string;
    scenes?: SpeakingScene[];
    voiceSettings?: VoiceSettings;
    editSettings?: Partial<VideoEditSettings>;
    width?: number;
    height?: number;
    topVideoH?: number;
    subtitleBase64?: string;
    subtitleUploadId?: string;
    subtitleFormat?: "mp4" | "webm";
    subtitleFps?: number;
    subtitleForceCfr?: boolean;
    subtitleRecordedDurationSec?: number;
    targetDurationSec?: number;
    fileName?: string;
  };

  try {
    if (!uploadId) {
      res.status(404).json({ error: "Uploaded video file not found. Please re-upload." });
      return;
    }

    const outW = Math.max(360, Math.min(1280, Math.round((Number(width) || 720) / 2) * 2));
    const outH = Math.max(640, Math.min(1920, Math.round((Number(height) || 1280) / 2) * 2));

    let subtitlePath: string | null = null;
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
    const topVideoH = hasSubStrip
      ? Math.max(240, Math.min(outH - 240, Math.round((Number(rawTopVideoH) || Math.round(outH * 0.35)) / 2) * 2))
      : outH;
    const listH = outH - topVideoH;
    const speed = Math.max(0.5, Math.min(2.5, Number(voiceSettings?.speed) || 1));

    const outputMp4Path = path.join(tmpDir, "output.mp4");
    const execOpts = { ...FFMPEG_EXEC_OPTS, signal: ffmpegAbort.signal, timeout: 110_000 };

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

    const entry = await withUploadSessionLock(
      uploadId,
      async (uploadedPath) => {
        const sourceProbe = await probeMediaInfo(uploadedPath);
        const topFilter = buildTopVideoFfmpegFilter(editSettings, outW, topVideoH);

        const ffmpegInputs: string[] = [];
        const filterChains: string[] = [];
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
          const concatLabels: string[] = [];
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
          const subParts: string[] = [];
          const safeTargetDur = Number(targetDurationSec);
          const safeSubFps = Math.max(8, Math.min(30, Number(subtitleFps) || 15));
          if (subtitleForceCfr) {
            subParts.push(`setpts=N/(${safeSubFps}*TB)`);
          } else if (
            Number.isFinite(safeTargetDur) &&
            safeTargetDur > 0.2 &&
            subtitleRecordedDurationSec !== undefined
          ) {
            const subProbe = await probeMediaInfo(subtitlePath);
            const actualDur =
              subProbe.durationSec > 0.2 ? subProbe.durationSec : Number(subtitleRecordedDurationSec);
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

        // Extract audio scenes in parallel batches of 4 when source has audio
        let origWavPath: string | null = null;
        if (sourceProbe.hasAudio && normalizedScenes.length > 0) {
          const segResults: (string | null)[] = new Array(normalizedScenes.length).fill(null);
          const extractOne = async (i: number) => {
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
                    segOut,
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
            const batch: Promise<void>[] = [];
            for (let idx = batchStart; idx < Math.min(normalizedScenes.length, batchStart + 4); idx++) {
              batch.push(extractOne(idx));
            }
            await Promise.all(batch);
          }

          const segFiles = segResults.filter((s): s is string => Boolean(s));
          if (segFiles.length === 1) {
            origWavPath = segFiles[0];
          } else if (segFiles.length > 1) {
            const mergedWav = path.join(tmpDir, "original-cuts.wav");
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
                mergedWav,
              ],
              execOpts
            );
            origWavPath = mergedWav;
          }
        }

        const audioArgs: string[] = [];
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
            outputMp4Path,
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
      sizeBytes: entry.sizeBytes,
    });
  } catch (err) {
    if (ffmpegAbort.signal.aborted) {
      return;
    }
    console.error("Fast export MP4 error:", err);
    res.status(500).json({
      error: err instanceof Error ? err.message : "Failed to export 9:16 MP4.",
    });
  } finally {
    res.off("close", onClientClose);
    if (subtitleUploadId) {
      await deleteUploadSession(subtitleUploadId);
    }
    await fs.promises.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
});

// Range-capable MP4 download endpoint (supports 8MB chunked fetches safely under Cloud Run's 32MB limit)
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
  // Refresh TTL on download so user can re-save or finish chunked transfer safely
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
    if (
      !Number.isFinite(start) ||
      !Number.isFinite(requestedEnd) ||
      start < 0 ||
      start >= totalSize ||
      requestedEnd < start
    ) {
      res.status(416).setHeader("Content-Range", `bytes */${totalSize}`).end();
      return;
    }
    const end = Math.min(totalSize - 1, requestedEnd);
    const chunkLength = end - start + 1;
    res.status(206);
    res.setHeader("Content-Range", `bytes ${start}-${end}/${totalSize}`);
    res.setHeader("Content-Length", String(chunkLength));
    const stream = fs.createReadStream(entry.filePath, { start, end });
    stream.on("error", () => {
      if (!res.headersSent) {
        res.status(500).json({ error: "Failed to stream exported video chunk." });
      } else {
        res.end();
      }
    });
    stream.pipe(res);
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

app.post("/api/extract-audio-pcm", async (req, res) => {
  const { uploadId, scenes = [] } = (req.body || {}) as {
    uploadId?: string;
    scenes?: Array<{ startSec: number; endSec: number }>;
  };

  if (!uploadId) {
    res.status(400).json({ error: "Missing uploadId for audio extraction." });
    return;
  }

  const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pcm-extract-"));
  try {
    const pcmResult = await withUploadSessionLock(uploadId, async (videoPath) => {
      const info = await probeMediaInfo(videoPath);
      if (!info.hasAudio) {
        return { error: "This video file does not contain an audio track." as const };
      }
      const totalDur = Math.max(0.5, info.durationSec || 120);
      const validScenes =
        Array.isArray(scenes) && scenes.length > 0
          ? scenes
              .map((sc) => {
                const startSec = Math.max(0, Math.min(totalDur, Number(sc.startSec) || 0));
                const endSec = Math.max(startSec + 0.1, Math.min(totalDur, Number(sc.endSec) || totalDur));
                return { startSec, endSec, durationSec: endSec - startSec };
              })
              .filter((sc) => sc.durationSec > 0.05)
          : [{ startSec: 0, endSec: totalDur, durationSec: totalDur }];

      const pcmBuffers: Buffer[] = [];
      for (let i = 0; i < validScenes.length; i++) {
        const sc = validScenes[i];
        const outPcmPath = path.join(tmpDir, `scene-${i}.pcm`);
        await execFileAsync(
          "ffmpeg",
          [
            "-y",
            "-ss",
            sc.startSec.toFixed(3),
            "-i",
            videoPath,
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
            outPcmPath,
          ],
          FFMPEG_EXEC_OPTS
        );
        if (fs.existsSync(outPcmPath)) {
          pcmBuffers.push(await fs.promises.readFile(outPcmPath));
        }
      }
      return { wav: pcmToWavBuffer(Buffer.concat(pcmBuffers), 16000) };
    });

    if (!pcmResult) {
      res.status(404).json({ error: "Uploaded video session expired. Please re-select the file." });
      return;
    }
    if ("error" in pcmResult) {
      res.status(422).json({ error: pcmResult.error });
      return;
    }

    res.setHeader("Content-Type", "audio/wav");
    res.setHeader("Content-Length", String(pcmResult.wav.length));
    res.send(pcmResult.wav);
  } catch (err) {
    console.error("Extract audio PCM error:", err);
    res.status(500).json({
      error: err instanceof Error ? err.message : "Failed to extract audio from video.",
    });
  } finally {
    await fs.promises.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
});

app.post("/api/transcript-only", async (req, res) => {
  const {
    uploadId,
    clips = [],
    scenes = [],
    language = "auto",
  } = (req.body || {}) as {
    uploadId?: string;
    clips?: Array<{
      startSec: number;
      endSec: number;
      trimLeadSec?: number;
      durationSec?: number;
      audioBase64: string;
      mimeType?: string;
    }>;
    scenes?: Array<{ startSec: number; endSec: number }>;
    language?: string;
  };

  const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "tr-only-"));
  try {
    const ai = getGeminiClient();
    const clipPcms: Array<{ pcm: Buffer; durationSec: number }> = [];

    if (Array.isArray(clips) && clips.length > 0) {
      for (let i = 0; i < clips.length; i++) {
        const clip = clips[i];
        const rawBuf = clip?.audioBase64 ? Buffer.from(clip.audioBase64, "base64") : null;
        if (!rawBuf || rawBuf.length < 32) continue;
        const ext = clip.mimeType?.includes("wav") ? ".wav" : ".m4a";
        const inPath = path.join(tmpDir, `clip-${i}${ext}`);
        const outPcmPath = path.join(tmpDir, `clip-${i}.pcm`);
        await fs.promises.writeFile(inPath, rawBuf);
        const trimLead = Math.max(0, Number(clip.trimLeadSec) || 0);
        const dur = Math.max(0.25, Number(clip.durationSec) || Math.max(0.25, clip.endSec - clip.startSec));
        await execFileAsync(
          "ffmpeg",
          [
            "-y",
            "-ss",
            trimLead.toFixed(4),
            "-i",
            inPath,
            "-t",
            dur.toFixed(4),
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
            outPcmPath,
          ],
          FFMPEG_EXEC_OPTS
        );
        if (fs.existsSync(outPcmPath)) {
          const pcm = await fs.promises.readFile(outPcmPath);
          clipPcms.push({ pcm, durationSec: pcm.length / 32000 });
        }
      }
    } else if (uploadId) {
      const extracted = await withUploadSessionLock(uploadId, async (videoPath) => {
        const info = await probeMediaInfo(videoPath);
        if (!info.hasAudio) return { error: "Video has no audio track." as const };
        const totalDur = Math.max(0.5, info.durationSec || 120);
        const targetScenes =
          Array.isArray(scenes) && scenes.length > 0
            ? scenes
            : [{ startSec: 0, endSec: totalDur }];
        const items: Array<{ pcm: Buffer; durationSec: number }> = [];
        for (let i = 0; i < targetScenes.length; i++) {
          const s = Math.max(0, Math.min(totalDur, Number(targetScenes[i].startSec) || 0));
          const e = Math.max(s + 0.1, Math.min(totalDur, Number(targetScenes[i].endSec) || totalDur));
          const outPcmPath = path.join(tmpDir, `up-${i}.pcm`);
          await execFileAsync(
            "ffmpeg",
            [
              "-y",
              "-ss",
              s.toFixed(3),
              "-i",
              videoPath,
              "-t",
              (e - s).toFixed(3),
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
              outPcmPath,
            ],
            FFMPEG_EXEC_OPTS
          );
          if (fs.existsSync(outPcmPath)) {
            const pcm = await fs.promises.readFile(outPcmPath);
            items.push({ pcm, durationSec: pcm.length / 32000 });
          }
        }
        return { items };
      });
      if (!extracted) {
        res.status(404).json({ error: "Uploaded video session expired. Please re-select the file." });
        return;
      }
      if ("error" in extracted) {
        res.status(422).json({ error: extracted.error });
        return;
      }
      clipPcms.push(...extracted.items);
    } else {
      res.status(400).json({ error: "No audio clips or uploadId provided." });
      return;
    }

    if (clipPcms.length === 0) {
      res.status(422).json({ error: "No audio found to transcribe." });
      return;
    }

    const fullPcm = Buffer.concat(clipPcms.map((c) => c.pcm));
    const totalDurationSec = fullPcm.length / 32000;
    const chunkSec = 45;
    const bytesPerChunk = chunkSec * 32000;

    const transcriptSchema = {
      type: Type.OBJECT,
      properties: {
        segments: {
          type: Type.ARRAY,
          items: {
            type: Type.OBJECT,
            properties: {
              startSec: { type: Type.NUMBER },
              endSec: { type: Type.NUMBER },
              text: { type: Type.STRING },
            },
            required: ["startSec", "endSec", "text"],
          },
        },
      },
      required: ["segments"],
    };

    const allSegments: Array<{
      id: string;
      index: number;
      startSec: number;
      endSec: number;
      text: string;
    }> = [];

    for (let offsetBytes = 0; offsetBytes < fullPcm.length; offsetBytes += bytesPerChunk) {
      const slice = fullPcm.subarray(
        offsetBytes,
        Math.min(fullPcm.length, offsetBytes + bytesPerChunk)
      );
      if (slice.length < 3200) continue;
      const chunkStartSec = offsetBytes / 32000;
      const chunkDurSec = slice.length / 32000;

      const wavBuf = await enhanceSpeechWavBuffer(pcmToWavBuffer(slice, 16000));
      const wavBase64 = wavBuf.toString("base64");
      const verbatimHint = await transcribeAudioVerbatimWithDedicatedModel(
        ai,
        wavBase64,
        language
      );

      const promptLines = [
        `Transcribe ONLY the actual spoken human dialogue in this ${chunkDurSec.toFixed(2)}-second audio clip into timestamped segments.`,
        language && language !== "auto"
          ? `Spoken language code: ${language}. Write verbatim in that language's natural script. Do NOT translate.`
          : "Write verbatim in the original spoken language's natural script. Do NOT translate.",
        "Return relative timestamps inside [0, " + chunkDurSec.toFixed(2) + "] seconds.",
        "Skip silence, music, or background noise without inventing words.",
        verbatimHint
          ? `Verbatim speech reference from dedicated transcriber:\n${verbatimHint}`
          : "",
      ]
        .filter(Boolean)
        .join("\n");

      const resp = await generateGroundedWithFailover(
        ai,
        {
          parts: [
            { inlineData: { mimeType: "audio/wav", data: wavBase64 } },
            { text: promptLines },
          ],
        },
        transcriptSchema,
        ThinkingLevel.LOW
      );

      let parsed: { segments?: Array<{ startSec?: number; endSec?: number; text?: string }> } = {};
      try {
        parsed = JSON.parse(resp.text || "{}");
      } catch {
        parsed = {};
      }

      const rawSegs = Array.isArray(parsed.segments) ? parsed.segments : [];
      for (const seg of rawSegs) {
        const text = String(seg.text || "").trim();
        if (!text) continue;
        const relStart = Math.max(0, Math.min(chunkDurSec, Number(seg.startSec) || 0));
        const relEnd = Math.max(relStart + 0.15, Math.min(chunkDurSec, Number(seg.endSec) || relStart + 2));
        allSegments.push({
          id: `tr-${allSegments.length + 1}`,
          index: allSegments.length + 1,
          startSec: Number((chunkStartSec + relStart).toFixed(2)),
          endSec: Number((chunkStartSec + relEnd).toFixed(2)),
          text,
        });
      }
    }

    res.json({
      durationSec: Number(totalDurationSec.toFixed(2)),
      text: allSegments.map((s) => s.text).join(" "),
      segments: allSegments,
    });
  } catch (err) {
    console.error("Transcript-only error:", err);
    const formatted = formatGeminiError(err, "Failed to transcribe audio.");
    res.status(formatted.status).json({ error: formatted.message });
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

const NOOP_VITE_CLIENT_ESM = `// HMR disabled: clean Vite client shim (no WebSocket, no auto-reload)
const sheetsMap = new Map();
const linkSheetsMap = new Map();
if ("document" in globalThis) {
  document.querySelectorAll("style[data-vite-dev-id]").forEach((el) => {
    sheetsMap.set(el.getAttribute("data-vite-dev-id"), el);
  });
  document.querySelectorAll('link[rel="stylesheet"][data-vite-dev-id]').forEach((el) => {
    linkSheetsMap.set(el.getAttribute("data-vite-dev-id"), el);
  });
}
let lastInsertedStyle;
export function updateStyle(id, content) {
  if (linkSheetsMap.has(id)) return;
  let style = sheetsMap.get(id);
  if (!style) {
    style = document.createElement("style");
    style.setAttribute("type", "text/css");
    style.setAttribute("data-vite-dev-id", id);
    style.textContent = content;
    if (!lastInsertedStyle) {
      document.head.appendChild(style);
      setTimeout(() => { lastInsertedStyle = undefined; }, 0);
    } else {
      lastInsertedStyle.insertAdjacentElement("afterend", style);
    }
    lastInsertedStyle = style;
  } else if (style.textContent !== content) {
    style.textContent = content;
  }
  sheetsMap.set(id, style);
}
export function removeStyle(id) {
  if (linkSheetsMap.has(id)) {
    document.querySelectorAll('link[rel="stylesheet"][data-vite-dev-id="' + CSS.escape(id) + '"]').forEach((el) => el.remove());
    linkSheetsMap.delete(id);
  }
  const style = sheetsMap.get(id);
  if (style) {
    document.head.removeChild(style);
    sheetsMap.delete(id);
  }
}
export function createHotContext() {
  return {
    data: {},
    accept() {},
    acceptExports() {},
    dispose() {},
    prune() {},
    decline() {},
    invalidate() {},
    on() {},
    off() {},
    send() {},
  };
}
export function injectQuery(url, queryToInject) {
  if (url[0] !== "." && url[0] !== "/") return url;
  const pathname = url.replace(/[?#].*$/, "");
  const { search, hash } = new URL(url, "http://vite.dev");
  return pathname + "?" + queryToInject + (search ? "&" + search.slice(1) : "") + (hash || "");
}
export class ErrorOverlay extends (typeof HTMLElement !== "undefined" ? HTMLElement : class {}) {}
`;

process.on("unhandledRejection", (reason) => {
  console.error("Unhandled promise rejection:", reason);
});

process.on("uncaughtException", (err) => {
  console.error("Uncaught exception:", err);
});

async function startServer() {
  await sweepOrphanedTempFiles();
  setInterval(() => {
    sweepExpiredUploadSessions().catch(() => {});
  }, UPLOAD_SWEEP_INTERVAL_MS).unref();

  const server = http.createServer(app);

  if (process.env.NODE_ENV !== "production") {
    const disableHmr = process.env.DISABLE_HMR === "true";
    if (disableHmr) {
      // Prevent Vite client WebSocket disconnects from triggering location.reload() loops
      app.get("/@vite/client", (_req, res) => {
        res.setHeader("Content-Type", "application/javascript; charset=utf-8");
        res.setHeader("Cache-Control", "no-store");
        res.send(NOOP_VITE_CLIENT_ESM);
      });
    }
    const { createServer: createViteServer } = await import("vite");
    const vite = await createViteServer({
      server: {
        middlewareMode: true,
        hmr: disableHmr ? false : { server },
        ws: disableHmr ? false : { server },
        watch: disableHmr ? null : undefined,
      },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    app.use(express.static(path.resolve("dist")));
    app.get("*", (_req, res) => {
      res.sendFile(path.resolve("dist", "index.html"));
    });
  }

  server.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer();
