import { useMemo, useRef, useState } from "react";
import {
  Bookmark,
  Check,
  Download,
  Film,
  FolderOpen,
  Link2,
  Pencil,
  Plus,
  Search,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import type { SavedProjectRecord } from "../types";
import { getEffectivePlaybackSpeed } from "../utils/voicePresets";

interface SavedProjectsPanelProps {
  projects: SavedProjectRecord[];
  activeSavedId: string | null;
  canSaveCurrent: boolean;
  isLoading: boolean;
  isSaving: boolean;
  onSaveCurrent: (asNew?: boolean) => void;
  onOpenProject: (record: SavedProjectRecord) => void;
  onRenameProject: (id: string, title: string) => void;
  onDeleteProject: (id: string) => void;
  onExportJson: (record: SavedProjectRecord) => void;
  onImportJson: (file: File) => void;
  onRelinkLocalVideo: (id: string, file: File) => void;
}

function formatShortDate(ms: number): string {
  try {
    return new Intl.DateTimeFormat(undefined, {
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    }).format(new Date(ms));
  } catch {
    return "";
  }
}

function formatSizeMb(bytes?: number): string {
  if (!bytes || bytes <= 0) return "";
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function SavedProjectsPanel({
  projects,
  activeSavedId,
  canSaveCurrent,
  isLoading,
  isSaving,
  onSaveCurrent,
  onOpenProject,
  onRenameProject,
  onDeleteProject,
  onExportJson,
  onImportJson,
  onRelinkLocalVideo,
}: SavedProjectsPanelProps) {
  const [filterText, setFilterText] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingTitle, setEditingTitle] = useState("");
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [relinkTargetId, setRelinkTargetId] = useState<string | null>(null);

  const importInputRef = useRef<HTMLInputElement | null>(null);
  const relinkInputRef = useRef<HTMLInputElement | null>(null);

  const filtered = useMemo(() => {
    const q = filterText.trim().toLowerCase();
    if (!q) return projects;
    return projects.filter(
      (p) =>
        p.title.toLowerCase().includes(q) ||
        p.channel.toLowerCase().includes(q) ||
        p.subtitles.some(
          (s) =>
            s.thaiPhonetic.toLowerCase().includes(q) ||
            s.burmese.toLowerCase().includes(q)
        )
    );
  }, [projects, filterText]);

  const startRename = (record: SavedProjectRecord) => {
    setEditingId(record.id);
    setEditingTitle(record.title);
    setConfirmDeleteId(null);
  };

  const commitRename = (id: string) => {
    const trimmed = editingTitle.trim();
    if (trimmed) {
      onRenameProject(id, trimmed);
    }
    setEditingId(null);
  };

  return (
    <div className="flex flex-col gap-4 pb-6">
      <input
        ref={importInputRef}
        type="file"
        accept="application/json,.json"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) onImportJson(f);
          e.target.value = "";
        }}
      />

      <input
        ref={relinkInputRef}
        type="file"
        accept="video/*"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f && relinkTargetId) {
            onRelinkLocalVideo(relinkTargetId, f);
          }
          setRelinkTargetId(null);
          e.target.value = "";
        }}
      />

      {/* Top Toolbar */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative flex-1 min-w-[160px]">
          <Search className="w-3.5 h-3.5 text-neutral-400 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
          <input
            type="text"
            value={filterText}
            onChange={(e) => setFilterText(e.target.value)}
            placeholder="Search saved projects..."
            aria-label="Search saved projects"
            className="w-full h-9 pl-8 pr-3 text-xs rounded-lg border border-neutral-200 dark:border-neutral-800 bg-neutral-50 dark:bg-neutral-900 text-neutral-950 dark:text-neutral-50 placeholder:text-neutral-400 focus:outline-none focus:border-neutral-950 dark:focus:border-white"
          />
        </div>

        <button
          type="button"
          onClick={() => importInputRef.current?.click()}
          className="h-9 px-3 rounded-lg border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-950 hover:bg-neutral-100 dark:hover:bg-neutral-900 text-xs font-medium flex items-center gap-1.5 whitespace-nowrap cursor-pointer transition-colors"
        >
          <Upload className="w-3.5 h-3.5" />
          <span>Import JSON</span>
        </button>

        {canSaveCurrent && (
          <>
            <button
              type="button"
              onClick={() => onSaveCurrent(false)}
              disabled={isSaving}
              className="h-9 px-3.5 rounded-lg bg-neutral-950 text-white dark:bg-white dark:text-neutral-950 text-xs font-semibold flex items-center gap-1.5 whitespace-nowrap hover:opacity-90 disabled:opacity-40 cursor-pointer transition-opacity"
            >
              <Bookmark className="w-3.5 h-3.5" />
              <span>{activeSavedId ? "Update Saved" : "Save Project"}</span>
            </button>

            {activeSavedId && (
              <button
                type="button"
                onClick={() => onSaveCurrent(true)}
                disabled={isSaving}
                title="Save as a new separate copy"
                className="h-9 px-3 rounded-lg border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-950 hover:bg-neutral-100 dark:hover:bg-neutral-900 text-xs font-medium flex items-center gap-1 whitespace-nowrap cursor-pointer transition-colors"
              >
                <Plus className="w-3.5 h-3.5" />
                <span>Copy</span>
              </button>
            )}
          </>
        )}
      </div>

      {/* Saved List */}
      {isLoading ? (
        <div className="space-y-3">
          {Array.from({ length: 3 }).map((_, i) => (
            <div
              key={i}
              className="h-24 rounded-xl border border-neutral-200 dark:border-neutral-800 bg-neutral-50 dark:bg-neutral-900 animate-pulse"
            />
          ))}
        </div>
      ) : filtered.length === 0 ? (
        <div className="py-16 px-4 rounded-xl border border-dashed border-neutral-200 dark:border-neutral-800 flex flex-col items-center justify-center text-center">
          <FolderOpen className="w-6 h-6 text-neutral-400 mb-2.5" />
          <p className="text-sm font-medium text-neutral-900 dark:text-neutral-100">
            {projects.length === 0 ? "No offline projects saved yet" : "No matching projects"}
          </p>
          <p className="text-xs text-neutral-500 dark:text-neutral-400 mt-1 max-w-xs">
            {projects.length === 0
              ? "Click Save in the top bar anytime to keep your scenes, subtitles, voice & edit settings stored offline on this device."
              : "Try a different search keyword."}
          </p>
        </div>
      ) : (
        <div className="space-y-2.5">
          {filtered.map((record) => {
            const isActive = record.id === activeSavedId;
            const isEditing = editingId === record.id;
            const isDeleting = confirmDeleteId === record.id;
            const spd = getEffectivePlaybackSpeed(
              record.sourceType,
              record.editSettings.playbackSpeed,
              record.voiceSettings.speed
            );
            const scaledDur = Math.round(record.targetDurationSec / spd);

            return (
              <div
                key={record.id}
                className={`rounded-xl border p-3 transition-colors ${
                  isActive
                    ? "border-neutral-950 dark:border-white bg-neutral-50 dark:bg-neutral-900"
                    : "border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-950 hover:border-neutral-300 dark:hover:border-neutral-700"
                }`}
              >
                <div className="flex items-start gap-3">
                  {/* Thumbnail */}
                  <button
                    type="button"
                    onClick={() => onOpenProject(record)}
                    aria-label={`Open ${record.title}`}
                    className="relative w-24 sm:w-28 aspect-video rounded-lg overflow-hidden bg-neutral-100 dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-800 shrink-0 cursor-pointer group"
                  >
                    {record.thumbnail ? (
                      <img
                        src={record.thumbnail}
                        alt={record.title}
                        referrerPolicy="no-referrer"
                        className="w-full h-full object-cover group-hover:scale-[1.03] transition-transform duration-200"
                      />
                    ) : (
                      <div className="w-full h-full flex items-center justify-center text-neutral-400">
                        <Film className="w-4 h-4" />
                      </div>
                    )}
                    <span className="absolute bottom-1 right-1 px-1 py-0.5 rounded bg-black/80 text-white text-[10px] font-mono-tabular leading-none">
                      {scaledDur}s
                    </span>
                  </button>

                  {/* Details */}
                  <div className="flex-1 min-w-0">
                    {isEditing ? (
                      <div className="flex items-center gap-1.5">
                        <input
                          type="text"
                          value={editingTitle}
                          onChange={(e) => setEditingTitle(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") commitRename(record.id);
                            if (e.key === "Escape") setEditingId(null);
                          }}
                          autoFocus
                          aria-label="Project title"
                          className="flex-1 min-w-0 h-7 px-2 text-xs font-semibold rounded border border-neutral-400 dark:border-neutral-600 bg-white dark:bg-neutral-950 focus:outline-none focus:border-neutral-950 dark:focus:border-white"
                        />
                        <button
                          type="button"
                          onClick={() => commitRename(record.id)}
                          aria-label="Save name"
                          className="w-7 h-7 rounded bg-neutral-950 text-white dark:bg-white dark:text-neutral-950 flex items-center justify-center cursor-pointer"
                        >
                          <Check className="w-3.5 h-3.5" />
                        </button>
                        <button
                          type="button"
                          onClick={() => setEditingId(null)}
                          aria-label="Cancel rename"
                          className="w-7 h-7 rounded border border-neutral-200 dark:border-neutral-700 flex items-center justify-center cursor-pointer"
                        >
                          <X className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    ) : (
                      <div className="flex items-start justify-between gap-2">
                        <button
                          type="button"
                          onClick={() => onOpenProject(record)}
                          className="text-left text-[13px] font-semibold text-neutral-950 dark:text-neutral-50 truncate hover:underline cursor-pointer"
                        >
                          {record.title}
                        </button>
                        <span className="text-[10px] font-mono-tabular uppercase tracking-wide px-1.5 py-0.5 rounded border border-neutral-200 dark:border-neutral-700 text-neutral-500 dark:text-neutral-400 shrink-0">
                          {record.sourceType === "youtube" ? "YouTube" : "Local"}
                        </span>
                      </div>
                    )}

                    <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-neutral-500 dark:text-neutral-400 font-mono-tabular">
                      <span>
                        {record.scenes.length}{" "}
                        {record.scenes.length === 1 ? "scene" : "scenes"}
                      </span>
                      <span aria-hidden="true">·</span>
                      <span>
                        {record.subtitles.length}{" "}
                        {record.subtitles.length === 1 ? "subtitle" : "subtitles"}
                      </span>
                      <span aria-hidden="true">·</span>
                      <span>{formatShortDate(record.updatedAt)}</span>
                      {record.sourceType === "local" && (
                        <>
                          <span aria-hidden="true">·</span>
                          <span>
                            {record.hasLocalVideoBlob
                              ? `Cached${record.localFileSize ? ` (${formatSizeMb(record.localFileSize)})` : ""}`
                              : "Video not linked"}
                          </span>
                        </>
                      )}
                    </div>

                    {/* Row Actions */}
                    <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
                      <button
                        type="button"
                        onClick={() => onOpenProject(record)}
                        className="h-7 px-2.5 rounded-md bg-neutral-950 text-white dark:bg-white dark:text-neutral-950 text-[11px] font-medium hover:opacity-90 cursor-pointer transition-opacity"
                      >
                        {isActive ? "Active" : "Open"}
                      </button>

                      {record.sourceType === "local" && !record.hasLocalVideoBlob && (
                        <button
                          type="button"
                          onClick={() => {
                            setRelinkTargetId(record.id);
                            relinkInputRef.current?.click();
                          }}
                          className="h-7 px-2.5 rounded-md border border-neutral-300 dark:border-neutral-700 bg-white dark:bg-neutral-950 hover:bg-neutral-100 dark:hover:bg-neutral-900 text-[11px] font-medium flex items-center gap-1 cursor-pointer transition-colors"
                        >
                          <Link2 className="w-3 h-3" />
                          <span>Link Video</span>
                        </button>
                      )}

                      <button
                        type="button"
                        onClick={() => startRename(record)}
                        title="Rename project"
                        aria-label={`Rename ${record.title}`}
                        className="h-7 w-7 rounded-md border border-neutral-200 dark:border-neutral-800 hover:bg-neutral-100 dark:hover:bg-neutral-900 flex items-center justify-center text-neutral-600 dark:text-neutral-400 cursor-pointer transition-colors"
                      >
                        <Pencil className="w-3 h-3" />
                      </button>

                      <button
                        type="button"
                        onClick={() => onExportJson(record)}
                        title="Export project JSON backup"
                        aria-label={`Export ${record.title} JSON`}
                        className="h-7 w-7 rounded-md border border-neutral-200 dark:border-neutral-800 hover:bg-neutral-100 dark:hover:bg-neutral-900 flex items-center justify-center text-neutral-600 dark:text-neutral-400 cursor-pointer transition-colors"
                      >
                        <Download className="w-3 h-3" />
                      </button>

                      {isDeleting ? (
                        <div className="flex items-center gap-1 ml-auto">
                          <button
                            type="button"
                            onClick={() => {
                              onDeleteProject(record.id);
                              setConfirmDeleteId(null);
                            }}
                            className="h-7 px-2 rounded-md bg-neutral-950 text-white dark:bg-white dark:text-neutral-950 text-[11px] font-semibold cursor-pointer"
                          >
                            Confirm
                          </button>
                          <button
                            type="button"
                            onClick={() => setConfirmDeleteId(null)}
                            className="h-7 px-2 rounded-md border border-neutral-200 dark:border-neutral-800 text-[11px] cursor-pointer"
                          >
                            Cancel
                          </button>
                        </div>
                      ) : (
                        <button
                          type="button"
                          onClick={() => setConfirmDeleteId(record.id)}
                          title="Delete saved project"
                          aria-label={`Delete ${record.title}`}
                          className="h-7 w-7 rounded-md border border-neutral-200 dark:border-neutral-800 hover:bg-neutral-100 dark:hover:bg-neutral-900 flex items-center justify-center text-neutral-500 hover:text-neutral-950 dark:hover:text-white cursor-pointer transition-colors ml-auto"
                        >
                          <Trash2 className="w-3 h-3" />
                        </button>
                      )}
                    </div>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
