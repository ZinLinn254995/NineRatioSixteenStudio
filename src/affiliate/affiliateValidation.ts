import { deleteField, type FieldValue } from "firebase/firestore";
import {
  FIELD_LIMITS,
  buildFirestoreQuotaGuidance,
  isValidDocumentId,
  sanitizeBoundedString,
  sanitizeOptionalString,
  sanitizeTags,
  type AffiliateProduct,
  type AffiliateProductStatus,
  type CampaignStatus,
  type ContentLanguage,
  type MarketingCampaign,
  type OwnedFirestoreDoc,
  type OwnerDocumentUpdate,
  type UiLanguage,
} from "../firebase";
import { isDateRangeValid } from "./affiliateDateUtils";
import type { WorkspaceConnectionState, WriteOperationState } from "./affiliateLabels";

export const PRODUCT_EDITABLE_STATUSES: readonly AffiliateProductStatus[] = [
  "researching",
  "shortlisted",
  "active",
  "paused",
  "archived",
] as const;

export const CAMPAIGN_EDITABLE_STATUSES: readonly CampaignStatus[] = [
  "draft",
  "active",
  "paused",
  "completed",
  "archived",
] as const;

export const CONTENT_LANGUAGES: readonly ContentLanguage[] = [
  "th",
  "my",
  "th_my",
] as const;

export function isValidUiLanguage(value: unknown): value is UiLanguage {
  return value === "en" || value === "my" || value === "th";
}

export function normalizeSearchText(value: string): string {
  return value.trim().toLowerCase().normalize("NFC");
}

export function isSafeHttpUrl(url: string): boolean {
  const trimmed = url.trim();
  if (!trimmed) return false;
  try {
    const parsed = new URL(trimmed);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

export function canEditRecord(status: AffiliateProductStatus | CampaignStatus): boolean {
  return status !== "archived";
}

export function canArchiveRecord(status: AffiliateProductStatus | CampaignStatus): boolean {
  return status !== "archived";
}

export function canAttachAffiliateListeners(input: {
  workspaceActive: boolean;
  isConfigured: boolean;
  authReady: boolean;
  isOwner: boolean;
  userUid: string | null | undefined;
  hasOwnerProfile: boolean;
}): boolean {
  return Boolean(
    input.workspaceActive &&
      input.isConfigured &&
      input.authReady &&
      input.isOwner &&
      input.userUid &&
      isValidDocumentId(input.userUid) &&
      input.hasOwnerProfile
  );
}

export function classifyWorkspaceConnectionState(input: {
  browserOnlineHint: boolean;
  bootConnectionStatus: "unconfigured" | "checking" | "connected" | "offline" | "error";
  listenerError: string | null;
  hasSnapshot: boolean;
  fromCache: boolean;
  hasPendingWrites: boolean;
  hasInFlightWrite: boolean;
}): WorkspaceConnectionState {
  if (input.listenerError) {
    const lower = input.listenerError.toLowerCase();
    if (
      lower.includes("the client is offline") ||
      lower.includes("unavailable") ||
      !input.browserOnlineHint
    ) {
      return "offline";
    }
    return "error";
  }

  if (input.hasPendingWrites || input.hasInFlightWrite) {
    return "sync_pending";
  }

  if (!input.browserOnlineHint || input.bootConnectionStatus === "offline") {
    return "offline";
  }

  if (input.bootConnectionStatus === "error") {
    return "error";
  }

  if (input.hasSnapshot) {
    return input.fromCache ? "cached" : "connected";
  }

  return "cached";
}

/**
 * M4: Blocks all new Firestore writes unless connectionState is strictly "connected"
 * (blocks "cached", "offline", "sync_pending", and "error").
 */
export function canStartFirestoreWrite(input: {
  isOwner: boolean;
  hasOwnerProfile: boolean;
  connectionState: WorkspaceConnectionState;
  browserOnlineHint: boolean;
}): boolean {
  if (!input.isOwner || !input.hasOwnerProfile) return false;
  if (!input.browserOnlineHint) return false;
  return input.connectionState === "connected";
}

/**
 * H1: Returns true ONLY when a modal transitions into a new logical session key
 * (e.g., closed -> create, closed -> edit:id, or edit:idA -> edit:idB).
 * Firestore snapshot object-reference updates for the SAME session key return false
 * so user drafts and pendingDocIds are never reset.
 */
export function shouldResetModalDraft(
  prevSessionKey: string | null,
  nextSessionKey: string | null
): boolean {
  return nextSessionKey !== null && prevSessionKey !== nextSessionKey;
}

/**
 * H1: Safely computes a one-time default productId backfill for Campaign create mode
 * ONLY when no productId is currently selected and no write is in progress.
 */
export function resolveCampaignProductBackfill(input: {
  isCreateMode: boolean;
  currentProductId: string;
  writeState: WriteOperationState;
  products: readonly { id: string; status: AffiliateProductStatus }[];
  defaultProductId?: string;
}): string | null {
  if (!input.isCreateMode) return null;
  if (input.currentProductId.trim().length > 0) return null;
  if (input.writeState !== "idle") return null;
  if (input.products.length === 0) return null;

  if (
    input.defaultProductId &&
    input.products.some((p) => p.id === input.defaultProductId)
  ) {
    return input.defaultProductId;
  }
  return (
    input.products.find((p) => p.status !== "archived")?.id ||
    input.products[0]?.id ||
    null
  );
}

export interface LanguageReconciliationInput {
  currentLocalLang: UiLanguage;
  pendingLocalLang: UiLanguage | null;
  lastSyncedServerLang: UiLanguage | null;
  serverLang: UiLanguage | null | undefined;
}

export interface LanguageReconciliationResult {
  nextLocalLang: UiLanguage;
  action: "push_local" | "adopt_server" | "noop";
  nextPendingLocalLang: UiLanguage | null;
  nextLastSyncedServerLang: UiLanguage | null;
}

/**
 * M3: Symmetric ("en" | "my" | "th") & deterministic two-device language reconciliation.
 *
 * Rules:
 * - No unsynced local edit (`pendingLocalLang === null`):
 *   Adopt server-confirmed language symmetrically for all 3 languages ("en", "my", "th").
 * - Unsynced local edit exists (`pendingLocalLang !== null`):
 *   1) If server already equals `pendingLocalLang`, converge cleanly (`noop`, clear pending).
 *   2) If server is still equal to `lastSyncedServerLang` (or no baseline existed yet),
 *      no remote device changed it -> push `pendingLocalLang` to server (`push_local`).
 *   3) If another device changed the server value (`serverLang !== lastSyncedServerLang`
 *      and `serverLang !== pendingLocalLang`), the server-confirmed remote value wins
 *      deterministically (`adopt_server`, clear pending) so both devices converge cleanly.
 */
export function reconcileLanguagePreference(
  input: LanguageReconciliationInput
): LanguageReconciliationResult {
  const { currentLocalLang, pendingLocalLang, lastSyncedServerLang, serverLang } = input;
  if (!isValidUiLanguage(serverLang)) {
    return {
      nextLocalLang: currentLocalLang,
      action: "noop",
      nextPendingLocalLang: pendingLocalLang,
      nextLastSyncedServerLang: lastSyncedServerLang,
    };
  }

  if (pendingLocalLang !== null) {
    if (serverLang === pendingLocalLang) {
      return {
        nextLocalLang: serverLang,
        action: "noop",
        nextPendingLocalLang: null,
        nextLastSyncedServerLang: serverLang,
      };
    }

    if (lastSyncedServerLang === null || serverLang === lastSyncedServerLang) {
      return {
        nextLocalLang: pendingLocalLang,
        action: "push_local",
        nextPendingLocalLang: pendingLocalLang,
        nextLastSyncedServerLang: serverLang,
      };
    }

    // Two-device conflict: another device committed a newer server-confirmed language
    return {
      nextLocalLang: serverLang,
      action: "adopt_server",
      nextPendingLocalLang: null,
      nextLastSyncedServerLang: serverLang,
    };
  }

  if (serverLang !== currentLocalLang) {
    return {
      nextLocalLang: serverLang,
      action: "adopt_server",
      nextPendingLocalLang: null,
      nextLastSyncedServerLang: serverLang,
    };
  }

  return {
    nextLocalLang: currentLocalLang,
    action: "noop",
    nextPendingLocalLang: null,
    nextLastSyncedServerLang: serverLang,
  };
}

/**
 * Checks whether a deterministic pendingDocId already exists in the synced
 * collection snapshot to prevent duplicate creates on retry.
 */
export function hasExistingDocumentWithId(
  docId: string,
  existingIds: readonly string[]
): boolean {
  return existingIds.includes(docId);
}

export interface ProductFormInput {
  name: string;
  category: string;
  tiktokShopUrl: string;
  priceThb: string;
  commissionRatePct: string;
  targetLanguage: ContentLanguage;
  sellingPoints: string;
  complianceNotes: string;
  tagsText: string;
  status: AffiliateProductStatus;
}

export type ProductValidationErrorKey =
  | "errNameRequired"
  | "errInvalidUrl"
  | "errInvalidPrice"
  | "errInvalidCommission";

function parseOptionalBoundedNumber(
  raw: string,
  min: number,
  max: number
): { ok: true; value: number | undefined } | { ok: false } {
  const trimmed = raw.trim();
  if (!trimmed) return { ok: true, value: undefined };
  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed) || parsed < min || parsed > max) {
    return { ok: false };
  }
  return { ok: true, value: parsed };
}

function parseTagsText(raw: string): string[] | undefined {
  const parts = raw
    .split(",")
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
  if (parts.length === 0) return undefined;
  const cleaned = sanitizeTags(parts);
  return cleaned && cleaned.length > 0 ? cleaned : undefined;
}

export function validateProductForm(
  input: ProductFormInput
):
  | {
      ok: true;
      sanitized: {
        name: string;
        category?: string;
        tiktokShopUrl?: string;
        priceThb?: number;
        commissionRatePct?: number;
        targetLanguage: ContentLanguage;
        sellingPoints?: string;
        complianceNotes?: string;
        tags?: string[];
        status: AffiliateProductStatus;
      };
    }
  | { ok: false; errorKey: ProductValidationErrorKey } {
  const name = sanitizeBoundedString(input.name, FIELD_LIMITS.name);
  if (!name) {
    return { ok: false, errorKey: "errNameRequired" };
  }

  const trimmedUrl = input.tiktokShopUrl.trim();
  if (trimmedUrl && !isSafeHttpUrl(trimmedUrl)) {
    return { ok: false, errorKey: "errInvalidUrl" };
  }

  const priceCheck = parseOptionalBoundedNumber(input.priceThb, 0, 10_000_000);
  if (!priceCheck.ok) {
    return { ok: false, errorKey: "errInvalidPrice" };
  }

  const commissionCheck = parseOptionalBoundedNumber(input.commissionRatePct, 0, 100);
  if (!commissionCheck.ok) {
    return { ok: false, errorKey: "errInvalidCommission" };
  }

  return {
    ok: true,
    sanitized: {
      name,
      category: sanitizeOptionalString(input.category, FIELD_LIMITS.category),
      tiktokShopUrl: trimmedUrl
        ? sanitizeBoundedString(trimmedUrl, FIELD_LIMITS.url)
        : undefined,
      priceThb: priceCheck.value,
      commissionRatePct: commissionCheck.value,
      targetLanguage: input.targetLanguage,
      sellingPoints: sanitizeOptionalString(input.sellingPoints, FIELD_LIMITS.sellingPoints),
      complianceNotes: sanitizeOptionalString(
        input.complianceNotes,
        FIELD_LIMITS.complianceNotes
      ),
      tags: parseTagsText(input.tagsText),
      status: input.status,
    },
  };
}

export function buildProductCreatePayload(
  input: ProductFormInput
):
  | { ok: true; payload: Omit<AffiliateProduct, keyof OwnedFirestoreDoc> }
  | { ok: false; errorKey: ProductValidationErrorKey } {
  const checked = validateProductForm(input);
  if (!checked.ok) return checked;
  return { ok: true, payload: checked.sanitized };
}

/**
 * Builds an update payload strictly matching Branch A of firestore.rules for
 * affiliateProducts (NEVER includes `status`, uses `deleteField()` for cleared
 * optional fields so rules validation passes cleanly).
 */
export function buildProductDetailsUpdatePayload(
  input: ProductFormInput,
  existing: Pick<
    AffiliateProduct,
    | "category"
    | "tiktokShopUrl"
    | "priceThb"
    | "commissionRatePct"
    | "sellingPoints"
    | "complianceNotes"
    | "tags"
  >
):
  | { ok: true; payload: OwnerDocumentUpdate<"affiliateProducts"> }
  | { ok: false; errorKey: ProductValidationErrorKey } {
  const checked = validateProductForm(input);
  if (!checked.ok) return checked;

  const s = checked.sanitized;
  const payload: OwnerDocumentUpdate<"affiliateProducts"> = {
    name: s.name,
    targetLanguage: s.targetLanguage,
  };

  const assignOptional = <K extends keyof OwnerDocumentUpdate<"affiliateProducts">>(
    key: K,
    nextVal: OwnerDocumentUpdate<"affiliateProducts">[K] | undefined,
    prevVal: unknown
  ) => {
    if (nextVal !== undefined) {
      payload[key] = nextVal;
    } else if (prevVal !== undefined) {
      payload[key] = deleteField() as FieldValue as OwnerDocumentUpdate<"affiliateProducts">[K];
    }
  };

  assignOptional("category", s.category, existing.category);
  assignOptional("tiktokShopUrl", s.tiktokShopUrl, existing.tiktokShopUrl);
  assignOptional("priceThb", s.priceThb, existing.priceThb);
  assignOptional("commissionRatePct", s.commissionRatePct, existing.commissionRatePct);
  assignOptional("sellingPoints", s.sellingPoints, existing.sellingPoints);
  assignOptional("complianceNotes", s.complianceNotes, existing.complianceNotes);
  assignOptional("tags", s.tags, existing.tags);

  return { ok: true, payload };
}

/**
 * Builds an update payload strictly matching Branch B of firestore.rules for
 * affiliateProducts (`status` + `updatedAt` only).
 */
export function buildProductStatusUpdatePayload(
  status: AffiliateProductStatus
): OwnerDocumentUpdate<"affiliateProducts"> {
  return { status };
}

export interface CampaignFormInput {
  productId: string;
  title: string;
  goal: string;
  targetLanguage: ContentLanguage;
  status: CampaignStatus;
  strategyNotes: string;
  startDate: string;
  endDate: string;
}

export type CampaignValidationErrorKey =
  | "errTitleRequired"
  | "errProductRequired"
  | "errInvalidStartDate"
  | "errInvalidEndDate"
  | "errEndBeforeStart";

export function validateCampaignForm(
  input: CampaignFormInput,
  requireProductId: boolean
):
  | {
      ok: true;
      sanitized: {
        productId: string;
        title: string;
        goal?: string;
        targetLanguage: ContentLanguage;
        status: CampaignStatus;
        strategyNotes?: string;
        startDate?: string;
        endDate?: string;
      };
    }
  | { ok: false; errorKey: CampaignValidationErrorKey } {
  const title = sanitizeBoundedString(input.title, FIELD_LIMITS.title);
  if (!title) {
    return { ok: false, errorKey: "errTitleRequired" };
  }

  const productId = input.productId.trim();
  if (requireProductId && !isValidDocumentId(productId)) {
    return { ok: false, errorKey: "errProductRequired" };
  }

  const dateCheck = isDateRangeValid(input.startDate, input.endDate);
  if (!dateCheck.valid) {
    if (dateCheck.errorKey === "invalidStart") {
      return { ok: false, errorKey: "errInvalidStartDate" };
    }
    if (dateCheck.errorKey === "invalidEnd") {
      return { ok: false, errorKey: "errInvalidEndDate" };
    }
    return { ok: false, errorKey: "errEndBeforeStart" };
  }

  return {
    ok: true,
    sanitized: {
      productId,
      title,
      goal: sanitizeOptionalString(input.goal, FIELD_LIMITS.goal),
      targetLanguage: input.targetLanguage,
      status: input.status,
      strategyNotes: sanitizeOptionalString(input.strategyNotes, FIELD_LIMITS.strategyNotes),
      startDate: sanitizeOptionalString(input.startDate, FIELD_LIMITS.dateString),
      endDate: sanitizeOptionalString(input.endDate, FIELD_LIMITS.dateString),
    },
  };
}

export function buildCampaignCreatePayload(
  input: CampaignFormInput
):
  | { ok: true; payload: Omit<MarketingCampaign, keyof OwnedFirestoreDoc> }
  | { ok: false; errorKey: CampaignValidationErrorKey } {
  const checked = validateCampaignForm(input, true);
  if (!checked.ok) return checked;
  return { ok: true, payload: checked.sanitized };
}

/**
 * Builds an update payload strictly matching Branch A of firestore.rules for
 * marketingCampaigns (NEVER includes `status` or `productId`).
 */
export function buildCampaignDetailsUpdatePayload(
  input: CampaignFormInput,
  existing: Pick<MarketingCampaign, "goal" | "strategyNotes" | "startDate" | "endDate">
):
  | { ok: true; payload: OwnerDocumentUpdate<"marketingCampaigns"> }
  | { ok: false; errorKey: CampaignValidationErrorKey } {
  const checked = validateCampaignForm(input, false);
  if (!checked.ok) return checked;

  const s = checked.sanitized;
  const payload: OwnerDocumentUpdate<"marketingCampaigns"> = {
    title: s.title,
    targetLanguage: s.targetLanguage,
  };

  const assignOptional = <K extends keyof OwnerDocumentUpdate<"marketingCampaigns">>(
    key: K,
    nextVal: OwnerDocumentUpdate<"marketingCampaigns">[K] | undefined,
    prevVal: unknown
  ) => {
    if (nextVal !== undefined) {
      payload[key] = nextVal;
    } else if (prevVal !== undefined) {
      payload[key] = deleteField() as FieldValue as OwnerDocumentUpdate<"marketingCampaigns">[K];
    }
  };

  assignOptional("goal", s.goal, existing.goal);
  assignOptional("strategyNotes", s.strategyNotes, existing.strategyNotes);
  assignOptional("startDate", s.startDate, existing.startDate);
  assignOptional("endDate", s.endDate, existing.endDate);

  return { ok: true, payload };
}

/**
 * Builds an update payload strictly matching Branch B of firestore.rules for
 * marketingCampaigns (`status` + `updatedAt` only).
 */
export function buildCampaignStatusUpdatePayload(
  status: CampaignStatus
): OwnerDocumentUpdate<"marketingCampaigns"> {
  return { status };
}

/**
 * Extracts a clean, user-readable message from structured FirestoreErrorInfo
 * JSON errors or standard Error objects without crashing.
 */
export function parseFirestoreErrorMessage(
  err: unknown,
  projectId?: string | null,
  databaseId?: string | null
): string {
  const quotaGuidance = buildFirestoreQuotaGuidance(
    err,
    projectId || undefined,
    databaseId || undefined
  );
  if (quotaGuidance) return quotaGuidance;

  const raw = err instanceof Error ? err.message : String(err ?? "Unknown Firestore error.");
  try {
    const parsed = JSON.parse(raw) as { error?: string; operationType?: string };
    if (parsed && typeof parsed.error === "string") {
      const innerQuota = buildFirestoreQuotaGuidance(
        parsed.error,
        projectId || undefined,
        databaseId || undefined
      );
      if (innerQuota) return innerQuota;
      return parsed.error;
    }
  } catch {
    // Plain error string
  }
  return raw;
}
