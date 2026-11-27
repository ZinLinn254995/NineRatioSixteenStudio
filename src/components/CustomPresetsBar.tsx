import { useEffect, useRef, useState } from "react";
import {
  Bookmark,
  Check,
  Plus,
  RefreshCw,
  Trash2,
  X,
} from "lucide-react";
import {
  deleteCustomPreset,
  listCustomPresets,
  saveCustomPreset,
  subscribeCustomPresets,
  updateCustomPresetValues,
  type CustomPresetCategory,
  type CustomPresetRecord,
  type CustomPresetValueMap,
} from "../utils/customPresets";

interface CustomPresetsBarProps<C extends CustomPresetCategory> {
  category: C;
  currentValues: CustomPresetValueMap[C];
  isMatch: (values: CustomPresetValueMap[C]) => boolean;
  onApply: (values: CustomPresetValueMap[C]) => void;
  getSummary?: (values: CustomPresetValueMap[C]) => string;
  getAccentDotClass?: (values: CustomPresetValueMap[C]) => string | null;
  placeholder?: string;
}

export function CustomPresetsBar<C extends CustomPresetCategory>({
  category,
  currentValues,
  isMatch,
  onApply,
  getSummary,
  getAccentDotClass,
  placeholder = "Preset name...",
}: CustomPresetsBarProps<C>) {
  const [presets, setPresets] = useState<CustomPresetRecord<C>[]>(() =>
    listCustomPresets(category)
  );
  const [isAdding, setIsAdding] = useState(false);
  const [draftName, setDraftName] = useState("");
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [justUpdatedId, setJustUpdatedId] = useState<string | null>(null);
  const [justSavedId, setJustSavedId] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    setPresets(listCustomPresets(category));
    return subscribeCustomPresets(() => {
      setPresets(listCustomPresets(category));
    });
  }, [category]);

  useEffect(() => {
    if (isAdding) {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [isAdding]);

  useEffect(() => {
    if (!justUpdatedId) return;
    const timer = window.setTimeout(() => setJustUpdatedId(null), 1400);
    return () => window.clearTimeout(timer);
  }, [justUpdatedId]);

  useEffect(() => {
    if (!justSavedId) return;
    const timer = window.setTimeout(() => setJustSavedId(null), 1400);
    return () => window.clearTimeout(timer);
  }, [justSavedId]);

  const handleOpenSave = () => {
    setConfirmDeleteId(null);
    setDraftName("");
    setIsAdding(true);
  };

  const handleConfirmSave = () => {
    const saved = saveCustomPreset(category, draftName, currentValues);
    setPresets(listCustomPresets(category));
    setDraftName("");
    setIsAdding(false);
    setJustSavedId(saved.id);
  };

  const handleOverwrite = (id: string) => {
    updateCustomPresetValues(category, id, currentValues);
    setPresets(listCustomPresets(category));
    setJustUpdatedId(id);
  };

  const handleDelete = (id: string) => {
    deleteCustomPreset(category, id);
    setPresets(listCustomPresets(category));
    setConfirmDeleteId(null);
  };

  return (
    <div className="space-y-2">
      {/* Header Row */}
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5 min-w-0">
          <Bookmark className="w-3.5 h-3.5 text-teal-700 dark:text-teal-400 shrink-0" />
          <span className="text-[11px] font-semibold text-[#4d597d] dark:text-[#919ec4] whitespace-nowrap">
            My Presets
          </span>
          {presets.length > 0 && (
            <span className="text-[11px] font-mono-tabular text-[#6d7a9e] dark:text-[#7c89b2]">
              · {presets.length}
            </span>
          )}
        </div>

        {!isAdding && (
          <button
            type="button"
            onClick={handleOpenSave}
            className="h-8 px-2.5 rounded-lg border border-teal-700/35 dark:border-teal-400/40 bg-teal-50/70 dark:bg-teal-950/35 hover:bg-teal-100/80 dark:hover:bg-teal-900/45 text-teal-800 dark:text-teal-200 text-[11px] font-semibold inline-flex items-center gap-1 whitespace-nowrap shrink-0 cursor-pointer transition-colors"
          >
            <Plus className="w-3.5 h-3.5 shrink-0" />
            <span>Save Preset</span>
          </button>
        )}
      </div>

      {/* Inline Save Input */}
      {isAdding && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            handleConfirmSave();
          }}
          className="flex items-center gap-1.5"
        >
          <input
            ref={inputRef}
            type="text"
            value={draftName}
            maxLength={32}
            onChange={(e) => setDraftName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                setIsAdding(false);
                setDraftName("");
              }
            }}
            placeholder={placeholder}
            aria-label="Custom preset name"
            className="flex-1 min-w-0 h-10 px-2.5 rounded-lg border border-teal-600/60 dark:border-teal-400/60 bg-white dark:bg-[#0d1022] text-xs text-[#0c1026] dark:text-[#f3f5fc] placeholder:text-[#7c89ab] dark:placeholder:text-[#637099] focus:outline-none focus:ring-2 focus:ring-teal-500/30"
          />
          <button
            type="submit"
            className="h-10 px-3 rounded-lg bg-teal-700 hover:bg-teal-800 dark:bg-teal-400 dark:hover:bg-teal-300 text-white dark:text-[#060918] text-xs font-semibold whitespace-nowrap shrink-0 cursor-pointer transition-colors"
          >
            Save
          </button>
          <button
            type="button"
            onClick={() => {
              setIsAdding(false);
              setDraftName("");
            }}
            aria-label="Cancel saving preset"
            className="h-10 w-10 rounded-lg border border-[#d2dcf0] dark:border-[#21284c] bg-white dark:bg-[#0d1022] hover:bg-[#edf1fb] dark:hover:bg-[#141933] text-[#4d597d] dark:text-[#919ec4] flex items-center justify-center shrink-0 cursor-pointer transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        </form>
      )}

      {/* Saved Presets List */}
      {presets.length > 0 ? (
        <div className="flex flex-wrap gap-1.5">
          {presets.map((preset) => {
            const active = isMatch(preset.values);
            const isDeleting = confirmDeleteId === preset.id;
            const isJustUpdated = justUpdatedId === preset.id;
            const isJustSaved = justSavedId === preset.id;
            const summary = getSummary ? getSummary(preset.values) : "";
            const dotClass = getAccentDotClass
              ? getAccentDotClass(preset.values)
              : null;

            if (isDeleting) {
              return (
                <div
                  key={preset.id}
                  className="min-h-[40px] px-2.5 py-1 rounded-lg border border-rose-400/70 dark:border-rose-500/60 bg-rose-50/90 dark:bg-rose-950/40 flex items-center gap-1.5"
                >
                  <span className="text-[11px] font-medium text-rose-800 dark:text-rose-200 max-w-[110px] truncate">
                    Delete “{preset.name}”?
                  </span>
                  <button
                    type="button"
                    onClick={() => handleDelete(preset.id)}
                    aria-label={`Confirm delete ${preset.name}`}
                    className="h-7 px-2 rounded-md bg-rose-600 hover:bg-rose-700 text-white text-[11px] font-semibold cursor-pointer transition-colors"
                  >
                    Delete
                  </button>
                  <button
                    type="button"
                    onClick={() => setConfirmDeleteId(null)}
                    aria-label="Cancel delete"
                    className="h-7 w-7 rounded-md text-[#4d597d] dark:text-[#919ec4] hover:bg-white/80 dark:hover:bg-[#1a2142] flex items-center justify-center cursor-pointer transition-colors"
                  >
                    <X className="w-3.5 h-3.5" />
                  </button>
                </div>
              );
            }

            return (
              <div
                key={preset.id}
                title={summary ? `${preset.name} · ${summary}` : preset.name}
                className={`group min-h-[40px] max-w-full rounded-lg border flex items-stretch overflow-hidden transition-colors ${
                  active
                    ? "border-teal-600 dark:border-teal-400 bg-teal-50/85 dark:bg-teal-950/45"
                    : "border-[#d2dcf0] dark:border-[#21284c] bg-white dark:bg-[#0d1022] hover:border-[#9eb1de] dark:hover:border-[#364378]"
                }`}
              >
                <button
                  type="button"
                  onClick={() => {
                    setConfirmDeleteId(null);
                    onApply(preset.values);
                  }}
                  className="px-2.5 py-1.5 flex items-center gap-1.5 min-w-0 text-left cursor-pointer focus-visible:outline-2 focus-visible:outline-teal-500"
                >
                  {dotClass && (
                    <span
                      aria-hidden="true"
                      className={`w-2.5 h-2.5 rounded-full shrink-0 ${dotClass}`}
                    />
                  )}
                  <span
                    className={`text-xs truncate max-w-[140px] ${
                      active
                        ? "font-semibold text-teal-900 dark:text-teal-200"
                        : "font-medium text-[#0c1026] dark:text-[#f3f5fc]"
                    }`}
                  >
                    {preset.name}
                  </span>
                  {(active || isJustSaved || isJustUpdated) && (
                    <Check className="w-3 h-3 text-teal-700 dark:text-teal-400 shrink-0" />
                  )}
                </button>

                {/* Update existing preset with current slider values */}
                {!active && (
                  <button
                    type="button"
                    onClick={() => handleOverwrite(preset.id)}
                    title={`Overwrite "${preset.name}" with current settings`}
                    aria-label={`Overwrite ${preset.name} with current settings`}
                    className="w-8 flex items-center justify-center border-l border-[#d2dcf0]/70 dark:border-[#21284c] text-[#6d7a9e] dark:text-[#7c89b2] hover:text-teal-700 dark:hover:text-teal-300 hover:bg-[#edf1fb] dark:hover:bg-[#141933] shrink-0 cursor-pointer transition-colors"
                  >
                    <RefreshCw className="w-3 h-3" />
                  </button>
                )}

                {/* Delete preset */}
                <button
                  type="button"
                  onClick={() => setConfirmDeleteId(preset.id)}
                  title={`Delete "${preset.name}"`}
                  aria-label={`Delete ${preset.name}`}
                  className="w-8 flex items-center justify-center border-l border-[#d2dcf0]/70 dark:border-[#21284c] text-[#6d7a9e] dark:text-[#7c89b2] hover:text-rose-600 dark:hover:text-rose-400 hover:bg-rose-50/70 dark:hover:bg-rose-950/35 shrink-0 cursor-pointer transition-colors"
                >
                  <Trash2 className="w-3 h-3" />
                </button>
              </div>
            );
          })}
        </div>
      ) : (
        !isAdding && (
          <p className="text-[11px] text-[#6d7a9e] dark:text-[#7c89b2] leading-snug">
            Save your current settings as a reusable preset.
          </p>
        )
      )}
    </div>
  );
}
