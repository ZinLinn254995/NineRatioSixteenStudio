import { useEffect, useRef, useState, type FormEvent } from "react";
import { AlertCircle, CheckCircle2, Clock, Loader2, X } from "lucide-react";
import {
  FIELD_LIMITS,
  type AffiliateProduct,
  type CampaignStatus,
  type ContentLanguage,
  type MarketingCampaign,
  type UiLanguage,
  type WithId,
} from "../firebase";
import {
  CAMPAIGN_STATUS_LABELS,
  CONTENT_LANGUAGE_LABELS,
  type AffiliateUiDictionary,
  type WorkspaceConnectionState,
  type WriteOperationState,
} from "./affiliateLabels";
import {
  CONTENT_LANGUAGES,
  resolveCampaignProductBackfill,
  shouldResetModalDraft,
  validateCampaignForm,
  type CampaignFormInput,
} from "./affiliateValidation";
import type { AffiliateWriteResult } from "./useAffiliateWorkspaceData";

interface CampaignFormModalProps {
  open: boolean;
  editingCampaign: WithId<MarketingCampaign> | null;
  pendingCreateDocId: string | null;
  products: WithId<AffiliateProduct>[];
  defaultProductId?: string;
  uiLang: UiLanguage;
  labels: AffiliateUiDictionary;
  connectionState: WorkspaceConnectionState;
  canWriteNow: boolean;
  isWriteBusy: boolean;
  writeState: WriteOperationState;
  writeDocId: string | null;
  writeError: string | null;
  onEnsurePendingCreateDocId: () => string;
  onDiscardPendingCreateDocId: () => boolean;
  onCreate: (input: CampaignFormInput, pendingDocId: string) => Promise<AffiliateWriteResult>;
  onUpdateDetails: (
    campaign: WithId<MarketingCampaign>,
    input: CampaignFormInput
  ) => Promise<AffiliateWriteResult>;
  onClose: () => void;
}

const CREATE_STATUS_OPTIONS: CampaignStatus[] = ["draft", "active", "paused", "completed"];

function buildInitialCampaignInput(
  campaign: WithId<MarketingCampaign> | null,
  products: WithId<AffiliateProduct>[],
  defaultProductId?: string
): CampaignFormInput {
  if (campaign) {
    return {
      productId: campaign.productId,
      title: campaign.title || "",
      goal: campaign.goal || "",
      targetLanguage: campaign.targetLanguage || "th",
      status: campaign.status,
      strategyNotes: campaign.strategyNotes || "",
      startDate: campaign.startDate || "",
      endDate: campaign.endDate || "",
    };
  }
  const preferred =
    defaultProductId && products.some((p) => p.id === defaultProductId)
      ? defaultProductId
      : products.find((p) => p.status !== "archived")?.id || products[0]?.id || "";

  return {
    productId: preferred,
    title: "",
    goal: "",
    targetLanguage: "th",
    status: "draft",
    strategyNotes: "",
    startDate: "",
    endDate: "",
  };
}

function resolveLabelError(error: string | null | undefined, labels: AffiliateUiDictionary): string {
  if (error && error in labels) {
    return labels[error as keyof AffiliateUiDictionary];
  }
  return error || labels.writeFailed;
}

export function CampaignFormModal({
  open,
  editingCampaign,
  pendingCreateDocId,
  products,
  defaultProductId,
  uiLang,
  labels,
  connectionState,
  canWriteNow,
  isWriteBusy,
  writeState,
  writeDocId,
  writeError,
  onEnsurePendingCreateDocId,
  onDiscardPendingCreateDocId,
  onCreate,
  onUpdateDetails,
  onClose,
}: CampaignFormModalProps) {
  const [form, setForm] = useState<CampaignFormInput>(() =>
    buildInitialCampaignInput(editingCampaign, products, defaultProductId)
  );
  const [localError, setLocalError] = useState<string | null>(null);
  const [localWriteState, setLocalWriteState] = useState<WriteOperationState>("idle");

  // H1: Initialize modal draft strictly on session key transitions so Firestore snapshot
  // updates for `products` or `editingCampaign` NEVER wipe draft fields or pendingDocId.
  const prevSessionKeyRef = useRef<string | null>(null);
  const openRef = useRef(open);
  openRef.current = open;
  const closeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const sessionKey = open ? (editingCampaign?.id ?? "__create__") : null;

  useEffect(() => {
    if (!open) {
      prevSessionKeyRef.current = null;
      if (closeTimerRef.current) {
        clearTimeout(closeTimerRef.current);
        closeTimerRef.current = null;
      }
      return;
    }

    if (shouldResetModalDraft(prevSessionKeyRef.current, sessionKey)) {
      prevSessionKeyRef.current = sessionKey;
      setForm(buildInitialCampaignInput(editingCampaign, products, defaultProductId));
      setLocalError(null);
      setLocalWriteState("idle");
      if (!editingCampaign) {
        onEnsurePendingCreateDocId();
      }
    }
    // Intentionally exclude `products` and `defaultProductId` from resetting the whole form;
    // late-arriving products are handled safely by the productId-only backfill effect below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, sessionKey, editingCampaign, onEnsurePendingCreateDocId]);

  useEffect(() => {
    return () => {
      if (closeTimerRef.current) {
        clearTimeout(closeTimerRef.current);
        closeTimerRef.current = null;
      }
    };
  }, []);

  const targetDocId = editingCampaign ? editingCampaign.id : pendingCreateDocId;
  const isTrackingThisModal = Boolean(targetDocId && writeDocId === targetDocId);

  const effectiveState: WriteOperationState =
    isTrackingThisModal && writeState !== "idle" ? writeState : localWriteState;

  // H1 safe backfill: if products arrive while create modal is open with empty productId
  // and write state is idle, backfill ONLY productId without touching any other fields.
  useEffect(() => {
    if (!open || editingCampaign) return;
    const backfillId = resolveCampaignProductBackfill({
      isCreateMode: !editingCampaign,
      currentProductId: form.productId,
      writeState: effectiveState,
      products,
      defaultProductId,
    });
    if (backfillId) {
      setForm((prev) => (prev.productId ? prev : { ...prev, productId: backfillId }));
    }
  }, [open, editingCampaign, form.productId, effectiveState, products, defaultProductId]);

  const displayedError =
    localError ||
    (isTrackingThisModal && writeState === "failed"
      ? resolveLabelError(writeError, labels)
      : null);

  if (!open) return null;

  const isSaving = effectiveState === "saving";
  const isSyncPending = effectiveState === "sync_pending";
  const isThisBusy = isSaving || isSyncPending;
  const isLockedByOtherWrite = isWriteBusy && !isTrackingThisModal;

  const linkedProductForEdit = editingCampaign
    ? products.find((p) => p.id === editingCampaign.productId) || null
    : null;

  const handleClose = () => {
    if (isSaving) return;
    if (!editingCampaign && !isSyncPending && effectiveState !== "failed") {
      onDiscardPendingCreateDocId();
    }
    onClose();
  };

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (isThisBusy || isWriteBusy) return;

    if (!canWriteNow) {
      setLocalError(
        connectionState === "cached" ? labels.errCachedWriteBlocked : labels.errOfflineWriteBlocked
      );
      setLocalWriteState("failed");
      return;
    }

    const check = validateCampaignForm(form, !editingCampaign);
    if (!check.ok) {
      setLocalError(labels[check.errorKey]);
      return;
    }

    setLocalError(null);
    setLocalWriteState("saving");

    const docIdForCreate = editingCampaign
      ? editingCampaign.id
      : pendingCreateDocId || onEnsurePendingCreateDocId();

    const res = editingCampaign
      ? await onUpdateDetails(editingCampaign, form)
      : await onCreate(form, docIdForCreate);

    if (!openRef.current) {
      return;
    }

    if (res.ok) {
      setLocalWriteState("saved");
      if (closeTimerRef.current) clearTimeout(closeTimerRef.current);
      closeTimerRef.current = setTimeout(() => {
        if (openRef.current) {
          onClose();
        }
      }, 350);
    } else {
      setLocalError(resolveLabelError(res.error, labels));
      setLocalWriteState("failed");
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 bg-black/50 backdrop-blur-[1px] flex items-end sm:items-center justify-center p-0 sm:p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="campaign-modal-title"
    >
      <form
        onSubmit={handleSubmit}
        className="w-full sm:max-w-lg max-h-[90dvh] flex flex-col rounded-t-2xl sm:rounded-2xl border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-950 shadow-xl overflow-hidden"
      >
        {/* Sticky Header */}
        <div className="px-4 py-3.5 border-b border-neutral-200 dark:border-neutral-800 flex items-center justify-between gap-3 shrink-0">
          <div>
            <h3
              id="campaign-modal-title"
              className="text-sm font-semibold text-neutral-950 dark:text-neutral-50"
            >
              {editingCampaign ? labels.editCampaign : labels.newCampaign}
            </h3>
            <p className="text-[11px] text-neutral-500 dark:text-neutral-400">
              {labels.manualEntry}
            </p>
          </div>
          <button
            type="button"
            disabled={isSaving}
            onClick={handleClose}
            aria-label={isSyncPending ? labels.dismissWhilePendingButton : labels.cancel}
            className="w-9 h-9 rounded-lg flex items-center justify-center text-neutral-500 hover:bg-neutral-100 dark:hover:bg-neutral-900 disabled:opacity-40 cursor-pointer"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Scrollable Body */}
        <div className="flex-1 overflow-y-auto p-4 space-y-4">
          {!canWriteNow && !isSyncPending && (
            <div className="p-3 rounded-lg border border-amber-300 dark:border-amber-800 bg-amber-50 dark:bg-amber-950/40 text-xs text-amber-800 dark:text-amber-200 leading-relaxed">
              {connectionState === "cached"
                ? labels.errCachedWriteBlocked
                : labels.errOfflineWriteBlocked}
            </div>
          )}

          {isLockedByOtherWrite && (
            <div className="p-3 rounded-lg border border-amber-300 dark:border-amber-800 bg-amber-50 dark:bg-amber-950/40 text-xs text-amber-800 dark:text-amber-200 flex items-start gap-2 leading-relaxed">
              <Clock className="w-4 h-4 shrink-0 mt-0.5" />
              <span>{labels.errWriteInFlightLocked}</span>
            </div>
          )}

          {isSyncPending && (
            <div className="p-3 rounded-lg border border-amber-300 dark:border-amber-800 bg-amber-50 dark:bg-amber-950/40 text-xs text-amber-800 dark:text-amber-200 space-y-1.5 leading-relaxed">
              <div className="flex items-start gap-2">
                <Clock className="w-4 h-4 shrink-0 mt-0.5" />
                <span>{labels.writeSyncPendingWarning}</span>
              </div>
              <p className="pl-6 text-[11px] opacity-90">{labels.dismissWhilePendingNotice}</p>
            </div>
          )}

          {effectiveState === "saved" && (
            <div className="p-3 rounded-lg border border-emerald-300 dark:border-emerald-800 bg-emerald-50 dark:bg-emerald-950/40 text-xs text-emerald-800 dark:text-emerald-200 flex items-center gap-2">
              <CheckCircle2 className="w-4 h-4 shrink-0" />
              <span>{labels.writeSaved}</span>
            </div>
          )}

          {displayedError && (
            <div className="p-3 rounded-lg border border-red-200 dark:border-red-900 bg-red-50 dark:bg-red-950/40 text-xs text-red-700 dark:text-red-300 flex items-start gap-2 leading-relaxed break-words">
              <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
              <span>{displayedError}</span>
            </div>
          )}

          {/* Linked Product Selector (Read-Only on Edit per firestore.rules) */}
          <div>
            <label className="block text-xs font-medium text-neutral-700 dark:text-neutral-300 mb-1">
              {labels.linkedProductLabel}
            </label>
            {editingCampaign ? (
              <div className="space-y-1">
                <div className="h-11 px-3 rounded-lg border border-neutral-200 dark:border-neutral-800 bg-neutral-100 dark:bg-neutral-900/70 text-sm text-neutral-700 dark:text-neutral-300 flex items-center truncate">
                  {linkedProductForEdit ? linkedProductForEdit.name : labels.missingLinkedProduct}
                </div>
                <p className="text-[11px] text-neutral-500 dark:text-neutral-400 leading-relaxed">
                  {labels.linkedProductImmutableHint}
                </p>
              </div>
            ) : (
              <select
                required
                value={form.productId}
                disabled={isThisBusy || products.length === 0}
                onChange={(e) => setForm((prev) => ({ ...prev, productId: e.target.value }))}
                className="w-full h-11 px-3 text-base sm:text-sm rounded-lg border border-neutral-200 dark:border-neutral-800 bg-neutral-50 dark:bg-neutral-900 text-neutral-950 dark:text-neutral-50 focus:outline-none focus:border-neutral-950 dark:focus:border-white"
              >
                {products.length === 0 ? (
                  <option value="">{labels.noProductsYet}</option>
                ) : (
                  products.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                      {p.status === "archived" ? " (Archived)" : ""}
                    </option>
                  ))
                )}
              </select>
            )}
          </div>

          <div>
            <div className="flex items-center justify-between mb-1">
              <label className="text-xs font-medium text-neutral-700 dark:text-neutral-300">
                {labels.campaignTitleLabel}
              </label>
              <span className="text-[11px] font-mono-tabular text-neutral-400">
                {form.title.trim().length}/{FIELD_LIMITS.title}
              </span>
            </div>
            <input
              type="text"
              required
              maxLength={FIELD_LIMITS.title}
              value={form.title}
              disabled={isThisBusy}
              onChange={(e) => setForm((prev) => ({ ...prev, title: e.target.value }))}
              placeholder="e.g. 11.11 Serum Review Series / ဗီတာမင်စီ Campaign"
              className="w-full h-11 px-3 text-base sm:text-sm rounded-lg border border-neutral-200 dark:border-neutral-800 bg-neutral-50 dark:bg-neutral-900 text-neutral-950 dark:text-neutral-50 focus:outline-none focus:border-neutral-950 dark:focus:border-white leading-relaxed"
            />
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium text-neutral-700 dark:text-neutral-300 mb-1">
                {labels.contentLanguageLabel}
              </label>
              <select
                value={form.targetLanguage}
                disabled={isThisBusy}
                onChange={(e) =>
                  setForm((prev) => ({
                    ...prev,
                    targetLanguage: e.target.value as ContentLanguage,
                  }))
                }
                className="w-full h-11 px-3 text-base sm:text-sm rounded-lg border border-neutral-200 dark:border-neutral-800 bg-neutral-50 dark:bg-neutral-900 text-neutral-950 dark:text-neutral-50 focus:outline-none focus:border-neutral-950 dark:focus:border-white"
              >
                {CONTENT_LANGUAGES.map((lang) => (
                  <option key={lang} value={lang}>
                    {CONTENT_LANGUAGE_LABELS[lang]}
                  </option>
                ))}
              </select>
            </div>

            {!editingCampaign && (
              <div>
                <label className="block text-xs font-medium text-neutral-700 dark:text-neutral-300 mb-1">
                  {labels.statusLabel}
                </label>
                <select
                  value={form.status}
                  disabled={isThisBusy}
                  onChange={(e) =>
                    setForm((prev) => ({
                      ...prev,
                      status: e.target.value as CampaignStatus,
                    }))
                  }
                  className="w-full h-11 px-3 text-base sm:text-sm rounded-lg border border-neutral-200 dark:border-neutral-800 bg-neutral-50 dark:bg-neutral-900 text-neutral-950 dark:text-neutral-50 focus:outline-none focus:border-neutral-950 dark:focus:border-white"
                >
                  {CREATE_STATUS_OPTIONS.map((st) => (
                    <option key={st} value={st}>
                      {CAMPAIGN_STATUS_LABELS[st][uiLang]}
                    </option>
                  ))}
                </select>
              </div>
            )}
          </div>

          {/* Planned Publishing Dates (Date-only YYYY-MM-DD, timezone-safe) */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium text-neutral-700 dark:text-neutral-300 mb-1">
                {labels.startDateLabel}
              </label>
              <input
                type="date"
                value={form.startDate}
                disabled={isThisBusy}
                onChange={(e) => setForm((prev) => ({ ...prev, startDate: e.target.value }))}
                className="w-full h-11 px-3 text-base sm:text-sm font-mono-tabular rounded-lg border border-neutral-200 dark:border-neutral-800 bg-neutral-50 dark:bg-neutral-900 text-neutral-950 dark:text-neutral-50 focus:outline-none focus:border-neutral-950 dark:focus:border-white"
              />
            </div>

            <div>
              <label className="block text-xs font-medium text-neutral-700 dark:text-neutral-300 mb-1">
                {labels.endDateLabel}
              </label>
              <input
                type="date"
                value={form.endDate}
                min={form.startDate || undefined}
                disabled={isThisBusy}
                onChange={(e) => setForm((prev) => ({ ...prev, endDate: e.target.value }))}
                className="w-full h-11 px-3 text-base sm:text-sm font-mono-tabular rounded-lg border border-neutral-200 dark:border-neutral-800 bg-neutral-50 dark:bg-neutral-900 text-neutral-950 dark:text-neutral-50 focus:outline-none focus:border-neutral-950 dark:focus:border-white"
              />
            </div>
          </div>

          <div>
            <div className="flex items-center justify-between mb-1">
              <label className="text-xs font-medium text-neutral-700 dark:text-neutral-300">
                {labels.goalLabel}
              </label>
              <span className="text-[11px] font-mono-tabular text-neutral-400">
                {form.goal.trim().length}/{FIELD_LIMITS.goal}
              </span>
            </div>
            <input
              type="text"
              maxLength={FIELD_LIMITS.goal}
              value={form.goal}
              disabled={isThisBusy}
              onChange={(e) => setForm((prev) => ({ ...prev, goal: e.target.value }))}
              className="w-full h-11 px-3 text-base sm:text-sm rounded-lg border border-neutral-200 dark:border-neutral-800 bg-neutral-50 dark:bg-neutral-900 text-neutral-950 dark:text-neutral-50 focus:outline-none focus:border-neutral-950 dark:focus:border-white leading-relaxed"
            />
          </div>

          <div>
            <div className="flex items-center justify-between mb-1">
              <label className="text-xs font-medium text-neutral-700 dark:text-neutral-300">
                {labels.strategyNotesLabel}
              </label>
              <span className="text-[11px] font-mono-tabular text-neutral-400">
                {form.strategyNotes.trim().length}/{FIELD_LIMITS.strategyNotes}
              </span>
            </div>
            <textarea
              rows={3}
              maxLength={FIELD_LIMITS.strategyNotes}
              value={form.strategyNotes}
              disabled={isThisBusy}
              onChange={(e) => setForm((prev) => ({ ...prev, strategyNotes: e.target.value }))}
              className="w-full p-3 text-base sm:text-sm rounded-lg border border-neutral-200 dark:border-neutral-800 bg-neutral-50 dark:bg-neutral-900 text-neutral-950 dark:text-neutral-50 focus:outline-none focus:border-neutral-950 dark:focus:border-white leading-relaxed resize-y"
            />
          </div>
        </div>

        {/* Sticky Footer */}
        <div className="px-4 py-3 border-t border-neutral-200 dark:border-neutral-800 bg-neutral-50/70 dark:bg-neutral-900/40 flex items-center justify-end gap-2 shrink-0">
          <button
            type="button"
            disabled={isSaving}
            onClick={handleClose}
            className="h-10 px-4 rounded-lg border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-950 hover:bg-neutral-100 dark:hover:bg-neutral-900 text-xs font-medium disabled:opacity-40 cursor-pointer"
          >
            {isSyncPending ? labels.dismissWhilePendingButton : labels.cancel}
          </button>
          <button
            type="submit"
            disabled={
              isThisBusy || isWriteBusy || !canWriteNow || (!editingCampaign && products.length === 0)
            }
            className="h-10 px-5 rounded-lg bg-neutral-950 text-white dark:bg-white dark:text-neutral-950 text-xs font-semibold flex items-center gap-1.5 disabled:opacity-40 cursor-pointer"
          >
            {isThisBusy && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
            <span>
              {isSyncPending
                ? labels.writeSyncPending
                : isSaving
                  ? labels.writeSaving
                  : labels.save}
            </span>
          </button>
        </div>
      </form>
    </div>
  );
}
