import type { SpeakingScene, SubtitleItem, SubtitleSourceSegment } from "../types";

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
  const matchedScene = scenes[sub.sceneIndex];
  if (matchedScene) {
    const matchedSceneId = matchedScene.id;
    const nextMediaUrl = matchedScene.mediaUrl;
    if (sub.sceneId === matchedSceneId && sub.mediaUrl === nextMediaUrl) {
      return sub;
    }
    return {
      ...sub,
      ...(matchedSceneId ? { sceneId: matchedSceneId } : {}),
      mediaUrl: nextMediaUrl,
    };
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

export interface BlockSceneRef {
  sceneIndex: number;
  sceneId?: string;
  startSec: number;
  endSec: number;
}

export interface ContiguousClipBlock {
  mediaUrl: string;
  mediaType: "video" | "image";
  startSec: number;
  endSec: number;
  cutStart: number;
  cutEnd: number;
  sceneRefs: BlockSceneRef[];
}

export function buildContiguousClipBlocks(scenes: SpeakingScene[]): ContiguousClipBlock[] {
  if (scenes.length === 0) return [];
  const sceneCutStarts: number[] = [];
  let cursor = 0;
  for (const sc of scenes) {
    sceneCutStarts.push(cursor);
    cursor += getSceneDurationSec(sc);
  }

  const blocks: ContiguousClipBlock[] = [];
  for (let i = 0; i < scenes.length; i++) {
    const sc = scenes[i];
    const dur = getSceneDurationSec(sc);
    const scStart = Number.isFinite(sc.startSec) ? sc.startSec : 0;
    const scEnd = Number.isFinite(sc.endSec) && sc.endSec > scStart ? sc.endSec : scStart + dur;
    const scMediaUrl = sc.mediaUrl || "";
    const scMediaType = sc.mediaType === "image" ? "image" : "video";
    const prev = blocks[blocks.length - 1];
    if (
      prev &&
      prev.mediaUrl === scMediaUrl &&
      prev.mediaType === scMediaType &&
      scMediaType !== "image" &&
      Math.abs(prev.endSec - scStart) < 0.03 &&
      scEnd > prev.startSec
    ) {
      prev.endSec = scEnd;
      prev.cutEnd = sceneCutStarts[i] + dur;
      prev.sceneRefs.push({
        sceneIndex: i,
        sceneId: sc.id,
        startSec: scStart,
        endSec: scEnd,
      });
    } else {
      blocks.push({
        mediaUrl: scMediaUrl,
        mediaType: scMediaType,
        startSec: scStart,
        endSec: scEnd,
        cutStart: sceneCutStarts[i],
        cutEnd: sceneCutStarts[i] + dur,
        sceneRefs: [
          {
            sceneIndex: i,
            sceneId: sc.id,
            startSec: scStart,
            endSec: scEnd,
          },
        ],
      });
    }
  }
  return blocks;
}

export function mapCutTimeToSourceExact(
  scenes: SpeakingScene[],
  cutTime: number
): { sceneIndex: number; sceneId?: string; mediaUrl?: string; sourceSec: number } {
  if (scenes.length === 0) {
    return { sceneIndex: 0, sourceSec: Math.max(0, cutTime) };
  }
  let acc = 0;
  for (let i = 0; i < scenes.length; i++) {
    const sc = scenes[i];
    const dur = getSceneDurationSec(sc);
    if (cutTime < acc + dur - 0.001 || i === scenes.length - 1) {
      const offset = Math.max(0, Math.min(dur, cutTime - acc));
      return {
        sceneIndex: i,
        sceneId: sc.id,
        mediaUrl: sc.mediaUrl,
        sourceSec: Math.min(sc.endSec, sc.startSec + offset),
      };
    }
    acc += dur;
  }
  const last = scenes[scenes.length - 1];
  return {
    sceneIndex: Math.max(0, scenes.length - 1),
    sceneId: last?.id,
    mediaUrl: last?.mediaUrl,
    sourceSec: last ? last.endSec : 0,
  };
}

export interface MappedCutSourceMetadata {
  sceneIndex: number;
  sceneId?: string;
  mediaUrl?: string;
  sourceStartSec: number;
  sourceEndSec: number;
  sourceSegments?: SubtitleSourceSegment[];
}

/**
 * Resolves a cut-timeline range [rawCutStart, rawCutEnd] against the scene list without
 * ever producing inverted source ranges or corrupting cross-seam / multi-clip references.
 */
export function mapCutRangeToSourceMetadata(
  scenes: SpeakingScene[],
  rawCutStart: number,
  rawCutEnd: number
): MappedCutSourceMetadata {
  if (scenes.length === 0) {
    const s = Number(Math.max(0, rawCutStart).toFixed(3));
    const e = Number(Math.max(s + 0.05, rawCutEnd).toFixed(3));
    return { sceneIndex: 0, sourceStartSec: s, sourceEndSec: e };
  }

  const cutStart = Math.max(0, Number.isFinite(rawCutStart) ? rawCutStart : 0);
  const cutEnd = Math.max(cutStart + 0.05, Number.isFinite(rawCutEnd) ? rawCutEnd : cutStart + 0.2);

  interface RawOverlapPart {
    sceneIndex: number;
    sceneId?: string;
    mediaUrl?: string;
    mediaType: "video" | "image";
    cutOverlapDur: number;
    sourceStartSec: number;
    sourceEndSec: number;
  }

  const overlaps: RawOverlapPart[] = [];
  let acc = 0;
  for (let i = 0; i < scenes.length; i++) {
    const sc = scenes[i];
    const dur = getSceneDurationSec(sc);
    const scCutStart = acc;
    const scCutEnd = acc + dur;
    acc = scCutEnd;

    const ovStart = Math.max(cutStart, scCutStart);
    const ovEnd = Math.min(cutEnd, scCutEnd);
    if (ovEnd - ovStart >= 0.02) {
      const relStart = Math.max(0, ovStart - scCutStart);
      const relEnd = Math.min(dur, ovEnd - scCutStart);
      const srcStart = Number(Math.max(0, sc.startSec + relStart).toFixed(3));
      const srcEnd = Number(
        Math.max(srcStart + 0.02, Math.min(sc.endSec, sc.startSec + relEnd)).toFixed(3)
      );
      const mediaType = sc.mediaType === "image" ? "image" : "video";
      const prev = overlaps[overlaps.length - 1];
      if (
        prev &&
        (prev.mediaUrl || "") === (sc.mediaUrl || "") &&
        prev.mediaType !== "image" &&
        mediaType !== "image" &&
        Math.abs(prev.sourceEndSec - srcStart) < 0.03 &&
        srcEnd > prev.sourceStartSec
      ) {
        prev.sourceEndSec = srcEnd;
        prev.cutOverlapDur += ovEnd - ovStart;
      } else {
        overlaps.push({
          sceneIndex: i,
          sceneId: sc.id,
          mediaUrl: sc.mediaUrl,
          mediaType,
          cutOverlapDur: ovEnd - ovStart,
          sourceStartSec: srcStart,
          sourceEndSec: srcEnd,
        });
      }
    }
  }

  if (overlaps.length === 0) {
    const exact = mapCutTimeToSourceExact(scenes, cutStart);
    const targetScene = scenes[exact.sceneIndex];
    const sceneEnd = targetScene ? targetScene.endSec : exact.sourceSec + 0.2;
    const span = Math.max(0.05, cutEnd - cutStart);
    const srcStart = Number(
      Math.max(targetScene?.startSec ?? 0, Math.min(sceneEnd - 0.05, exact.sourceSec)).toFixed(3)
    );
    const srcEnd = Number(Math.max(srcStart + 0.05, Math.min(sceneEnd, srcStart + span)).toFixed(3));
    return {
      sceneIndex: exact.sceneIndex,
      sceneId: exact.sceneId,
      mediaUrl: exact.mediaUrl,
      sourceStartSec: srcStart,
      sourceEndSec: srcEnd,
    };
  }

  let dominant = overlaps[0];
  for (let i = 1; i < overlaps.length; i++) {
    if (overlaps[i].cutOverlapDur > dominant.cutOverlapDur + 0.01) {
      dominant = overlaps[i];
    }
  }

  const sourceStartSec = Number(dominant.sourceStartSec.toFixed(3));
  const sourceEndSec = Number(Math.max(sourceStartSec + 0.05, dominant.sourceEndSec).toFixed(3));

  const sourceSegments: SubtitleSourceSegment[] | undefined =
    overlaps.length > 1
      ? overlaps.map((p) => ({
          ...(p.sceneId ? { sceneId: p.sceneId } : {}),
          ...(p.mediaUrl !== undefined ? { mediaUrl: p.mediaUrl } : {}),
          sourceStartSec: p.sourceStartSec,
          sourceEndSec: p.sourceEndSec,
        }))
      : undefined;

  return {
    sceneIndex: dominant.sceneIndex,
    sceneId: dominant.sceneId,
    mediaUrl: dominant.mediaUrl,
    sourceStartSec,
    sourceEndSec,
    ...(sourceSegments ? { sourceSegments } : {}),
  };
}

/**
 * Projects a baseline list of subtitles (with sourceStartSec/sourceEndSec or sourceSegments)
 * onto an edited sequence of SpeakingScenes. Adjacent contiguous clips are merged temporarily
 * into contiguous blocks so subtitles spanning split points stay intact, while duplicate/cloned
 * clips respect sceneId ownership so subtitles do not multiply unexpectedly.
 */
export function remapSubtitlesToScenes(
  baselineSubtitles: SubtitleItem[],
  nextScenes: SpeakingScene[]
): SubtitleItem[] {
  if (nextScenes.length === 0 || baselineSubtitles.length === 0) {
    return [];
  }

  const blocks = buildContiguousClipBlocks(nextScenes);
  if (blocks.length === 0) return [];

  const findSceneIndexInBlock = (
    block: ContiguousClipBlock,
    srcSec: number,
    preferredSceneId?: string
  ): number => {
    if (preferredSceneId) {
      const idRef = block.sceneRefs.find((ref) => ref.sceneId === preferredSceneId);
      if (idRef && srcSec >= idRef.startSec - 0.05 && srcSec <= idRef.endSec + 0.05) {
        return idRef.sceneIndex;
      }
    }
    for (const ref of block.sceneRefs) {
      if (srcSec >= ref.startSec - 0.05 && srcSec <= ref.endSec + 0.05) {
        return ref.sceneIndex;
      }
    }
    return block.sceneRefs[0]?.sceneIndex ?? 0;
  };

  const findMatchingBlocksForRange = (
    mediaUrl: string,
    srcStart: number,
    srcEnd: number,
    preferredSceneId: string | undefined,
    minOverlapSec: number
  ) => {
    const candidates = blocks
      .map((block, bIdx) => {
        if (block.mediaUrl !== mediaUrl) return null;
        const ovStart = Math.max(srcStart, block.startSec);
        const ovEnd = Math.min(srcEnd, block.endSec);
        if (ovEnd - ovStart < minOverlapSec) return null;
        const hasSceneId = Boolean(
          preferredSceneId && block.sceneRefs.some((ref) => ref.sceneId === preferredSceneId)
        );
        return { block, bIdx, ovStart, ovEnd, hasSceneId };
      })
      .filter((item): item is NonNullable<typeof item> => item !== null);

    if (candidates.length > 1 && preferredSceneId) {
      const ownMatches = candidates.filter((c) => c.hasSceneId);
      if (ownMatches.length > 0) {
        return ownMatches;
      }
    }
    return candidates;
  };

  const sliceWordsToWindow = (
    sub: SubtitleItem,
    clipLeftRatio: number,
    clipRightRatio: number,
    clippedDur: number
  ) => {
    const baseWords = Array.isArray(sub.words) ? sub.words : [];
    if (baseWords.length === 0) return [];
    const oldDur = Math.max(0.15, sub.endTime - sub.startTime);
    const clipLeftSec = clipLeftRatio * oldDur;
    const clipRightSec = clipRightRatio * oldDur;

    if (clipLeftRatio <= 0.02 && clipRightRatio >= 0.98 && Math.abs(clippedDur - oldDur) < 0.04) {
      return baseWords.map((w) => ({ ...w }));
    }

    return baseWords
      .filter((w) => w.endOffsetSec > clipLeftSec + 0.04 && w.startOffsetSec < clipRightSec - 0.04)
      .map((w) => {
        const shiftedStart = Math.max(0, w.startOffsetSec - clipLeftSec);
        const clampedStart = Math.min(Math.max(0, clippedDur - 0.05), shiftedStart);
        const shiftedEnd = Math.max(clampedStart + 0.04, w.endOffsetSec - clipLeftSec);
        const clampedEnd = Math.min(clippedDur, shiftedEnd);
        return {
          ...w,
          startOffsetSec: Number(clampedStart.toFixed(2)),
          endOffsetSec: Number(Math.max(clampedStart + 0.01, clampedEnd).toFixed(2)),
        };
      });
  };

  const mapped: SubtitleItem[] = [];
  const usedIds = new Set<string>();

  for (const sub of baselineSubtitles) {
    if (Array.isArray(sub.sourceSegments) && sub.sourceSegments.length > 1) {
      const validParts = sub.sourceSegments.filter(
        (p) =>
          Number.isFinite(p.sourceStartSec) &&
          Number.isFinite(p.sourceEndSec) &&
          p.sourceEndSec > p.sourceStartSec
      );
      if (validParts.length > 0) {
        const totalPartsDur = validParts.reduce(
          (acc, p) => acc + Math.max(0.04, p.sourceEndSec - p.sourceStartSec),
          0
        );
        interface ProjectedSlice {
          cutStart: number;
          cutEnd: number;
          sceneIndex: number;
          mediaUrl?: string;
          sourceStartSec: number;
          sourceEndSec: number;
          ratioStart: number;
          ratioEnd: number;
        }
        const slices: ProjectedSlice[] = [];
        let partCursor = 0;
        for (const part of validParts) {
          const partDur = Math.max(0.04, part.sourceEndSec - part.sourceStartSec);
          const partMediaUrl = part.mediaUrl !== undefined ? part.mediaUrl || "" : sub.mediaUrl || "";
          const partMatches = findMatchingBlocksForRange(
            partMediaUrl,
            part.sourceStartSec,
            part.sourceEndSec,
            part.sceneId ?? sub.sceneId,
            0.04
          );
          if (partMatches.length > 0) {
            const best = partMatches[0];
            const cutStart = best.block.cutStart + (best.ovStart - best.block.startSec);
            const cutEnd = best.block.cutStart + (best.ovEnd - best.block.startSec);
            const rStart =
              (partCursor + (best.ovStart - part.sourceStartSec)) / Math.max(0.05, totalPartsDur);
            const rEnd =
              (partCursor + (best.ovEnd - part.sourceStartSec)) / Math.max(0.05, totalPartsDur);
            slices.push({
              cutStart,
              cutEnd,
              sceneIndex: findSceneIndexInBlock(best.block, best.ovStart, part.sceneId ?? sub.sceneId),
              mediaUrl: nextScenes[findSceneIndexInBlock(best.block, best.ovStart, part.sceneId)]?.mediaUrl,
              sourceStartSec: Number(best.ovStart.toFixed(2)),
              sourceEndSec: Number(best.ovEnd.toFixed(2)),
              ratioStart: Math.max(0, Math.min(1, rStart)),
              ratioEnd: Math.max(0, Math.min(1, rEnd)),
            });
          }
          partCursor += partDur;
        }

        if (slices.length > 0) {
          slices.sort((a, b) => a.cutStart - b.cutStart);
          const groups: ProjectedSlice[][] = [];
          for (const sl of slices) {
            const curGroup = groups[groups.length - 1];
            const prevSlice = curGroup?.[curGroup.length - 1];
            if (prevSlice && sl.cutStart - prevSlice.cutEnd <= 0.08) {
              curGroup.push(sl);
            } else {
              groups.push([sl]);
            }
          }

          let bestGroup = groups[0];
          let bestGroupDur = 0;
          for (const grp of groups) {
            const gDur = grp[grp.length - 1].cutEnd - grp[0].cutStart;
            if (gDur > bestGroupDur) {
              bestGroupDur = gDur;
              bestGroup = grp;
            }
          }

          if (bestGroupDur >= 0.12 && bestGroup.length > 0) {
            const cutStart = Number(bestGroup[0].cutStart.toFixed(2));
            const cutEnd = Number(
              Math.max(cutStart + 0.12, bestGroup[bestGroup.length - 1].cutEnd).toFixed(2)
            );
            const clippedDur = Math.max(0.12, Number((cutEnd - cutStart).toFixed(2)));
            let dominantSlice = bestGroup[0];
            for (const sl of bestGroup) {
              if (sl.cutEnd - sl.cutStart > dominantSlice.cutEnd - dominantSlice.cutStart) {
                dominantSlice = sl;
              }
            }
            const minRatio = bestGroup.reduce((m, s) => Math.min(m, s.ratioStart), 1);
            const maxRatio = bestGroup.reduce((m, s) => Math.max(m, s.ratioEnd), 0);

            let uniqueId = sub.id;
            if (usedIds.has(uniqueId)) {
              let suffix = 1;
              while (usedIds.has(`${sub.id}-b${suffix}`)) suffix++;
              uniqueId = `${sub.id}-b${suffix}`;
            }
            usedIds.add(uniqueId);

            mapped.push(
              withSceneId(
                {
                  ...sub,
                  id: uniqueId,
                  sceneIndex: dominantSlice.sceneIndex,
                  startTime: cutStart,
                  endTime: cutEnd,
                  sourceStartSec: dominantSlice.sourceStartSec,
                  sourceEndSec: dominantSlice.sourceEndSec,
                  sourceSegments:
                    bestGroup.length > 1
                      ? bestGroup.map((sl) => ({
                          ...(nextScenes[sl.sceneIndex]?.id
                            ? { sceneId: nextScenes[sl.sceneIndex].id }
                            : {}),
                          ...(sl.mediaUrl !== undefined ? { mediaUrl: sl.mediaUrl } : {}),
                          sourceStartSec: sl.sourceStartSec,
                          sourceEndSec: sl.sourceEndSec,
                        }))
                      : undefined,
                  words: sliceWordsToWindow(sub, minRatio, maxRatio, clippedDur),
                  isManuallyEdited: Boolean(sub.isManuallyEdited),
                },
                nextScenes
              )
            );
          }
          continue;
        }
      }
    }

    const subSrcStart = sub.sourceStartSec;
    const subSrcEnd = sub.sourceEndSec;
    if (!Number.isFinite(subSrcStart) || !Number.isFinite(subSrcEnd) || subSrcEnd <= subSrcStart) {
      continue;
    }
    const subMediaUrl = sub.mediaUrl || "";
    const subSrcDur = Math.max(0.12, subSrcEnd - subSrcStart);
    const matchingBlocks = findMatchingBlocksForRange(
      subMediaUrl,
      subSrcStart,
      subSrcEnd,
      sub.sceneId,
      0.12
    );

    matchingBlocks.forEach(({ block, bIdx, ovStart, ovEnd }) => {
      const cutStart = Number((block.cutStart + (ovStart - block.startSec)).toFixed(2));
      const cutEnd = Number((block.cutStart + (ovEnd - block.startSec)).toFixed(2));
      const clipLeftRatio = Math.max(0, (ovStart - subSrcStart) / subSrcDur);
      const clipRightRatio = Math.min(1, (ovEnd - subSrcStart) / subSrcDur);
      const clippedDur = Math.max(0.12, Number((cutEnd - cutStart).toFixed(2)));

      let uniqueId = sub.id;
      if (usedIds.has(uniqueId)) {
        let suffix = bIdx || 1;
        while (usedIds.has(`${sub.id}-b${suffix}`)) {
          suffix++;
        }
        uniqueId = `${sub.id}-b${suffix}`;
      }
      usedIds.add(uniqueId);

      const mappedSceneIndex = findSceneIndexInBlock(block, ovStart, sub.sceneId);
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
            sourceSegments: undefined,
            words: sliceWordsToWindow(sub, clipLeftRatio, clipRightRatio, clippedDur),
            isManuallyEdited: Boolean(sub.isManuallyEdited),
          },
          nextScenes
        )
      );
    });
  }

  return mapped.sort((a, b) => a.startTime - b.startTime);
}
