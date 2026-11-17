import "dotenv/config";
import express from "express";
import fs from "fs";
import path from "path";
import os from "os";
import crypto from "crypto";
import { execFile } from "child_process";
import { promisify } from "util";
import { GoogleGenAI, Type, ThinkingLevel } from "@google/genai";
import type { SpeakingScene, SubtitleItem, VoiceSettings, YouTubeVideo } from "./src/types.ts";

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
          thinkingConfig: { thinkingLevel: ThinkingLevel.LOW },
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

function walkVideoRenderers(node: unknown, out: Record<string, unknown>[]): void {
  if (!node || typeof node !== "object") return;
  if (Array.isArray(node)) {
    for (const item of node) walkVideoRenderers(item, out);
    return;
  }
  const obj = node as Record<string, unknown>;
  if (obj.videoRenderer && typeof obj.videoRenderer === "object") {
    out.push(obj.videoRenderer as Record<string, unknown>);
  }
  for (const val of Object.values(obj)) {
    walkVideoRenderers(val, out);
  }
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

// Search all YouTube videos (unrestricted)
app.get("/api/youtube/search", async (req, res) => {
  try {
    const rawQuery = String(req.query.q ?? "").trim() || "thai 3d animation cartoon";
    const directId = extractYouTubeVideoId(rawQuery);

    if (directId) {
      const oembedResp = await fetch(
        `https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${directId}&format=json`
      );
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
      };
      res.json({ videos: [video] });
      return;
    }

    const url = `https://www.youtube.com/results?search_query=${encodeURIComponent(rawQuery)}`;

    const response = await fetch(url, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
        "Accept-Language": "en-US,en;q=0.9,th;q=0.8",
      },
    });

    if (!response.ok) {
      res.status(502).json({ error: `YouTube search returned HTTP ${response.status}` });
      return;
    }

    const html = await response.text();
    const match = html.match(/var ytInitialData = (\{[\s\S]*?\});<\/script>/);
    if (!match?.[1]) {
      res.status(502).json({ error: "Could not parse YouTube search results." });
      return;
    }

    const data = JSON.parse(match[1]);
    const renderers: Record<string, unknown>[] = [];
    walkVideoRenderers(data, renderers);

    const seen = new Set<string>();
    const videos: YouTubeVideo[] = [];

    for (const v of renderers) {
      const videoId = typeof v.videoId === "string" ? v.videoId : "";
      if (!videoId || seen.has(videoId)) continue;
      seen.add(videoId);

      const durationText = readRunsText(v.lengthText);
      const durationSec = parseDurationToSeconds(durationText);
      if (durationSec < 5) continue;

      const title = readRunsText(v.title);
      const channel = readRunsText(v.ownerText) || readRunsText(v.longBylineText) || "YouTube";
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
      });

      if (videos.length >= 20) break;
    }

    res.json({ videos });
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
            description: "Word-by-word breakdown matching thaiPhonetic tokens in exact speaking order.",
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
    words: { phonetic: string; thai: string; burmeseGloss?: string }[];
  }[];
}

function getClipPrompt(clipDurationSec: number, sourceStartSec: number, sourceEndSec: number): string {
  return `Listen carefully to the ACTUAL spoken audio in this ${clipDurationSec.toFixed(1)}-second clip (from ${sourceStartSec.toFixed(1)}s to ${sourceEndSec.toFixed(1)}s of the video).

CRITICAL GROUNDING RULES:
- ONLY transcribe and translate what is ACTUALLY SPOKEN in the audio of this clip.
- NEVER invent, guess, or fabricate dialogue that is not spoken.
- If there is NO spoken dialogue in this clip (only silence, music, or sound effects), set "hasDialogue": false and return an empty "utterances" array.
- Report "startSec" and "endSec" relative to the start of THIS clip (between 0 and ${clipDurationSec.toFixed(1)} seconds).

For each spoken sentence/utterance in this clip:
- "originalSpokenText": Exact verbatim words spoken in the audio.
- "thaiScript": Verbatim Thai if spoken in Thai, otherwise accurate natural Thai translation of what was spoken.
- "thaiPhonetic": Clear, easy-to-read English phonetic spelling of the Thai pronunciation (e.g. "Sa-wat-dee khrap").
- "burmese": Accurate Burmese translation (မြန်မာဘာသာပြန်) matching what was spoken.
- "words": Split "thaiPhonetic" into word tokens in exact spoken order, with matching Thai word and a 1-2 word Burmese gloss for key content words (empty string for particles).`;
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

function compileSceneTranscripts(
  scenes: SpeakingScene[],
  results: RawSceneUtterances[]
): { scenes: SpeakingScene[]; subtitles: SubtitleItem[]; targetDurationSec: number } {
  const subtitles: SubtitleItem[] = [];
  let cutOffset = 0;

  const updatedScenes = scenes.map((sc, sIdx) => {
    const res = results[sIdx];
    const clipDur = sc.durationSec;

    if (res && res.hasDialogue !== false && Array.isArray(res.utterances)) {
      // Detect whether model returned absolute source timestamps or clip-relative [0..clipDur]
      const looksAbsolute =
        sc.startSec > 2 &&
        res.utterances.length > 0 &&
        res.utterances.every((u) => u.startSec >= sc.startSec - 1 && u.endSec <= sc.endSec + 1.5);

      for (const u of res.utterances) {
        const rawLocalStart = looksAbsolute ? u.startSec - sc.startSec : u.startSec;
        const rawLocalEnd = looksAbsolute ? u.endSec - sc.startSec : u.endSec;

        const localStart = Math.max(0, Math.min(clipDur - 0.3, rawLocalStart));
        const localEnd = Math.max(localStart + 0.4, Math.min(clipDur, rawLocalEnd));
        const lineDur = Math.max(0.4, localEnd - localStart);

        const cutStart = Number((cutOffset + localStart).toFixed(2));
        const cutEnd = Number((cutOffset + localEnd).toFixed(2));

        const rawWords =
          u.words && u.words.length > 0
            ? u.words
            : (u.thaiPhonetic || "")
                .split(/\s+/)
                .filter(Boolean)
                .map((w) => ({ phonetic: w, thai: w, burmeseGloss: "" }));

        const totalWeight =
          rawWords.reduce((acc, w) => acc + Math.max(2, w.phonetic.length), 0) || 1;
        let wCursor = 0;
        const words = rawWords.map((w, wi) => {
          const wDur = (Math.max(2, w.phonetic.length) / totalWeight) * lineDur;
          const startOffsetSec = Number(wCursor.toFixed(2));
          const endOffsetSec = Number(
            (wi === rawWords.length - 1 ? lineDur : wCursor + wDur).toFixed(2)
          );
          wCursor = endOffsetSec;
          return {
            phonetic: w.phonetic,
            thai: w.thai,
            burmeseGloss: w.burmeseGloss || "",
            startOffsetSec,
            endOffsetSec,
          };
        });

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

// Upload local video file, slice ONLY user-selected scenes with ffmpeg, and transcribe verbatim
app.post(
  "/api/upload-video",
  express.raw({ type: ["video/*", "application/octet-stream"], limit: "250mb" }),
  async (req, res) => {
    const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "upload-vid-"));
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
      const scenes = normalizeSelectedScenes(parsedScenes, durationSec);

      if (scenes.length === 0) {
        res.status(400).json({ error: "Select at least one scene before generating subtitles." });
        return;
      }

      const uploadId = crypto.randomUUID();
      const persistentPath = path.join(os.tmpdir(), `thai-studio-upload-${uploadId}.mp4`);
      await fs.promises.writeFile(persistentPath, videoBuf);
      uploadedFiles.set(uploadId, persistentPath);

      const ai = getGeminiClient();

      // Extract audio and transcribe each selected scene in parallel
      const results = await Promise.all(
        scenes.map(async (sc, idx) => {
          const segAudioPath = path.join(tmpDir, `scene-${idx}.mp3`);
          await execFileAsync("ffmpeg", [
            "-y",
            "-ss",
            String(sc.startSec),
            "-t",
            String(sc.durationSec),
            "-i",
            persistentPath,
            "-vn",
            "-ac",
            "1",
            "-ar",
            "16000",
            "-b:a",
            "32k",
            segAudioPath,
          ]);
          const audioBase64 = (await fs.promises.readFile(segAudioPath)).toString("base64");
          const resp = await generateGroundedWithFailover(
            ai,
            {
              parts: [
                { inlineData: { mimeType: "audio/mp3", data: audioBase64 } },
                { text: getClipPrompt(sc.durationSec, sc.startSec, sc.endSec) },
              ],
            },
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

      res.json({
        sourceType: "local",
        uploadId,
        title,
        channel: "Local Video",
        sourceDurationSec: durationSec,
        targetDurationSec: compiled.targetDurationSec,
        scenes: compiled.scenes,
        subtitles: compiled.subtitles,
        keyframeUrls: [],
      });
    } catch (err) {
      console.error("Upload analysis error:", err);
      res.status(500).json({
        error: err instanceof Error ? err.message : "Failed to transcribe selected scenes.",
      });
    } finally {
      await fs.promises.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
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
      videoFormat = "mp4",
      uploadId,
      scenes = [],
      voiceSettings,
    } = req.body as {
      videoBase64: string;
      videoFormat?: "mp4" | "webm";
      uploadId?: string;
      scenes?: SpeakingScene[];
      voiceSettings?: VoiceSettings;
    };

    if (!videoBase64) {
      res.status(400).json({ error: "Missing rendered video payload." });
      return;
    }

    const inputVideoPath = path.join(tmpDir, `input.${videoFormat}`);
    const outputMp4Path = path.join(tmpDir, "output.mp4");
    await fs.promises.writeFile(inputVideoPath, Buffer.from(videoBase64, "base64"));

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
            "-ss",
            String(sc.startSec),
            "-t",
            String(sc.durationSec),
            "-i",
            uploadedPath,
            "-vn",
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
          const speed = Math.max(0.75, Math.min(1.4, Number(voiceSettings.speed) || 1));
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
