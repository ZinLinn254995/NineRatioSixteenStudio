import { useEffect, useMemo, useRef, useState } from "react";
import {
  createOwnerDocument,
  deleteOwnerDocument,
  generateFirestoreDocId,
  updateOwnerDocument,
  useFirebase,
  type AffiliateProduct,
  type AffiliateProductStatus,
  type CampaignStatus,
  type FirebaseConnectionStatus,
  type MarketingCampaign,
  type OwnerCollectionKey,
  type OwnerCollectionMap,
  type OwnerDocumentUpdate,
  type OwnedFirestoreDoc,
  type WithId,
} from "../firebase";
import { getOwnerDocumentFromServer } from "../firebase/firestoreService";
import type { WorkspaceConnectionState, WriteOperationState } from "./affiliateLabels";
import {
  buildCampaignCreatePayload,
  buildCampaignDetailsUpdatePayload,
  buildCampaignStatusUpdatePayload,
  buildProductCreatePayload,
  buildProductDetailsUpdatePayload,
  buildProductStatusUpdatePayload,
  canEditRecord,
  canStartFirestoreWrite,
  parseFirestoreErrorMessage,
  type CampaignFormInput,
  type ProductFormInput,
} from "./affiliateValidation";

export const SYNC_PENDING_GRACE_MS = 2500;

export type AffiliateWriteOperationType =
  | "create_product"
  | "update_product_details"
  | "update_product_status"
  | "create_campaign"
  | "update_campaign_details"
  | "update_campaign_status"
  | "delete_campaign";

export interface AffiliateWriteTracker {
  state: WriteOperationState;
  docId: string | null;
  operationId: number | null;
  operationType: AffiliateWriteOperationType | null;
  error: string | null;
  ownerUid: string | null;
}

export interface PendingCreateDocIds {
  product: string | null;
  campaign: string | null;
}

export interface AffiliateWriteResult {
  ok: boolean;
  docId?: string;
  error?: string;
  reconciledExisting?: boolean;
}

export interface AffiliateWriteWorkspaceContext {
  connectionState: WorkspaceConnectionState;
  browserOnlineHint: boolean;
  bootConnectionStatus?: FirebaseConnectionStatus;
  pendingDocIds: readonly string[];
  snapshotHasPendingWrites: boolean;
}

export interface AffiliateWriteControllerSnapshot {
  tracker: AffiliateWriteTracker;
  pendingCreateDocIds: PendingCreateDocIds;
  sessionGeneration: number;
  ownerUid: string | null;
}

export interface AffiliateWriteControllerDeps {
  createOwnerDocument: <K extends OwnerCollectionKey>(
    col: K,
    data: Omit<OwnerCollectionMap[K], keyof OwnedFirestoreDoc>,
    customId?: string,
    expectedOwnerUid?: string
  ) => Promise<string>;
  updateOwnerDocument: <K extends OwnerCollectionKey>(
    col: K,
    docId: string,
    updates: OwnerDocumentUpdate<K>,
    expectedOwnerUid?: string
  ) => Promise<void>;
  deleteOwnerDocument: (
    col: "marketingCampaigns",
    docId: string,
    expectedOwnerUid?: string
  ) => Promise<void>;
  getOwnerDocumentFromServer: <K extends OwnerCollectionKey>(
    col: K,
    docId: string,
    expectedOwnerUid?: string
  ) => Promise<WithId<OwnerCollectionMap[K]> | null>;
  generateDocId: (prefix: string) => string;
  projectId?: string | null;
  databaseId?: string | null;
  syncPendingGraceMs?: number;
}

interface ActiveWriteHandle {
  docId: string;
  operationId: number;
  operationType: AffiliateWriteOperationType;
  sessionGeneration: number;
  ownerUid: string;
}

interface OwnerSessionState {
  ownerUid: string | null;
  isOwner: boolean;
  hasOwnerProfile: boolean;
}

/**
 * Pure, testable App-level Affiliate write controller core.
 *
 * Guarantees:
 * - H2: Survives modal dismissal and Video <-> Affiliate workspace switches.
 * - Owner Session Isolation: Tracks owner UID + monotonic sessionGeneration so
 *   stale async continuations from a previous session can never mutate state.
 * - Duplicate-Safe Create Retry: Reuses a controller-owned pendingDocId and checks
 *   server-confirmed document existence + ownerUid before retrying a create,
 *   reconciling via two-branch updateOwnerDocument instead of creating duplicates.
 * - M4: Blocks writes unless connectionState === "connected" and browserOnlineHint === true.
 * - L1: Enforces a global single-flight write lock across all Affiliate mutations.
 */
export function createAffiliateWriteControllerCore(deps: AffiliateWriteControllerDeps) {
  const graceMs = deps.syncPendingGraceMs ?? SYNC_PENDING_GRACE_MS;

  let session: OwnerSessionState = {
    ownerUid: null,
    isOwner: false,
    hasOwnerProfile: false,
  };
  let sessionGeneration = 0;
  let operationCounter = 0;

  let workspaceCtx: AffiliateWriteWorkspaceContext = {
    connectionState: "cached",
    browserOnlineHint: true,
    pendingDocIds: [],
    snapshotHasPendingWrites: false,
  };

  let tracker: AffiliateWriteTracker = {
    state: "idle",
    docId: null,
    operationId: null,
    operationType: null,
    error: null,
    ownerUid: null,
  };

  let pendingCreateDocIds: PendingCreateDocIds = {
    product: null,
    campaign: null,
  };

  let activeWrite: ActiveWriteHandle | null = null;
  let graceTimer: ReturnType<typeof setTimeout> | null = null;
  const listeners = new Set<() => void>();

  const notify = () => {
    for (const listener of listeners) {
      listener();
    }
  };

  const clearGraceTimer = () => {
    if (graceTimer !== null) {
      clearTimeout(graceTimer);
      graceTimer = null;
    }
  };

  const isCurrentSession = (capturedGen: number, capturedUid: string): boolean => {
    return (
      capturedGen === sessionGeneration &&
      session.ownerUid !== null &&
      session.ownerUid === capturedUid &&
      session.isOwner
    );
  };

  const getSnapshot = (): AffiliateWriteControllerSnapshot => ({
    tracker: { ...tracker },
    pendingCreateDocIds: { ...pendingCreateDocIds },
    sessionGeneration,
    ownerUid: session.ownerUid,
  });

  const subscribe = (listener: () => void): (() => void) => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  };

  const syncOwnerSession = (next: OwnerSessionState) => {
    const uidChanged = next.ownerUid !== session.ownerUid;
    const ownerRevoked = session.isOwner && !next.isOwner;

    session = {
      ownerUid: next.ownerUid,
      isOwner: next.isOwner,
      hasOwnerProfile: next.hasOwnerProfile,
    };

    if (uidChanged || ownerRevoked) {
      sessionGeneration += 1;
      clearGraceTimer();
      activeWrite = null;
      pendingCreateDocIds = { product: null, campaign: null };
      tracker = {
        state: "idle",
        docId: null,
        operationId: null,
        operationType: null,
        error: null,
        ownerUid: next.ownerUid,
      };
      notify();
    }
  };

  const syncWorkspaceContext = (next: AffiliateWriteWorkspaceContext) => {
    workspaceCtx = {
      connectionState: next.connectionState,
      browserOnlineHint: next.browserOnlineHint,
      bootConnectionStatus: next.bootConnectionStatus ?? workspaceCtx.bootConnectionStatus,
      pendingDocIds: [...next.pendingDocIds],
      snapshotHasPendingWrites: next.snapshotHasPendingWrites,
    };

    // Immediately escalate an in-flight write to sync_pending when network drops
    // or snapshot metadata reports pending local writes.
    if (
      activeWrite &&
      tracker.state === "saving" &&
      (!next.browserOnlineHint ||
        next.snapshotHasPendingWrites ||
        next.pendingDocIds.includes(activeWrite.docId))
    ) {
      tracker = { ...tracker, state: "sync_pending" };
      notify();
    }
  };

  const handleBrowserOnlineChange = (isOnline: boolean) => {
    workspaceCtx = {
      ...workspaceCtx,
      browserOnlineHint: isOnline,
    };
    if (!isOnline && activeWrite && tracker.state === "saving") {
      tracker = { ...tracker, state: "sync_pending" };
      notify();
    }
  };

  const syncBootConnectionStatus = (bootConnectionStatus: FirebaseConnectionStatus) => {
    workspaceCtx = {
      ...workspaceCtx,
      bootConnectionStatus,
    };
  };

  const allocatePendingCreateDocId = (kind: "product" | "campaign"): string => {
    const existing = pendingCreateDocIds[kind];
    if (existing) {
      return existing;
    }
    const created = deps.generateDocId(kind === "product" ? "prod" : "camp");
    pendingCreateDocIds = {
      ...pendingCreateDocIds,
      [kind]: created,
    };
    notify();
    return created;
  };

  const discardPendingCreateDocId = (kind: "product" | "campaign"): boolean => {
    const existing = pendingCreateDocIds[kind];
    if (!existing) return true;
    // Never discard the deterministic docId while an operation for it is still in flight
    if (activeWrite && activeWrite.docId === existing) {
      return false;
    }
    pendingCreateDocIds = {
      ...pendingCreateDocIds,
      [kind]: null,
    };
    notify();
    return true;
  };

  const clearWriteTracker = () => {
    if (activeWrite !== null || tracker.state === "saving" || tracker.state === "sync_pending") {
      return;
    }
    tracker = {
      state: "idle",
      docId: null,
      operationId: null,
      operationType: null,
      error: null,
      ownerUid: session.ownerUid,
    };
    notify();
  };

  const runTrackedWrite = async <T extends { reconciledExisting?: boolean }>(
    docId: string,
    operationType: AffiliateWriteOperationType,
    operation: (capturedUid: string, capturedGen: number) => Promise<T | void>,
    contextOverride?: Partial<AffiliateWriteWorkspaceContext>
  ): Promise<AffiliateWriteResult> => {
    const effectiveCtx: AffiliateWriteWorkspaceContext = {
      ...workspaceCtx,
      ...contextOverride,
    };

    if (!session.isOwner || !session.ownerUid || !session.hasOwnerProfile) {
      return {
        ok: false,
        docId,
        error: "Authenticated owner session is required to save records.",
      };
    }

    // L1: Global single-flight write lock (never clobber active write tracker state)
    if (activeWrite !== null) {
      return {
        ok: false,
        docId,
        error: "errWriteInFlightLocked",
      };
    }

    // M4 + D-01: Strict connected-only write guard (blocks checking, unconfigured, cached, offline, sync_pending, error)
    const allowedToWrite = canStartFirestoreWrite({
      isOwner: session.isOwner,
      hasOwnerProfile: session.hasOwnerProfile,
      connectionState: effectiveCtx.connectionState,
      browserOnlineHint: effectiveCtx.browserOnlineHint,
      bootConnectionStatus: effectiveCtx.bootConnectionStatus,
    });
    if (!allowedToWrite) {
      const errorKey =
        effectiveCtx.connectionState === "sync_pending"
          ? "errWriteInFlightLocked"
          : effectiveCtx.connectionState === "cached" ||
              effectiveCtx.bootConnectionStatus === "checking"
            ? "errCachedWriteBlocked"
            : "errOfflineWriteBlocked";
      return {
        ok: false,
        docId,
        error: errorKey,
      };
    }

    const capturedUid = session.ownerUid;
    const capturedGen = sessionGeneration;
    const operationId = ++operationCounter;

    activeWrite = {
      docId,
      operationId,
      operationType,
      sessionGeneration: capturedGen,
      ownerUid: capturedUid,
    };
    tracker = {
      state: "saving",
      docId,
      operationId,
      operationType,
      error: null,
      ownerUid: capturedUid,
    };
    notify();

    clearGraceTimer();
    graceTimer = setTimeout(() => {
      if (
        isCurrentSession(capturedGen, capturedUid) &&
        activeWrite?.operationId === operationId &&
        tracker.state === "saving"
      ) {
        tracker = { ...tracker, state: "sync_pending" };
        notify();
      }
    }, graceMs);

    try {
      const result = await operation(capturedUid, capturedGen);

      // Safeguard 1: Abort state mutation if owner signed out or switched mid-flight
      if (!isCurrentSession(capturedGen, capturedUid)) {
        return {
          ok: false,
          docId,
          error: "Owner session changed before write completed.",
        };
      }

      if (activeWrite?.operationId === operationId) {
        clearGraceTimer();
        activeWrite = null;
        if (operationType === "create_product" && pendingCreateDocIds.product === docId) {
          pendingCreateDocIds = { ...pendingCreateDocIds, product: null };
        } else if (operationType === "create_campaign" && pendingCreateDocIds.campaign === docId) {
          pendingCreateDocIds = { ...pendingCreateDocIds, campaign: null };
        }
        tracker = {
          state: "saved",
          docId,
          operationId,
          operationType,
          error: null,
          ownerUid: capturedUid,
        };
        notify();
      }

      return {
        ok: true,
        docId,
        reconciledExisting: Boolean(result && result.reconciledExisting),
      };
    } catch (err) {
      if (!isCurrentSession(capturedGen, capturedUid)) {
        return {
          ok: false,
          docId,
          error: "Owner session changed before write completed.",
        };
      }

      const message = parseFirestoreErrorMessage(err, deps.projectId, deps.databaseId);
      if (activeWrite?.operationId === operationId) {
        clearGraceTimer();
        activeWrite = null;
        tracker = {
          state: "failed",
          docId,
          operationId,
          operationType,
          error: message,
          ownerUid: capturedUid,
        };
        notify();
      }

      return {
        ok: false,
        docId,
        error: message,
      };
    }
  };

  const createProduct = async (
    input: ProductFormInput,
    pendingDocId: string,
    contextOverride?: Partial<AffiliateWriteWorkspaceContext>
  ): Promise<AffiliateWriteResult> => {
    const effectivePendingIds = contextOverride?.pendingDocIds ?? workspaceCtx.pendingDocIds;
    if (effectivePendingIds.includes(pendingDocId)) {
      return {
        ok: false,
        docId: pendingDocId,
        error: "errWriteInFlightLocked",
      };
    }

    const built = buildProductCreatePayload(input);
    if (!built.ok) {
      return { ok: false, docId: pendingDocId, error: built.errorKey };
    }

    return runTrackedWrite(
      pendingDocId,
      "create_product",
      async (capturedUid, capturedGen) => {
        // Safeguard 2: Server-confirmed existence + ownerUid verification before create
        const serverExisting = await deps.getOwnerDocumentFromServer(
          "affiliateProducts",
          pendingDocId,
          capturedUid
        );
        if (!isCurrentSession(capturedGen, capturedUid)) {
          return;
        }

        if (serverExisting) {
          if (serverExisting.ownerUid !== capturedUid) {
            throw new Error("Document owner UID verification failed.");
          }
          if (!canEditRecord(serverExisting.status)) {
            throw new Error("Archived records are read-only.");
          }

          // Reconcile existing server document strictly respecting firestore.rules Branch A + Branch B
          const detailsBuilt = buildProductDetailsUpdatePayload(input, serverExisting);
          if (!detailsBuilt.ok) {
            throw new Error(detailsBuilt.errorKey);
          }
          await deps.updateOwnerDocument(
            "affiliateProducts",
            pendingDocId,
            detailsBuilt.payload,
            capturedUid
          );

          if (!isCurrentSession(capturedGen, capturedUid)) {
            return;
          }

          if (serverExisting.status !== built.payload.status) {
            await deps.updateOwnerDocument(
              "affiliateProducts",
              pendingDocId,
              buildProductStatusUpdatePayload(built.payload.status),
              capturedUid
            );
          }

          return { reconciledExisting: true };
        }

        await deps.createOwnerDocument(
          "affiliateProducts",
          built.payload,
          pendingDocId,
          capturedUid
        );
        return { reconciledExisting: false };
      },
      contextOverride
    );
  };

  const updateProductDetails = async (
    product: WithId<AffiliateProduct>,
    input: ProductFormInput,
    contextOverride?: Partial<AffiliateWriteWorkspaceContext>
  ): Promise<AffiliateWriteResult> => {
    if (!canEditRecord(product.status)) {
      return { ok: false, docId: product.id, error: "errArchivedReadOnly" };
    }
    const effectivePendingIds = contextOverride?.pendingDocIds ?? workspaceCtx.pendingDocIds;
    if (effectivePendingIds.includes(product.id)) {
      return { ok: false, docId: product.id, error: "errWriteInFlightLocked" };
    }

    const built = buildProductDetailsUpdatePayload(input, product);
    if (!built.ok) {
      return { ok: false, docId: product.id, error: built.errorKey };
    }

    return runTrackedWrite(
      product.id,
      "update_product_details",
      async (capturedUid) => {
        await deps.updateOwnerDocument(
          "affiliateProducts",
          product.id,
          built.payload,
          capturedUid
        );
      },
      contextOverride
    );
  };

  const updateProductStatus = async (
    product: WithId<AffiliateProduct>,
    nextStatus: AffiliateProductStatus,
    contextOverride?: Partial<AffiliateWriteWorkspaceContext>
  ): Promise<AffiliateWriteResult> => {
    if (!canEditRecord(product.status)) {
      return { ok: false, docId: product.id, error: "errArchivedReadOnly" };
    }
    if (product.status === nextStatus) {
      return { ok: true, docId: product.id };
    }
    const effectivePendingIds = contextOverride?.pendingDocIds ?? workspaceCtx.pendingDocIds;
    if (effectivePendingIds.includes(product.id)) {
      return { ok: false, docId: product.id, error: "errWriteInFlightLocked" };
    }

    const payload = buildProductStatusUpdatePayload(nextStatus);
    return runTrackedWrite(
      product.id,
      "update_product_status",
      async (capturedUid) => {
        await deps.updateOwnerDocument("affiliateProducts", product.id, payload, capturedUid);
      },
      contextOverride
    );
  };

  const createCampaign = async (
    input: CampaignFormInput,
    pendingDocId: string,
    contextOverride?: Partial<AffiliateWriteWorkspaceContext>
  ): Promise<AffiliateWriteResult> => {
    const effectivePendingIds = contextOverride?.pendingDocIds ?? workspaceCtx.pendingDocIds;
    if (effectivePendingIds.includes(pendingDocId)) {
      return {
        ok: false,
        docId: pendingDocId,
        error: "errWriteInFlightLocked",
      };
    }

    const built = buildCampaignCreatePayload(input);
    if (!built.ok) {
      return { ok: false, docId: pendingDocId, error: built.errorKey };
    }

    return runTrackedWrite(
      pendingDocId,
      "create_campaign",
      async (capturedUid, capturedGen) => {
        // Safeguard 2: Server-confirmed existence + ownerUid verification before create
        const serverExisting = await deps.getOwnerDocumentFromServer(
          "marketingCampaigns",
          pendingDocId,
          capturedUid
        );
        if (!isCurrentSession(capturedGen, capturedUid)) {
          return;
        }

        if (serverExisting) {
          if (serverExisting.ownerUid !== capturedUid) {
            throw new Error("Document owner UID verification failed.");
          }
          if (!canEditRecord(serverExisting.status)) {
            throw new Error("Archived records are read-only.");
          }

          // Reconcile existing server document strictly respecting firestore.rules Branch A + Branch B
          const detailsBuilt = buildCampaignDetailsUpdatePayload(input, serverExisting);
          if (!detailsBuilt.ok) {
            throw new Error(detailsBuilt.errorKey);
          }
          await deps.updateOwnerDocument(
            "marketingCampaigns",
            pendingDocId,
            detailsBuilt.payload,
            capturedUid
          );

          if (!isCurrentSession(capturedGen, capturedUid)) {
            return;
          }

          if (serverExisting.status !== built.payload.status) {
            await deps.updateOwnerDocument(
              "marketingCampaigns",
              pendingDocId,
              buildCampaignStatusUpdatePayload(built.payload.status),
              capturedUid
            );
          }

          return { reconciledExisting: true };
        }

        await deps.createOwnerDocument(
          "marketingCampaigns",
          built.payload,
          pendingDocId,
          capturedUid
        );
        return { reconciledExisting: false };
      },
      contextOverride
    );
  };

  const updateCampaignDetails = async (
    campaign: WithId<MarketingCampaign>,
    input: CampaignFormInput,
    contextOverride?: Partial<AffiliateWriteWorkspaceContext>
  ): Promise<AffiliateWriteResult> => {
    if (!canEditRecord(campaign.status)) {
      return { ok: false, docId: campaign.id, error: "errArchivedReadOnly" };
    }
    const effectivePendingIds = contextOverride?.pendingDocIds ?? workspaceCtx.pendingDocIds;
    if (effectivePendingIds.includes(campaign.id)) {
      return { ok: false, docId: campaign.id, error: "errWriteInFlightLocked" };
    }

    const built = buildCampaignDetailsUpdatePayload(input, campaign);
    if (!built.ok) {
      return { ok: false, docId: campaign.id, error: built.errorKey };
    }

    return runTrackedWrite(
      campaign.id,
      "update_campaign_details",
      async (capturedUid) => {
        await deps.updateOwnerDocument(
          "marketingCampaigns",
          campaign.id,
          built.payload,
          capturedUid
        );
      },
      contextOverride
    );
  };

  const updateCampaignStatus = async (
    campaign: WithId<MarketingCampaign>,
    nextStatus: CampaignStatus,
    contextOverride?: Partial<AffiliateWriteWorkspaceContext>
  ): Promise<AffiliateWriteResult> => {
    if (!canEditRecord(campaign.status)) {
      return { ok: false, docId: campaign.id, error: "errArchivedReadOnly" };
    }
    if (campaign.status === nextStatus) {
      return { ok: true, docId: campaign.id };
    }
    const effectivePendingIds = contextOverride?.pendingDocIds ?? workspaceCtx.pendingDocIds;
    if (effectivePendingIds.includes(campaign.id)) {
      return { ok: false, docId: campaign.id, error: "errWriteInFlightLocked" };
    }

    const payload = buildCampaignStatusUpdatePayload(nextStatus);
    return runTrackedWrite(
      campaign.id,
      "update_campaign_status",
      async (capturedUid) => {
        await deps.updateOwnerDocument("marketingCampaigns", campaign.id, payload, capturedUid);
      },
      contextOverride
    );
  };

  /**
   * Campaign deletion only (explicitly permitted by firestore.rules).
   * Product deletion is intentionally excluded from Phase 3.
   */
  const deleteCampaign = async (
    campaignId: string,
    contextOverride?: Partial<AffiliateWriteWorkspaceContext>
  ): Promise<AffiliateWriteResult> => {
    const effectivePendingIds = contextOverride?.pendingDocIds ?? workspaceCtx.pendingDocIds;
    if (effectivePendingIds.includes(campaignId)) {
      return { ok: false, docId: campaignId, error: "errWriteInFlightLocked" };
    }

    return runTrackedWrite(
      campaignId,
      "delete_campaign",
      async (capturedUid) => {
        await deps.deleteOwnerDocument("marketingCampaigns", campaignId, capturedUid);
      },
      contextOverride
    );
  };

  const dispose = () => {
    clearGraceTimer();
    listeners.clear();
  };

  return {
    getSnapshot,
    subscribe,
    syncOwnerSession,
    syncWorkspaceContext,
    syncBootConnectionStatus,
    handleBrowserOnlineChange,
    allocatePendingCreateDocId,
    discardPendingCreateDocId,
    clearWriteTracker,
    createProduct,
    updateProductDetails,
    updateProductStatus,
    createCampaign,
    updateCampaignDetails,
    updateCampaignStatus,
    deleteCampaign,
    dispose,
  };
}

export type AffiliateWriteControllerCore = ReturnType<typeof createAffiliateWriteControllerCore>;

export interface AffiliateWriteController {
  writeTracker: AffiliateWriteTracker;
  pendingCreateDocIds: PendingCreateDocIds;
  isWriteBusy: boolean;
  syncWorkspaceContext: (ctx: AffiliateWriteWorkspaceContext) => void;
  allocatePendingCreateDocId: (kind: "product" | "campaign") => string;
  discardPendingCreateDocId: (kind: "product" | "campaign") => boolean;
  clearWriteTracker: () => void;
  createProduct: (
    input: ProductFormInput,
    pendingDocId: string,
    contextOverride?: Partial<AffiliateWriteWorkspaceContext>
  ) => Promise<AffiliateWriteResult>;
  updateProductDetails: (
    product: WithId<AffiliateProduct>,
    input: ProductFormInput,
    contextOverride?: Partial<AffiliateWriteWorkspaceContext>
  ) => Promise<AffiliateWriteResult>;
  updateProductStatus: (
    product: WithId<AffiliateProduct>,
    nextStatus: AffiliateProductStatus,
    contextOverride?: Partial<AffiliateWriteWorkspaceContext>
  ) => Promise<AffiliateWriteResult>;
  createCampaign: (
    input: CampaignFormInput,
    pendingDocId: string,
    contextOverride?: Partial<AffiliateWriteWorkspaceContext>
  ) => Promise<AffiliateWriteResult>;
  updateCampaignDetails: (
    campaign: WithId<MarketingCampaign>,
    input: CampaignFormInput,
    contextOverride?: Partial<AffiliateWriteWorkspaceContext>
  ) => Promise<AffiliateWriteResult>;
  updateCampaignStatus: (
    campaign: WithId<MarketingCampaign>,
    nextStatus: CampaignStatus,
    contextOverride?: Partial<AffiliateWriteWorkspaceContext>
  ) => Promise<AffiliateWriteResult>;
  deleteCampaign: (
    campaignId: string,
    contextOverride?: Partial<AffiliateWriteWorkspaceContext>
  ) => Promise<AffiliateWriteResult>;
}

/**
 * App-level Affiliate write controller hook.
 * Mounted in App.tsx so pending writes, deterministic create doc IDs, and
 * final Saved/Failed feedback survive modal dismissal and Video <-> Affiliate switches.
 */
export function useAffiliateWriteController(): AffiliateWriteController {
  const {
    user,
    isOwner,
    ownerProfile,
    connectionStatus: bootConnectionStatus,
    projectId,
    databaseId,
  } = useFirebase();
  const userUid = user?.uid ?? null;
  const hasOwnerProfile = Boolean(ownerProfile);

  const projectMetaRef = useRef({ projectId, databaseId });
  projectMetaRef.current = { projectId, databaseId };

  const coreRef = useRef<AffiliateWriteControllerCore | null>(null);
  if (!coreRef.current) {
    coreRef.current = createAffiliateWriteControllerCore({
      createOwnerDocument,
      updateOwnerDocument,
      deleteOwnerDocument: (col, docId, expectedOwnerUid) =>
        deleteOwnerDocument(col, docId, expectedOwnerUid),
      getOwnerDocumentFromServer,
      generateDocId: generateFirestoreDocId,
      get projectId() {
        return projectMetaRef.current.projectId;
      },
      get databaseId() {
        return projectMetaRef.current.databaseId;
      },
    });
  }

  const core = coreRef.current;
  const [snapshot, setSnapshot] = useState<AffiliateWriteControllerSnapshot>(() =>
    core.getSnapshot()
  );

  useEffect(() => {
    const unsub = core.subscribe(() => {
      setSnapshot(core.getSnapshot());
    });
    return () => {
      unsub();
    };
  }, [core]);

  useEffect(() => {
    return () => {
      core.dispose();
    };
  }, [core]);

  // Safeguard 1: Synchronize owner session UID immediately on auth changes
  useEffect(() => {
    core.syncOwnerSession({
      ownerUid: userUid,
      isOwner,
      hasOwnerProfile,
    });
  }, [core, userUid, isOwner, hasOwnerProfile]);

  // Keep controller synchronized with live Firebase boot connection status
  useEffect(() => {
    core.syncBootConnectionStatus(bootConnectionStatus);
  }, [core, bootConnectionStatus]);

  // Keep online/offline escalation active even when AffiliateWorkspace is unmounted
  useEffect(() => {
    if (typeof window === "undefined") return;
    const onOnline = () => core.handleBrowserOnlineChange(true);
    const onOffline = () => core.handleBrowserOnlineChange(false);
    window.addEventListener("online", onOnline);
    window.addEventListener("offline", onOffline);
    return () => {
      window.removeEventListener("online", onOnline);
      window.removeEventListener("offline", onOffline);
    };
  }, [core]);

  return useMemo<AffiliateWriteController>(
    () => ({
      writeTracker: snapshot.tracker,
      pendingCreateDocIds: snapshot.pendingCreateDocIds,
      isWriteBusy:
        snapshot.tracker.state === "saving" || snapshot.tracker.state === "sync_pending",
      syncWorkspaceContext: core.syncWorkspaceContext,
      allocatePendingCreateDocId: core.allocatePendingCreateDocId,
      discardPendingCreateDocId: core.discardPendingCreateDocId,
      clearWriteTracker: core.clearWriteTracker,
      createProduct: core.createProduct,
      updateProductDetails: core.updateProductDetails,
      updateProductStatus: core.updateProductStatus,
      createCampaign: core.createCampaign,
      updateCampaignDetails: core.updateCampaignDetails,
      updateCampaignStatus: core.updateCampaignStatus,
      deleteCampaign: core.deleteCampaign,
    }),
    [core, snapshot]
  );
}
