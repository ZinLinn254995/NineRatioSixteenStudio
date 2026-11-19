import { useMemo, useState } from "react";
import {
  AlertCircle,
  Archive,
  Check,
  Clock,
  Copy,
  Edit3,
  ExternalLink,
  Info,
  PauseCircle,
  PlayCircle,
  Plus,
  Search,
  X,
} from "lucide-react";
import type {
  AffiliateProduct,
  AffiliateProductStatus,
  ContentLanguage,
  MarketingCampaign,
  UiLanguage,
  WithId,
} from "../firebase";
import { formatSystemTimestamp } from "./affiliateDateUtils";
import {
  CONTENT_LANGUAGE_LABELS,
  PRODUCT_STATUS_LABELS,
  type AffiliateUiDictionary,
  type WorkspaceConnectionState,
  type WriteOperationState,
} from "./affiliateLabels";
import {
  CONTENT_LANGUAGES,
  PRODUCT_EDITABLE_STATUSES,
  canArchiveRecord,
  canEditRecord,
  isSafeHttpUrl,
  normalizeSearchText,
} from "./affiliateValidation";
import { ConfirmActionModal } from "./ConfirmActionModal";
import type { AffiliateWriteResult } from "./useAffiliateWorkspaceData";

interface ProductWorkspaceViewProps {
  products: WithId<AffiliateProduct>[];
  campaigns: WithId<MarketingCampaign>[];
  pendingDocIds: readonly string[];
  uiLang: UiLanguage;
  labels: AffiliateUiDictionary;
  connectionState?: WorkspaceConnectionState;
  canWriteNow: boolean;
  isWriteBusy: boolean;
  writeState: WriteOperationState;
  writeDocId: string | null;
  onAddProduct: () => void;
  onEditProduct: (product: WithId<AffiliateProduct>) => void;
  onUpdateStatus: (
    product: WithId<AffiliateProduct>,
    nextStatus: AffiliateProductStatus
  ) => Promise<AffiliateWriteResult>;
}

const NON_ARCHIVED_STATUSES: AffiliateProductStatus[] = [
  "researching",
  "shortlisted",
  "active",
  "paused",
];

function resolveErrorLabel(error: string | null | undefined, labels: AffiliateUiDictionary): string {
  if (error && error in labels) {
    return labels[error as keyof AffiliateUiDictionary];
  }
  return error || labels.writeFailed;
}

/**
 * Affiliate Product Workspace (Phase 3).
 * Product Deletion is intentionally excluded to prevent orphaned campaign references.
 * Products support Paused (temporary) and one-way Archived (read-only).
 */
export function ProductWorkspaceView({
  products,
  campaigns,
  pendingDocIds,
  uiLang,
  labels,
  connectionState,
  canWriteNow,
  isWriteBusy,
  writeState,
  writeDocId,
  onAddProduct,
  onEditProduct,
  onUpdateStatus,
}: ProductWorkspaceViewProps) {
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<AffiliateProductStatus | "all">("all");
  const [langFilter, setLangFilter] = useState<ContentLanguage | "all">("all");
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [inlineError, setInlineError] = useState<string | null>(null);
  const [archivingProduct, setArchivingProduct] = useState<WithId<AffiliateProduct> | null>(
    null
  );
  const [archiveWriteState, setArchiveWriteState] = useState<WriteOperationState>("idle");
  const [archiveError, setArchiveError] = useState<string | null>(null);

  const effectiveCanWriteNow =
    canWriteNow && (connectionState === undefined || connectionState === "connected");

  const campaignCountByProduct = useMemo(() => {
    const counts = new Map<string, number>();
    for (const c of campaigns) {
      counts.set(c.productId, (counts.get(c.productId) || 0) + 1);
    }
    return counts;
  }, [campaigns]);

  const filteredProducts = useMemo(() => {
    const q = normalizeSearchText(query);
    return products.filter((p) => {
      if (statusFilter !== "all" && p.status !== statusFilter) return false;
      if (langFilter !== "all" && p.targetLanguage !== langFilter) return false;
      if (!q) return true;
      const haystack = normalizeSearchText(
        [p.name, p.category || "", p.sellingPoints || "", (p.tags || []).join(" ")].join(" ")
      );
      return haystack.includes(q);
    });
  }, [products, query, statusFilter, langFilter]);

  const handleCopyUrl = async (productId: string, url: string) => {
    try {
      await navigator.clipboard.writeText(url);
      setCopiedId(productId);
      setTimeout(() => {
        setCopiedId((curr) => (curr === productId ? null : curr));
      }, 1800);
    } catch {
      // Clipboard may be unavailable in restricted contexts
    }
  };

  // L1 + M4: Capture inline status mutation errors and distinguish cached vs offline blocking
  const handleInlineStatusChange = async (
    product: WithId<AffiliateProduct>,
    nextStatus: AffiliateProductStatus
  ) => {
    if (isWriteBusy) {
      setInlineError(labels.errWriteInFlightLocked);
      return;
    }
    if (!effectiveCanWriteNow) {
      if (connectionState) {
        setInlineError(
          connectionState === "cached"
            ? labels.errCachedWriteBlocked
            : labels.errOfflineWriteBlocked
        );
        return;
      }
      const blockedRes = await onUpdateStatus(product, nextStatus);
      setInlineError(
        resolveErrorLabel(blockedRes.error || "errOfflineWriteBlocked", labels)
      );
      return;
    }
    setInlineError(null);
    const res = await onUpdateStatus(product, nextStatus);
    if (!res.ok) {
      setInlineError(resolveErrorLabel(res.error, labels));
    }
  };

  const handleConfirmArchive = async () => {
    if (!archivingProduct) return;
    if (isWriteBusy) {
      setArchiveError(labels.errWriteInFlightLocked);
      setArchiveWriteState("failed");
      return;
    }
    if (!effectiveCanWriteNow) {
      if (connectionState) {
        setArchiveError(
          connectionState === "cached"
            ? labels.errCachedWriteBlocked
            : labels.errOfflineWriteBlocked
        );
        setArchiveWriteState("failed");
        return;
      }
      const blockedRes = await onUpdateStatus(archivingProduct, "archived");
      setArchiveError(
        resolveErrorLabel(blockedRes.error || "errOfflineWriteBlocked", labels)
      );
      setArchiveWriteState("failed");
      return;
    }

    setArchiveError(null);
    setArchiveWriteState("saving");
    const res = await onUpdateStatus(archivingProduct, "archived");
    if (res.ok) {
      setArchiveWriteState("saved");
      setArchivingProduct(null);
    } else {
      setArchiveError(resolveErrorLabel(res.error, labels));
      setArchiveWriteState("failed");
    }
  };

  const isTrackingArchiveTarget = Boolean(
    archivingProduct && writeDocId === archivingProduct.id
  );
  const effectiveArchiveModalState: WriteOperationState =
    isTrackingArchiveTarget && (writeState === "saving" || writeState === "sync_pending")
      ? writeState
      : archiveWriteState;

  return (
    <div className="space-y-4">
      {/* Header Row */}
      <div className="flex items-center justify-between gap-3">
        <div>
          <h2 className="text-base font-bold text-neutral-950 dark:text-neutral-50">
            {labels.productsTitle}
          </h2>
          <p className="text-[11px] text-neutral-500 dark:text-neutral-400 font-mono-tabular">
            {filteredProducts.length} / {products.length}
          </p>
        </div>
        <button
          type="button"
          disabled={!effectiveCanWriteNow || isWriteBusy}
          onClick={onAddProduct}
          className="h-10 px-4 rounded-lg bg-neutral-950 text-white dark:bg-white dark:text-neutral-950 text-xs font-semibold flex items-center gap-1.5 shrink-0 disabled:opacity-40 hover:opacity-90 cursor-pointer"
        >
          <Plus className="w-4 h-4" />
          <span>{labels.addProduct}</span>
        </button>
      </div>

      {/* Visible Inline Action Error Banner (L1) */}
      {inlineError && (
        <div
          role="alert"
          className="p-3 rounded-lg border border-red-200 dark:border-red-900 bg-red-50 dark:bg-red-950/40 text-xs text-red-700 dark:text-red-300 flex items-start justify-between gap-2 leading-relaxed"
        >
          <div className="flex items-start gap-2 min-w-0">
            <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
            <span className="break-words">{inlineError}</span>
          </div>
          <button
            type="button"
            onClick={() => setInlineError(null)}
            aria-label={labels.dismiss}
            className="p-0.5 opacity-70 hover:opacity-100 cursor-pointer shrink-0"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      )}

      {/* Data Integrity Note (Pause / Archive Only — No Product Deletion) */}
      <div className="p-3 rounded-lg border border-neutral-200 dark:border-neutral-800 bg-neutral-50 dark:bg-neutral-900/50 text-[11px] text-neutral-600 dark:text-neutral-400 flex items-start gap-2 leading-relaxed">
        <Info className="w-3.5 h-3.5 shrink-0 mt-0.5 text-neutral-400" />
        <span>{labels.productArchiveOnlyNote}</span>
      </div>

      {/* Search & Filters */}
      <div className="space-y-2.5">
        <div className="relative">
          <Search className="w-4 h-4 text-neutral-400 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={labels.searchProductsPlaceholder}
            className="w-full h-10 pl-9 pr-9 text-base sm:text-sm rounded-lg border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-950 text-neutral-950 dark:text-neutral-50 focus:outline-none focus:border-neutral-950 dark:focus:border-white"
          />
          {query && (
            <button
              type="button"
              onClick={() => setQuery("")}
              aria-label="Clear search"
              className="w-7 h-7 rounded flex items-center justify-center text-neutral-400 hover:text-neutral-900 dark:hover:text-white absolute right-1.5 top-1/2 -translate-y-1/2 cursor-pointer"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          )}
        </div>

        <div className="grid grid-cols-2 gap-2.5">
          <select
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value as AffiliateProductStatus | "all")}
            aria-label={labels.statusLabel}
            className="h-10 px-3 text-xs rounded-lg border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-950 text-neutral-900 dark:text-neutral-100"
          >
            <option value="all">{labels.allStatuses}</option>
            {PRODUCT_EDITABLE_STATUSES.map((st) => (
              <option key={st} value={st}>
                {PRODUCT_STATUS_LABELS[st][uiLang]}
              </option>
            ))}
          </select>

          <select
            value={langFilter}
            onChange={(e) => setLangFilter(e.target.value as ContentLanguage | "all")}
            aria-label={labels.contentLanguageLabel}
            className="h-10 px-3 text-xs rounded-lg border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-950 text-neutral-900 dark:text-neutral-100"
          >
            <option value="all">{labels.allLanguages}</option>
            {CONTENT_LANGUAGES.map((lang) => (
              <option key={lang} value={lang}>
                {CONTENT_LANGUAGE_LABELS[lang]}
              </option>
            ))}
          </select>
        </div>
      </div>

      {/* Product Cards */}
      {filteredProducts.length === 0 ? (
        <div className="rounded-xl border border-dashed border-neutral-200 dark:border-neutral-800 p-8 text-center space-y-3">
          <p className="text-xs text-neutral-500 dark:text-neutral-400 leading-relaxed">
            {products.length === 0 ? labels.noProductsYet : labels.noProductsMatch}
          </p>
          {products.length === 0 && (
            <button
              type="button"
              disabled={!effectiveCanWriteNow || isWriteBusy}
              onClick={onAddProduct}
              className="h-10 px-4 rounded-lg bg-neutral-950 text-white dark:bg-white dark:text-neutral-950 text-xs font-semibold inline-flex items-center gap-1.5 disabled:opacity-40 cursor-pointer"
            >
              <Plus className="w-4 h-4" />
              <span>{labels.addProduct}</span>
            </button>
          )}
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3.5">
          {filteredProducts.map((product) => {
            const isArchived = !canEditRecord(product.status);
            const isPending = pendingDocIds.includes(product.id);
            const actionsDisabled = !effectiveCanWriteNow || isWriteBusy || isPending;
            const linkedCount = campaignCountByProduct.get(product.id) || 0;
            const hasSafeUrl = Boolean(
              product.tiktokShopUrl && isSafeHttpUrl(product.tiktokShopUrl)
            );

            return (
              <article
                key={product.id}
                className={`rounded-xl border p-4 flex flex-col justify-between gap-3.5 ${
                  isArchived
                    ? "border-neutral-200 dark:border-neutral-800 bg-neutral-50/80 dark:bg-neutral-900/40"
                    : "border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-950"
                }`}
              >
                <div className="space-y-2.5">
                  {/* Top Title & Status */}
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0 space-y-1">
                      <h3 className="text-sm font-semibold text-neutral-950 dark:text-neutral-50 break-words leading-relaxed">
                        {product.name}
                      </h3>
                      <div className="flex flex-wrap items-center gap-1.5 text-[11px] text-neutral-500 dark:text-neutral-400">
                        <span className="px-1.5 py-0.5 rounded bg-neutral-100 dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-800 text-neutral-700 dark:text-neutral-300">
                          {CONTENT_LANGUAGE_LABELS[product.targetLanguage]}
                        </span>
                        {product.category && (
                          <span className="truncate max-w-[160px]">{product.category}</span>
                        )}
                      </div>
                    </div>

                    <div className="flex flex-col items-end gap-1 shrink-0">
                      <span
                        className={`px-2 py-0.5 rounded-md border text-[11px] font-medium ${
                          isArchived
                            ? "border-neutral-300 dark:border-neutral-700 bg-neutral-100 dark:bg-neutral-800 text-neutral-600 dark:text-neutral-300"
                            : product.status === "active"
                              ? "border-emerald-200 dark:border-emerald-900 bg-emerald-50 dark:bg-emerald-950/40 text-emerald-700 dark:text-emerald-300"
                              : product.status === "paused"
                                ? "border-amber-200 dark:border-amber-900 bg-amber-50 dark:bg-amber-950/40 text-amber-700 dark:text-amber-300"
                                : "border-neutral-200 dark:border-neutral-800 bg-neutral-50 dark:bg-neutral-900 text-neutral-700 dark:text-neutral-300"
                        }`}
                      >
                        {isArchived
                          ? labels.readOnlyArchived
                          : PRODUCT_STATUS_LABELS[product.status][uiLang]}
                      </span>
                      {isPending && (
                        <span className="inline-flex items-center gap-1 text-[10px] text-amber-600 dark:text-amber-400 font-medium">
                          <Clock className="w-3 h-3" />
                          {labels.writeSyncPending}
                        </span>
                      )}
                    </div>
                  </div>

                  {/* Manual Entry Metrics & Provenance */}
                  <div className="rounded-lg border border-neutral-100 dark:border-neutral-900 bg-neutral-50/70 dark:bg-neutral-900/50 p-2.5 space-y-1.5">
                    <div className="flex items-center justify-between text-[10px] uppercase tracking-wide text-neutral-400">
                      <span>{labels.manualEntry}</span>
                      <span className="font-mono-tabular">
                        {labels.linkedCampaignsCount}: {linkedCount}
                      </span>
                    </div>
                    <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs font-mono-tabular text-neutral-800 dark:text-neutral-200">
                      <span>
                        THB:{" "}
                        {product.priceThb !== undefined
                          ? `฿${product.priceThb.toLocaleString()}`
                          : "—"}
                      </span>
                      <span>
                        Commission:{" "}
                        {product.commissionRatePct !== undefined
                          ? `${product.commissionRatePct}%`
                          : "—"}
                      </span>
                    </div>
                  </div>

                  {/* Safe URL Link + Copy */}
                  {hasSafeUrl && product.tiktokShopUrl && (
                    <div className="flex items-center gap-2 text-xs">
                      <a
                        href={product.tiktokShopUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-neutral-700 dark:text-neutral-300 hover:underline inline-flex items-center gap-1 truncate min-w-0"
                      >
                        <ExternalLink className="w-3.5 h-3.5 shrink-0" />
                        <span className="truncate">{labels.openLink}</span>
                      </a>
                      <button
                        type="button"
                        onClick={() => void handleCopyUrl(product.id, product.tiktokShopUrl!)}
                        className="h-7 px-2 rounded border border-neutral-200 dark:border-neutral-800 text-[11px] text-neutral-600 dark:text-neutral-300 hover:bg-neutral-100 dark:hover:bg-neutral-900 inline-flex items-center gap-1 shrink-0 cursor-pointer"
                      >
                        {copiedId === product.id ? (
                          <>
                            <Check className="w-3 h-3 text-emerald-600" />
                            <span>{labels.copied}</span>
                          </>
                        ) : (
                          <>
                            <Copy className="w-3 h-3" />
                            <span>{labels.copyUrl}</span>
                          </>
                        )}
                      </button>
                    </div>
                  )}

                  {product.sellingPoints && (
                    <p className="text-xs text-neutral-600 dark:text-neutral-300 leading-relaxed break-words line-clamp-3">
                      {product.sellingPoints}
                    </p>
                  )}

                  {product.complianceNotes && (
                    <p className="text-[11px] text-amber-700 dark:text-amber-300 leading-relaxed break-words line-clamp-2">
                      {product.complianceNotes}
                    </p>
                  )}

                  {product.tags && product.tags.length > 0 && (
                    <div className="flex flex-wrap gap-1">
                      {product.tags.map((tag, idx) => (
                        <span
                          key={`${tag}-${idx}`}
                          className="px-1.5 py-0.5 rounded bg-neutral-100 dark:bg-neutral-900 text-[11px] text-neutral-600 dark:text-neutral-400"
                        >
                          #{tag}
                        </span>
                      ))}
                    </div>
                  )}

                  {/* System Record Timestamps */}
                  <div className="text-[11px] text-neutral-400 flex items-center justify-between gap-2 pt-1 border-t border-neutral-100 dark:border-neutral-900">
                    <span>{labels.systemRecord}</span>
                    <span className="font-mono-tabular">
                      {labels.updatedLabel}: {formatSystemTimestamp(product.updatedAt, uiLang)}
                    </span>
                  </div>
                </div>

                {/* Action Footer (NO Product Removal Button — Pause & One-Way Archive Only) */}
                {!isArchived && (
                  <div className="pt-2 border-t border-neutral-100 dark:border-neutral-900 flex flex-wrap items-center gap-2">
                    <button
                      type="button"
                      disabled={actionsDisabled}
                      onClick={() => onEditProduct(product)}
                      className="h-9 px-3 rounded-lg border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-950 hover:bg-neutral-100 dark:hover:bg-neutral-900 text-xs font-medium inline-flex items-center gap-1.5 disabled:opacity-40 cursor-pointer"
                    >
                      <Edit3 className="w-3.5 h-3.5" />
                      <span>{labels.editDetails}</span>
                    </button>

                    <select
                      aria-label={labels.changeStatus}
                      disabled={actionsDisabled}
                      value={product.status}
                      onChange={(e) => {
                        const next = e.target.value as AffiliateProductStatus;
                        if (next !== product.status) {
                          void handleInlineStatusChange(product, next);
                        }
                      }}
                      className="h-9 px-2.5 rounded-lg border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-950 text-xs text-neutral-800 dark:text-neutral-200 disabled:opacity-40"
                    >
                      {NON_ARCHIVED_STATUSES.map((st) => (
                        <option key={st} value={st}>
                          {PRODUCT_STATUS_LABELS[st][uiLang]}
                        </option>
                      ))}
                    </select>

                    <button
                      type="button"
                      disabled={actionsDisabled}
                      onClick={() =>
                        void handleInlineStatusChange(
                          product,
                          product.status === "paused" ? "active" : "paused"
                        )
                      }
                      className="h-9 px-2.5 rounded-lg border border-neutral-200 dark:border-neutral-800 hover:bg-neutral-100 dark:hover:bg-neutral-900 text-xs font-medium inline-flex items-center gap-1 disabled:opacity-40 cursor-pointer"
                    >
                      {product.status === "paused" ? (
                        <>
                          <PlayCircle className="w-3.5 h-3.5" />
                          <span>{labels.resumeAction}</span>
                        </>
                      ) : (
                        <>
                          <PauseCircle className="w-3.5 h-3.5" />
                          <span>{labels.pauseAction}</span>
                        </>
                      )}
                    </button>

                    {canArchiveRecord(product.status) && (
                      <button
                        type="button"
                        disabled={actionsDisabled}
                        onClick={() => {
                          setArchiveError(null);
                          setArchiveWriteState("idle");
                          setArchivingProduct(product);
                        }}
                        className="h-9 px-2.5 rounded-lg border border-neutral-200 dark:border-neutral-800 hover:bg-neutral-100 dark:hover:bg-neutral-900 text-xs font-medium text-neutral-600 dark:text-neutral-300 inline-flex items-center gap-1 ml-auto disabled:opacity-40 cursor-pointer"
                      >
                        <Archive className="w-3.5 h-3.5" />
                        <span>{labels.archiveAction}</span>
                      </button>
                    )}
                  </div>
                )}
              </article>
            );
          })}
        </div>
      )}

      <ConfirmActionModal
        open={Boolean(archivingProduct)}
        title={labels.archiveConfirmTitle}
        body={labels.archiveConfirmBody}
        itemName={archivingProduct?.name || ""}
        confirmLabel={labels.archiveConfirmButton}
        tone="archive"
        writeState={effectiveArchiveModalState}
        connectionState={connectionState}
        canWriteNow={effectiveCanWriteNow}
        isWriteBusy={isWriteBusy}
        errorMessage={archiveError}
        labels={labels}
        onConfirm={() => void handleConfirmArchive()}
        onClose={() => {
          setArchivingProduct(null);
          setArchiveError(null);
          setArchiveWriteState("idle");
        }}
      />
    </div>
  );
}
