import "dotenv/config";
import express from "express";
import fs from "fs";
import path from "path";
import os from "os";
import crypto from "crypto";
import { execFile } from "child_process";
import { promisify } from "util";
import type { SpeakingScene, VoiceSettings } from "./src/types.ts";

const execFileAsync = promisify(execFile);
const app = express();
const PORT = Number(process.env.PORT) || 3000;
app.use(express.json({ limit: "100mb" }));

const uploadedFiles = new Map<string, string>();

app.post(
  "/api/upload-raw",
  express.raw({ type: ["video/*", "application/octet-stream"], limit: "250mb" }),
  async (req, res) => {
    try {
      const videoBuffer = req.body as Buffer;
      if (!videoBuffer?.length) {
        res.status(400).json({ error: "Empty video upload." });
        return;
      }
      const uploadId = crypto.randomUUID();
      const filePath = path.join(os.tmpdir(), "nine-studio-" + uploadId + ".video");
      await fs.promises.writeFile(filePath, videoBuffer);
      uploadedFiles.set(uploadId, filePath);
      res.json({ uploadId });
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : "Video upload failed." });
    }
  }
);

app.get("/api/subtitle-tracks/:uploadId", async (req, res) => {
  try {
    const filePath = uploadedFiles.get(req.params.uploadId);
    if (!filePath || !fs.existsSync(filePath)) {
      res.status(404).json({ error: "Uploaded video was not found. Please upload it again." });
      return;
    }
    const result = await execFileAsync("ffprobe", [
      "-v", "error",
      "-select_streams", "s",
      "-show_entries", "stream=index:stream_tags=language,title",
      "-of", "json",
      filePath,
    ]);
    const parsed = JSON.parse(result.stdout || "{}") as {
      streams?: { index: number; tags?: { language?: string; title?: string } }[];
    };
    const tracks = (parsed.streams || []).map((stream) => ({
      index: stream.index,
      language: stream.tags?.language || "und",
      title: stream.tags?.title || "",
    }));
    res.json({ tracks });
  } catch (error) {
    res.status(500).json({
      error: error instanceof Error ? error.message : "Could not inspect embedded subtitle tracks. Check FFmpeg/FFprobe installation.",
    });
  }
});

app.post("/api/extract-subtitle", async (req, res) => {
  try {
    const uploadId = String(req.body?.uploadId || "");
    const streamIndex = Number(req.body?.streamIndex);
    const filePath = uploadedFiles.get(uploadId);
    if (!filePath || !fs.existsSync(filePath)) {
      res.status(404).json({ error: "Uploaded video was not found. Please upload it again." });
      return;
    }
    if (!Number.isInteger(streamIndex) || streamIndex < 0) {
      res.status(400).json({ error: "Invalid subtitle stream selection." });
      return;
    }
    const result = await execFileAsync("ffmpeg", [
      "-v", "error",
      "-i", filePath,
      "-map", "0:" + streamIndex,
      "-f", "srt",
      "pipe:1",
    ], { maxBuffer: 32 * 1024 * 1024 });
    const subtitleText = result.stdout || "";
    if (!subtitleText.trim()) {
      res.status(422).json({ error: "This embedded subtitle track could not be converted to SRT text." });
      return;
    }
    res.json({ subtitleText, trackTitle: "Embedded subtitle track " + streamIndex });
  } catch (error) {
    res.status(500).json({
      error: error instanceof Error ? error.message : "Failed to extract embedded subtitles. The selected subtitle codec may not be supported by FFmpeg.",
    });
  }
});

app.post("/api/mux-mp4", async (req, res) => {
  const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "nine-studio-export-"));
  try {
    const body = req.body as {
      videoBase64?: string;
      videoFormat?: "mp4" | "webm";
      uploadId?: string;
      scenes?: SpeakingScene[];
      voiceSettings?: VoiceSettings;
    };
    if (!body.videoBase64) {
      res.status(400).json({ error: "Missing rendered video payload." });
      return;
    }
    const renderedPath = path.join(tempDir, "rendered." + (body.videoFormat === "webm" ? "webm" : "mp4"));
    const outputPath = path.join(tempDir, "final.mp4");
    await fs.promises.writeFile(renderedPath, Buffer.from(body.videoBase64, "base64"));

    const originalPath = body.uploadId ? uploadedFiles.get(body.uploadId) : undefined;
    const scene = body.scenes?.[0];
    let audioPath: string | undefined;
    if (originalPath && fs.existsSync(originalPath) && scene) {
      audioPath = path.join(tempDir, "original-audio.wav");
      try {
        await execFileAsync("ffmpeg", [
          "-y", "-ss", String(scene.startSec), "-t", String(scene.durationSec),
          "-i", originalPath, "-vn", "-ac", "2", "-ar", "44100", audioPath,
        ]);
      } catch {
        audioPath = undefined;
      }
    }

    const audioFilters: string[] = [];
    const voice = body.voiceSettings;
    if (voice) {
      const pitch = Math.max(-12, Math.min(12, Number(voice.pitchSemitones) || 0));
      const speed = Math.max(0.75, Math.min(1.4, Number(voice.speed) || 1));
      if (pitch !== 0 || speed !== 1) {
        audioFilters.push("asetrate=44100*" + Math.pow(2, pitch / 12).toFixed(5));
        audioFilters.push("aresample=44100");
        audioFilters.push("atempo=" + Math.max(0.5, Math.min(2, speed / Math.pow(2, pitch / 12))).toFixed(5));
      }
      const tone = Math.max(-10, Math.min(10, Number(voice.tone) || 0));
      if (tone) audioFilters.push("equalizer=f=180:width_type=o:width=1:g=" + (-tone * 0.45).toFixed(1));
      const echo = Math.max(0, Math.min(100, Number(voice.echo) || 0));
      if (echo) audioFilters.push("aecho=0.8:0.7:90:" + (echo / 220).toFixed(2));
      const robot = Math.max(0, Math.min(100, Number(voice.robot) || 0));
      if (robot) audioFilters.push("tremolo=f=55:d=" + (robot / 100).toFixed(2));
    }

    const args = ["-y", "-i", renderedPath];
    if (audioPath) args.push("-i", audioPath, "-map", "0:v:0", "-map", "1:a:0");
    else args.push("-map", "0:v:0", "-map", "0:a:0?");
    if (body.videoFormat === "webm") args.push("-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p");
    else args.push("-c:v", "copy");
    if (audioFilters.length) args.push("-af", audioFilters.join(","));
    args.push("-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart", "-shortest", outputPath);
    await execFileAsync("ffmpeg", args);

    const output = await fs.promises.readFile(outputPath);
    res.setHeader("Content-Type", "video/mp4");
    res.setHeader("Content-Disposition", 'attachment; filename="nine-studio-9x16.mp4"');
    res.send(output);
  } catch (error) {
    console.error("MP4 export error:", error);
    res.status(500).json({ error: error instanceof Error ? error.message : "Failed to export MP4." });
  } finally {
    await fs.promises.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
});

async function startServer() {
  if (process.env.NODE_ENV !== "production") {
    const { createServer: createViteServer } = await import("vite");
    const vite = await createViteServer({ server: { middlewareMode: true }, appType: "spa" });
    app.use(vite.middlewares);
  } else {
    app.use(express.static(path.resolve("dist")));
    app.get("*", (_req, res) => res.sendFile(path.resolve("dist", "index.html")));
  }
  app.listen(PORT, "0.0.0.0", () => console.log("Server running on http://localhost:" + PORT));
}

startServer();
