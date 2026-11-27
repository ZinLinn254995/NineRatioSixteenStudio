export type TranscriptVersionKind = "old" | "new" | "backup";

export interface TranscriptVersion {
  id: string;
  label: string;
  kind: TranscriptVersionKind;
  createdAt: number;
  lineCount: number;
  changedCount?: number;
  text: string;
  previewLine: string;
}

const STORAGE_KEY = "nine_ratio_transcript_history_v1";
const MAX_VERSIONS_PER_PROJECT = 15;
const MAX_STORED_PROJECTS = 25;

type TranscriptHistoryStore = Record<
  string,
  {
    updatedAt: number;
    versions: TranscriptVersion[];
  }
>;

function normalizeProjectKey(projectKey: string): string {
  const cleaned = projectKey.trim();
  return cleaned || "__default_project__";
}

function readStore(): TranscriptHistoryStore {
  if (typeof window === "undefined" || !window.localStorage) return {};
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return {};
    return parsed as TranscriptHistoryStore;
  } catch {
    return {};
  }
}

function writeStore(store: TranscriptHistoryStore): void {
  if (typeof window === "undefined" || !window.localStorage) return;
  try {
    const keys = Object.keys(store);
    if (keys.length > MAX_STORED_PROJECTS) {
      keys
        .sort((a, b) => (store[a]?.updatedAt ?? 0) - (store[b]?.updatedAt ?? 0))
        .slice(0, keys.length - MAX_STORED_PROJECTS)
        .forEach((oldestKey) => {
          delete store[oldestKey];
        });
    }
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(store));
  } catch {
    // Ignore quota errors gracefully
  }
}

function makeVersionId(): string {
  return `tv_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
}

export function loadTranscriptVersions(projectKey: string): TranscriptVersion[] {
  const key = normalizeProjectKey(projectKey);
  const store = readStore();
  const entry = store[key];
  if (!entry || !Array.isArray(entry.versions)) return [];
  return entry.versions.filter(
    (v) => v && typeof v.id === "string" && typeof v.text === "string"
  );
}

export function saveTranscriptVersion(
  projectKey: string,
  draft: Omit<TranscriptVersion, "id" | "createdAt">
): TranscriptVersion[] {
  const key = normalizeProjectKey(projectKey);
  const trimmedText = draft.text.trim();
  if (!trimmedText) return loadTranscriptVersions(key);

  const store = readStore();
  const existing = store[key]?.versions ?? [];

  // Avoid duplicate back-to-back snapshot with the exact same text and kind
  const top = existing[0];
  let nextVersions: TranscriptVersion[];
  if (top && top.text.trim() === trimmedText && top.kind === draft.kind) {
    nextVersions = [
      {
        ...top,
        label: draft.label || top.label,
        createdAt: Date.now(),
        lineCount: draft.lineCount,
        changedCount: draft.changedCount ?? top.changedCount,
        previewLine: draft.previewLine || top.previewLine,
      },
      ...existing.slice(1),
    ];
  } else {
    const item: TranscriptVersion = {
      id: makeVersionId(),
      label: draft.label.trim() || "Transcript Snapshot",
      kind: draft.kind,
      createdAt: Date.now(),
      lineCount: draft.lineCount,
      changedCount: draft.changedCount,
      text: draft.text,
      previewLine: draft.previewLine,
    };
    nextVersions = [item, ...existing].slice(0, MAX_VERSIONS_PER_PROJECT);
  }

  store[key] = {
    updatedAt: Date.now(),
    versions: nextVersions,
  };
  writeStore(store);
  return nextVersions;
}

export function renameTranscriptVersion(
  projectKey: string,
  versionId: string,
  nextLabel: string
): TranscriptVersion[] {
  const key = normalizeProjectKey(projectKey);
  const cleanLabel = nextLabel.trim();
  if (!cleanLabel) return loadTranscriptVersions(key);

  const store = readStore();
  const existing = store[key]?.versions ?? [];
  const nextVersions = existing.map((v) =>
    v.id === versionId ? { ...v, label: cleanLabel } : v
  );
  store[key] = {
    updatedAt: Date.now(),
    versions: nextVersions,
  };
  writeStore(store);
  return nextVersions;
}

export function deleteTranscriptVersion(
  projectKey: string,
  versionId: string
): TranscriptVersion[] {
  const key = normalizeProjectKey(projectKey);
  const store = readStore();
  const existing = store[key]?.versions ?? [];
  const nextVersions = existing.filter((v) => v.id !== versionId);
  store[key] = {
    updatedAt: Date.now(),
    versions: nextVersions,
  };
  writeStore(store);
  return nextVersions;
}

export function clearTranscriptVersions(projectKey: string): TranscriptVersion[] {
  const key = normalizeProjectKey(projectKey);
  const store = readStore();
  delete store[key];
  writeStore(store);
  return [];
}

export async function copyTextToClipboard(text: string): Promise<boolean> {
  if (!text) return false;
  try {
    if (navigator.clipboard && typeof navigator.clipboard.writeText === "function") {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Fall through to legacy textarea copy fallback
  }

  try {
    const textarea = document.createElement("textarea");
    textarea.value = text;
    textarea.setAttribute("readonly", "");
    textarea.style.position = "fixed";
    textarea.style.top = "-9999px";
    textarea.style.left = "-9999px";
    textarea.style.opacity = "0";
    document.body.appendChild(textarea);
    textarea.focus();
    textarea.select();
    const ok = document.execCommand("copy");
    textarea.remove();
    return ok;
  } catch {
    return false;
  }
}
