import type { SpeechRegion } from "../types";

export interface TimelineSegmentLike {
  startSec: number;
  endSec: number;
  clipDur: number;
  cutStart: number;
  cutEnd: number;
  mediaUrl?: string;
  sceneId?: string;
}

export interface CutSpeechRegion {
  cutStart: number;
  cutEnd: number;
}

export function projectSpeechRegionsToCutTimeline(
  segments: TimelineSegmentLike[],
  speechRegions: SpeechRegion[]
): CutSpeechRegion[] {
  if (segments.length === 0 || speechRegions.length === 0) return [];
  const projected: CutSpeechRegion[] = [];

  for (const seg of segments) {
    const segMediaUrl = seg.mediaUrl || "";
    for (const sr of speechRegions) {
      if (sr.mediaUrl !== undefined && (sr.mediaUrl || "") !== segMediaUrl) {
        continue;
      }
      if (sr.sceneId && seg.sceneId && sr.sceneId !== seg.sceneId) {
        continue;
      }
      const ovStart = Math.max(seg.startSec, sr.sourceStartSec);
      const ovEnd = Math.min(seg.endSec, sr.sourceEndSec);
      if (ovEnd - ovStart >= 0.04) {
        projected.push({
          cutStart: seg.cutStart + (ovStart - seg.startSec),
          cutEnd: seg.cutStart + (ovEnd - seg.startSec),
        });
      }
    }
  }

  if (projected.length === 0) return [];
  projected.sort((a, b) => a.cutStart - b.cutStart);

  // Only merge genuinely overlapping intervals so individual initial subtitle clips stay distinct
  const merged: CutSpeechRegion[] = [];
  for (const r of projected) {
    const prev = merged[merged.length - 1];
    if (prev && r.cutStart < prev.cutEnd - 0.001) {
      prev.cutEnd = Math.max(prev.cutEnd, r.cutEnd);
    } else {
      merged.push({ ...r });
    }
  }
  return merged;
}
