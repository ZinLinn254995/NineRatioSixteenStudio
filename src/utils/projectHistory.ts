import type { SpeakingScene, SubtitleItem } from "../types";

export interface ProjectSnapshot {
  scenes: SpeakingScene[];
  subtitles: SubtitleItem[];
  baselineSubtitles: SubtitleItem[] | null;
  baselineScenes: SpeakingScene[] | null;
}

export const MAX_HISTORY = 50;

export function snapshotsEqual(a: ProjectSnapshot, b: ProjectSnapshot): boolean {
  return (
    a.scenes === b.scenes &&
    a.subtitles === b.subtitles &&
    a.baselineSubtitles === b.baselineSubtitles &&
    a.baselineScenes === b.baselineScenes
  );
}

export function pushCapped<T>(stack: T[], item: T, max = MAX_HISTORY): T[] {
  if (max <= 0) return [];
  const next = stack.length >= max ? stack.slice(-(max - 1)) : stack.slice();
  next.push(item);
  return next;
}
