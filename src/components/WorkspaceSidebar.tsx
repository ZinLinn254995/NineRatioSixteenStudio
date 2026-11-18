import { useEffect, useRef, type ReactNode } from "react";
import { Film, Loader2 } from "lucide-react";
import type {
  ActiveMediaSource,
  SavedProjectRecord,
  SceneSelection,
  SubtitleItem,
  VideoEditSettings,
  VideoProject,
  VoiceSettings,
  YouTubeLicenseFilter,
  YouTubeVideo,
} from "../types";
import { ScenePicker } from "./ScenePicker";
import { YouTubePreviewPanel } from "./YouTubePreviewPanel";
import { VoiceChangerPanel } from "./VoiceChangerPanel";
import { VideoEditPanel } from "./VideoEditPanel";
import { SavedProjectsPanel } from "./SavedProjectsPanel";
import { getEffectivePlaybackSpeed } from "../utils/voicePresets";

export type WorkspaceTab =
  | "videos"
  | "ytPreview"
  | "scenes"
  | "edit"
  | "script"
  | "voice"
  | "projects";

interface WorkspaceSidebarProps {
  activeTab: WorkspaceTab;
  onTabChange: (tab: WorkspaceTab) => void;
  videos: YouTubeVideo[];
  selectedVideoId?: string;
  activeQuery: string;
  licenseFilter: YouTubeLicenseFilter;
  hasMoreVideos: boolean;
  isLoadingMore: boolean;
  localMedia: ActiveMediaSource | null;
  youtubeMedia: ActiveMediaSource | null;
  selectedScenes: SceneSelection[];
  voiceSettings: VoiceSettings;
  editSettings: VideoEditSettings;
  isSearching: boolean;
  isProcessing: boolean;
  isExporting: boolean;
  searchError: string | null;
  project: VideoProject | null;
  cutTime: number;
  savedProjects: SavedProjectRecord[];
  activeSavedId: string | null;
  canSaveCurrent: boolean;
  isLoadingSaved: boolean;
  isSavingProject: boolean;
  onSelectVideo: (video: YouTubeVideo) => void;
  onChangeLicenseFilter: (license: YouTubeLicenseFilter) => void;
  onLoadMoreVideos: () => void;
  onResetToRecommended: () => void;
  onUpdateScene: (id: string, startSec: number, endSec: number) => void;
  onRemoveScene: (id: string) => void;
  onReplaceScenes: (scenes: SceneSelection[]) => void;
  onDetectedLocalDuration: (dur: number) => void;
  onDetectedYouTubeDuration: (dur: number) => void;
  onGenerateSubtitles: () => void;
  onChangeVoiceSettings: (next: VoiceSettings) => void;
  onChangeEditSettings: (next: VideoEditSettings) => void;
  onUploadLocalVideo: (file: File) => void;
  onClearLocalVideo: () => void;
  onUploadVoiceVideo: (file: File) => void;
  onDownloadMp4: () => void;
  onSeek: (sec: number) => void;
  onUpdateSubtitle: (id: string, field: "thaiPhonetic" | "burmese", value: string) => void;
  onSaveProject: (asNew?: boolean) => void;
  onOpenSavedProject: (record: SavedProjectRecord) => void;
  onRenameSavedProject: (id: string, title: string) => void;
  onDeleteSavedProject: (id: string) => void;
  onExportSavedJson: (record: SavedProjectRecord) => void;
  onImportSavedJson: (file: File) => void;
  onRelinkLocalVideo: (id: string, file: File) => void;
  ytPreviewSec?: number;
  ytSeekRequest?: { sec: number; nonce: number } | null;
  onYtCurrentSecChange?: (sec: number) => void;
  inlineStage?: ReactNode;
}

function formatRangeSec(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}:${String(r).padStart(2, "0")}`;
}

export function WorkspaceSidebar({
  activeTab,
  onTabChange,
  videos,
  selectedVideoId,
  activeQuery,
  licenseFilter,
  hasMoreVideos,
  isLoadingMore,
  localMedia,
  youtubeMedia,
  selectedScenes,
  voiceSettings,
  editSettings,
  isSearching,
  isProcessing,
  isExporting,
  searchError,
  project,
  cutTime,
  savedProjects,
  activeSavedId,
  canSaveCurrent,
  isLoadingSaved,
  isSavingProject,
  onSelectVideo,
  onChangeLicenseFilter,
  onLoadMoreVideos,
  onResetToRecommended,
  onUpdateScene,
  onRemoveScene,
  onReplaceScenes,
  onDetectedLocalDuration,
  onDetectedYouTubeDuration,
  onGenerateSubtitles,
  onChangeVoiceSettings,
  onChangeEditSettings,
  onUploadLocalVideo,
  onClearLocalVideo,
  onUploadVoiceVideo,
  onDownloadMp4,
  onSeek,
  onUpdateSubtitle,
  onSaveProject,
  onOpenSavedProject,
  onRenameSavedProject,
  onDeleteSavedProject,
  onExportSavedJson,
  onImportSavedJson,
  onRelinkLocalVideo,
  ytPreviewSec = 0,
  ytSeekRequest,
  onYtCurrentSecChange,
  inlineStage,
}: WorkspaceSidebarProps) {
  const scrollRootRef = useRef<HTMLDivElement | null>(null);
  const loadMoreSentinelRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (activeTab !== "videos" || !hasMoreVideos || isSearching || isLoadingMore) return;
    const sentinel = loadMoreSentinelRef.current;
    if (!sentinel) return;

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          onLoadMoreVideos();
        }
      },
      { root: scrollRootRef.current, rootMargin: "240px" }
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [activeTab, hasMoreVideos, isSearching, isLoadingMore, onLoadMoreVideos]);
  return (
    <div className="flex flex-col h-full min-h-0">
      {/* Minimal Segmented Switch */}
      <div className="flex items-center justify-between gap-4 pb-3 border-b border-neutral-200 dark:border-neutral-800 shrink-0">
        <div className="inline-flex items-center p-1 rounded-lg bg-neutral-100 dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-800 overflow-x-auto no-scrollbar max-w-full">
          <button
            type="button"
            onClick={() => onTabChange("videos")}
            className={`px-3 py-1.5 text-xs font-medium rounded-md whitespace-nowrap transition-colors cursor-pointer ${
              activeTab === "videos"
                ? "bg-white dark:bg-neutral-800 text-neutral-950 dark:text-white shadow-xs"
                : "text-neutral-500 dark:text-neutral-400 hover:text-neutral-900 dark:hover:text-neutral-200"
            }`}
          >
            Videos
          </button>
          <button
            type="button"
            onClick={() => onTabChange("ytPreview")}
            className={`px-3 py-1.5 text-xs font-medium rounded-md whitespace-nowrap transition-colors cursor-pointer ${
              activeTab === "ytPreview"
                ? "bg-white dark:bg-neutral-800 text-neutral-950 dark:text-white shadow-xs"
                : "text-neutral-500 dark:text-neutral-400 hover:text-neutral-900 dark:hover:text-neutral-200"
            }`}
          >
            YouTube Preview
          </button>
          <button
            type="button"
            onClick={() => onTabChange("scenes")}
            className={`px-3 py-1.5 text-xs font-medium rounded-md whitespace-nowrap transition-colors cursor-pointer ${
              activeTab === "scenes"
                ? "bg-white dark:bg-neutral-800 text-neutral-950 dark:text-white shadow-xs"
                : "text-neutral-500 dark:text-neutral-400 hover:text-neutral-900 dark:hover:text-neutral-200"
            }`}
          >
            Watch & Scenes
          </button>
          <button
            type="button"
            onClick={() => onTabChange("edit")}
            className={`px-3 py-1.5 text-xs font-medium rounded-md whitespace-nowrap transition-colors cursor-pointer ${
              activeTab === "edit"
                ? "bg-white dark:bg-neutral-800 text-neutral-950 dark:text-white shadow-xs"
                : "text-neutral-500 dark:text-neutral-400 hover:text-neutral-900 dark:hover:text-neutral-200"
            }`}
          >
            Edit
          </button>
          <button
            type="button"
            onClick={() => onTabChange("script")}
            disabled={!project}
            className={`px-3 py-1.5 text-xs font-medium rounded-md whitespace-nowrap transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed ${
              activeTab === "script"
                ? "bg-white dark:bg-neutral-800 text-neutral-950 dark:text-white shadow-xs"
                : "text-neutral-500 dark:text-neutral-400 hover:text-neutral-900 dark:hover:text-neutral-200"
            }`}
          >
            Subtitles
          </button>
          <button
            type="button"
            onClick={() => onTabChange("voice")}
            className={`px-3 py-1.5 text-xs font-medium rounded-md whitespace-nowrap transition-colors cursor-pointer ${
              activeTab === "voice"
                ? "bg-white dark:bg-neutral-800 text-neutral-950 dark:text-white shadow-xs"
                : "text-neutral-500 dark:text-neutral-400 hover:text-neutral-900 dark:hover:text-neutral-200"
            }`}
          >
            Voice
          </button>
          <button
            type="button"
            onClick={() => onTabChange("projects")}
            className={`px-3 py-1.5 text-xs font-medium rounded-md whitespace-nowrap transition-colors cursor-pointer ${
              activeTab === "projects"
                ? "bg-white dark:bg-neutral-800 text-neutral-950 dark:text-white shadow-xs"
                : "text-neutral-500 dark:text-neutral-400 hover:text-neutral-900 dark:hover:text-neutral-200"
            }`}
          >
            Saved{savedProjects.length > 0 ? ` (${savedProjects.length})` : ""}
          </button>
        </div>

        {project && activeTab === "script" && (
          <span className="text-xs text-neutral-500 dark:text-neutral-400 font-mono-tabular whitespace-nowrap shrink-0">
            {project.scenes.length} {project.scenes.length === 1 ? "scene" : "scenes"} ·{" "}
            {Math.round(
              project.targetDurationSec /
                getEffectivePlaybackSpeed(
                  project.sourceType,
                  editSettings.playbackSpeed,
                  voiceSettings.speed
                )
            )}
            s
          </span>
        )}
      </div>

      {/* Inline 9:16 Stage directly below Tab Switcher (used on compact mobile Edit view) */}
      {inlineStage && (
        <div className="py-2 border-b border-neutral-200 dark:border-neutral-800 shrink-0 flex justify-center">
          {inlineStage}
        </div>
      )}

      {/* Tab Body */}
      <div
        ref={scrollRootRef}
        className={`flex-1 overflow-y-auto pr-1 min-h-0 ${inlineStage ? "pt-3" : "pt-4"}`}
      >
        {isProcessing && (
          <div className="mb-4 px-4 py-3 rounded-xl border border-neutral-200 dark:border-neutral-800 bg-neutral-50 dark:bg-neutral-900 flex items-center gap-3 text-sm text-neutral-800 dark:text-neutral-200">
            <Loader2 className="w-4 h-4 animate-spin shrink-0" />
            <span>Transcribing spoken dialogue in your selected scenes...</span>
          </div>
        )}

        {activeTab === "videos" && (
          <>
            {/* Feed Header & Reuse License Filter Bar */}
            <div className="mb-3.5 flex flex-wrap items-center justify-between gap-2.5">
              <div className="flex items-center gap-2 min-w-0">
                <span className="text-xs font-semibold text-neutral-900 dark:text-neutral-100 truncate">
                  {activeQuery ? `Results for “${activeQuery}”` : "Recommended Videos"}
                </span>
                {videos.length > 0 && !isSearching && (
                  <span className="text-[11px] font-mono-tabular text-neutral-500 dark:text-neutral-400 shrink-0">
                    ({videos.length}{hasMoreVideos ? "+" : ""})
                  </span>
                )}
                {activeQuery && (
                  <button
                    type="button"
                    onClick={onResetToRecommended}
                    className="text-[11px] text-neutral-500 hover:text-neutral-950 dark:hover:text-white underline shrink-0 cursor-pointer"
                  >
                    Recommended
                  </button>
                )}
              </div>

              <div
                role="group"
                aria-label="Reuse license filter"
                className="inline-flex items-center p-0.5 rounded-lg bg-neutral-100 dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-800 shrink-0"
              >
                {(
                  [
                    { id: "all", label: "All Licenses" },
                    { id: "creative_commons", label: "Creative Commons" },
                    { id: "standard", label: "Standard" },
                  ] as const
                ).map((opt) => {
                  const selected = licenseFilter === opt.id;
                  return (
                    <button
                      key={opt.id}
                      type="button"
                      onClick={() => onChangeLicenseFilter(opt.id)}
                      className={`px-2.5 py-1 text-[11px] font-medium rounded-md whitespace-nowrap transition-colors cursor-pointer ${
                        selected
                          ? "bg-white dark:bg-neutral-800 text-neutral-950 dark:text-white shadow-xs"
                          : "text-neutral-500 dark:text-neutral-400 hover:text-neutral-900 dark:hover:text-neutral-200"
                      }`}
                    >
                      {opt.label}
                    </button>
                  );
                })}
              </div>
            </div>

            {searchError && (
              <div className="p-4 rounded-xl border border-neutral-300 dark:border-neutral-700 text-sm text-neutral-800 dark:text-neutral-200 mb-4">
                {searchError}
              </div>
            )}

            {isSearching ? (
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
                {Array.from({ length: 8 }).map((_, i) => (
                  <div
                    key={i}
                    className="rounded-xl border border-neutral-200 dark:border-neutral-800 overflow-hidden animate-pulse"
                  >
                    <div className="aspect-video bg-neutral-100 dark:bg-neutral-900" />
                    <div className="p-3 space-y-2">
                      <div className="h-4 bg-neutral-100 dark:bg-neutral-900 rounded w-4/5" />
                      <div className="h-3 bg-neutral-100 dark:bg-neutral-900 rounded w-1/2" />
                    </div>
                  </div>
                ))}
              </div>
            ) : videos.length === 0 ? (
              <div className="py-16 flex flex-col items-center justify-center text-center text-neutral-500 dark:text-neutral-400">
                <Film className="w-6 h-6 mb-2 opacity-60" />
                <p className="text-sm">
                  {licenseFilter !== "all"
                    ? "No videos matched this license filter"
                    : "No YouTube videos found"}
                </p>
                {licenseFilter !== "all" && (
                  <button
                    type="button"
                    onClick={() => onChangeLicenseFilter("all")}
                    className="mt-2 text-xs font-medium underline text-neutral-900 dark:text-neutral-100 cursor-pointer"
                  >
                    Show all licenses
                  </button>
                )}
              </div>
            ) : (
              <>
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3.5 pb-4">
                  {videos.map((v) => {
                    const isSelected = selectedVideoId === v.videoId;
                    return (
                      <button
                        key={v.videoId}
                        type="button"
                        onClick={() => onSelectVideo(v)}
                        className={`group text-left rounded-xl overflow-hidden border transition-colors cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-neutral-950 dark:focus-visible:ring-white ${
                          isSelected
                            ? "border-neutral-950 dark:border-white bg-neutral-50 dark:bg-neutral-900"
                            : "border-neutral-200 dark:border-neutral-800 hover:border-neutral-400 dark:hover:border-neutral-600 bg-white dark:bg-neutral-950"
                        }`}
                      >
                        <div className="relative aspect-video bg-neutral-100 dark:bg-neutral-900 overflow-hidden">
                          <img
                            src={v.thumbnail}
                            alt={v.title}
                            referrerPolicy="no-referrer"
                            className="w-full h-full object-cover group-hover:scale-[1.02] transition-transform duration-200"
                          />
                          {v.license && (
                            <span
                              className={`absolute top-2 left-2 px-1.5 py-0.5 rounded text-[10px] font-medium backdrop-blur-xs ${
                                v.license === "creative_commons"
                                  ? "bg-white/90 text-neutral-950 dark:bg-neutral-950/90 dark:text-white border border-neutral-300 dark:border-neutral-700"
                                  : "bg-black/70 text-neutral-200"
                              }`}
                            >
                              {v.license === "creative_commons" ? "Creative Commons" : "Standard"}
                            </span>
                          )}
                          <span className="absolute bottom-2 right-2 px-1.5 py-0.5 rounded bg-black/80 text-white text-[11px] font-mono-tabular">
                            {v.durationText}
                          </span>
                        </div>
                        <div className="p-3">
                          <p className="text-[13px] font-semibold text-neutral-950 dark:text-neutral-50 line-clamp-2 leading-snug">
                            {v.title}
                          </p>
                          <div className="mt-1.5 flex items-center gap-1.5 text-xs text-neutral-500 dark:text-neutral-400 truncate">
                            <span className="truncate">{v.channel}</span>
                            {v.viewCountText && (
                              <>
                                <span aria-hidden="true">·</span>
                                <span className="shrink-0">{v.viewCountText}</span>
                              </>
                            )}
                          </div>
                        </div>
                      </button>
                    );
                  })}
                </div>

                {/* Infinite scroll sentinel & manual Load More */}
                {hasMoreVideos && (
                  <div ref={loadMoreSentinelRef} className="pb-6 pt-1 flex justify-center">
                    <button
                      type="button"
                      onClick={onLoadMoreVideos}
                      disabled={isLoadingMore}
                      className="h-9 px-4 rounded-lg border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-950 hover:bg-neutral-100 dark:hover:bg-neutral-900 text-xs font-medium flex items-center gap-2 cursor-pointer disabled:opacity-50 transition-colors"
                    >
                      {isLoadingMore ? (
                        <>
                          <Loader2 className="w-3.5 h-3.5 animate-spin" />
                          <span>Loading more videos...</span>
                        </>
                      ) : (
                        <span>Load More Videos</span>
                      )}
                    </button>
                  </div>
                )}
              </>
            )}
          </>
        )}

        {activeTab === "ytPreview" && (
          <YouTubePreviewPanel
            media={youtubeMedia}
            videos={videos}
            hasMoreVideos={hasMoreVideos}
            isLoadingMore={isLoadingMore}
            isSearching={isSearching}
            voiceSettings={voiceSettings}
            editSettings={editSettings}
            initialSec={ytPreviewSec}
            seekRequest={ytSeekRequest}
            onSelectPreviewVideo={onSelectVideo}
            onLoadMoreVideos={onLoadMoreVideos}
            onCurrentSecChange={onYtCurrentSecChange}
            onDetectedDuration={onDetectedYouTubeDuration}
          />
        )}

        {localMedia && (
          <div className={activeTab === "scenes" ? "" : "hidden"}>
            <ScenePicker
              media={localMedia}
              scenes={selectedScenes}
              voiceSettings={voiceSettings}
              editSettings={editSettings}
              isProcessing={isProcessing}
              isTabActive={activeTab === "scenes"}
              onUpdateScene={onUpdateScene}
              onRemoveScene={onRemoveScene}
              onReplaceScenes={onReplaceScenes}
              onDetectedDuration={onDetectedLocalDuration}
              onGenerate={onGenerateSubtitles}
              onUploadVideo={onUploadLocalVideo}
              onClearVideo={onClearLocalVideo}
            />
          </div>
        )}

        {!localMedia && activeTab === "scenes" && (
          <ScenePicker
            media={null}
            scenes={selectedScenes}
            voiceSettings={voiceSettings}
            editSettings={editSettings}
            isProcessing={isProcessing}
            onUpdateScene={onUpdateScene}
            onRemoveScene={onRemoveScene}
            onReplaceScenes={onReplaceScenes}
            onDetectedDuration={onDetectedLocalDuration}
            onGenerate={onGenerateSubtitles}
            onUploadVideo={onUploadLocalVideo}
            onClearVideo={onClearLocalVideo}
          />
        )}

        {activeTab === "edit" && (
          <VideoEditPanel
            settings={editSettings}
            sourceType={
              project?.sourceType ?? localMedia?.sourceType ?? youtubeMedia?.sourceType ?? "local"
            }
            sourceDurationSec={
              project?.targetDurationSec ??
              (selectedScenes.length > 0
                ? selectedScenes.reduce(
                    (acc, sc) => acc + Math.max(0, sc.endSec - sc.startSec),
                    0
                  )
                : localMedia?.durationSec ?? youtubeMedia?.durationSec)
            }
            voiceSpeed={voiceSettings.speed}
            onChange={onChangeEditSettings}
          />
        )}

        {activeTab === "script" && project && (
          <div className="space-y-5 pb-6">
            {/* Extracted Scenes Strip */}
            <div className="flex flex-wrap gap-1.5">
              {project.scenes.map((sc, idx) => {
                let sceneCutStart = 0;
                for (let i = 0; i < idx; i++) {
                  sceneCutStart += project.scenes[i].durationSec;
                }
                const isSceneActive =
                  cutTime >= sceneCutStart && cutTime < sceneCutStart + sc.durationSec;

                return (
                  <button
                    key={sc.index}
                    type="button"
                    onClick={() => onSeek(sceneCutStart)}
                    className={`px-2.5 py-1.5 rounded-lg text-xs font-mono-tabular border transition-colors cursor-pointer whitespace-nowrap ${
                      isSceneActive
                        ? "bg-neutral-950 text-white border-neutral-950 dark:bg-white dark:text-neutral-950 dark:border-white"
                        : "bg-white dark:bg-neutral-950 text-neutral-700 dark:text-neutral-300 border-neutral-200 dark:border-neutral-800 hover:border-neutral-400 dark:hover:border-neutral-600"
                    }`}
                  >
                    {idx + 1}. {formatRangeSec(sc.startSec)}–{formatRangeSec(sc.endSec)}
                  </button>
                );
              })}
            </div>

            {/* Editable Subtitles */}
            <div className="divide-y divide-neutral-200 dark:divide-neutral-800 border border-neutral-200 dark:border-neutral-800 rounded-xl overflow-hidden">
              {(() => {
                const activeSubId = project.subtitles.reduce<string | undefined>(
                  (acc, s) => (cutTime >= s.startTime ? s.id : acc),
                  undefined
                );
                return project.subtitles.map((sub: SubtitleItem) => {
                  const isCurrent = sub.id === activeSubId;
                  return (
                  <div
                    key={sub.id}
                    className={`p-3.5 transition-colors ${
                      isCurrent
                        ? "bg-neutral-100 dark:bg-neutral-900"
                        : "bg-white dark:bg-neutral-950"
                    }`}
                  >
                    <div className="flex items-center justify-between gap-2 mb-1.5">
                      <button
                        type="button"
                        onClick={() => onSeek(sub.startTime)}
                        className="text-[11px] font-mono-tabular text-neutral-500 dark:text-neutral-400 hover:text-neutral-950 dark:hover:text-white cursor-pointer shrink-0"
                      >
                        {(() => {
                          const spd = getEffectivePlaybackSpeed(
                            project.sourceType,
                            editSettings.playbackSpeed,
                            voiceSettings.speed
                          );
                          return `${formatRangeSec(sub.startTime / spd)} – ${formatRangeSec(
                            sub.endTime / spd
                          )}`;
                        })()}
                      </button>
                      <span className="text-[11px] text-neutral-400 dark:text-neutral-500 truncate">
                        {sub.originalSpokenText}
                      </span>
                    </div>

                    <input
                      type="text"
                      value={sub.thaiPhonetic}
                      onChange={(e) => onUpdateSubtitle(sub.id, "thaiPhonetic", e.target.value)}
                      aria-label="Thai in English phonetics"
                      className="w-full text-sm font-semibold text-neutral-950 dark:text-neutral-50 bg-transparent border-b border-transparent focus:border-neutral-400 dark:focus:border-neutral-600 focus:outline-none py-0.5"
                    />

                    <input
                      type="text"
                      value={sub.burmese}
                      onChange={(e) => onUpdateSubtitle(sub.id, "burmese", e.target.value)}
                      aria-label="Burmese translation"
                      className="w-full font-myanmar text-[13px] text-neutral-700 dark:text-neutral-300 bg-transparent border-b border-transparent focus:border-neutral-400 dark:focus:border-neutral-600 focus:outline-none py-0.5 mt-1"
                    />
                  </div>
                  );
                });
              })()}
            </div>
          </div>
        )}

        {activeTab === "voice" && (
          <VoiceChangerPanel
            sourceType={
              project?.sourceType ?? localMedia?.sourceType ?? youtubeMedia?.sourceType ?? "youtube"
            }
            localVideoTitle={
              project?.sourceType === "local"
                ? project.title
                : localMedia?.title
            }
            settings={voiceSettings}
            canDownload={Boolean(project)}
            isExporting={isExporting}
            onChange={onChangeVoiceSettings}
            onUploadVoiceVideo={onUploadVoiceVideo}
            onDownloadMp4={onDownloadMp4}
          />
        )}

        {activeTab === "projects" && (
          <SavedProjectsPanel
            projects={savedProjects}
            activeSavedId={activeSavedId}
            canSaveCurrent={canSaveCurrent}
            isLoading={isLoadingSaved}
            isSaving={isSavingProject}
            onSaveCurrent={onSaveProject}
            onOpenProject={onOpenSavedProject}
            onRenameProject={onRenameSavedProject}
            onDeleteProject={onDeleteSavedProject}
            onExportJson={onExportSavedJson}
            onImportJson={onImportSavedJson}
            onRelinkLocalVideo={onRelinkLocalVideo}
          />
        )}
      </div>
    </div>
  );
}
