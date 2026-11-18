import type { SpeakingScene, SubtitleItem } from "../types";

export function roundTenth(sec: number): number {
  return Math.round(sec * 10) / 10;
}

export function ensureSceneIds(scenes: SpeakingScene[]): SpeakingScene[] {
  return scenes.map((sc, idx) => ({
    ...sc,
    id: sc.id || `proj-sc-${idx}-${Math.round(sc.startSec * 10)}-${Math.round(sc.endSec * 10)}`,
    index: idx,
    durationSec: roundTenth(Math.max(0.1, sc.endSec - sc.startSec)),
  }));
}

interface ContiguousBlock {
  startSec: number;
  endSec: number;
  cutStart: number;
  sceneIndexStart: number;
}

/**
 * Projects a baseline list of subtitles (with sourceStartSec/sourceEndSec) onto an
 * edited sequence of SpeakingScenes. Adjacent contiguous clips (e.g. immediately
 * after a Split before either half is deleted) are merged temporarily into a
 * single contiguous block so subtitles spanning the split point remain intact.
 */
export function remapSubtitlesToScenes(
  baselineSubtitles: SubtitleItem[],
  nextScenes: SpeakingScene[]
): SubtitleItem[] {
  if (nextScenes.length === 0 || baselineSubtitles.length === 0) {
    return [];
  }

  const sceneCutStarts: number[] = [];
  let cursor = 0;
  for (const sc of nextScenes) {
    sceneCutStarts.push(cursor);
    cursor += Math.max(0.1, sc.endSec - sc.startSec);
  }

  const blocks: ContiguousBlock[] = [];
  for (let i = 0; i < nextScenes.length; i++) {
    const sc = nextScenes[i];
    const prev = blocks[blocks.length - 1];
    if (prev && Math.abs(prev.endSec - sc.startSec) < 0.03) {
      prev.endSec = sc.endSec;
    } else {
      blocks.push({
        startSec: sc.startSec,
        endSec: sc.endSec,
        cutStart: sceneCutStarts[i],
        sceneIndexStart: i,
      });
    }
  }

  const findSceneIndexAtSource = (srcSec: number, fallbackIdx: number): number => {
    for (let i = 0; i < nextScenes.length; i++) {
      if (srcSec >= nextScenes[i].startSec - 0.05 && srcSec <= nextScenes[i].endSec + 0.05) {
        return i;
      }
    }
    return fallbackIdx;
  };

  const mapped: SubtitleItem[] = [];

  for (const sub of baselineSubtitles) {
    const subSrcStart = sub.sourceStartSec;
    const subSrcEnd = sub.sourceEndSec;
    const subSrcDur = Math.max(0.2, subSrcEnd - subSrcStart);

    blocks.forEach((block, bIdx) => {
      const ovStart = Math.max(subSrcStart, block.startSec);
      const ovEnd = Math.min(subSrcEnd, block.endSec);
      if (ovEnd - ovStart < 0.15) return;

      const cutStart = Number((block.cutStart + (ovStart - block.startSec)).toFixed(2));
      const cutEnd = Number((block.cutStart + (ovEnd - block.startSec)).toFixed(2));
      const clipLeft = Math.max(0, ovStart - subSrcStart);
      const clipRight = Math.min(subSrcDur, ovEnd - subSrcStart);
      const clippedDur = Math.max(0.15, cutEnd - cutStart);

      const isFullMatch =
        Math.abs(ovStart - subSrcStart) < 0.03 && Math.abs(ovEnd - subSrcEnd) < 0.03;

      const words = isFullMatch
        ? sub.words.map((w) => ({ ...w }))
        : sub.words
            .filter((w) => w.endOffsetSec > clipLeft + 0.04 && w.startOffsetSec < clipRight - 0.04)
            .map((w) => ({
              ...w,
              startOffsetSec: Number(Math.max(0, w.startOffsetSec - clipLeft).toFixed(2)),
              endOffsetSec: Number(
                Math.min(clippedDur, Math.max(0.05, w.endOffsetSec - clipLeft)).toFixed(2)
              ),
            }));

      mapped.push({
        ...sub,
        id: bIdx === 0 || mapped.every((m) => m.id !== sub.id) ? sub.id : `${sub.id}-b${bIdx}`,
        sceneIndex: findSceneIndexAtSource(ovStart, block.sceneIndexStart),
        startTime: cutStart,
        endTime: cutEnd,
        sourceStartSec: Number(ovStart.toFixed(2)),
        sourceEndSec: Number(ovEnd.toFixed(2)),
        words,
      });
    });
  }

  return mapped.sort((a, b) => a.startTime - b.startTime);
}
