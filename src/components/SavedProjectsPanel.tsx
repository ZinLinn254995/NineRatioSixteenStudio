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
import { isLegacyYouTubeProject } from "../utils/offlineProjects";
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
    if (isLegacyYouTubeProject(record)) return;
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
      <div className="flex flex-wrap items-center gap-2 pb-3 border-b border-[#d2dcf0] dark:border-[#21284c]">
        <div className="relative flex-1 min-w-[160px]">
          <Search className="w-3.5 h-3.5 text-[#4d597d] dark:text-[#919ec4] absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
          <input
            type="text"
            value={filterText}
            onChange={(e) => setFilterText(e.target.value)}
            placeholder="Search saved projects..."
            aria-label="Search saved projects"
            className="w-full h-9 pl-8 pr-3 text-xs rounded-md border border-[#d2dcf0] dark:border-[#21284c] bg-[#f3f5fc] dark:bg-[#141933] text-[#0c1026] dark:text-[#f3f5fc] placeholder:text-[#4d597d]/75 dark:placeholder:text-[#919ec4]/75 focus:outline-none focus:border-teal-700 dark:focus:border-teal-400 transition-colors"
          />
        </div>

        <button
          type="button"
          onClick={() => importInputRef.current?.click()}
          className="h-9 px-3 rounded-md border border-[#d2dcf0] dark:border-[#21284c] bg-[#f3f5fc] dark:bg-[#141933] hover:bg-[#e7ecf8] dark:hover:bg-[#1a2142] text-xs font-medium text-[#0c1026] dark:text-[#f3f5fc] flex items-center gap-1.5 whitespace-nowrap cursor-pointer transition-colors"
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
              className="h-9 px-3.5 rounded-md bg-teal-700 hover:bg-teal-800 dark:bg-teal-400 dark:hover:bg-teal-300 text-white dark:text-[#060918] text-xs font-semibold flex items-center gap-1.5 whitespace-nowrap disabled:opacity-40 cursor-pointer transition-colors shadow-xs"
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
                className="h-9 px-3 rounded-md border border-[#d2dcf0] dark:border-[#21284c] bg-[#f3f5fc] dark:bg-[#141933] hover:bg-[#e7ecf8] dark:hover:bg-[#1a2142] text-xs font-medium text-[#0c1026] dark:text-[#f3f5fc] flex items-center gap-1 whitespace-nowrap cursor-pointer transition-colors"
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
        <div className="divide-y divide-[#d2dcf0] dark:divide-[#21284c]">
          {Array.from({ length: 3 }).map((_, i) => (
            <div
              key={i}
              className="h-24 bg-[#e7ecf8]/60 dark:bg-[#141933]/60 animate-pulse my-1 rounded-md"
            />
          ))}
        </div>
      ) : filtered.length === 0 ? (
        <div className="py-16 px-4 rounded-lg border border-dashed border-[#bcc9e6] dark:border-[#2e3644] bg-[#e7ecf8]/40 dark:bg-[#050712] flex flex-col items-center justify-center text-center">
          <FolderOpen className="w-6 h-6 text-[#4d597d] dark:text-[#919ec4] mb-2.5" />
          <p className="font-display text-sm font-semibold text-[#0c1026] dark:text-[#f3f5fc]">
            {projects.length === 0 ? "No offline projects saved yet" : "No matching projects"}
          </p>
          <p className="text-xs text-[#4d597d] dark:text-[#919ec4] mt-1 max-w-xs">
            {projects.length === 0
              ? "Click Save anytime to keep your scenes, subtitles, voice & edit settings stored offline on this device."
              : "Try a different search keyword."}
          </p>
        </div>
      ) : (
        <div className="divide-y divide-[#d2dcf0] dark:divide-[#21284c] border-y border-[#d2dcf0] dark:border-[#21284c]">
          {filtered.map((record) => {
            const isLegacy = isLegacyYouTubeProject(record);
            const isActive = !isLegacy && record.id === activeSavedId;
            const isEditing = !isLegacy && editingId === record.id;
            const isDeleting = confirmDeleteId === record.id;
            const spd = getEffectivePlaybackSpeed(
              record.editSettings.playbackSpeed,
              record.voiceSettings.speed
            );
            const scaledDur = Math.round(record.targetDurationSec / spd);

            return (
              <div
                key={record.id}
                className={`py-3.5 px-2 transition-colors ${
                  isActive
                    ? "bg-teal-50/60 dark:bg-teal-950/25"
                    : "hover:bg-[#e7ecf8]/60 dark:hover:bg-[#141933]/60"
                }`}
              >
                <div className="flex items-start gap-3.5">
                  {/* Thumbnail */}
                  {isLegacy ? (
                    <div
                      aria-label={`${record.title} (Legacy YouTube read-only)`}
                      className="relative w-24 sm:w-28 aspect-video rounded-md overflow-hidden bg-[#e7ecf8] dark:bg-[#141933] border border-[#d2dcf0] dark:border-[#21284c] shrink-0 opacity-80"
                    >
                      {record.thumbnail ? (
                        <img
                          src={record.thumbnail}
                          alt={record.title}
                          referrerPolicy="no-referrer"
                          className="w-full h-full object-cover"
                        />
                      ) : (
                        <div className="w-full h-full flex items-center justify-center text-[#4d597d] dark:text-[#919ec4]">
                          <Film className="w-4 h-4" />
                        </div>
                      )}
                      <span className="absolute bottom-1 right-1 px-1 py-0.5 rounded bg-black/80 text-white text-[10px] font-mono-tabular leading-none">
                        {scaledDur}s
                      </span>
                    </div>
                  ) : (
                    <button
                      type="button"
                      onClick={() => onOpenProject(record)}
                      aria-label={`Open ${record.title}`}
                      className="relative w-24 sm:w-28 aspect-video rounded-md overflow-hidden bg-[#e7ecf8] dark:bg-[#141933] border border-[#d2dcf0] dark:border-[#21284c] shrink-0 cursor-pointer group"
                    >
                      {record.thumbnail ? (
                        <img
                          src={record.thumbnail}
                          alt={record.title}
                          referrerPolicy="no-referrer"
                          className="w-full h-full object-cover group-hover:scale-[1.03] transition-transform duration-200"
                        />
                      ) : (
                        <div className="w-full h-full flex items-center justify-center text-[#4d597d] dark:text-[#919ec4]">
                          <Film className="w-4 h-4" />
                        </div>
                      )}
                      <span className="absolute bottom-1 right-1 px-1 py-0.5 rounded bg-black/80 text-white text-[10px] font-mono-tabular leading-none">
                        {scaledDur}s
                      </span>
                    </button>
                  )}

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
                          className="flex-1 min-w-0 h-7 px-2 text-xs font-semibold rounded border border-teal-700 dark:border-teal-400 bg-white dark:bg-[#141933] text-[#0c1026] dark:text-[#f3f5fc] focus:outline-none"
                        />
                        <button
                          type="button"
                          onClick={() => commitRename(record.id)}
                          aria-label="Save name"
                          className="w-7 h-7 rounded bg-teal-700 text-white dark:bg-teal-400 dark:text-[#060918] flex items-center justify-center cursor-pointer"
                        >
                          <Check className="w-3.5 h-3.5" />
                        </button>
                        <button
                          type="button"
                          onClick={() => setEditingId(null)}
                          aria-label="Cancel rename"
                          className="w-7 h-7 rounded border border-[#d2dcf0] dark:border-[#21284c] flex items-center justify-center cursor-pointer"
                        >
                          <X className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    ) : isLegacy ? (
                      <div className="text-left text-[13px] font-semibold text-[#4d597d] dark:text-[#919ec4] truncate block max-w-full">
                        {record.title}
                      </div>
                    ) : (
                      <button
                        type="button"
                        onClick={() => onOpenProject(record)}
                        className="text-left text-[13px] font-semibold text-[#0c1026] dark:text-[#f3f5fc] truncate hover:text-teal-700 dark:hover:text-teal-400 transition-colors cursor-pointer block max-w-full"
                      >
                        {record.title}
                      </button>
                    )}

                    <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-[#4d597d] dark:text-[#919ec4] font-mono-tabular">
                      <span>{isLegacy ? "Legacy YouTube · Read-only" : "Local"}</span>
                      <span aria-hidden="true">·</span>
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
                      {!isLegacy && (
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
                      {isLegacy ? (
                        <span
                          title="Legacy YouTube projects are read-only and cannot open in Studio. Export JSON for backup or upload a local video to edit."
                          className="h-7 px-2.5 rounded-md border border-[#d2dcf0] dark:border-[#21284c] bg-[#e7ecf8]/70 dark:bg-[#141933]/70 text-[11px] font-medium text-[#4d597d] dark:text-[#919ec4] inline-flex items-center whitespace-nowrap shrink-0"
                        >
                          Read-only (Legacy)
                        </span>
                      ) : (
                        <>
                          <button
                            type="button"
                            onClick={() => onOpenProject(record)}
                            className={`h-7 px-3 rounded-md text-[11px] font-semibold cursor-pointer transition-colors whitespace-nowrap shrink-0 ${
                              isActive
                                ? "bg-teal-700 text-white dark:bg-teal-400 dark:text-[#060918]"
                                : "bg-[#0c1026] text-white dark:bg-[#f3f5fc] dark:text-[#070814] hover:bg-teal-700 dark:hover:bg-teal-400 dark:hover:text-[#060918]"
                            }`}
                          >
                            {isActive ? "Active" : "Open"}
                          </button>

                          {!record.hasLocalVideoBlob && (
                            <button
                              type="button"
                              onClick={() => {
                                setRelinkTargetId(record.id);
                                relinkInputRef.current?.click();
                              }}
                              className="h-7 px-2.5 rounded-md border border-[#d2dcf0] dark:border-[#21284c] bg-[#f3f5fc] dark:bg-[#141933] hover:bg-[#e7ecf8] dark:hover:bg-[#1a2142] text-[11px] font-medium text-[#0c1026] dark:text-[#f3f5fc] flex items-center gap-1 cursor-pointer transition-colors whitespace-nowrap"
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
                            className="h-7 w-7 rounded-md border border-[#d2dcf0] dark:border-[#21284c] bg-[#f3f5fc] dark:bg-[#141933] hover:bg-[#e7ecf8] dark:hover:bg-[#1a2142] flex items-center justify-center text-[#4d597d] dark:text-[#919ec4] hover:text-[#0c1026] dark:hover:text-[#f3f5fc] cursor-pointer transition-colors"
                          >
                            <Pencil className="w-3 h-3" />
                          </button>
                        </>
                      )}

                      <button
                        type="button"
                        onClick={() => onExportJson(record)}
                        title="Export project JSON backup"
                        aria-label={`Export ${record.title} JSON`}
                        className="h-7 w-7 rounded-md border border-[#d2dcf0] dark:border-[#21284c] bg-[#f3f5fc] dark:bg-[#141933] hover:bg-[#e7ecf8] dark:hover:bg-[#1a2142] flex items-center justify-center text-[#4d597d] dark:text-[#919ec4] hover:text-[#0c1026] dark:hover:text-[#f3f5fc] cursor-pointer transition-colors"
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
                            className="h-7 px-2.5 rounded-md bg-red-600 hover:bg-red-700 text-white text-[11px] font-semibold cursor-pointer transition-colors"
                          >
                            Confirm
                          </button>
                          <button
                            type="button"
                            onClick={() => setConfirmDeleteId(null)}
                            className="h-7 px-2 rounded-md border border-[#d2dcf0] dark:border-[#21284c] text-[11px] text-[#4d597d] dark:text-[#919ec4] cursor-pointer"
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
                          className="h-7 w-7 rounded-md border border-[#d2dcf0] dark:border-[#21284c] bg-[#f3f5fc] dark:bg-[#141933] hover:bg-red-50 hover:border-red-200 dark:hover:bg-red-950/40 dark:hover:border-red-900 flex items-center justify-center text-[#4d597d] dark:text-[#919ec4] hover:text-red-600 dark:hover:text-red-400 cursor-pointer transition-colors ml-auto"
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
