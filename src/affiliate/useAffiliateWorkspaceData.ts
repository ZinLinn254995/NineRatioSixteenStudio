import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  subscribeOwnerCollection,
  useFirebase,
  type AffiliateProduct,
  type AffiliateProductStatus,
  type CampaignStatus,
  type MarketingCampaign,
  type OwnerCollectionSnapshotMetadata,
  type WithId,
} from "../firebase";
import { getTimestampMillis } from "./affiliateDateUtils";
import type { WorkspaceConnectionState, WriteOperationState } from "./affiliateLabels";
import {
  canAttachAffiliateListeners,
  canStartFirestoreWrite,
  classifyWorkspaceConnectionState,
  parseFirestoreErrorMessage,
  type CampaignFormInput,
  type ProductFormInput,
} from "./affiliateValidation";
import type {
  AffiliateWriteController,
  AffiliateWriteResult,
} from "./useAffiliateWriteController";

export type { AffiliateWriteResult };

export interface ActiveWriteTracker {
  state: WriteOperationState;
  docId: string | null;
  error: string | null;
}

export interface SubscriptionHandle {
  unsubscribe: () => void;
}

export interface AffiliateSubscriptionManagerDeps {
  subscribeProducts: () => () => void;
  subscribeCampaigns: () => () => void;
}

/**
 * Pure lifecycle manager for Affiliate Firestore subscriptions.
 * Guarantees zero duplicate listeners across repeated workspace switches and
 * immediate detachment when leaving Affiliate Studio or signing out.
 */
export function createAffiliateSubscriptionManager(deps: AffiliateSubscriptionManagerDeps) {
  let activeKey: string | null = null;
  let unsubs: (() => void)[] = [];

  return {
    sync(input: {
      workspaceActive: boolean;
      isConfigured: boolean;
      authReady: boolean;
      isOwner: boolean;
      userUid: string | null | undefined;
      hasOwnerProfile: boolean;
      retryNonce: number;
    }) {
      const allowed = canAttachAffiliateListeners(input);
      if (!allowed || !input.userUid) {
        if (unsubs.length > 0) {
          for (const fn of unsubs) fn();
          unsubs = [];
          activeKey = null;
        }
        return { activeListenerCount: 0 };
      }

      const nextKey = `${input.userUid}:${input.retryNonce}`;
      if (activeKey === nextKey && unsubs.length === 2) {
        return { activeListenerCount: unsubs.length };
      }

      // Always detach previous listeners before attaching fresh ones
      for (const fn of unsubs) fn();
      unsubs = [];

      const unsubProducts = deps.subscribeProducts();
      const unsubCampaigns = deps.subscribeCampaigns();
      unsubs = [unsubProducts, unsubCampaigns];
      activeKey = nextKey;
      return { activeListenerCount: unsubs.length };
    },
    detach() {
      for (const fn of unsubs) fn();
      unsubs = [];
      activeKey = null;
    },
    getActiveCount() {
      return unsubs.length;
    },
  };
}

/**
 * Pure write-state transition evaluator so the UI NEVER displays "saved"
 * before server confirmation (Promise resolved & no pending write for docId).
 */
export function resolveWriteDisplayState(input: {
  baseState: WriteOperationState;
  docId: string | null;
  pendingDocIds: readonly string[];
  snapshotHasPendingWrites: boolean;
}): WriteOperationState {
  if (input.baseState === "saved" || input.baseState === "failed" || input.baseState === "idle") {
    return input.baseState;
  }
  if (
    input.baseState === "saving" &&
    ((input.docId && input.pendingDocIds.includes(input.docId)) ||
      input.snapshotHasPendingWrites)
  ) {
    return "sync_pending";
  }
  return input.baseState;
}

export function useAffiliateWorkspaceData(
  workspaceActive: boolean,
  writeController: AffiliateWriteController
) {
  const {
    isConfigured,
    authReady,
    isOwner,
    user,
    ownerProfile,
    connectionStatus: bootConnectionStatus,
    retryBootConnection,
    projectId,
    databaseId,
  } = useFirebase();

  // M2: Primitive listener dependencies so unrelated ownerProfile updates (e.g. UI language)
  // NEVER detach or recreate Firestore onSnapshot listeners.
  const userUid = user?.uid ?? null;
  const hasOwnerProfile = Boolean(ownerProfile);

  const [products, setProducts] = useState<WithId<AffiliateProduct>[]>([]);
  const [campaigns, setCampaigns] = useState<WithId<MarketingCampaign>[]>([]);
  const [productsMeta, setProductsMeta] = useState<OwnerCollectionSnapshotMetadata | null>(null);
  const [campaignsMeta, setCampaignsMeta] = useState<OwnerCollectionSnapshotMetadata | null>(null);
  const [listenerError, setListenerError] = useState<string | null>(null);
  const [retryNonce, setRetryNonce] = useState(0);
  const [browserOnlineHint, setBrowserOnlineHint] = useState<boolean>(() =>
    typeof navigator !== "undefined" ? navigator.onLine : true
  );

  // Track browser online/offline strictly as a hint (never sole truth for sync)
  useEffect(() => {
    if (typeof window === "undefined") return;
    const onOnline = () => setBrowserOnlineHint(true);
    const onOffline = () => setBrowserOnlineHint(false);
    window.addEventListener("online", onOnline);
    window.addEventListener("offline", onOffline);
    return () => {
      window.removeEventListener("online", onOnline);
      window.removeEventListener("offline", onOffline);
    };
  }, []);

  const canSubscribe = canAttachAffiliateListeners({
    workspaceActive,
    isConfigured,
    authReady,
    isOwner,
    userUid,
    hasOwnerProfile,
  });

  const managerRef = useRef<ReturnType<typeof createAffiliateSubscriptionManager> | null>(null);

  useEffect(() => {
    if (!canSubscribe) {
      managerRef.current?.detach();
      managerRef.current = null;
      if (!isOwner || !userUid) {
        setProducts([]);
        setCampaigns([]);
        setProductsMeta(null);
        setCampaignsMeta(null);
        setListenerError(null);
      }
      return;
    }

    setListenerError(null);
    const manager = createAffiliateSubscriptionManager({
      subscribeProducts: () =>
        subscribeOwnerCollection(
          "affiliateProducts",
          (items, metadata) => {
            setProducts(items);
            setProductsMeta(metadata);
            setListenerError(null);
          },
          [],
          (err) => {
            setListenerError(parseFirestoreErrorMessage(err, projectId, databaseId));
          }
        ),
      subscribeCampaigns: () =>
        subscribeOwnerCollection(
          "marketingCampaigns",
          (items, metadata) => {
            setCampaigns(items);
            setCampaignsMeta(metadata);
            setListenerError(null);
          },
          [],
          (err) => {
            setListenerError(parseFirestoreErrorMessage(err, projectId, databaseId));
          }
        ),
    });

    managerRef.current = manager;
    manager.sync({
      workspaceActive,
      isConfigured,
      authReady,
      isOwner,
      userUid,
      hasOwnerProfile,
      retryNonce,
    });

    return () => {
      manager.detach();
      if (managerRef.current === manager) {
        managerRef.current = null;
      }
    };
  }, [
    canSubscribe,
    workspaceActive,
    isConfigured,
    authReady,
    isOwner,
    userUid,
    hasOwnerProfile,
    retryNonce,
    projectId,
    databaseId,
  ]);

  // Client-side sort by updatedAt descending (avoids Firestore composite index requirement)
  const sortedProducts = useMemo(() => {
    return [...products].sort(
      (a, b) => getTimestampMillis(b.updatedAt) - getTimestampMillis(a.updatedAt)
    );
  }, [products]);

  const sortedCampaigns = useMemo(() => {
    return [...campaigns].sort(
      (a, b) => getTimestampMillis(b.updatedAt) - getTimestampMillis(a.updatedAt)
    );
  }, [campaigns]);

  const pendingDocIds = useMemo(() => {
    const ids = new Set<string>();
    for (const id of productsMeta?.pendingDocIds || []) ids.add(id);
    for (const id of campaignsMeta?.pendingDocIds || []) ids.add(id);
    if (
      writeController.writeTracker.docId &&
      (writeController.writeTracker.state === "saving" ||
        writeController.writeTracker.state === "sync_pending")
    ) {
      ids.add(writeController.writeTracker.docId);
    }
    return Array.from(ids);
  }, [productsMeta, campaignsMeta, writeController.writeTracker.docId, writeController.writeTracker.state]);

  const snapshotPendingDocIds = useMemo(() => {
    const ids = new Set<string>();
    for (const id of productsMeta?.pendingDocIds || []) ids.add(id);
    for (const id of campaignsMeta?.pendingDocIds || []) ids.add(id);
    return Array.from(ids);
  }, [productsMeta, campaignsMeta]);

  const snapshotHasPendingWrites = Boolean(
    productsMeta?.hasPendingWrites || campaignsMeta?.hasPendingWrites
  );

  const hasSnapshot = Boolean(productsMeta !== null || campaignsMeta !== null);
  const anyFromCache = Boolean(
    (productsMeta && productsMeta.fromCache) || (campaignsMeta && campaignsMeta.fromCache)
  );

  const effectiveWriteState = resolveWriteDisplayState({
    baseState: writeController.writeTracker.state,
    docId: writeController.writeTracker.docId,
    pendingDocIds: snapshotPendingDocIds,
    snapshotHasPendingWrites,
  });

  const isWriteBusy = effectiveWriteState === "saving" || effectiveWriteState === "sync_pending";

  const connectionState: WorkspaceConnectionState = classifyWorkspaceConnectionState({
    browserOnlineHint,
    bootConnectionStatus,
    listenerError,
    hasSnapshot,
    fromCache: anyFromCache,
    hasPendingWrites: snapshotHasPendingWrites,
    hasInFlightWrite: isWriteBusy,
  });

  const isLoading = canSubscribe && !hasSnapshot && !listenerError;

  const canWriteNow = canStartFirestoreWrite({
    isOwner,
    hasOwnerProfile,
    connectionState,
    browserOnlineHint,
  });

  // Keep App-level write controller synced with live Firestore snapshot metadata
  useEffect(() => {
    writeController.syncWorkspaceContext({
      connectionState,
      browserOnlineHint,
      pendingDocIds: snapshotPendingDocIds,
      snapshotHasPendingWrites,
    });
  }, [
    writeController,
    connectionState,
    browserOnlineHint,
    snapshotPendingDocIds,
    snapshotHasPendingWrites,
  ]);

  const retryConnection = useCallback(() => {
    setListenerError(null);
    setRetryNonce((n) => n + 1);
    void retryBootConnection();
  }, [retryBootConnection]);

  const currentCtx = useMemo(
    () => ({
      connectionState,
      browserOnlineHint,
      pendingDocIds: snapshotPendingDocIds,
      snapshotHasPendingWrites,
    }),
    [connectionState, browserOnlineHint, snapshotPendingDocIds, snapshotHasPendingWrites]
  );

  const createProduct = useCallback(
    (input: ProductFormInput, pendingDocId: string) =>
      writeController.createProduct(input, pendingDocId, currentCtx),
    [writeController, currentCtx]
  );

  const updateProductDetails = useCallback(
    (product: WithId<AffiliateProduct>, input: ProductFormInput) =>
      writeController.updateProductDetails(product, input, currentCtx),
    [writeController, currentCtx]
  );

  const updateProductStatus = useCallback(
    (product: WithId<AffiliateProduct>, nextStatus: AffiliateProductStatus) =>
      writeController.updateProductStatus(product, nextStatus, currentCtx),
    [writeController, currentCtx]
  );

  const createCampaign = useCallback(
    (input: CampaignFormInput, pendingDocId: string) =>
      writeController.createCampaign(input, pendingDocId, currentCtx),
    [writeController, currentCtx]
  );

  const updateCampaignDetails = useCallback(
    (campaign: WithId<MarketingCampaign>, input: CampaignFormInput) =>
      writeController.updateCampaignDetails(campaign, input, currentCtx),
    [writeController, currentCtx]
  );

  const updateCampaignStatus = useCallback(
    (campaign: WithId<MarketingCampaign>, nextStatus: CampaignStatus) =>
      writeController.updateCampaignStatus(campaign, nextStatus, currentCtx),
    [writeController, currentCtx]
  );

  const deleteCampaign = useCallback(
    (campaignId: string) => writeController.deleteCampaign(campaignId, currentCtx),
    [writeController, currentCtx]
  );

  return {
    products: sortedProducts,
    campaigns: sortedCampaigns,
    isLoading,
    connectionState,
    listenerError,
    pendingDocIds,
    canWriteNow,
    isWriteBusy,
    writeState: effectiveWriteState,
    writeDocId: writeController.writeTracker.docId,
    writeError: writeController.writeTracker.error,
    writeTracker: writeController.writeTracker,
    pendingCreateDocIds: writeController.pendingCreateDocIds,
    allocatePendingCreateDocId: writeController.allocatePendingCreateDocId,
    discardPendingCreateDocId: writeController.discardPendingCreateDocId,
    clearWriteTracker: writeController.clearWriteTracker,
    retryConnection,
    createProduct,
    updateProductDetails,
    updateProductStatus,
    createCampaign,
    updateCampaignDetails,
    updateCampaignStatus,
    deleteCampaign,
  };
}
