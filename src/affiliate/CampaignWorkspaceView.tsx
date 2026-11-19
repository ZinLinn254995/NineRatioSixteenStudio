import { useMemo, useState } from "react";
import {
  AlertCircle,
  AlertTriangle,
  Archive,
  Calendar,
  Clock,
  Edit3,
  Info,
  Package,
  PauseCircle,
  PlayCircle,
  Plus,
  Search,
  Trash2,
  X,
} from "lucide-react";
import type {
  AffiliateProduct,
  CampaignStatus,
  ContentLanguage,
  MarketingCampaign,
  UiLanguage,
  WithId,
} from "../firebase";
import { formatDateOnlyDisplay, formatSystemTimestamp } from "./affiliateDateUtils";
import {
  CAMPAIGN_STATUS_LABELS,
  CONTENT_LANGUAGE_LABELS,
  type AffiliateUiDictionary,
  type WorkspaceConnectionState,
  type WriteOperationState,
} from "./affiliateLabels";
import {
  CAMPAIGN_EDITABLE_STATUSES,
  CONTENT_LANGUAGES,
  canArchiveRecord,
  canEditRecord,
  normalizeSearchText,
} from "./affiliateValidation";
import { ConfirmActionModal } from "./ConfirmActionModal";
import type { AffiliateWriteResult } from "./useAffiliateWorkspaceData";

interface CampaignWorkspaceViewProps {
  campaigns: WithId<MarketingCampaign>[];
  products: WithId<AffiliateProduct>[];
  pendingDocIds: readonly string[];
  uiLang: UiLanguage;
  labels: AffiliateUiDictionary;
  connectionState?: WorkspaceConnectionState;
  canWriteNow: boolean;
  isWriteBusy: boolean;
  writeState: WriteOperationState;
  writeDocId: string | null;
  onNewCampaign: () => void;
  onEditCampaign: (campaign: WithId<MarketingCampaign>) => void;
  onUpdateStatus: (
    campaign: WithId<MarketingCampaign>,
    nextStatus: CampaignStatus
  ) => Promise<AffiliateWriteResult>;
  onDeleteCampaign: (campaignId: string) => Promise<AffiliateWriteResult>;
}

const NON_ARCHIVED_CAMPAIGN_STATUSES: CampaignStatus[] = [
  "draft",
  "active",
  "paused",
  "completed",
];

function resolveErrorLabel(error: string | null | undefined, labels: AffiliateUiDictionary): string {
  if (error && error in labels) {
    return labels[error as keyof AffiliateUiDictionary];
  }
  return error || labels.writeFailed;
}

export function CampaignWorkspaceView({
  campaigns,
  products,
  pendingDocIds,
  uiLang,
  labels,
  connectionState,
  canWriteNow,
  isWriteBusy,
  writeState,
  writeDocId,
  onNewCampaign,
  onEditCampaign,
  onUpdateStatus,
  onDeleteCampaign,
}: CampaignWorkspaceViewProps) {
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<CampaignStatus | "all">("all");
  const [productFilter, setProductFilter] = useState<string>("all");
  const [langFilter, setLangFilter] = useState<ContentLanguage | "all">("all");
  const [inlineError, setInlineError] = useState<string | null>(null);

  const [confirmState, setConfirmState] = useState<{
    kind: "archive" | "delete";
    campaign: WithId<MarketingCampaign>;
  } | null>(null);
  const [modalWriteState, setModalWriteState] = useState<WriteOperationState>("idle");
  const [modalError, setModalError] = useState<string | null>(null);

  const effectiveCanWriteNow =
    canWriteNow && (connectionState === undefined || connectionState === "connected");

  const productById = useMemo(() => new Map(products.map((p) => [p.id, p])), [products]);

  const filteredCampaigns = useMemo(() => {
    const q = normalizeSearchText(query);
    return campaigns.filter((c) => {
      if (statusFilter !== "all" && c.status !== statusFilter) return false;
      if (productFilter !== "all" && c.productId !== productFilter) return false;
      if (langFilter !== "all" && c.targetLanguage !== langFilter) return false;
      if (!q) return true;
      const prodName = productById.get(c.productId)?.name || "";
      const haystack = normalizeSearchText(
        [c.title, c.goal || "", c.strategyNotes || "", prodName].join(" ")
      );
      return haystack.includes(q);
    });
  }, [campaigns, query, statusFilter, productFilter, langFilter, productById]);

  // L1 + M4: Capture returned AffiliateWriteResult errors and distinguish cached vs offline blocking
  const handleInlineStatusChange = async (
    campaign: WithId<MarketingCampaign>,
    nextStatus: CampaignStatus
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
      const blockedRes = await onUpdateStatus(campaign, nextStatus);
      setInlineError(
        resolveErrorLabel(blockedRes.error || "errOfflineWriteBlocked", labels)
      );
      return;
    }
    setInlineError(null);
    const res = await onUpdateStatus(campaign, nextStatus);
    if (!res.ok) {
      setInlineError(resolveErrorLabel(res.error, labels));
    }
  };

  const handleConfirmModalAction = async () => {
    if (!confirmState) return;
    if (isWriteBusy) {
      setModalError(labels.errWriteInFlightLocked);
      setModalWriteState("failed");
      return;
    }
    if (!effectiveCanWriteNow) {
      if (connectionState) {
        setModalError(
          connectionState === "cached"
            ? labels.errCachedWriteBlocked
            : labels.errOfflineWriteBlocked
        );
        setModalWriteState("failed");
        return;
      }
      const blockedRes =
        confirmState.kind === "archive"
          ? await onUpdateStatus(confirmState.campaign, "archived")
          : await onDeleteCampaign(confirmState.campaign.id);
      setModalError(
        resolveErrorLabel(blockedRes.error || "errOfflineWriteBlocked", labels)
      );
      setModalWriteState("failed");
      return;
    }

    setModalError(null);
    setModalWriteState("saving");

    const res =
      confirmState.kind === "archive"
        ? await onUpdateStatus(confirmState.campaign, "archived")
        : await onDeleteCampaign(confirmState.campaign.id);

    if (res.ok) {
      setModalWriteState("saved");
      setConfirmState(null);
    } else {
      setModalError(resolveErrorLabel(res.error, labels));
      setModalWriteState("failed");
    }
  };

  const isTrackingConfirmTarget = Boolean(
    confirmState && writeDocId === confirmState.campaign.id
  );
  const effectiveModalState: WriteOperationState =
    isTrackingConfirmTarget && (writeState === "saving" || writeState === "sync_pending")
      ? writeState
      : modalWriteState;

  return (
    <div className="space-y-4">
      {/* Header Row */}
      <div className="flex items-center justify-between gap-3">
        <div>
          <h2 className="text-base font-bold text-neutral-950 dark:text-neutral-50">
            {labels.campaignsTitle}
          </h2>
          <p className="text-[11px] text-neutral-500 dark:text-neutral-400 font-mono-tabular">
            {filteredCampaigns.length} / {campaigns.length}
          </p>
        </div>
        <button
          type="button"
          disabled={!effectiveCanWriteNow || isWriteBusy || products.length === 0}
          title={products.length === 0 ? labels.needProductForCampaignHint : undefined}
          onClick={onNewCampaign}
          className="h-10 px-4 rounded-lg bg-neutral-950 text-white dark:bg-white dark:text-neutral-950 text-xs font-semibold flex items-center gap-1.5 shrink-0 disabled:opacity-40 hover:opacity-90 cursor-pointer"
        >
          <Plus className="w-4 h-4" />
          <span>{labels.newCampaign}</span>
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

      {/* Manual Publishing Notice */}
      <div className="p-3 rounded-lg border border-neutral-200 dark:border-neutral-800 bg-neutral-50 dark:bg-neutral-900/50 text-[11px] text-neutral-600 dark:text-neutral-400 flex items-start gap-2 leading-relaxed">
        <Info className="w-3.5 h-3.5 shrink-0 mt-0.5 text-neutral-400" />
        <span>{labels.manualPublishingNotice}</span>
      </div>

      {products.length === 0 && (
        <div className="p-3 rounded-lg border border-amber-200 dark:border-amber-900 bg-amber-50 dark:bg-amber-950/40 text-xs text-amber-800 dark:text-amber-200 leading-relaxed">
          {labels.needProductForCampaignHint}
        </div>
      )}

      {/* Search & Filters */}
      <div className="space-y-2.5">
        <div className="relative">
          <Search className="w-4 h-4 text-neutral-400 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={labels.searchCampaignsPlaceholder}
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

        <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
          <select
            value={productFilter}
            onChange={(e) => setProductFilter(e.target.value)}
            aria-label={labels.linkedProductLabel}
            className="h-10 px-3 text-xs rounded-lg border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-950 text-neutral-900 dark:text-neutral-100"
          >
            <option value="all">{labels.allProducts}</option>
            {products.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>

          <select
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value as CampaignStatus | "all")}
            aria-label={labels.statusLabel}
            className="h-10 px-3 text-xs rounded-lg border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-950 text-neutral-900 dark:text-neutral-100"
          >
            <option value="all">{labels.allStatuses}</option>
            {CAMPAIGN_EDITABLE_STATUSES.map((st) => (
              <option key={st} value={st}>
                {CAMPAIGN_STATUS_LABELS[st][uiLang]}
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

      {/* Campaign Cards */}
      {filteredCampaigns.length === 0 ? (
        <div className="rounded-xl border border-dashed border-neutral-200 dark:border-neutral-800 p-8 text-center space-y-3">
          <p className="text-xs text-neutral-500 dark:text-neutral-400 leading-relaxed">
            {campaigns.length === 0 ? labels.noCampaignsYet : labels.noCampaignsMatch}
          </p>
          {campaigns.length === 0 && products.length > 0 && (
            <button
              type="button"
              disabled={!effectiveCanWriteNow || isWriteBusy}
              onClick={onNewCampaign}
              className="h-10 px-4 rounded-lg bg-neutral-950 text-white dark:bg-white dark:text-neutral-950 text-xs font-semibold inline-flex items-center gap-1.5 disabled:opacity-40 cursor-pointer"
            >
              <Plus className="w-4 h-4" />
              <span>{labels.newCampaign}</span>
            </button>
          )}
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3.5">
          {filteredCampaigns.map((campaign) => {
            const linkedProduct = productById.get(campaign.productId);
            const isArchived = !canEditRecord(campaign.status);
            const isPending = pendingDocIds.includes(campaign.id);
            const actionsDisabled = !effectiveCanWriteNow || isWriteBusy || isPending;

            return (
              <article
                key={campaign.id}
                className={`rounded-xl border p-4 flex flex-col justify-between gap-3.5 ${
                  isArchived
                    ? "border-neutral-200 dark:border-neutral-800 bg-neutral-50/80 dark:bg-neutral-900/40"
                    : "border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-950"
                }`}
              >
                <div className="space-y-2.5">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0 space-y-1">
                      <h3 className="text-sm font-semibold text-neutral-950 dark:text-neutral-50 break-words leading-relaxed">
                        {campaign.title}
                      </h3>
                      <div className="flex flex-wrap items-center gap-1.5 text-[11px]">
                        {linkedProduct ? (
                          <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-neutral-100 dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-800 text-neutral-700 dark:text-neutral-300 max-w-[200px] truncate">
                            <Package className="w-3 h-3 shrink-0" />
                            <span className="truncate">{linkedProduct.name}</span>
                          </span>
                        ) : (
                          <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-amber-50 dark:bg-amber-950/40 border border-amber-200 dark:border-amber-900 text-amber-700 dark:text-amber-300">
                            <AlertTriangle className="w-3 h-3 shrink-0" />
                            <span>{labels.missingLinkedProduct}</span>
                          </span>
                        )}
                        <span className="px-1.5 py-0.5 rounded bg-neutral-100 dark:bg-neutral-900 text-neutral-600 dark:text-neutral-400">
                          {CONTENT_LANGUAGE_LABELS[campaign.targetLanguage]}
                        </span>
                      </div>
                    </div>

                    <div className="flex flex-col items-end gap-1 shrink-0">
                      <span
                        className={`px-2 py-0.5 rounded-md border text-[11px] font-medium ${
                          isArchived
                            ? "border-neutral-300 dark:border-neutral-700 bg-neutral-100 dark:bg-neutral-800 text-neutral-600 dark:text-neutral-300"
                            : campaign.status === "active"
                              ? "border-emerald-200 dark:border-emerald-900 bg-emerald-50 dark:bg-emerald-950/40 text-emerald-700 dark:text-emerald-300"
                              : campaign.status === "paused"
                                ? "border-amber-200 dark:border-amber-900 bg-amber-50 dark:bg-amber-950/40 text-amber-700 dark:text-amber-300"
                                : "border-neutral-200 dark:border-neutral-800 bg-neutral-50 dark:bg-neutral-900 text-neutral-700 dark:text-neutral-300"
                        }`}
                      >
                        {isArchived
                          ? labels.readOnlyArchived
                          : CAMPAIGN_STATUS_LABELS[campaign.status][uiLang]}
                      </span>
                      {isPending && (
                        <span className="inline-flex items-center gap-1 text-[10px] text-amber-600 dark:text-amber-400 font-medium">
                          <Clock className="w-3 h-3" />
                          {labels.writeSyncPending}
                        </span>
                      )}
                    </div>
                  </div>

                  {/* Planned Date-Only Schedule (Timezone-safe) */}
                  {(campaign.startDate || campaign.endDate) && (
                    <div className="rounded-lg border border-neutral-100 dark:border-neutral-900 bg-neutral-50/70 dark:bg-neutral-900/50 px-2.5 py-2 flex items-center justify-between gap-2 text-xs">
                      <span className="inline-flex items-center gap-1.5 text-neutral-600 dark:text-neutral-300 font-mono-tabular">
                        <Calendar className="w-3.5 h-3.5 text-neutral-400 shrink-0" />
                        <span>
                          {campaign.startDate
                            ? formatDateOnlyDisplay(campaign.startDate, uiLang)
                            : "—"}
                          {campaign.endDate
                            ? ` -> ${formatDateOnlyDisplay(campaign.endDate, uiLang)}`
                            : ""}
                        </span>
                      </span>
                      <span className="text-[10px] uppercase tracking-wide text-neutral-400 shrink-0">
                        {labels.manualEntry}
                      </span>
                    </div>
                  )}

                  {campaign.goal && (
                    <p className="text-xs font-medium text-neutral-800 dark:text-neutral-200 leading-relaxed break-words">
                      {campaign.goal}
                    </p>
                  )}

                  {campaign.strategyNotes && (
                    <p className="text-xs text-neutral-600 dark:text-neutral-300 leading-relaxed break-words line-clamp-3">
                      {campaign.strategyNotes}
                    </p>
                  )}

                  <div className="text-[11px] text-neutral-400 flex items-center justify-between gap-2 pt-1 border-t border-neutral-100 dark:border-neutral-900">
                    <span>{labels.systemRecord}</span>
                    <span className="font-mono-tabular">
                      {labels.updatedLabel}: {formatSystemTimestamp(campaign.updatedAt, uiLang)}
                    </span>
                  </div>
                </div>

                {/* Action Footer: Edit/Status/Pause/Archive for non-archived, Campaign Delete (permitted by firestore.rules:464) */}
                <div className="pt-2 border-t border-neutral-100 dark:border-neutral-900 flex flex-wrap items-center gap-2">
                  {!isArchived && (
                    <>
                      <button
                        type="button"
                        disabled={actionsDisabled}
                        onClick={() => onEditCampaign(campaign)}
                        className="h-9 px-3 rounded-lg border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-950 hover:bg-neutral-100 dark:hover:bg-neutral-900 text-xs font-medium inline-flex items-center gap-1.5 disabled:opacity-40 cursor-pointer"
                      >
                        <Edit3 className="w-3.5 h-3.5" />
                        <span>{labels.editDetails}</span>
                      </button>

                      <select
                        aria-label={labels.changeStatus}
                        disabled={actionsDisabled}
                        value={campaign.status}
                        onChange={(e) => {
                          const next = e.target.value as CampaignStatus;
                          if (next !== campaign.status) {
                            void handleInlineStatusChange(campaign, next);
                          }
                        }}
                        className="h-9 px-2.5 rounded-lg border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-950 text-xs text-neutral-800 dark:text-neutral-200 disabled:opacity-40"
                      >
                        {NON_ARCHIVED_CAMPAIGN_STATUSES.map((st) => (
                          <option key={st} value={st}>
                            {CAMPAIGN_STATUS_LABELS[st][uiLang]}
                          </option>
                        ))}
                      </select>

                      <button
                        type="button"
                        disabled={actionsDisabled}
                        onClick={() =>
                          void handleInlineStatusChange(
                            campaign,
                            campaign.status === "paused" ? "active" : "paused"
                          )
                        }
                        className="h-9 px-2.5 rounded-lg border border-neutral-200 dark:border-neutral-800 hover:bg-neutral-100 dark:hover:bg-neutral-900 text-xs font-medium inline-flex items-center gap-1 disabled:opacity-40 cursor-pointer"
                      >
                        {campaign.status === "paused" ? (
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

                      {canArchiveRecord(campaign.status) && (
                        <button
                          type="button"
                          disabled={actionsDisabled}
                          onClick={() => {
                            setModalError(null);
                            setModalWriteState("idle");
                            setConfirmState({ kind: "archive", campaign });
                          }}
                          className="h-9 px-2.5 rounded-lg border border-neutral-200 dark:border-neutral-800 hover:bg-neutral-100 dark:hover:bg-neutral-900 text-xs font-medium text-neutral-600 dark:text-neutral-300 inline-flex items-center gap-1 disabled:opacity-40 cursor-pointer"
                        >
                          <Archive className="w-3.5 h-3.5" />
                          <span>{labels.archiveAction}</span>
                        </button>
                      )}
                    </>
                  )}

                  <button
                    type="button"
                    disabled={actionsDisabled}
                    onClick={() => {
                      setModalError(null);
                      setModalWriteState("idle");
                      setConfirmState({ kind: "delete", campaign });
                    }}
                    className="h-9 px-2.5 rounded-lg border border-red-200 dark:border-red-900/70 text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-950/40 text-xs font-medium inline-flex items-center gap-1 ml-auto disabled:opacity-40 cursor-pointer"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                    <span>{labels.deleteCampaignAction}</span>
                  </button>
                </div>
              </article>
            );
          })}
        </div>
      )}

      <ConfirmActionModal
        open={Boolean(confirmState)}
        title={
          confirmState?.kind === "delete"
            ? labels.deleteCampaignConfirmTitle
            : labels.archiveConfirmTitle
        }
        body={
          confirmState?.kind === "delete"
            ? labels.deleteCampaignConfirmBody
            : labels.archiveConfirmBody
        }
        itemName={confirmState?.campaign.title || ""}
        confirmLabel={
          confirmState?.kind === "delete"
            ? labels.deleteCampaignConfirmButton
            : labels.archiveConfirmButton
        }
        tone={confirmState?.kind === "delete" ? "danger" : "archive"}
        writeState={effectiveModalState}
        connectionState={connectionState}
        canWriteNow={effectiveCanWriteNow}
        isWriteBusy={isWriteBusy}
        errorMessage={modalError}
        labels={labels}
        onConfirm={() => void handleConfirmModalAction()}
        onClose={() => {
          setConfirmState(null);
          setModalError(null);
          setModalWriteState("idle");
        }}
      />
    </div>
  );
}
