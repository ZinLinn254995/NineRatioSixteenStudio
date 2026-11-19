import { useEffect, useRef, useState } from "react";
import {
  AlertCircle,
  CheckCircle2,
  Clock,
  CloudOff,
  FolderKanban,
  LayoutDashboard,
  Loader2,
  LogIn,
  LogOut,
  Package,
  RefreshCw,
  Video,
  X,
} from "lucide-react";
import {
  useFirebase,
  type AffiliateProduct,
  type MarketingCampaign,
  type UiLanguage,
  type UserProfile,
  type WithId,
} from "../firebase";
import { getAffiliateLabels, type AffiliateUiDictionary } from "./affiliateLabels";
import { isValidUiLanguage, reconcileLanguagePreference } from "./affiliateValidation";
import { AffiliateDashboardView } from "./AffiliateDashboardView";
import { ProductWorkspaceView } from "./ProductWorkspaceView";
import { CampaignWorkspaceView } from "./CampaignWorkspaceView";
import { ProductFormModal } from "./ProductFormModal";
import { CampaignFormModal } from "./CampaignFormModal";
import { useAffiliateWorkspaceData } from "./useAffiliateWorkspaceData";
import type { AffiliateWriteController } from "./useAffiliateWriteController";

type AffiliateTab = "dashboard" | "products" | "campaigns";

const UI_LANG_STORAGE_KEY = "affiliate_ui_lang";
const UI_LANG_META_KEY = "affiliate_ui_lang_meta";

interface UiLanguageMeta {
  pendingLocalLang: UiLanguage | null;
  lastSyncedServerLang: UiLanguage | null;
}

function readInitialUiLang(): UiLanguage {
  if (typeof window === "undefined") return "my";
  try {
    const saved = window.localStorage.getItem(UI_LANG_STORAGE_KEY);
    if (isValidUiLanguage(saved)) {
      return saved;
    }
  } catch {
    // ignore storage errors
  }
  // Approved default: Burmese with English technical terms
  return "my";
}

function readUiLangMeta(): UiLanguageMeta {
  if (typeof window === "undefined") {
    return { pendingLocalLang: null, lastSyncedServerLang: null };
  }
  try {
    const raw = window.localStorage.getItem(UI_LANG_META_KEY);
    if (!raw) return { pendingLocalLang: null, lastSyncedServerLang: null };
    const parsed = JSON.parse(raw) as Partial<UiLanguageMeta>;
    return {
      pendingLocalLang: isValidUiLanguage(parsed.pendingLocalLang)
        ? parsed.pendingLocalLang
        : null,
      lastSyncedServerLang: isValidUiLanguage(parsed.lastSyncedServerLang)
        ? parsed.lastSyncedServerLang
        : null,
    };
  } catch {
    return { pendingLocalLang: null, lastSyncedServerLang: null };
  }
}

function persistUiLangState(lang: UiLanguage, meta: UiLanguageMeta) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(UI_LANG_STORAGE_KEY, lang);
    window.localStorage.setItem(UI_LANG_META_KEY, JSON.stringify(meta));
  } catch {
    // ignore storage errors
  }
}

function resolveWriteErrorText(
  error: string | null | undefined,
  labels: AffiliateUiDictionary
): string {
  if (error && error in labels) {
    return labels[error as keyof AffiliateUiDictionary];
  }
  return error || labels.writeFailed;
}

export type Gate4ViewMode = "ready" | "loading" | "retrying" | "error";

/**
 * Pure Gate 4 state resolver.
 * Guarantees that whenever ownerProfile is null and isProfileLoading is false,
 * Gate 4 ALWAYS renders the recoverable error state (with Retry + Sign Out),
 * even if header authError was dismissed.
 */
export function resolveGate4ViewMode(input: {
  ownerProfile: WithId<UserProfile> | null;
  isProfileLoading: boolean;
  isRetryingProfile: boolean;
}): Gate4ViewMode {
  if (input.ownerProfile) {
    return "ready";
  }
  if (input.isProfileLoading) {
    return input.isRetryingProfile ? "retrying" : "loading";
  }
  return "error";
}

export interface OwnerProfileGateViewProps {
  ownerProfile: WithId<UserProfile> | null;
  isProfileLoading: boolean;
  isRetryingProfile: boolean;
  profileError: string | null;
  authError: string | null;
  labels: AffiliateUiDictionary;
  onRetry: () => void;
  onSignOut: () => void;
}

export function OwnerProfileGateView({
  ownerProfile,
  isProfileLoading,
  isRetryingProfile,
  profileError,
  authError,
  labels,
  onRetry,
  onSignOut,
}: OwnerProfileGateViewProps) {
  const mode = resolveGate4ViewMode({
    ownerProfile,
    isProfileLoading,
    isRetryingProfile,
  });

  if (mode === "ready") {
    return null;
  }

  const detailError = profileError || authError;

  return (
    <main className="flex-1 flex flex-col items-center justify-center px-4 py-12">
      {mode === "error" ? (
        <div
          role="alert"
          data-testid="gate4-profile-error"
          className="max-w-lg w-full rounded-2xl border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-950 p-6 space-y-4 shadow-sm"
        >
          <div className="flex items-start gap-2.5">
            <AlertCircle className="w-5 h-5 text-red-600 dark:text-red-400 shrink-0 mt-0.5" />
            <div className="space-y-1 min-w-0">
              <h1 className="text-base font-bold text-neutral-950 dark:text-neutral-50">
                {labels.profileSyncFailedTitle}
              </h1>
              <p className="text-xs text-neutral-600 dark:text-neutral-400 leading-relaxed">
                {labels.profileSyncFailedDesc}
              </p>
            </div>
          </div>

          {detailError && (
            <div className="p-3 rounded-lg border border-red-200 dark:border-red-900 bg-red-50 dark:bg-red-950/40 text-xs text-red-700 dark:text-red-300 leading-relaxed break-words">
              {detailError}
            </div>
          )}

          <div className="flex flex-col sm:flex-row gap-2.5 pt-1">
            <button
              type="button"
              disabled={isProfileLoading}
              onClick={onRetry}
              className="h-11 px-4 rounded-lg bg-neutral-950 text-white dark:bg-white dark:text-neutral-950 text-xs font-semibold inline-flex items-center justify-center gap-2 disabled:opacity-50 cursor-pointer"
            >
              <RefreshCw className="w-4 h-4" />
              <span>{labels.retry}</span>
            </button>

            <button
              type="button"
              onClick={onSignOut}
              className="h-11 px-4 rounded-lg border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-950 hover:bg-neutral-100 dark:hover:bg-neutral-900 text-xs font-medium text-neutral-700 dark:text-neutral-200 inline-flex items-center justify-center gap-1.5 cursor-pointer"
            >
              <LogOut className="w-3.5 h-3.5" />
              <span>{labels.signOut}</span>
            </button>
          </div>
        </div>
      ) : (
        <div
          data-testid="gate4-profile-loading"
          className="flex flex-col items-center gap-4"
        >
          <div className="flex items-center gap-2 text-xs text-neutral-600 dark:text-neutral-300">
            <Loader2 className="w-4 h-4 animate-spin" />
            <span>{mode === "retrying" ? labels.retryingProfile : labels.syncingProfile}</span>
          </div>
          <button
            type="button"
            onClick={onSignOut}
            className="h-9 px-3.5 rounded-lg border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-950 hover:bg-neutral-100 dark:hover:bg-neutral-900 text-xs font-medium text-neutral-600 dark:text-neutral-300 inline-flex items-center gap-1.5 cursor-pointer"
          >
            <LogOut className="w-3.5 h-3.5" />
            <span>{labels.signOut}</span>
          </button>
        </div>
      )}
    </main>
  );
}

interface AffiliateWorkspaceProps {
  writeController: AffiliateWriteController;
  onSwitchToVideoStudio: () => void;
}

export function AffiliateWorkspace({
  writeController,
  onSwitchToVideoStudio,
}: AffiliateWorkspaceProps) {
  const {
    isConfigured,
    authReady,
    isSigningIn,
    isCheckingConnection,
    isProfileLoading,
    isRetryingProfile,
    user,
    ownerProfile,
    isOwner,
    authError,
    profileError,
    signInWithGoogle,
    signOutOwner,
    retryOwnerProfile,
    refreshOwnerProfile,
    updatePreferredUiLanguage,
  } = useFirebase();

  const [activeTab, setActiveTab] = useState<AffiliateTab>("dashboard");
  const [uiLang, setUiLang] = useState<UiLanguage>(readInitialUiLang);
  const [productModalOpen, setProductModalOpen] = useState(false);
  const [editingProduct, setEditingProduct] = useState<WithId<AffiliateProduct> | null>(null);
  const [campaignModalOpen, setCampaignModalOpen] = useState(false);
  const [editingCampaign, setEditingCampaign] = useState<WithId<MarketingCampaign> | null>(
    null
  );

  const uiLangRef = useRef<UiLanguage>(uiLang);
  uiLangRef.current = uiLang;

  const labels = getAffiliateLabels(uiLang);

  const data = useAffiliateWorkspaceData(true, writeController);

  const userUid = user?.uid ?? null;
  const hasOwnerProfile = Boolean(ownerProfile);

  // M3: Server-confirmed language refresh + symmetric ("en" | "my" | "th") deterministic
  // two-device reconciliation whenever the owner is connected (including reconnects).
  const prevConnectedSyncKeyRef = useRef<string | null>(null);
  const langSyncSeqRef = useRef(0);

  useEffect(() => {
    if (!isOwner || !userUid || !hasOwnerProfile || data.connectionState !== "connected") {
      if (data.connectionState !== "connected") {
        prevConnectedSyncKeyRef.current = null;
      }
      return;
    }

    const syncKey = `${userUid}:connected`;
    if (prevConnectedSyncKeyRef.current === syncKey) {
      return;
    }
    prevConnectedSyncKeyRef.current = syncKey;

    const seq = ++langSyncSeqRef.current;
    let cancelled = false;

    void (async () => {
      try {
        const freshProfile = await refreshOwnerProfile();
        if (cancelled || langSyncSeqRef.current !== seq) return;

        const serverLang = freshProfile?.preferredUiLanguage ?? ownerProfile?.preferredUiLanguage;
        const meta = readUiLangMeta();
        const decision = reconcileLanguagePreference({
          currentLocalLang: uiLangRef.current,
          pendingLocalLang: meta.pendingLocalLang,
          lastSyncedServerLang: meta.lastSyncedServerLang,
          serverLang,
        });

        if (decision.action === "adopt_server") {
          setUiLang(decision.nextLocalLang);
          persistUiLangState(decision.nextLocalLang, {
            pendingLocalLang: decision.nextPendingLocalLang,
            lastSyncedServerLang: decision.nextLastSyncedServerLang,
          });
        } else if (decision.action === "push_local") {
          const langToPush = decision.nextLocalLang;
          try {
            await updatePreferredUiLanguage(langToPush);
            if (cancelled || langSyncSeqRef.current !== seq) return;
            persistUiLangState(langToPush, {
              pendingLocalLang: null,
              lastSyncedServerLang: langToPush,
            });
          } catch {
            // Keep pendingLocalLang intact to retry on next reconnect
          }
        } else {
          persistUiLangState(decision.nextLocalLang, {
            pendingLocalLang: decision.nextPendingLocalLang,
            lastSyncedServerLang: decision.nextLastSyncedServerLang,
          });
        }
      } catch {
        // Server refresh unavailable; allow retry on next connected transition
        if (!cancelled && prevConnectedSyncKeyRef.current === syncKey) {
          prevConnectedSyncKeyRef.current = null;
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [
    isOwner,
    userUid,
    hasOwnerProfile,
    data.connectionState,
    ownerProfile?.preferredUiLanguage,
    refreshOwnerProfile,
    updatePreferredUiLanguage,
  ]);

  const handleChangeUiLang = (nextLang: UiLanguage) => {
    const seq = ++langSyncSeqRef.current;
    const prevMeta = readUiLangMeta();
    const baselineServerLang =
      prevMeta.lastSyncedServerLang ??
      (isValidUiLanguage(ownerProfile?.preferredUiLanguage)
        ? ownerProfile!.preferredUiLanguage
        : null);

    setUiLang(nextLang);
    // Mark as pending local edit until server confirms write
    persistUiLangState(nextLang, {
      pendingLocalLang: nextLang,
      lastSyncedServerLang: baselineServerLang,
    });

    if (isOwner && userUid && hasOwnerProfile && data.canWriteNow) {
      void updatePreferredUiLanguage(nextLang)
        .then(() => {
          if (langSyncSeqRef.current !== seq) return;
          persistUiLangState(nextLang, {
            pendingLocalLang: null,
            lastSyncedServerLang: nextLang,
          });
        })
        .catch(() => {
          // Keep pendingLocalLang in localStorage so reconnect reconciles cleanly
        });
    }
  };

  // Gate 1: Firebase not configured
  if (!isConfigured) {
    return (
      <main className="flex-1 max-w-2xl w-full mx-auto px-4 py-10">
        <div className="rounded-2xl border border-neutral-200 dark:border-neutral-800 bg-neutral-50 dark:bg-neutral-900/50 p-6 space-y-4">
          <div className="flex items-center gap-2 text-neutral-900 dark:text-neutral-100 font-semibold text-sm">
            <CloudOff className="w-4 h-4" />
            <span>{labels.unconfiguredTitle}</span>
          </div>
          <p className="text-xs text-neutral-600 dark:text-neutral-400 leading-relaxed">
            {labels.unconfiguredDesc}
          </p>
          <button
            type="button"
            onClick={onSwitchToVideoStudio}
            className="h-10 px-4 rounded-lg bg-neutral-950 text-white dark:bg-white dark:text-neutral-950 text-xs font-semibold inline-flex items-center gap-1.5 cursor-pointer"
          >
            <Video className="w-3.5 h-3.5" />
            <span>{labels.switchToVideoStudio}</span>
          </button>
        </div>
      </main>
    );
  }

  // Gate 2: Auth initializing
  if (!authReady) {
    return (
      <main className="flex-1 flex items-center justify-center px-4 py-16">
        <div className="flex items-center gap-2 text-xs text-neutral-500 dark:text-neutral-400">
          <Loader2 className="w-4 h-4 animate-spin" />
          <span>{labels.loadingWorkspace}</span>
        </div>
      </main>
    );
  }

  // Gate 3: Not signed in as verified owner
  if (!isOwner || !user) {
    return (
      <main className="flex-1 max-w-lg w-full mx-auto px-4 py-10">
        <div className="rounded-2xl border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-950 p-6 space-y-4 shadow-sm">
          <div className="space-y-1">
            <h1 className="text-base font-bold text-neutral-950 dark:text-neutral-50">
              {labels.signInRequiredTitle}
            </h1>
            <p className="text-xs text-neutral-600 dark:text-neutral-400 leading-relaxed">
              {labels.signInRequiredDesc}
            </p>
          </div>

          {authError && (
            <div className="p-3 rounded-lg border border-red-200 dark:border-red-900 bg-red-50 dark:bg-red-950/40 text-xs text-red-700 dark:text-red-300 leading-relaxed">
              {authError}
            </div>
          )}

          <div className="flex flex-col sm:flex-row gap-2.5 pt-1">
            <button
              type="button"
              disabled={isSigningIn}
              onClick={() => void signInWithGoogle()}
              className="h-11 px-4 rounded-lg bg-neutral-950 text-white dark:bg-white dark:text-neutral-950 text-xs font-semibold inline-flex items-center justify-center gap-2 disabled:opacity-50 cursor-pointer"
            >
              {isSigningIn ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                <LogIn className="w-4 h-4" />
              )}
              <span>{labels.signInWithGoogle}</span>
            </button>

            <button
              type="button"
              onClick={onSwitchToVideoStudio}
              className="h-11 px-4 rounded-lg border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-950 hover:bg-neutral-100 dark:hover:bg-neutral-900 text-xs font-medium inline-flex items-center justify-center gap-1.5 cursor-pointer"
            >
              <Video className="w-3.5 h-3.5" />
              <span>{labels.switchToVideoStudio}</span>
            </button>
          </div>
        </div>
      </main>
    );
  }

  // Gate 4: Owner signed in, waiting for /users/{uid} ownerProfile master gate (D-02 recovery)
  if (!ownerProfile) {
    return (
      <OwnerProfileGateView
        ownerProfile={ownerProfile}
        isProfileLoading={isProfileLoading}
        isRetryingProfile={isRetryingProfile}
        profileError={profileError}
        authError={authError}
        labels={labels}
        onRetry={() => void retryOwnerProfile()}
        onSignOut={() => void signOutOwner()}
      />
    );
  }

  return (
    <div className="flex-1 flex flex-col min-h-0">
      {/* Sub-header: Title, Desktop Tabs & EN | MY | TH Language Switcher */}
      <div className="border-b border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-950">
        <div className="max-w-[1200px] mx-auto px-4 sm:px-6 py-2.5 flex items-center justify-between gap-3">
          <div className="min-w-0">
            <h1 className="text-sm font-bold text-neutral-950 dark:text-neutral-50 truncate">
              {labels.studioTitle}
            </h1>
            <p className="text-[11px] text-neutral-500 dark:text-neutral-400 truncate">
              {labels.studioSubtitle}
            </p>
          </div>

          {/* Desktop Sub-Tabs */}
          <nav
            aria-label="Affiliate Workspace Sections"
            className="hidden md:flex items-center gap-1 p-1 rounded-lg bg-neutral-100 dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-800"
          >
            {(
              [
                { id: "dashboard", label: labels.navDashboard, Icon: LayoutDashboard },
                { id: "products", label: labels.navProducts, Icon: Package },
                { id: "campaigns", label: labels.navCampaigns, Icon: FolderKanban },
              ] as const
            ).map(({ id, label, Icon }) => (
              <button
                key={id}
                type="button"
                onClick={() => setActiveTab(id)}
                className={`h-8 px-3 rounded-md text-xs font-medium inline-flex items-center gap-1.5 transition-colors cursor-pointer ${
                  activeTab === id
                    ? "bg-white dark:bg-neutral-950 text-neutral-950 dark:text-white shadow-xs"
                    : "text-neutral-600 dark:text-neutral-400 hover:text-neutral-950 dark:hover:text-white"
                }`}
              >
                <Icon className="w-3.5 h-3.5" />
                <span>{label}</span>
              </button>
            ))}
          </nav>

          {/* Compact EN | MY | TH Switcher */}
          <div
            role="group"
            aria-label="Interface language"
            className="inline-flex items-center p-0.5 rounded-lg border border-neutral-200 dark:border-neutral-800 bg-neutral-100 dark:bg-neutral-900 shrink-0"
          >
            {(["en", "my", "th"] as const).map((lang) => (
              <button
                key={lang}
                type="button"
                onClick={() => handleChangeUiLang(lang)}
                className={`h-7 px-2 rounded-md text-[11px] font-semibold uppercase transition-colors cursor-pointer ${
                  uiLang === lang
                    ? "bg-white dark:bg-neutral-950 text-neutral-950 dark:text-white shadow-xs"
                    : "text-neutral-500 dark:text-neutral-400 hover:text-neutral-900 dark:hover:text-white"
                }`}
              >
                {lang}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Main Content Area (with Android bottom-nav clearance) */}
      <main className="flex-1 max-w-[1200px] w-full mx-auto px-4 sm:px-6 py-4 pb-20 md:pb-8 space-y-4">
        {/* Connection & Cache Status Banners */}
        {data.connectionState === "offline" && (
          <div className="p-3 rounded-xl border border-amber-300 dark:border-amber-800 bg-amber-50 dark:bg-amber-950/40 text-xs text-amber-800 dark:text-amber-200 flex items-start justify-between gap-3 leading-relaxed">
            <div className="flex items-start gap-2">
              <CloudOff className="w-4 h-4 shrink-0 mt-0.5" />
              <span>{labels.connOfflineBanner}</span>
            </div>
            <button
              type="button"
              disabled={isCheckingConnection}
              onClick={data.retryConnection}
              className="h-7 px-2.5 rounded-md border border-amber-300 dark:border-amber-700 text-[11px] font-medium shrink-0 inline-flex items-center gap-1 disabled:opacity-50 cursor-pointer"
            >
              <RefreshCw className={`w-3 h-3 ${isCheckingConnection ? "animate-spin" : ""}`} />
              <span>{labels.retry}</span>
            </button>
          </div>
        )}

        {data.connectionState === "cached" && (
          <div className="p-3 rounded-xl border border-neutral-200 dark:border-neutral-800 bg-neutral-50 dark:bg-neutral-900/60 text-xs text-neutral-700 dark:text-neutral-300 flex items-start gap-2 leading-relaxed">
            <Clock className="w-4 h-4 shrink-0 mt-0.5 text-neutral-400" />
            <span>{labels.connCachedBanner}</span>
          </div>
        )}

        {data.connectionState === "sync_pending" && (
          <div className="p-3 rounded-xl border border-amber-300 dark:border-amber-800 bg-amber-50 dark:bg-amber-950/40 text-xs text-amber-800 dark:text-amber-200 flex items-start gap-2 leading-relaxed">
            <Clock className="w-4 h-4 shrink-0 mt-0.5" />
            <span>{labels.connSyncPendingBanner}</span>
          </div>
        )}

        {data.connectionState === "error" && (
          <div className="p-3 rounded-xl border border-red-200 dark:border-red-900 bg-red-50 dark:bg-red-950/40 text-xs text-red-700 dark:text-red-300 flex items-start justify-between gap-3 leading-relaxed">
            <div className="flex items-start gap-2 min-w-0">
              <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
              <span className="break-words">
                {data.listenerError || labels.connError}
              </span>
            </div>
            <button
              type="button"
              disabled={isCheckingConnection}
              onClick={data.retryConnection}
              className="h-7 px-2.5 rounded-md border border-red-300 dark:border-red-800 text-[11px] font-medium shrink-0 inline-flex items-center gap-1 disabled:opacity-50 cursor-pointer"
            >
              <RefreshCw className={`w-3 h-3 ${isCheckingConnection ? "animate-spin" : ""}`} />
              <span>{labels.retry}</span>
            </button>
          </div>
        )}

        {/* Persistent App-Level 4-State Write Feedback Strip (Survives modal close & workspace switches) */}
        {data.writeState !== "idle" && (
          <div
            role={data.writeState === "failed" ? "alert" : "status"}
            className={`px-3 py-2.5 rounded-lg border text-xs flex items-start justify-between gap-2 leading-relaxed ${
              data.writeState === "saved"
                ? "border-emerald-200 dark:border-emerald-900 bg-emerald-50 dark:bg-emerald-950/40 text-emerald-700 dark:text-emerald-300"
                : data.writeState === "failed"
                  ? "border-red-200 dark:border-red-900 bg-red-50 dark:bg-red-950/40 text-red-700 dark:text-red-300"
                  : "border-amber-200 dark:border-amber-900 bg-amber-50 dark:bg-amber-950/40 text-amber-800 dark:text-amber-200"
            }`}
          >
            <div className="flex items-start gap-2 min-w-0">
              {data.writeState === "saving" && (
                <Loader2 className="w-3.5 h-3.5 animate-spin shrink-0 mt-0.5" />
              )}
              {data.writeState === "sync_pending" && (
                <Clock className="w-3.5 h-3.5 shrink-0 mt-0.5" />
              )}
              {data.writeState === "saved" && (
                <CheckCircle2 className="w-3.5 h-3.5 shrink-0 mt-0.5" />
              )}
              {data.writeState === "failed" && (
                <AlertCircle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
              )}
              <span className="break-words">
                {data.writeState === "saving"
                  ? labels.writeSaving
                  : data.writeState === "sync_pending"
                    ? labels.writeSyncPendingWarning
                    : data.writeState === "saved"
                      ? labels.writeSaved
                      : resolveWriteErrorText(data.writeError, labels)}
              </span>
            </div>

            {(data.writeState === "saved" || data.writeState === "failed") && (
              <button
                type="button"
                onClick={data.clearWriteTracker}
                aria-label={labels.dismiss}
                className="p-0.5 opacity-70 hover:opacity-100 cursor-pointer shrink-0"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            )}
          </div>
        )}

        {/* Loading or Active Sub-View */}
        {data.isLoading ? (
          <div className="py-14 flex items-center justify-center gap-2 text-xs text-neutral-500 dark:text-neutral-400">
            <Loader2 className="w-4 h-4 animate-spin" />
            <span>{labels.loadingWorkspace}</span>
          </div>
        ) : activeTab === "dashboard" ? (
          <AffiliateDashboardView
            ownerEmail={user.email || ownerProfile.email}
            connectionState={data.connectionState}
            products={data.products}
            campaigns={data.campaigns}
            pendingDocIds={data.pendingDocIds}
            uiLang={uiLang}
            labels={labels}
            canWriteNow={data.canWriteNow && !data.isWriteBusy}
            onAddProduct={() => {
              setEditingProduct(null);
              setProductModalOpen(true);
            }}
            onNewCampaign={() => {
              setEditingCampaign(null);
              setCampaignModalOpen(true);
            }}
            onNavigateTab={(tab) => setActiveTab(tab)}
            onSwitchToVideoStudio={onSwitchToVideoStudio}
          />
        ) : activeTab === "products" ? (
          <ProductWorkspaceView
            products={data.products}
            campaigns={data.campaigns}
            pendingDocIds={data.pendingDocIds}
            uiLang={uiLang}
            labels={labels}
            connectionState={data.connectionState}
            canWriteNow={data.canWriteNow}
            isWriteBusy={data.isWriteBusy}
            writeState={data.writeState}
            writeDocId={data.writeDocId}
            onAddProduct={() => {
              setEditingProduct(null);
              setProductModalOpen(true);
            }}
            onEditProduct={(product) => {
              setEditingProduct(product);
              setProductModalOpen(true);
            }}
            onUpdateStatus={data.updateProductStatus}
          />
        ) : (
          <CampaignWorkspaceView
            campaigns={data.campaigns}
            products={data.products}
            pendingDocIds={data.pendingDocIds}
            uiLang={uiLang}
            labels={labels}
            connectionState={data.connectionState}
            canWriteNow={data.canWriteNow}
            isWriteBusy={data.isWriteBusy}
            writeState={data.writeState}
            writeDocId={data.writeDocId}
            onNewCampaign={() => {
              setEditingCampaign(null);
              setCampaignModalOpen(true);
            }}
            onEditCampaign={(campaign) => {
              setEditingCampaign(campaign);
              setCampaignModalOpen(true);
            }}
            onUpdateStatus={data.updateCampaignStatus}
            onDeleteCampaign={data.deleteCampaign}
          />
        )}
      </main>

      {/* Android Mobile Fixed Bottom Navigation Bar */}
      <nav
        aria-label="Affiliate Mobile Navigation"
        className="md:hidden fixed bottom-0 inset-x-0 z-40 border-t border-neutral-200 dark:border-neutral-800 bg-white/95 dark:bg-neutral-950/95 backdrop-blur-sm pb-[env(safe-area-inset-bottom)]"
      >
        <div className="grid grid-cols-3 h-14">
          {(
            [
              { id: "dashboard", label: labels.navDashboard, Icon: LayoutDashboard },
              { id: "products", label: labels.navProducts, Icon: Package },
              { id: "campaigns", label: labels.navCampaigns, Icon: FolderKanban },
            ] as const
          ).map(({ id, label, Icon }) => {
            const active = activeTab === id;
            return (
              <button
                key={id}
                type="button"
                onClick={() => setActiveTab(id)}
                className={`flex flex-col items-center justify-center gap-0.5 text-[11px] font-medium cursor-pointer transition-colors ${
                  active
                    ? "text-neutral-950 dark:text-white font-semibold"
                    : "text-neutral-500 dark:text-neutral-400"
                }`}
              >
                <Icon className="w-4 h-4" />
                <span>{label}</span>
              </button>
            );
          })}
        </div>
      </nav>

      {/* Modals */}
      <ProductFormModal
        open={productModalOpen}
        editingProduct={editingProduct}
        pendingCreateDocId={data.pendingCreateDocIds.product}
        uiLang={uiLang}
        labels={labels}
        connectionState={data.connectionState}
        canWriteNow={data.canWriteNow}
        isWriteBusy={data.isWriteBusy}
        writeState={data.writeState}
        writeDocId={data.writeDocId}
        writeError={data.writeError}
        onEnsurePendingCreateDocId={() => data.allocatePendingCreateDocId("product")}
        onDiscardPendingCreateDocId={() => data.discardPendingCreateDocId("product")}
        onCreate={data.createProduct}
        onUpdateDetails={data.updateProductDetails}
        onClose={() => {
          setProductModalOpen(false);
          setEditingProduct(null);
        }}
      />

      <CampaignFormModal
        open={campaignModalOpen}
        editingCampaign={editingCampaign}
        pendingCreateDocId={data.pendingCreateDocIds.campaign}
        products={data.products}
        uiLang={uiLang}
        labels={labels}
        connectionState={data.connectionState}
        canWriteNow={data.canWriteNow}
        isWriteBusy={data.isWriteBusy}
        writeState={data.writeState}
        writeDocId={data.writeDocId}
        writeError={data.writeError}
        onEnsurePendingCreateDocId={() => data.allocatePendingCreateDocId("campaign")}
        onDiscardPendingCreateDocId={() => data.discardPendingCreateDocId("campaign")}
        onCreate={data.createCampaign}
        onUpdateDetails={data.updateCampaignDetails}
        onClose={() => {
          setCampaignModalOpen(false);
          setEditingCampaign(null);
        }}
      />
    </div>
  );
}
