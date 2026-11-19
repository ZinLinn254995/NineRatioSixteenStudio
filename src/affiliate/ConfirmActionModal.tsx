import { AlertTriangle, Clock, CloudOff, Loader2, X } from "lucide-react";
import type {
  AffiliateUiDictionary,
  WorkspaceConnectionState,
  WriteOperationState,
} from "./affiliateLabels";

interface ConfirmActionModalProps {
  open: boolean;
  title: string;
  body: string;
  itemName: string;
  confirmLabel: string;
  tone: "archive" | "danger";
  writeState: WriteOperationState;
  connectionState?: WorkspaceConnectionState;
  canWriteNow?: boolean;
  isWriteBusy?: boolean;
  errorMessage: string | null;
  labels: AffiliateUiDictionary;
  onConfirm: () => void;
  onClose: () => void;
}

export function ConfirmActionModal({
  open,
  title,
  body,
  itemName,
  confirmLabel,
  tone,
  writeState,
  connectionState,
  canWriteNow = true,
  isWriteBusy = false,
  errorMessage,
  labels,
  onConfirm,
  onClose,
}: ConfirmActionModalProps) {
  if (!open) return null;

  const isSaving = writeState === "saving";
  const isSyncPending = writeState === "sync_pending";
  const isBusy = isSaving || isSyncPending;
  const effectiveCanWriteNow =
    canWriteNow && (connectionState === undefined || connectionState === "connected");

  return (
    <div
      className="fixed inset-0 z-50 bg-black/50 backdrop-blur-[1px] flex items-end sm:items-center justify-center p-0 sm:p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="confirm-action-title"
    >
      <div className="w-full sm:max-w-md rounded-t-2xl sm:rounded-2xl border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-950 shadow-xl overflow-hidden">
        <div className="px-4 py-3.5 border-b border-neutral-200 dark:border-neutral-800 flex items-center justify-between gap-3">
          <div className="flex items-center gap-2 min-w-0">
            <AlertTriangle
              className={`w-4 h-4 shrink-0 ${
                tone === "danger"
                  ? "text-red-600 dark:text-red-400"
                  : "text-amber-600 dark:text-amber-400"
              }`}
            />
            <h3
              id="confirm-action-title"
              className="text-sm font-semibold text-neutral-950 dark:text-neutral-50 truncate"
            >
              {title}
            </h3>
          </div>
          <button
            type="button"
            disabled={isSaving}
            onClick={onClose}
            aria-label={isSyncPending ? labels.dismissWhilePendingButton : labels.cancel}
            className="w-8 h-8 rounded-lg flex items-center justify-center text-neutral-500 hover:bg-neutral-100 dark:hover:bg-neutral-900 disabled:opacity-40 cursor-pointer"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="p-4 space-y-3 text-xs leading-relaxed text-neutral-600 dark:text-neutral-300">
          <div className="px-3 py-2 rounded-lg bg-neutral-100 dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-800 font-medium text-neutral-900 dark:text-neutral-100 break-words">
            {itemName}
          </div>
          <p>{body}</p>

          {!effectiveCanWriteNow && !isBusy && (
            <div
              role="alert"
              data-testid="confirm-modal-connection-warning"
              className="p-2.5 rounded-lg border border-amber-300 dark:border-amber-800 bg-amber-50 dark:bg-amber-950/40 text-amber-800 dark:text-amber-200 flex items-start gap-2 leading-relaxed"
            >
              <CloudOff className="w-4 h-4 shrink-0 mt-0.5" />
              <span>
                {connectionState === "cached"
                  ? labels.errCachedWriteBlocked
                  : labels.confirmConnectionUnavailable}
              </span>
            </div>
          )}

          {isSyncPending && (
            <div className="p-2.5 rounded-lg border border-amber-300 dark:border-amber-800 bg-amber-50 dark:bg-amber-950/40 text-amber-800 dark:text-amber-200 space-y-1.5">
              <div className="flex items-start gap-2">
                <Clock className="w-4 h-4 shrink-0 mt-0.5" />
                <span>{labels.writeSyncPendingWarning}</span>
              </div>
              <p className="pl-6 text-[11px] opacity-90">{labels.dismissWhilePendingNotice}</p>
            </div>
          )}

          {errorMessage && (
            <div className="p-2.5 rounded-lg border border-red-200 dark:border-red-900 bg-red-50 dark:bg-red-950/40 text-red-700 dark:text-red-300 break-words">
              {errorMessage}
            </div>
          )}
        </div>

        <div className="px-4 py-3 border-t border-neutral-200 dark:border-neutral-800 flex items-center justify-end gap-2 bg-neutral-50/70 dark:bg-neutral-900/40">
          <button
            type="button"
            disabled={isSaving}
            onClick={onClose}
            className="h-10 px-4 rounded-lg border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-950 hover:bg-neutral-100 dark:hover:bg-neutral-900 text-xs font-medium disabled:opacity-40 cursor-pointer"
          >
            {isSyncPending ? labels.dismissWhilePendingButton : labels.cancel}
          </button>
          <button
            type="button"
            disabled={isBusy || isWriteBusy || !effectiveCanWriteNow}
            onClick={onConfirm}
            className={`h-10 px-4 rounded-lg text-xs font-semibold flex items-center gap-1.5 disabled:opacity-50 cursor-pointer ${
              tone === "danger"
                ? "bg-red-600 text-white hover:bg-red-700"
                : "bg-neutral-950 text-white dark:bg-white dark:text-neutral-950 hover:opacity-90"
            }`}
          >
            {isBusy && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
            <span>
              {isSyncPending
                ? labels.writeSyncPending
                : isSaving
                  ? labels.writeSaving
                  : confirmLabel}
            </span>
          </button>
        </div>
      </div>
    </div>
  );
}
