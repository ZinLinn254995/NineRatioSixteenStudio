import {
  ArrowRight,
  Calendar,
  FolderKanban,
  Package,
  Plus,
  ShieldCheck,
  Video,
} from "lucide-react";
import type {
  AffiliateProduct,
  MarketingCampaign,
  UiLanguage,
  WithId,
} from "../firebase";
import {
  compareDateOnly,
  formatDateOnlyDisplay,
  formatSystemTimestamp,
  getLocalTodayDateOnly,
} from "./affiliateDateUtils";
import {
  CAMPAIGN_STATUS_LABELS,
  CONTENT_LANGUAGE_LABELS,
  PRODUCT_STATUS_LABELS,
  type AffiliateUiDictionary,
  type WorkspaceConnectionState,
} from "./affiliateLabels";

interface AffiliateDashboardViewProps {
  ownerEmail: string;
  connectionState: WorkspaceConnectionState;
  products: WithId<AffiliateProduct>[];
  campaigns: WithId<MarketingCampaign>[];
  pendingDocIds: readonly string[];
  uiLang: UiLanguage;
  labels: AffiliateUiDictionary;
  canWriteNow: boolean;
  onAddProduct: () => void;
  onNewCampaign: () => void;
  onNavigateTab: (tab: "products" | "campaigns") => void;
  onSwitchToVideoStudio: () => void;
}

function getConnectionBadgeStyle(state: WorkspaceConnectionState): string {
  switch (state) {
    case "connected":
      return "border-emerald-200 dark:border-emerald-900 bg-emerald-50 dark:bg-emerald-950/40 text-emerald-700 dark:text-emerald-300";
    case "sync_pending":
      return "border-amber-200 dark:border-amber-900 bg-amber-50 dark:bg-amber-950/40 text-amber-700 dark:text-amber-300";
    case "cached":
      return "border-neutral-300 dark:border-neutral-700 bg-neutral-100 dark:bg-neutral-900 text-neutral-700 dark:text-neutral-300";
    case "offline":
      return "border-amber-300 dark:border-amber-800 bg-amber-50 dark:bg-amber-950/50 text-amber-800 dark:text-amber-200";
    case "error":
      return "border-red-200 dark:border-red-900 bg-red-50 dark:bg-red-950/40 text-red-700 dark:text-red-300";
  }
}

export function AffiliateDashboardView({
  ownerEmail,
  connectionState,
  products,
  campaigns,
  pendingDocIds,
  uiLang,
  labels,
  canWriteNow,
  onAddProduct,
  onNewCampaign,
  onNavigateTab,
  onSwitchToVideoStudio,
}: AffiliateDashboardViewProps) {
  const productById = new Map(products.map((p) => [p.id, p]));
  const todayYmd = getLocalTodayDateOnly();

  const productCounts = {
    total: products.length,
    active: products.filter((p) => p.status === "active").length,
    shortlisted: products.filter((p) => p.status === "shortlisted").length,
    researching: products.filter((p) => p.status === "researching").length,
    paused: products.filter((p) => p.status === "paused").length,
    archived: products.filter((p) => p.status === "archived").length,
  };

  const campaignCounts = {
    total: campaigns.length,
    active: campaigns.filter((c) => c.status === "active").length,
    draft: campaigns.filter((c) => c.status === "draft").length,
    paused: campaigns.filter((c) => c.status === "paused").length,
    completed: campaigns.filter((c) => c.status === "completed").length,
    archived: campaigns.filter((c) => c.status === "archived").length,
  };

  // Pure date-only string sorting/filtering (immune to Thailand UTC+7 shifts)
  const upcomingCampaigns = campaigns
    .filter((c) => {
      if (c.status === "archived" || c.status === "completed") return false;
      const anchor = c.startDate || c.endDate;
      if (!anchor) return false;
      return compareDateOnly(c.endDate || anchor, todayYmd) >= 0;
    })
    .sort((a, b) =>
      compareDateOnly(a.startDate || a.endDate || "9999-12-31", b.startDate || b.endDate || "9999-12-31")
    )
    .slice(0, 5);

  const recentProducts = products.slice(0, 3);
  const recentCampaigns = campaigns.slice(0, 3);

  const connectionLabel =
    connectionState === "connected"
      ? labels.connConnected
      : connectionState === "sync_pending"
        ? labels.connSyncPending
        : connectionState === "cached"
          ? labels.connCached
          : connectionState === "offline"
            ? labels.connOffline
            : labels.connError;

  return (
    <div className="space-y-5">
      {/* Authenticated Owner & Connection/Cache Status Strip (No fabricated Last Synced) */}
      <section className="rounded-xl border border-neutral-200 dark:border-neutral-800 bg-neutral-50/70 dark:bg-neutral-900/50 p-4 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div className="min-w-0 space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-neutral-900 dark:text-neutral-100">
              <ShieldCheck className="w-4 h-4 text-emerald-600 dark:text-emerald-400 shrink-0" />
              {labels.authenticatedOwner}
            </span>
            <span
              className={`px-2 py-0.5 rounded-md border text-[11px] font-medium ${getConnectionBadgeStyle(
                connectionState
              )}`}
            >
              {connectionLabel}
            </span>
          </div>
          <p className="text-xs text-neutral-500 dark:text-neutral-400 truncate">{ownerEmail}</p>
        </div>

        <button
          type="button"
          onClick={onSwitchToVideoStudio}
          className="h-10 px-3.5 rounded-lg border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-950 hover:bg-neutral-100 dark:hover:bg-neutral-900 text-xs font-medium inline-flex items-center justify-center gap-1.5 shrink-0 cursor-pointer transition-colors"
        >
          <Video className="w-3.5 h-3.5" />
          <span>{labels.switchToVideoStudio}</span>
        </button>
      </section>

      {/* Quick Actions */}
      <section className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
        <button
          type="button"
          disabled={!canWriteNow}
          onClick={onAddProduct}
          className="h-11 px-4 rounded-xl bg-neutral-950 text-white dark:bg-white dark:text-neutral-950 text-xs font-semibold flex items-center justify-center gap-2 disabled:opacity-40 hover:opacity-90 transition-opacity cursor-pointer"
        >
          <Plus className="w-4 h-4" />
          <span>{labels.quickAddProduct}</span>
        </button>
        <button
          type="button"
          disabled={!canWriteNow || products.length === 0}
          onClick={onNewCampaign}
          title={products.length === 0 ? labels.needProductForCampaignHint : undefined}
          className="h-11 px-4 rounded-xl border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-950 hover:bg-neutral-100 dark:hover:bg-neutral-900 text-xs font-semibold flex items-center justify-center gap-2 disabled:opacity-40 cursor-pointer transition-colors"
        >
          <Plus className="w-4 h-4" />
          <span>{labels.quickNewCampaign}</span>
        </button>
      </section>

      {products.length === 0 && (
        <p className="text-xs text-neutral-500 dark:text-neutral-400 leading-relaxed">
          {labels.needProductForCampaignHint}
        </p>
      )}

      {/* Real Saved Record Counters ONLY (Zero Fake Analytics/Sales) */}
      <section className="space-y-2.5">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div className="rounded-xl border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-950 p-4 space-y-3">
            <div className="flex items-center justify-between">
              <span className="text-xs font-medium text-neutral-500 dark:text-neutral-400 flex items-center gap-1.5">
                <Package className="w-3.5 h-3.5" />
                {labels.savedProductsLabel}
              </span>
              <span className="text-[10px] font-medium uppercase tracking-wide text-neutral-400">
                {labels.systemRecord}
              </span>
            </div>
            <div className="text-2xl font-bold font-mono-tabular text-neutral-950 dark:text-neutral-50">
              {productCounts.total}
            </div>
            <div className="flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-neutral-500 dark:text-neutral-400 font-mono-tabular">
              <span>
                {PRODUCT_STATUS_LABELS.active[uiLang]}: {productCounts.active}
              </span>
              <span>
                {PRODUCT_STATUS_LABELS.shortlisted[uiLang]}: {productCounts.shortlisted}
              </span>
              <span>
                {PRODUCT_STATUS_LABELS.researching[uiLang]}: {productCounts.researching}
              </span>
              <span>
                {PRODUCT_STATUS_LABELS.paused[uiLang]}: {productCounts.paused}
              </span>
              <span>
                {PRODUCT_STATUS_LABELS.archived[uiLang]}: {productCounts.archived}
              </span>
            </div>
          </div>

          <div className="rounded-xl border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-950 p-4 space-y-3">
            <div className="flex items-center justify-between">
              <span className="text-xs font-medium text-neutral-500 dark:text-neutral-400 flex items-center gap-1.5">
                <FolderKanban className="w-3.5 h-3.5" />
                {labels.savedCampaignsLabel}
              </span>
              <span className="text-[10px] font-medium uppercase tracking-wide text-neutral-400">
                {labels.systemRecord}
              </span>
            </div>
            <div className="text-2xl font-bold font-mono-tabular text-neutral-950 dark:text-neutral-50">
              {campaignCounts.total}
            </div>
            <div className="flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-neutral-500 dark:text-neutral-400 font-mono-tabular">
              <span>
                {CAMPAIGN_STATUS_LABELS.active[uiLang]}: {campaignCounts.active}
              </span>
              <span>
                {CAMPAIGN_STATUS_LABELS.draft[uiLang]}: {campaignCounts.draft}
              </span>
              <span>
                {CAMPAIGN_STATUS_LABELS.paused[uiLang]}: {campaignCounts.paused}
              </span>
              <span>
                {CAMPAIGN_STATUS_LABELS.completed[uiLang]}: {campaignCounts.completed}
              </span>
              <span>
                {CAMPAIGN_STATUS_LABELS.archived[uiLang]}: {campaignCounts.archived}
              </span>
            </div>
          </div>
        </div>

        <p className="text-[11px] text-neutral-500 dark:text-neutral-400 leading-relaxed">
          {labels.savedRecordsNote}
        </p>
      </section>

      {/* Upcoming Planned Publishing Dates */}
      <section className="rounded-xl border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-950 p-4 space-y-3">
        <div className="flex items-center justify-between gap-2">
          <h2 className="text-sm font-semibold text-neutral-950 dark:text-neutral-50 flex items-center gap-2">
            <Calendar className="w-4 h-4 text-neutral-500" />
            <span>{labels.upcomingDatesTitle}</span>
          </h2>
          <button
            type="button"
            onClick={() => onNavigateTab("campaigns")}
            className="text-xs font-medium text-neutral-500 hover:text-neutral-950 dark:hover:text-white inline-flex items-center gap-1 cursor-pointer"
          >
            <span>{labels.viewAll}</span>
            <ArrowRight className="w-3.5 h-3.5" />
          </button>
        </div>

        {upcomingCampaigns.length === 0 ? (
          <p className="text-xs text-neutral-500 dark:text-neutral-400 leading-relaxed">
            {labels.upcomingDatesEmpty}
          </p>
        ) : (
          <div className="divide-y divide-neutral-100 dark:divide-neutral-900">
            {upcomingCampaigns.map((c) => {
              const prod = productById.get(c.productId);
              return (
                <div
                  key={c.id}
                  className="py-2.5 first:pt-0 last:pb-0 flex flex-col sm:flex-row sm:items-center justify-between gap-1.5"
                >
                  <div className="min-w-0">
                    <div className="text-xs font-semibold text-neutral-900 dark:text-neutral-100 break-words leading-relaxed">
                      {c.title}
                    </div>
                    <div className="text-[11px] text-neutral-500 dark:text-neutral-400 truncate">
                      {prod ? prod.name : labels.missingLinkedProduct} ·{" "}
                      {CAMPAIGN_STATUS_LABELS[c.status][uiLang]}
                    </div>
                  </div>
                  <div className="text-xs font-mono-tabular text-neutral-700 dark:text-neutral-300 shrink-0">
                    {c.startDate ? formatDateOnlyDisplay(c.startDate, uiLang) : "—"}
                    {c.endDate ? ` -> ${formatDateOnlyDisplay(c.endDate, uiLang)}` : ""}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </section>

      {/* Recent Saved Products & Campaigns */}
      <section className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div className="rounded-xl border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-950 p-4 space-y-3">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold text-neutral-950 dark:text-neutral-50">
              {labels.recentProductsTitle}
            </h2>
            <button
              type="button"
              onClick={() => onNavigateTab("products")}
              className="text-xs font-medium text-neutral-500 hover:text-neutral-950 dark:hover:text-white inline-flex items-center gap-1 cursor-pointer"
            >
              <span>{labels.viewAll}</span>
              <ArrowRight className="w-3.5 h-3.5" />
            </button>
          </div>

          {recentProducts.length === 0 ? (
            <p className="text-xs text-neutral-500 dark:text-neutral-400 leading-relaxed">
              {labels.noProductsYet}
            </p>
          ) : (
            <div className="space-y-2.5">
              {recentProducts.map((p) => (
                <div
                  key={p.id}
                  className="p-3 rounded-lg border border-neutral-100 dark:border-neutral-900 bg-neutral-50/70 dark:bg-neutral-900/40 space-y-1"
                >
                  <div className="flex items-start justify-between gap-2">
                    <span className="text-xs font-semibold text-neutral-900 dark:text-neutral-100 break-words leading-relaxed">
                      {p.name}
                    </span>
                    <span className="text-[10px] px-1.5 py-0.5 rounded border border-neutral-200 dark:border-neutral-700 text-neutral-600 dark:text-neutral-300 shrink-0">
                      {pendingDocIds.includes(p.id)
                        ? labels.writeSyncPending
                        : PRODUCT_STATUS_LABELS[p.status][uiLang]}
                    </span>
                  </div>
                  <div className="text-[11px] text-neutral-500 dark:text-neutral-400 flex flex-wrap gap-x-2 gap-y-0.5">
                    <span>{CONTENT_LANGUAGE_LABELS[p.targetLanguage]}</span>
                    {p.priceThb !== undefined && (
                      <span className="font-mono-tabular">฿{p.priceThb.toLocaleString()}</span>
                    )}
                    {p.commissionRatePct !== undefined && (
                      <span className="font-mono-tabular">{p.commissionRatePct}%</span>
                    )}
                    <span>
                      · {labels.updatedLabel}: {formatSystemTimestamp(p.updatedAt, uiLang)}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="rounded-xl border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-950 p-4 space-y-3">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold text-neutral-950 dark:text-neutral-50">
              {labels.recentCampaignsTitle}
            </h2>
            <button
              type="button"
              onClick={() => onNavigateTab("campaigns")}
              className="text-xs font-medium text-neutral-500 hover:text-neutral-950 dark:hover:text-white inline-flex items-center gap-1 cursor-pointer"
            >
              <span>{labels.viewAll}</span>
              <ArrowRight className="w-3.5 h-3.5" />
            </button>
          </div>

          {recentCampaigns.length === 0 ? (
            <p className="text-xs text-neutral-500 dark:text-neutral-400 leading-relaxed">
              {labels.noCampaignsYet}
            </p>
          ) : (
            <div className="space-y-2.5">
              {recentCampaigns.map((c) => {
                const prod = productById.get(c.productId);
                return (
                  <div
                    key={c.id}
                    className="p-3 rounded-lg border border-neutral-100 dark:border-neutral-900 bg-neutral-50/70 dark:bg-neutral-900/40 space-y-1"
                  >
                    <div className="flex items-start justify-between gap-2">
                      <span className="text-xs font-semibold text-neutral-900 dark:text-neutral-100 break-words leading-relaxed">
                        {c.title}
                      </span>
                      <span className="text-[10px] px-1.5 py-0.5 rounded border border-neutral-200 dark:border-neutral-700 text-neutral-600 dark:text-neutral-300 shrink-0">
                        {pendingDocIds.includes(c.id)
                          ? labels.writeSyncPending
                          : CAMPAIGN_STATUS_LABELS[c.status][uiLang]}
                      </span>
                    </div>
                    <div className="text-[11px] text-neutral-500 dark:text-neutral-400 flex flex-wrap gap-x-2 gap-y-0.5">
                      <span className="truncate max-w-[180px]">
                        {prod ? prod.name : labels.missingLinkedProduct}
                      </span>
                      <span>· {CONTENT_LANGUAGE_LABELS[c.targetLanguage]}</span>
                      <span>
                        · {labels.updatedLabel}: {formatSystemTimestamp(c.updatedAt, uiLang)}
                      </span>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </section>
    </div>
  );
}
