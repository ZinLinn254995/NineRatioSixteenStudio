import type { SpeakingScene, SubtitleItem } from "../types";

export function roundTenth(sec: number): number {
  return Math.round(sec * 10) / 10;
}

export function getSceneDurationSec(sc: {
  startSec: number;
  endSec: number;
  durationSec?: number;
}): number {
  const start = Number(sc.startSec);
  const end = Number(sc.endSec);
  if (Number.isFinite(start) && Number.isFinite(end) && end > start) {
    return Math.max(0.1, end - start);
  }
  const fallback = Number(sc.durationSec);
  return Number.isFinite(fallback) && fallback > 0 ? Math.max(0.1, fallback) : 0.1;
}

export function ensureSceneIds(scenes: SpeakingScene[]): SpeakingScene[] {
  return scenes.map((sc, idx) => ({
    ...sc,
    id: sc.id || `proj-sc-${idx}-${Math.round(sc.startSec * 10)}-${Math.round(sc.endSec * 10)}`,
    index: idx,
    durationSec: Number(getSceneDurationSec(sc).toFixed(2)),
  }));
}

export function withSceneId(sub: SubtitleItem, scenes: SpeakingScene[]): SubtitleItem {
  const matchedSceneId = scenes[sub.sceneIndex]?.id;
  if (matchedSceneId) {
    return sub.sceneId === matchedSceneId ? sub : { ...sub, sceneId: matchedSceneId };
  }
  if (sub.sceneId !== undefined) {
    return { ...sub, sceneId: undefined };
  }
  return sub;
}

/**
 * Returns the active subtitle when timeSec falls within [startTime, endTime].
 * During silent gaps after a subtitle finishes and before the next subtitle starts,
 * keeps the most recently spoken subtitle selected until the next subtitle arrives.
 */
export function findActiveSubtitle(
  subtitles: SubtitleItem[],
  timeSec: number
): SubtitleItem | undefined {
  let activeInRange: SubtitleItem | undefined;
  let lastStarted: SubtitleItem | undefined;

  for (let i = 0; i < subtitles.length; i++) {
    const sub = subtitles[i];
    if (timeSec >= sub.startTime) {
      if (!lastStarted || sub.startTime >= lastStarted.startTime) {
        lastStarted = sub;
      }
      if (timeSec <= sub.endTime) {
        activeInRange = sub;
      }
    }
  }

  return activeInRange ?? lastStarted;
}

/**
 * Returns the nearest scroll-anchor subtitle (active subtitle, or the most recent
 * subtitle that already started) so auto-scroll does not snap back to item #0 during gaps.
 */
export function getScrollAnchorSubtitle(
  subtitles: SubtitleItem[],
  timeSec: number
): SubtitleItem | undefined {
  const active = findActiveSubtitle(subtitles, timeSec);
  if (active) return active;
  let lastStarted: SubtitleItem | undefined;
  for (let i = 0; i < subtitles.length; i++) {
    if (timeSec >= subtitles[i].startTime) {
      lastStarted = subtitles[i];
    } else {
      break;
    }
  }
  return lastStarted ?? subtitles[0];
}

interface BlockSceneRef {
  sceneIndex: number;
  startSec: number;
  endSec: number;
}

interface ContiguousBlock {
  startSec: number;
  endSec: number;
  cutStart: number;
  sceneRefs: BlockSceneRef[];
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
    cursor += getSceneDurationSec(sc);
  }

  const blocks: ContiguousBlock[] = [];
  for (let i = 0; i < nextScenes.length; i++) {
    const sc = nextScenes[i];
    if (!Number.isFinite(sc.startSec) || !Number.isFinite(sc.endSec) || sc.endSec <= sc.startSec) {
      continue;
    }
    const prev = blocks[blocks.length - 1];
    if (prev && Math.abs(prev.endSec - sc.startSec) < 0.03 && sc.endSec > prev.startSec) {
      prev.endSec = sc.endSec;
      prev.sceneRefs.push({
        sceneIndex: i,
        startSec: sc.startSec,
        endSec: sc.endSec,
      });
    } else {
      blocks.push({
        startSec: sc.startSec,
        endSec: sc.endSec,
        cutStart: sceneCutStarts[i],
        sceneRefs: [
          {
            sceneIndex: i,
            startSec: sc.startSec,
            endSec: sc.endSec,
          },
        ],
      });
    }
  }

  const findSceneIndexInBlock = (block: ContiguousBlock, srcSec: number): number => {
    for (const ref of block.sceneRefs) {
      if (srcSec >= ref.startSec - 0.05 && srcSec <= ref.endSec + 0.05) {
        return ref.sceneIndex;
      }
    }
    return block.sceneRefs[0]?.sceneIndex ?? 0;
  };

  const mapped: SubtitleItem[] = [];
  const usedIds = new Set<string>();

  for (const sub of baselineSubtitles) {
    const subSrcStart = sub.sourceStartSec;
    const subSrcEnd = sub.sourceEndSec;
    if (!Number.isFinite(subSrcStart) || !Number.isFinite(subSrcEnd) || subSrcEnd <= subSrcStart) {
      continue;
    }
    const subSrcDur = Math.max(0.15, subSrcEnd - subSrcStart);
    const baseWords = Array.isArray(sub.words) ? sub.words : [];

    blocks.forEach((block, bIdx) => {
      const ovStart = Math.max(subSrcStart, block.startSec);
      const ovEnd = Math.min(subSrcEnd, block.endSec);
      if (ovEnd - ovStart < 0.15) return;

      const cutStart = Number((block.cutStart + (ovStart - block.startSec)).toFixed(2));
      const cutEnd = Number((block.cutStart + (ovEnd - block.startSec)).toFixed(2));
      const clipLeft = Math.max(0, ovStart - subSrcStart);
      const clipRight = Math.min(subSrcDur, ovEnd - subSrcStart);
      const clippedDur = Math.max(0.15, Number((cutEnd - cutStart).toFixed(2)));

      const isFullMatch =
        Math.abs(ovStart - subSrcStart) < 0.03 && Math.abs(ovEnd - subSrcEnd) < 0.03;

      const words = isFullMatch
        ? baseWords.map((w) => ({ ...w }))
        : baseWords
            .filter((w) => w.endOffsetSec > clipLeft + 0.04 && w.startOffsetSec < clipRight - 0.04)
            .map((w) => {
              const shiftedStart = Math.max(0, w.startOffsetSec - clipLeft);
              const clampedStart = Math.min(Math.max(0, clippedDur - 0.05), shiftedStart);
              const shiftedEnd = Math.max(clampedStart + 0.04, w.endOffsetSec - clipLeft);
              const clampedEnd = Math.min(clippedDur, shiftedEnd);
              return {
                ...w,
                startOffsetSec: Number(clampedStart.toFixed(2)),
                endOffsetSec: Number(Math.max(clampedStart + 0.01, clampedEnd).toFixed(2)),
              };
            });

      let uniqueId = sub.id;
      if (usedIds.has(uniqueId)) {
        let suffix = bIdx || 1;
        while (usedIds.has(`${sub.id}-b${suffix}`)) {
          suffix++;
        }
        uniqueId = `${sub.id}-b${suffix}`;
      }
      usedIds.add(uniqueId);

      const mappedSceneIndex = findSceneIndexInBlock(block, ovStart);
      mapped.push(
        withSceneId(
          {
            ...sub,
            id: uniqueId,
            sceneIndex: mappedSceneIndex,
            startTime: cutStart,
            endTime: cutEnd,
            sourceStartSec: Number(ovStart.toFixed(2)),
            sourceEndSec: Number(ovEnd.toFixed(2)),
            words,
            isManuallyEdited: Boolean(sub.isManuallyEdited),
          },
          nextScenes
        )
      );
    });
  }

  return mapped.sort((a, b) => a.startTime - b.startTime);
}
