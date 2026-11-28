import type {
  SpeakingScene,
  SubtitleGenerationConfig,
  SubtitleItem,
  SubtitleWord,
  TranscriptResult,
  TranscriptSegment,
  TranslationTone,
} from "../types";
import {
  ensureSceneIds,
  getSceneDurationSec,
  mapCutRangeToSourceMetadata,
  withSceneId,
} from "./projectTimeline";
import { readStreamingProcessResponse } from "./uploadFile";

export interface AudioToCutBlock {
  audioStart: number;
  audioEnd: number;
  cutStart: number;
  cutEnd: number;
}

/**
 * Builds contiguous audio->cut blocks aligning sequential non-image audio scenes
 * back onto the full project timeline (preserving offsets across skipped image clips).
 */
export function buildAudioToCutBlocks(
  projectScenes: SpeakingScene[],
  audioScenes: Array<{ id?: string; startSec: number; endSec: number }>
): AudioToCutBlock[] {
  const normalizedProjectScenes = ensureSceneIds(projectScenes);
  const projectVideoInfos: Array<{
    id?: string;
    startSec: number;
    endSec: number;
    cutStart: number;
    cutEnd: number;
  }> = [];

  let cutCursor = 0;
  for (const sc of normalizedProjectScenes) {
    const dur = getSceneDurationSec(sc);
    const cutStart = cutCursor;
    const cutEnd = cutCursor + dur;
    cutCursor = cutEnd;
    if (sc.mediaType !== "image") {
      projectVideoInfos.push({
        id: sc.id,
        startSec: sc.startSec,
        endSec: sc.endSec,
        cutStart,
        cutEnd,
      });
    }
  }

  if (projectVideoInfos.length === 0) {
    // Fallback 1:1 audio-to-cut timeline when project has no video scenes
    let audioCursor = 0;
    return audioScenes.map((sc) => {
      const dur = Math.max(0.1, Number((sc.endSec - sc.startSec).toFixed(4)));
      const block: AudioToCutBlock = {
        audioStart: audioCursor,
        audioEnd: audioCursor + dur,
        cutStart: audioCursor,
        cutEnd: audioCursor + dur,
      };
      audioCursor += dur;
      return block;
    });
  }

  const usedIndices = new Set<number>();
  const rawBlocks: AudioToCutBlock[] = [];
  let audioCursor = 0;

  for (let i = 0; i < audioScenes.length; i++) {
    const aScene = audioScenes[i];
    const audioDur = Math.max(0.1, Number((aScene.endSec - aScene.startSec).toFixed(4)));
    const audioStart = audioCursor;
    const audioEnd = audioCursor + audioDur;
    audioCursor = audioEnd;

    let matchIdx = -1;
    if (aScene.id) {
      matchIdx = projectVideoInfos.findIndex(
        (pv, idx) => !usedIndices.has(idx) && pv.id === aScene.id
      );
    }
    if (matchIdx === -1) {
      matchIdx = projectVideoInfos.findIndex(
        (pv, idx) =>
          !usedIndices.has(idx) &&
          Math.abs(pv.startSec - aScene.startSec) < 0.15 &&
          Math.abs(pv.endSec - aScene.endSec) < 0.15
      );
    }
    if (matchIdx === -1 && i < projectVideoInfos.length && !usedIndices.has(i)) {
      matchIdx = i;
    }

    const matched = matchIdx >= 0 ? projectVideoInfos[matchIdx] : undefined;
    if (matchIdx >= 0) {
      usedIndices.add(matchIdx);
    }

    const cutStart = matched ? matched.cutStart : rawBlocks[rawBlocks.length - 1]?.cutEnd ?? audioStart;
    const cutEnd = matched ? matched.cutEnd : cutStart + audioDur;

    const prev = rawBlocks[rawBlocks.length - 1];
    if (
      prev &&
      Math.abs(prev.audioEnd - audioStart) < 0.02 &&
      Math.abs(prev.cutEnd - cutStart) < 0.02
    ) {
      prev.audioEnd = audioEnd;
      prev.cutEnd = cutEnd;
    } else {
      rawBlocks.push({
        audioStart,
        audioEnd,
        cutStart,
        cutEnd,
      });
    }
  }

  return rawBlocks;
}

/**
 * Maps a segment's concatenated audio interval [rawAudioStart, rawAudioEnd] onto
 * the full cut timeline [cutStart, cutEnd], respecting skipped image clips.
 */
export function mapAudioRangeToCutRange(
  blocks: AudioToCutBlock[],
  rawAudioStart: number,
  rawAudioEnd: number
): { startTime: number; endTime: number } {
  const safeStart = Math.max(0, Number.isFinite(rawAudioStart) ? rawAudioStart : 0);
  const safeEnd = Math.max(
    safeStart + 0.12,
    Number.isFinite(rawAudioEnd) ? rawAudioEnd : safeStart + 1.5
  );

  if (blocks.length === 0) {
    return {
      startTime: Number(safeStart.toFixed(2)),
      endTime: Number(safeEnd.toFixed(2)),
    };
  }

  let bestBlock = blocks[0];
  let bestOverlap = -1;

  for (const blk of blocks) {
    const ov = Math.min(safeEnd, blk.audioEnd) - Math.max(safeStart, blk.audioStart);
    if (ov > bestOverlap) {
      bestOverlap = ov;
      bestBlock = blk;
    }
  }

  if (bestOverlap <= 0) {
    const mid = (safeStart + safeEnd) / 2;
    let bestDist = Infinity;
    for (const blk of blocks) {
      const dist =
        mid < blk.audioStart
          ? blk.audioStart - mid
          : mid > blk.audioEnd
            ? mid - blk.audioEnd
            : 0;
      if (dist < bestDist) {
        bestDist = dist;
        bestBlock = blk;
      }
    }
  }

  const blockAudioDur = Math.max(0.12, bestBlock.audioEnd - bestBlock.audioStart);
  const blockCutDur = Math.max(0.12, bestBlock.cutEnd - bestBlock.cutStart);
  const relStart = Math.max(0, Math.min(blockAudioDur - 0.12, safeStart - bestBlock.audioStart));
  const relEnd = Math.max(
    relStart + 0.12,
    Math.min(blockAudioDur, safeEnd - bestBlock.audioStart)
  );

  const scale = blockCutDur / blockAudioDur;
  const startTime = Number((bestBlock.cutStart + relStart * scale).toFixed(2));
  const endTime = Number(
    Math.max(startTime + 0.12, bestBlock.cutStart + relEnd * scale).toFixed(2)
  );

  return { startTime, endTime };
}

interface TranslatedSegmentResponseItem {
  id: string;
  originalSpokenText: string;
  thaiScript: string;
  thaiPhonetic: string;
  burmese: string;
  words: SubtitleWord[];
}

export async function translateTranscriptToTimelineSubtitles(params: {
  result: TranscriptResult;
  projectScenes: SpeakingScene[];
  audioScenes: Array<{ id?: string; startSec: number; endSec: number }>;
  generationConfig: SubtitleGenerationConfig;
  translationTone: TranslationTone;
  signal?: AbortSignal;
  onProgress?: (percent: number, label: string) => void;
}): Promise<SubtitleItem[]> {
  const nonEmptySegments: TranscriptSegment[] = params.result.segments.filter(
    (s) => s.text.trim().length > 0
  );
  if (nonEmptySegments.length === 0) {
    return [];
  }

  params.onProgress?.(5, `Translating ${nonEmptySegments.length} transcript lines...`);

  const resp = await fetch("/api/translate-transcript-segments", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/x-ndjson",
    },
    signal: params.signal,
    body: JSON.stringify({
      segments: nonEmptySegments.map((s) => ({
        id: s.id,
        startSec: s.startSec,
        endSec: s.endSec,
        text: s.text,
        ...(Array.isArray(s.words) && s.words.length > 0 ? { words: s.words } : {}),
      })),
      generationConfig: params.generationConfig,
      translationTone: params.translationTone,
      detectedLanguage:
        params.result.detectedLanguage ||
        (params.result.language !== "auto" ? params.result.language : undefined),
      stream: true,
    }),
  });

  const data = await readStreamingProcessResponse<{
    items?: TranslatedSegmentResponseItem[];
    error?: string;
  }>(resp, (ev) => {
    params.onProgress?.(ev.percent, ev.label);
  });

  if (params.signal?.aborted) {
    throw new DOMException("Aborted", "AbortError");
  }

  const translatedItems = Array.isArray(data.items) ? data.items : [];
  const translatedById = new Map<string, TranslatedSegmentResponseItem>(
    translatedItems.map((it) => [it.id, it])
  );

  const normalizedScenes = ensureSceneIds(params.projectScenes);
  const blocks = buildAudioToCutBlocks(normalizedScenes, params.audioScenes);
  const batchNonce = Date.now().toString(36);

  const mappedSubs: SubtitleItem[] = nonEmptySegments.map((seg, idx) => {
    const tr = translatedById.get(seg.id);
    const { startTime, endTime } = mapAudioRangeToCutRange(
      blocks,
      seg.startSec,
      seg.endSec
    );
    const oldDur = Math.max(0.12, seg.endSec - seg.startSec);
    const newDur = Math.max(0.12, endTime - startTime);
    const timeRatio = newDur / oldDur;

    const meta = mapCutRangeToSourceMetadata(normalizedScenes, startTime, endTime);
    const rawWords: SubtitleWord[] = Array.isArray(tr?.words)
      ? tr.words.map((w) => ({
          phonetic: w.phonetic,
          thai: w.thai,
          burmeseGloss: w.burmeseGloss || "",
          startOffsetSec: Number(
            Math.max(0, Math.min(newDur - 0.02, (Number(w.startOffsetSec) || 0) * timeRatio)).toFixed(2)
          ),
          endOffsetSec: Number(
            Math.max(0.02, Math.min(newDur, (Number(w.endOffsetSec) || newDur) * timeRatio)).toFixed(2)
          ),
        }))
      : [];

    return withSceneId(
      {
        id: `sub-ws-${batchNonce}-${idx + 1}`,
        sceneIndex: meta.sceneIndex,
        ...(meta.sceneId ? { sceneId: meta.sceneId } : {}),
        mediaUrl: meta.mediaUrl,
        startTime,
        endTime,
        sourceStartSec: Number(meta.sourceStartSec.toFixed(2)),
        sourceEndSec: Number(meta.sourceEndSec.toFixed(2)),
        ...(meta.sourceSegments ? { sourceSegments: meta.sourceSegments } : {}),
        originalSpokenText: tr?.originalSpokenText || seg.text.trim(),
        thaiPhonetic: tr?.thaiPhonetic || seg.text.trim(),
        thaiScript: tr?.thaiScript ?? "",
        burmese: tr?.burmese ?? "",
        words: rawWords,
      },
      normalizedScenes
    );
  });

  mappedSubs.sort((a, b) => a.startTime - b.startTime);

  // Resolve any minor adjacent overlaps cleanly without touching source metadata
  for (let i = 1; i < mappedSubs.length; i++) {
    const prev = mappedSubs[i - 1];
    const curr = mappedSubs[i];
    if (curr.startTime < prev.endTime) {
      const mid = Number(((prev.endTime + curr.startTime) / 2).toFixed(2));
      prev.endTime = Math.max(Number((prev.startTime + 0.12).toFixed(2)), mid);
      curr.startTime = prev.endTime;
      curr.endTime = Math.max(Number((curr.startTime + 0.12).toFixed(2)), curr.endTime);
    }
  }

  return mappedSubs;
}
