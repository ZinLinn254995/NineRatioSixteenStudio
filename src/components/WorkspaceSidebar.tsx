import { Film, Loader2 } from "lucide-react";
import type {
  ActiveMediaSource,
  SceneSelection,
  SubtitleItem,
  VideoEditSettings,
  VideoProject,
  VoiceSettings,
  YouTubeVideo,
} from "../types";
import { ScenePicker } from "./ScenePicker";
import { VoiceChangerPanel } from "./VoiceChangerPanel";
import { VideoEditPanel } from "./VideoEditPanel";

interface WorkspaceSidebarProps {
  activeTab: "videos" | "scenes" | "edit" | "script" | "voice";
  onTabChange: (tab: "videos" | "scenes" | "edit" | "script" | "voice") => void;
  videos: YouTubeVideo[];
  selectedVideoId?: string;
  activeMedia: ActiveMediaSource | null;
  selectedScenes: SceneSelection[];
  voiceSettings: VoiceSettings;
  editSettings: VideoEditSettings;
  isSearching: boolean;
  isProcessing: boolean;
  isExporting: boolean;
  searchError: string | null;
  project: VideoProject | null;
  cutTime: number;
  onSelectVideo: (video: YouTubeVideo) => void;
  onAddScene: (startSec: number, endSec: number) => void;
  onUpdateScene: (id: string, startSec: number, endSec: number) => void;
  onRemoveScene: (id: string) => void;
  onDetectedDuration: (dur: number) => void;
  onGenerateSubtitles: () => void;
  onChangeVoiceSettings: (next: VoiceSettings) => void;
  onChangeEditSettings: (next: VideoEditSettings) => void;
  onUploadVoiceVideo: (file: File) => void;
  onDownloadMp4: () => void;
  onSeek: (sec: number) => void;
  onUpdateSubtitle: (id: string, field: "thaiPhonetic" | "burmese", value: string) => void;
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
  activeMedia,
  selectedScenes,
  voiceSettings,
  editSettings,
  isSearching,
  isProcessing,
  isExporting,
  searchError,
  project,
  cutTime,
  onSelectVideo,
  onAddScene,
  onUpdateScene,
  onRemoveScene,
  onDetectedDuration,
  onGenerateSubtitles,
  onChangeVoiceSettings,
  onChangeEditSettings,
  onUploadVoiceVideo,
  onDownloadMp4,
  onSeek,
  onUpdateSubtitle,
}: WorkspaceSidebarProps) {
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
            onClick={() => onTabChange("scenes")}
            disabled={!activeMedia}
            className={`px-3 py-1.5 text-xs font-medium rounded-md whitespace-nowrap transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed ${
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
        </div>

        {project && activeTab === "script" && (
          <span className="text-xs text-neutral-500 dark:text-neutral-400 font-mono-tabular whitespace-nowrap shrink-0">
            {project.scenes.length} {project.scenes.length === 1 ? "scene" : "scenes"} ·{" "}
            {Math.round(project.targetDurationSec)}s
          </span>
        )}
      </div>

      {/* Tab Body */}
      <div className="flex-1 overflow-y-auto pt-4 pr-1 min-h-0">
        {isProcessing && (
          <div className="mb-4 px-4 py-3 rounded-xl border border-neutral-200 dark:border-neutral-800 bg-neutral-50 dark:bg-neutral-900 flex items-center gap-3 text-sm text-neutral-800 dark:text-neutral-200">
            <Loader2 className="w-4 h-4 animate-spin shrink-0" />
            <span>Transcribing spoken dialogue in your selected scenes...</span>
          </div>
        )}

        {activeTab === "videos" && (
          <>
            {searchError && (
              <div className="p-4 rounded-xl border border-neutral-300 dark:border-neutral-700 text-sm text-neutral-800 dark:text-neutral-200 mb-4">
                {searchError}
              </div>
            )}

            {isSearching ? (
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                {Array.from({ length: 6 }).map((_, i) => (
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
                <p className="text-sm">No YouTube videos found</p>
              </div>
            ) : (
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3.5 pb-6">
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
            )}
          </>
        )}

        {activeTab === "scenes" && activeMedia && (
          <ScenePicker
            media={activeMedia}
            scenes={selectedScenes}
            voiceSettings={voiceSettings}
            editSettings={editSettings}
            isProcessing={isProcessing}
            onAddScene={onAddScene}
            onUpdateScene={onUpdateScene}
            onRemoveScene={onRemoveScene}
            onDetectedDuration={onDetectedDuration}
            onGenerate={onGenerateSubtitles}
          />
        )}

        {activeTab === "edit" && (
          <VideoEditPanel settings={editSettings} onChange={onChangeEditSettings} />
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
              {project.subtitles.map((sub: SubtitleItem) => {
                const isCurrent = cutTime >= sub.startTime && cutTime < sub.endTime;
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
                        {formatRangeSec(sub.startTime)} – {formatRangeSec(sub.endTime)}
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
              })}
            </div>
          </div>
        )}

        {activeTab === "voice" && (
          <VoiceChangerPanel
            sourceType={project?.sourceType ?? activeMedia?.sourceType ?? "youtube"}
            localVideoTitle={
              project?.sourceType === "local"
                ? project.title
                : activeMedia?.sourceType === "local"
                  ? activeMedia.title
                  : undefined
            }
            settings={voiceSettings}
            canDownload={Boolean(project)}
            isExporting={isExporting}
            onChange={onChangeVoiceSettings}
            onUploadVoiceVideo={onUploadVoiceVideo}
            onDownloadMp4={onDownloadMp4}
          />
        )}
      </div>
    </div>
  );
}
