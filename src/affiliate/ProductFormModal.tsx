import { useEffect, useRef, useState, type FormEvent } from "react";
import { AlertCircle, CheckCircle2, Clock, Loader2, X } from "lucide-react";
import {
  FIELD_LIMITS,
  type AffiliateProduct,
  type AffiliateProductStatus,
  type ContentLanguage,
  type UiLanguage,
  type WithId,
} from "../firebase";
import {
  CONTENT_LANGUAGE_LABELS,
  PRODUCT_STATUS_LABELS,
  type AffiliateUiDictionary,
  type WorkspaceConnectionState,
  type WriteOperationState,
} from "./affiliateLabels";
import {
  CONTENT_LANGUAGES,
  shouldResetModalDraft,
  validateProductForm,
  type ProductFormInput,
} from "./affiliateValidation";
import type { AffiliateWriteResult } from "./useAffiliateWorkspaceData";

interface ProductFormModalProps {
  open: boolean;
  editingProduct: WithId<AffiliateProduct> | null;
  pendingCreateDocId: string | null;
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
  onCreate: (input: ProductFormInput, pendingDocId: string) => Promise<AffiliateWriteResult>;
  onUpdateDetails: (
    product: WithId<AffiliateProduct>,
    input: ProductFormInput
  ) => Promise<AffiliateWriteResult>;
  onClose: () => void;
}

const CREATE_STATUS_OPTIONS: AffiliateProductStatus[] = [
  "researching",
  "shortlisted",
  "active",
  "paused",
];

function buildInitialInput(product: WithId<AffiliateProduct> | null): ProductFormInput {
  if (!product) {
    return {
      name: "",
      category: "",
      tiktokShopUrl: "",
      priceThb: "",
      commissionRatePct: "",
      targetLanguage: "th",
      sellingPoints: "",
      complianceNotes: "",
      tagsText: "",
      status: "researching",
    };
  }
  return {
    name: product.name || "",
    category: product.category || "",
    tiktokShopUrl: product.tiktokShopUrl || "",
    priceThb: product.priceThb !== undefined ? String(product.priceThb) : "",
    commissionRatePct:
      product.commissionRatePct !== undefined ? String(product.commissionRatePct) : "",
    targetLanguage: product.targetLanguage || "th",
    sellingPoints: product.sellingPoints || "",
    complianceNotes: product.complianceNotes || "",
    tagsText: (product.tags || []).join(", "),
    status: product.status,
  };
}

function resolveLabelError(error: string | null | undefined, labels: AffiliateUiDictionary): string {
  if (error && error in labels) {
    return labels[error as keyof AffiliateUiDictionary];
  }
  return error || labels.writeFailed;
}

export function ProductFormModal({
  open,
  editingProduct,
  pendingCreateDocId,
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
}: ProductFormModalProps) {
  const [form, setForm] = useState<ProductFormInput>(() => buildInitialInput(editingProduct));
  const [localError, setLocalError] = useState<string | null>(null);
  const [localWriteState, setLocalWriteState] = useState<WriteOperationState>("idle");

  // H1: Key draft initialization strictly by logical modal session (open + record id or "__create__")
  // so Firestore snapshot updates NEVER wipe in-progress edits or regenerate pendingDocId.
  const prevSessionKeyRef = useRef<string | null>(null);
  const openRef = useRef(open);
  openRef.current = open;
  const closeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const sessionKey = open ? (editingProduct?.id ?? "__create__") : null;

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
      setForm(buildInitialInput(editingProduct));
      setLocalError(null);
      setLocalWriteState("idle");
      if (!editingProduct) {
        onEnsurePendingCreateDocId();
      }
    }
  }, [open, sessionKey, editingProduct, onEnsurePendingCreateDocId]);

  useEffect(() => {
    return () => {
      if (closeTimerRef.current) {
        clearTimeout(closeTimerRef.current);
        closeTimerRef.current = null;
      }
    };
  }, []);

  const targetDocId = editingProduct ? editingProduct.id : pendingCreateDocId;
  const isTrackingThisModal = Boolean(targetDocId && writeDocId === targetDocId);

  // H2: Reflect App-level write controller state when this modal targets the active/recent docId
  const effectiveState: WriteOperationState =
    isTrackingThisModal && writeState !== "idle" ? writeState : localWriteState;

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

  const handleClose = () => {
    if (isSaving) return;
    // Only discard controller-owned pending create ID when cancelling an idle/unsent create.
    // During sync_pending or after a failed retryable attempt, keep the same pendingDocId!
    if (!editingProduct && !isSyncPending && effectiveState !== "failed") {
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

    const check = validateProductForm(form);
    if (!check.ok) {
      setLocalError(labels[check.errorKey]);
      return;
    }

    setLocalError(null);
    setLocalWriteState("saving");

    const docIdForCreate = editingProduct
      ? editingProduct.id
      : pendingCreateDocId || onEnsurePendingCreateDocId();

    const res = editingProduct
      ? await onUpdateDetails(editingProduct, form)
      : await onCreate(form, docIdForCreate);

    if (!openRef.current) {
      return;
    }

    if (res.ok) {
      // Only reached after Firestore Promise resolves (server commit confirmed)
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
      aria-labelledby="product-modal-title"
    >
      <form
        onSubmit={handleSubmit}
        className="w-full sm:max-w-lg max-h-[90dvh] flex flex-col rounded-t-2xl sm:rounded-2xl border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-950 shadow-xl overflow-hidden"
      >
        {/* Sticky Header */}
        <div className="px-4 py-3.5 border-b border-neutral-200 dark:border-neutral-800 flex items-center justify-between gap-3 shrink-0">
          <div>
            <h3
              id="product-modal-title"
              className="text-sm font-semibold text-neutral-950 dark:text-neutral-50"
            >
              {editingProduct ? labels.editProduct : labels.addProduct}
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

          <div>
            <div className="flex items-center justify-between mb-1">
              <label className="text-xs font-medium text-neutral-700 dark:text-neutral-300">
                {labels.productNameLabel}
              </label>
              <span className="text-[11px] font-mono-tabular text-neutral-400">
                {form.name.trim().length}/{FIELD_LIMITS.name}
              </span>
            </div>
            <input
              type="text"
              required
              maxLength={FIELD_LIMITS.name}
              value={form.name}
              disabled={isThisBusy}
              onChange={(e) => setForm((prev) => ({ ...prev, name: e.target.value }))}
              placeholder="e.g. Vitamin C Serum / ဗီတာမင်စီ ဆီရမ်"
              className="w-full h-11 px-3 text-base sm:text-sm rounded-lg border border-neutral-200 dark:border-neutral-800 bg-neutral-50 dark:bg-neutral-900 text-neutral-950 dark:text-neutral-50 focus:outline-none focus:border-neutral-950 dark:focus:border-white leading-relaxed"
            />
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium text-neutral-700 dark:text-neutral-300 mb-1">
                {labels.categoryLabel}
              </label>
              <input
                type="text"
                maxLength={FIELD_LIMITS.category}
                value={form.category}
                disabled={isThisBusy}
                onChange={(e) => setForm((prev) => ({ ...prev, category: e.target.value }))}
                placeholder="Skincare, Home, Beauty..."
                className="w-full h-11 px-3 text-base sm:text-sm rounded-lg border border-neutral-200 dark:border-neutral-800 bg-neutral-50 dark:bg-neutral-900 text-neutral-950 dark:text-neutral-50 focus:outline-none focus:border-neutral-950 dark:focus:border-white"
              />
            </div>

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
          </div>

          <div>
            <label className="block text-xs font-medium text-neutral-700 dark:text-neutral-300 mb-1">
              {labels.tiktokShopUrlLabel}
            </label>
            <input
              type="url"
              maxLength={FIELD_LIMITS.url}
              value={form.tiktokShopUrl}
              disabled={isThisBusy}
              onChange={(e) => setForm((prev) => ({ ...prev, tiktokShopUrl: e.target.value }))}
              placeholder="https://shop.tiktok.com/..."
              className="w-full h-11 px-3 text-base sm:text-sm rounded-lg border border-neutral-200 dark:border-neutral-800 bg-neutral-50 dark:bg-neutral-900 text-neutral-950 dark:text-neutral-50 focus:outline-none focus:border-neutral-950 dark:focus:border-white"
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium text-neutral-700 dark:text-neutral-300 mb-1">
                {labels.priceThbLabel}
              </label>
              <input
                type="number"
                inputMode="decimal"
                min={0}
                max={10000000}
                step="any"
                value={form.priceThb}
                disabled={isThisBusy}
                onChange={(e) => setForm((prev) => ({ ...prev, priceThb: e.target.value }))}
                placeholder="299"
                className="w-full h-11 px-3 text-base sm:text-sm font-mono-tabular rounded-lg border border-neutral-200 dark:border-neutral-800 bg-neutral-50 dark:bg-neutral-900 text-neutral-950 dark:text-neutral-50 focus:outline-none focus:border-neutral-950 dark:focus:border-white"
              />
            </div>

            <div>
              <label className="block text-xs font-medium text-neutral-700 dark:text-neutral-300 mb-1">
                {labels.commissionRateLabel}
              </label>
              <input
                type="number"
                inputMode="decimal"
                min={0}
                max={100}
                step="any"
                value={form.commissionRatePct}
                disabled={isThisBusy}
                onChange={(e) =>
                  setForm((prev) => ({ ...prev, commissionRatePct: e.target.value }))
                }
                placeholder="10"
                className="w-full h-11 px-3 text-base sm:text-sm font-mono-tabular rounded-lg border border-neutral-200 dark:border-neutral-800 bg-neutral-50 dark:bg-neutral-900 text-neutral-950 dark:text-neutral-50 focus:outline-none focus:border-neutral-950 dark:focus:border-white"
              />
            </div>
          </div>

          {!editingProduct && (
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
                    status: e.target.value as AffiliateProductStatus,
                  }))
                }
                className="w-full h-11 px-3 text-base sm:text-sm rounded-lg border border-neutral-200 dark:border-neutral-800 bg-neutral-50 dark:bg-neutral-900 text-neutral-950 dark:text-neutral-50 focus:outline-none focus:border-neutral-950 dark:focus:border-white"
              >
                {CREATE_STATUS_OPTIONS.map((st) => (
                  <option key={st} value={st}>
                    {PRODUCT_STATUS_LABELS[st][uiLang]}
                  </option>
                ))}
              </select>
            </div>
          )}

          <div>
            <div className="flex items-center justify-between mb-1">
              <label className="text-xs font-medium text-neutral-700 dark:text-neutral-300">
                {labels.tagsLabel}
              </label>
              <span className="text-[11px] text-neutral-400">{labels.tagsHint}</span>
            </div>
            <input
              type="text"
              value={form.tagsText}
              disabled={isThisBusy}
              onChange={(e) => setForm((prev) => ({ ...prev, tagsText: e.target.value }))}
              placeholder="skincare, viral, ผิวใส"
              className="w-full h-11 px-3 text-base sm:text-sm rounded-lg border border-neutral-200 dark:border-neutral-800 bg-neutral-50 dark:bg-neutral-900 text-neutral-950 dark:text-neutral-50 focus:outline-none focus:border-neutral-950 dark:focus:border-white leading-relaxed"
            />
          </div>

          <div>
            <div className="flex items-center justify-between mb-1">
              <label className="text-xs font-medium text-neutral-700 dark:text-neutral-300">
                {labels.sellingPointsLabel}
              </label>
              <span className="text-[11px] font-mono-tabular text-neutral-400">
                {form.sellingPoints.trim().length}/{FIELD_LIMITS.sellingPoints}
              </span>
            </div>
            <textarea
              rows={3}
              maxLength={FIELD_LIMITS.sellingPoints}
              value={form.sellingPoints}
              disabled={isThisBusy}
              onChange={(e) => setForm((prev) => ({ ...prev, sellingPoints: e.target.value }))}
              className="w-full p-3 text-base sm:text-sm rounded-lg border border-neutral-200 dark:border-neutral-800 bg-neutral-50 dark:bg-neutral-900 text-neutral-950 dark:text-neutral-50 focus:outline-none focus:border-neutral-950 dark:focus:border-white leading-relaxed resize-y"
            />
          </div>

          <div>
            <div className="flex items-center justify-between mb-1">
              <label className="text-xs font-medium text-neutral-700 dark:text-neutral-300">
                {labels.complianceNotesLabel}
              </label>
              <span className="text-[11px] font-mono-tabular text-neutral-400">
                {form.complianceNotes.trim().length}/{FIELD_LIMITS.complianceNotes}
              </span>
            </div>
            <textarea
              rows={2}
              maxLength={FIELD_LIMITS.complianceNotes}
              value={form.complianceNotes}
              disabled={isThisBusy}
              onChange={(e) =>
                setForm((prev) => ({ ...prev, complianceNotes: e.target.value }))
              }
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
            disabled={isThisBusy || isWriteBusy || !canWriteNow}
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
