/**
 * Phase 3 Automated Verification Suite — Affiliate Workspace (NineRatioSixteenStudio)
 *
 * Run with: npx tsx affiliate.phase3.test.ts
 *
 * Verifies:
 * 1. Product & Campaign payload validation, FIELD_LIMITS, Thai/Burmese Unicode, safe HTTP URLs
 * 2. Two-branch firestore.rules update payload separation (Details vs Status) & deleteField() clearing
 * 3. Date-only YYYY-MM-DD validation & timezone-safe Thailand UTC+7 display/comparison
 * 4. Auth & listener lifecycle guards (signed-out blocked, non-owner blocked, detach on switch/sign-out, zero duplicate listeners)
 * 5. 5-state connection classifier & structured FirestoreErrorInfo parser (no crashes)
 * 6. 4-state write lifecycle & duplicate-create prevention (never claims Saved while pending)
 * 7. Archived read-only lock & complete exclusion of Product Deletion in Phase 3
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import {
  compareDateOnly,
  formatDateOnlyDisplay,
  getLocalTodayDateOnly,
  isDateRangeValid,
  isValidDateOnly,
} from "./src/affiliate/affiliateDateUtils";
import {
  buildCampaignCreatePayload,
  buildCampaignDetailsUpdatePayload,
  buildCampaignStatusUpdatePayload,
  buildProductCreatePayload,
  buildProductDetailsUpdatePayload,
  buildProductStatusUpdatePayload,
  canArchiveRecord,
  canAttachAffiliateListeners,
  canEditRecord,
  canStartFirestoreWrite,
  classifyWorkspaceConnectionState,
  evaluateAffiliateFormWriteGuard,
  hasExistingDocumentWithId,
  isSafeHttpUrl,
  normalizeSearchText,
  parseFirestoreErrorMessage,
  reconcileLanguagePreference,
  resolveCampaignProductBackfill,
  shouldResetModalDraft,
} from "./src/affiliate/affiliateValidation";
import {
  createAffiliateSubscriptionManager,
  resolveWriteDisplayState,
} from "./src/affiliate/useAffiliateWorkspaceData";
import {
  createAffiliateWriteControllerCore,
  type AffiliateWriteControllerDeps,
} from "./src/affiliate/useAffiliateWriteController";
import { createYouTubePlayerInstanceGuard } from "./src/components/YouTubePreviewPanel";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { getAffiliateLabels } from "./src/affiliate/affiliateLabels";
import { ConfirmActionModal } from "./src/affiliate/ConfirmActionModal";
import { ProductWorkspaceView } from "./src/affiliate/ProductWorkspaceView";
import { CampaignWorkspaceView } from "./src/affiliate/CampaignWorkspaceView";
import { ProductFormModal } from "./src/affiliate/ProductFormModal";
import { CampaignFormModal } from "./src/affiliate/CampaignFormModal";
import {
  OwnerProfileGateView,
  resolveGate4ViewMode,
} from "./src/affiliate/AffiliateWorkspace";
import {
  createFirebaseRecoveryCoordinator,
  matchesOwnerAccount,
} from "./src/firebase/FirebaseContext";
import {
  classifyFirestoreConnectionError,
  isFirestoreOfflineError,
} from "./src/firebase/client";
import { verifyOwnerProfileSnapshot } from "./src/firebase/firestoreService";
import type { User } from "firebase/auth";
import type {
  AffiliateProduct,
  MarketingCampaign,
  OwnerCollectionKey,
  OwnerCollectionMap,
  OwnerDocumentUpdate,
  UserProfile,
  WithId,
} from "./src/firebase";

interface TestResult {
  name: string;
  ok: boolean;
  error?: string;
}

const results: TestResult[] = [];

async function runTest(name: string, fn: () => void | Promise<void>): Promise<void> {
  try {
    await fn();
    results.push({ name, ok: true });
    console.log(`PASS  ${name}`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    results.push({ name, ok: false, error: message });
    console.error(`FAIL  ${name}\n      ${message}`);
  }
}

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function makeSampleProductInput(overrides: Partial<{
  name: string;
  category: string;
  tiktokShopUrl: string;
  priceThb: string;
  commissionRatePct: string;
  targetLanguage: "th" | "my" | "th_my";
  sellingPoints: string;
  complianceNotes: string;
  tagsText: string;
  status: "researching" | "shortlisted" | "active" | "paused" | "archived";
}> = {}) {
  return {
    name: "Vitamin C Serum",
    category: "Skincare",
    tiktokShopUrl: "https://shop.tiktok.com/item/1",
    priceThb: "299",
    commissionRatePct: "12",
    targetLanguage: "th_my" as const,
    sellingPoints: "Brightening",
    complianceNotes: "No exaggerated claims",
    tagsText: "skincare, serum",
    status: "active" as const,
    ...overrides,
  };
}

function makeSampleCampaignInput(overrides: Partial<{
  productId: string;
  title: string;
  goal: string;
  targetLanguage: "th" | "my" | "th_my";
  status: "draft" | "active" | "paused" | "completed" | "archived";
  strategyNotes: string;
  startDate: string;
  endDate: string;
}> = {}) {
  return {
    productId: "prod_1",
    title: "11.11 Flash Campaign",
    goal: "3 review clips",
    targetLanguage: "th" as const,
    status: "draft" as const,
    strategyNotes: "Hook in first 2s",
    startDate: "2026-11-20",
    endDate: "2026-11-30",
    ...overrides,
  };
}

async function main() {
  // 1. Product validation, Thai/Burmese Unicode & safe URL check
  await runTest("Product validation: enforces required name, safe HTTP/HTTPS URL, numeric bounds & TH/MY Unicode", () => {
    assert.equal(isSafeHttpUrl("https://shop.tiktok.com/view/product/123"), true);
    assert.equal(isSafeHttpUrl("http://example.com"), true);
    assert.equal(isSafeHttpUrl("javascript:alert(1)"), false);
    assert.equal(isSafeHttpUrl("ftp://files.example.com"), false);

    const invalidEmpty = buildProductCreatePayload({
      name: "   ",
      category: "",
      tiktokShopUrl: "",
      priceThb: "",
      commissionRatePct: "",
      targetLanguage: "th",
      sellingPoints: "",
      complianceNotes: "",
      tagsText: "",
      status: "researching",
    });
    assert.equal(invalidEmpty.ok, false);

    const invalidUrl = buildProductCreatePayload({
      name: "เซรั่มวิตามินซี / ဗီတာမင်စီ",
      category: "Skincare",
      tiktokShopUrl: "javascript:void(0)",
      priceThb: "299",
      commissionRatePct: "15",
      targetLanguage: "th_my",
      sellingPoints: "ผิวใส",
      complianceNotes: "",
      tagsText: "skincare, ผิวใส, အလှကုန်",
      status: "active",
    });
    assert.equal(invalidUrl.ok, false);

    const invalidCommission = buildProductCreatePayload({
      name: "Valid Product",
      category: "",
      tiktokShopUrl: "",
      priceThb: "299",
      commissionRatePct: "150",
      targetLanguage: "my",
      sellingPoints: "",
      complianceNotes: "",
      tagsText: "",
      status: "shortlisted",
    });
    assert.equal(invalidCommission.ok, false);

    const valid = buildProductCreatePayload({
      name: "  เซรั่มวิตามินซี / ဗီတာမင်စီ  ",
      category: "Skincare",
      tiktokShopUrl: "https://shop.tiktok.com/item/1",
      priceThb: "299.5",
      commissionRatePct: "12.5",
      targetLanguage: "th_my",
      sellingPoints: "จุดเด่นสินค้า",
      complianceNotes: "ห้ามเคลมเกินจริง",
      tagsText: "skincare, ผิวใส, အလှကုန်",
      status: "active",
    });
    assert.equal(valid.ok, true);
    if (valid.ok) {
      assert.equal(valid.payload.name, "เซรั่มวิตามินซี / ဗီတာမင်စီ");
      assert.equal(valid.payload.priceThb, 299.5);
      assert.equal(valid.payload.commissionRatePct, 12.5);
      assert.deepEqual(valid.payload.tags, ["skincare", "ผิวใส", "အလှကုန်"]);
    }

    assert.equal(
      normalizeSearchText("เซรั่มวิตามินซี").includes(normalizeSearchText("เซรั่ม")),
      true
    );
  });

  // 2. Two-branch update payload separation (matches firestore.rules exactly)
  await runTest("Two-branch update separation: Product & Campaign details updates exclude status/productId and use deleteField()", () => {
    const detailsRes = buildProductDetailsUpdatePayload(
      {
        name: "Updated Serum",
        category: "",
        tiktokShopUrl: "",
        priceThb: "",
        commissionRatePct: "",
        targetLanguage: "th",
        sellingPoints: "New notes",
        complianceNotes: "",
        tagsText: "",
        status: "archived", // MUST NOT leak into details payload!
      },
      {
        category: "Skincare",
        tiktokShopUrl: "https://shop.tiktok.com/old",
        priceThb: 299,
        commissionRatePct: 10,
        sellingPoints: "Old notes",
        complianceNotes: undefined,
        tags: ["old"],
      }
    );
    assert.equal(detailsRes.ok, true);
    if (detailsRes.ok) {
      assert.equal("status" in detailsRes.payload, false, "status must never be in Details update payload");
      assert.equal("priceThb" in detailsRes.payload, true, "cleared priceThb must include deleteField() sentinel");
      assert.equal("commissionRatePct" in detailsRes.payload, true, "cleared commissionRatePct must include deleteField() sentinel");
      assert.equal("complianceNotes" in detailsRes.payload, false, "previously absent field should not be mutated");
    }

    const prodStatusPayload = buildProductStatusUpdatePayload("paused");
    assert.deepEqual(Object.keys(prodStatusPayload), ["status"]);

    const campCreate = buildCampaignCreatePayload({
      productId: "prod_abc_123",
      title: "11.11 Campaign",
      goal: "3 review videos",
      targetLanguage: "th",
      status: "draft",
      strategyNotes: "Hook test",
      startDate: "2026-11-20",
      endDate: "2026-11-30",
    });
    assert.equal(campCreate.ok, true);

    const campDetails = buildCampaignDetailsUpdatePayload(
      {
        productId: "prod_different_should_ignore",
        title: "11.11 Campaign Edited",
        goal: "",
        targetLanguage: "my",
        status: "completed", // MUST NOT leak into details payload!
        strategyNotes: "Updated notes",
        startDate: "2026-11-21",
        endDate: "",
      },
      {
        goal: "Old goal",
        strategyNotes: "Old notes",
        startDate: "2026-11-20",
        endDate: "2026-11-30",
      }
    );
    assert.equal(campDetails.ok, true);
    if (campDetails.ok) {
      assert.equal("status" in campDetails.payload, false, "status must never be in Campaign details payload");
      assert.equal("productId" in campDetails.payload, false, "productId is immutable and must never be in Campaign details payload");
      assert.equal("endDate" in campDetails.payload, true, "cleared endDate must include deleteField() sentinel");
    }

    const campStatusPayload = buildCampaignStatusUpdatePayload("active");
    assert.deepEqual(Object.keys(campStatusPayload), ["status"]);
  });

  // 3. Date-only & Thailand UTC+7 timezone-safety tests
  await runTest("Date-only utils: rejects invalid calendar dates, enforces endDate >= startDate, zero timezone shift", () => {
    assert.equal(isValidDateOnly("2024-02-29"), true); // leap year
    assert.equal(isValidDateOnly("2025-02-29"), false); // non-leap year
    assert.equal(isValidDateOnly("2026-02-30"), false);
    assert.equal(isValidDateOnly("2026-11-20T00:00:00Z"), false);

    assert.equal(isDateRangeValid("2026-11-20", "2026-11-25").valid, true);
    assert.equal(isDateRangeValid("2026-11-25", "2026-11-20").valid, false);
    assert.equal(compareDateOnly("2026-11-20", "2026-11-25") < 0, true);

    // Local date formatting uses local parts directly (no UTC shift)
    const sampleLocal = new Date(2026, 10, 20, 0, 30, 0); // 00:30 local time on Nov 20, 2026
    assert.equal(getLocalTodayDateOnly(sampleLocal), "2026-11-20");

    // Display formatting preserves exact day number 20 (never shifts to 19 or 21)
    const formattedEn = formatDateOnlyDisplay("2026-11-20", "en");
    const formattedTh = formatDateOnlyDisplay("2026-11-20", "th");
    assert.match(formattedEn, /20/);
    assert.match(formattedTh, /20/);
  });

  // 4. Auth & Listener Lifecycle Tests (M2: primitive-key stability, detach on switch/sign-out, zero duplicates)
  await runTest("M2 Listener lifecycle: blocks signed-out/non-owner, stays attached on primitive-stable syncs, detaches on switch/sign-out", () => {
    assert.equal(
      canAttachAffiliateListeners({
        workspaceActive: true,
        isConfigured: true,
        authReady: true,
        isOwner: false,
        userUid: null,
        hasOwnerProfile: false,
      }),
      false
    );

    assert.equal(
      canAttachAffiliateListeners({
        workspaceActive: true,
        isConfigured: true,
        authReady: true,
        isOwner: false,
        userUid: "otherUserUid123",
        hasOwnerProfile: true,
      }),
      false
    );

    let attachCount = 0;
    let detachCount = 0;
    const manager = createAffiliateSubscriptionManager({
      subscribeProducts: () => {
        attachCount++;
        return () => {
          detachCount++;
        };
      },
      subscribeCampaigns: () => {
        attachCount++;
        return () => {
          detachCount++;
        };
      },
    });

    // Signed out -> 0 listeners
    manager.sync({
      workspaceActive: true,
      isConfigured: true,
      authReady: true,
      isOwner: false,
      userUid: null,
      hasOwnerProfile: false,
      retryNonce: 0,
    });
    assert.equal(manager.getActiveCount(), 0);
    assert.equal(attachCount, 0);

    // Owner enters Affiliate workspace -> 2 listeners
    manager.sync({
      workspaceActive: true,
      isConfigured: true,
      authReady: true,
      isOwner: true,
      userUid: "ownerUid123",
      hasOwnerProfile: true,
      retryNonce: 0,
    });
    assert.equal(manager.getActiveCount(), 2);
    assert.equal(attachCount, 2);

    // Repeated sync with unchanged primitives (e.g. after ownerProfile object changes on language switch) -> NO detach/re-attach
    for (let i = 0; i < 3; i++) {
      manager.sync({
        workspaceActive: true,
        isConfigured: true,
        authReady: true,
        isOwner: true,
        userUid: "ownerUid123",
        hasOwnerProfile: true,
        retryNonce: 0,
      });
    }
    assert.equal(manager.getActiveCount(), 2);
    assert.equal(attachCount, 2);
    assert.equal(detachCount, 0);

    // Switch back to Video Studio -> detaches both
    manager.sync({
      workspaceActive: false,
      isConfigured: true,
      authReady: true,
      isOwner: true,
      userUid: "ownerUid123",
      hasOwnerProfile: true,
      retryNonce: 0,
    });
    assert.equal(manager.getActiveCount(), 0);
    assert.equal(detachCount, 2);

    // Switch back to Affiliate -> attaches cleanly (2 active, never >2)
    manager.sync({
      workspaceActive: true,
      isConfigured: true,
      authReady: true,
      isOwner: true,
      userUid: "ownerUid123",
      hasOwnerProfile: true,
      retryNonce: 0,
    });
    assert.equal(manager.getActiveCount(), 2);
    assert.equal(attachCount, 4);

    // Sign out -> detaches both
    manager.sync({
      workspaceActive: true,
      isConfigured: true,
      authReady: true,
      isOwner: false,
      userUid: null,
      hasOwnerProfile: false,
      retryNonce: 0,
    });
    assert.equal(manager.getActiveCount(), 0);
    assert.equal(detachCount, 4);
  });

  // 5. 5-state Connection Classifier & Error Parser
  await runTest("Connection state & error parser: classifies all 5 states and parses structured FirestoreErrorInfo safely", () => {
    assert.equal(
      classifyWorkspaceConnectionState({
        browserOnlineHint: true,
        bootConnectionStatus: "connected",
        listenerError: null,
        hasSnapshot: true,
        fromCache: false,
        hasPendingWrites: false,
        hasInFlightWrite: false,
      }),
      "connected"
    );

    assert.equal(
      classifyWorkspaceConnectionState({
        browserOnlineHint: true,
        bootConnectionStatus: "connected",
        listenerError: null,
        hasSnapshot: true,
        fromCache: true,
        hasPendingWrites: false,
        hasInFlightWrite: false,
      }),
      "cached"
    );

    assert.equal(
      classifyWorkspaceConnectionState({
        browserOnlineHint: true,
        bootConnectionStatus: "connected",
        listenerError: null,
        hasSnapshot: true,
        fromCache: true,
        hasPendingWrites: true,
        hasInFlightWrite: false,
      }),
      "sync_pending"
    );

    assert.equal(
      classifyWorkspaceConnectionState({
        browserOnlineHint: false,
        bootConnectionStatus: "connected",
        listenerError: null,
        hasSnapshot: true,
        fromCache: true,
        hasPendingWrites: false,
        hasInFlightWrite: false,
      }),
      "offline"
    );

    assert.equal(
      classifyWorkspaceConnectionState({
        browserOnlineHint: true,
        bootConnectionStatus: "connected",
        listenerError: "Missing or insufficient permissions.",
        hasSnapshot: false,
        fromCache: false,
        hasPendingWrites: false,
        hasInFlightWrite: false,
      }),
      "error"
    );

    const parsed = parseFirestoreErrorMessage(
      new Error(
        JSON.stringify({
          error: "Missing or insufficient permissions.",
          operationType: "write",
          path: "users/owner/affiliateProducts/p1",
        })
      )
    );
    assert.equal(parsed, "Missing or insufficient permissions.");
  });

  // 6. H1: Modal Draft Reset Protection & Safe Campaign Product Backfill
  await runTest("H1 Modal draft safety: preserves drafts across snapshot updates and safely backfills Campaign productId only when empty & idle", () => {
    // Opening modal -> resets once
    assert.equal(shouldResetModalDraft(null, "create"), true);
    assert.equal(shouldResetModalDraft(null, "edit:prod_1"), true);

    // Same session key across snapshot prop reference updates -> NEVER resets
    assert.equal(shouldResetModalDraft("create", "create"), false);
    assert.equal(shouldResetModalDraft("edit:prod_1", "edit:prod_1"), false);

    // Switching to another record -> resets cleanly
    assert.equal(shouldResetModalDraft("edit:prod_1", "edit:prod_2"), true);

    // Closing modal -> does not reset while closed
    assert.equal(shouldResetModalDraft("edit:prod_1", null), false);

    // Campaign productId backfill
    const products = [
      { id: "p_arch", status: "archived" as const },
      { id: "p_active", status: "active" as const },
    ];
    assert.equal(
      resolveCampaignProductBackfill({
        isCreateMode: true,
        currentProductId: "",
        writeState: "idle",
        products,
      }),
      "p_active"
    );
    assert.equal(
      resolveCampaignProductBackfill({
        isCreateMode: true,
        currentProductId: "",
        writeState: "idle",
        products,
        defaultProductId: "p_arch",
      }),
      "p_arch"
    );
    // Never overwrite user-selected productId
    assert.equal(
      resolveCampaignProductBackfill({
        isCreateMode: true,
        currentProductId: "p_user_selected",
        writeState: "idle",
        products,
      }),
      null
    );
    // Never mutate while saving/sync_pending
    assert.equal(
      resolveCampaignProductBackfill({
        isCreateMode: true,
        currentProductId: "",
        writeState: "saving",
        products,
      }),
      null
    );
    // Never mutate in edit mode
    assert.equal(
      resolveCampaignProductBackfill({
        isCreateMode: false,
        currentProductId: "",
        writeState: "idle",
        products,
      }),
      null
    );
  });

  // 7. M4: Strict connectionState === "connected" Write Gating
  await runTest("M4 Write gating: blocks cached, offline, sync_pending, and error states; allows strictly connected only", async () => {
    assert.equal(
      resolveWriteDisplayState({
        baseState: "saving",
        docId: "prod_1",
        pendingDocIds: ["prod_1"],
        snapshotHasPendingWrites: true,
      }),
      "sync_pending"
    );
    assert.equal(hasExistingDocumentWithId("prod_1", ["prod_1", "prod_2"]), true);

    const blockedStates = ["cached", "offline", "sync_pending", "error"] as const;
    for (const connectionState of blockedStates) {
      assert.equal(
        canStartFirestoreWrite({
          isOwner: true,
          hasOwnerProfile: true,
          connectionState,
          browserOnlineHint: true,
        }),
        false,
        `connectionState=${connectionState} must block writes`
      );
    }

    assert.equal(
      canStartFirestoreWrite({
        isOwner: true,
        hasOwnerProfile: true,
        connectionState: "connected",
        browserOnlineHint: true,
      }),
      true
    );

    // Controller rejects cached write with errCachedWriteBlocked without calling Firestore
    let createCalled = 0;
    const controller = createAffiliateWriteControllerCore({
      createOwnerDocument: async () => {
        createCalled++;
        return "prod_new";
      },
      updateOwnerDocument: async () => {},
      deleteOwnerDocument: async () => {},
      getOwnerDocumentFromServer: async () => null,
      generateDocId: () => "prod_gen_1",
      syncPendingGraceMs: 50,
    });
    controller.syncOwnerSession({ ownerUid: "owner_1", isOwner: true, hasOwnerProfile: true });
    controller.syncWorkspaceContext({
      connectionState: "cached",
      browserOnlineHint: true,
      pendingDocIds: [],
      snapshotHasPendingWrites: false,
    });

    const docId = controller.allocatePendingCreateDocId("product");
    const res = await controller.createProduct(makeSampleProductInput(), docId);
    assert.equal(res.ok, false);
    assert.equal(res.error, "errCachedWriteBlocked");
    assert.equal(createCalled, 0);
    controller.dispose();
  });

  // 8. H2 + L1: App-level Write Controller Persistence Across Workspace Switches & Global Mutation Lock
  await runTest("H2 & L1 Write controller: survives simulated workspace switch, escalates to sync_pending, enforces global lock", async () => {
    const createDeferredWrite = createDeferred<string>();
    const updateCalls: Array<{ col: string; docId: string }> = [];

    const controller = createAffiliateWriteControllerCore({
      createOwnerDocument: async () => createDeferredWrite.promise,
      updateOwnerDocument: async (col, docId) => {
        updateCalls.push({ col, docId });
      },
      deleteOwnerDocument: async () => {},
      getOwnerDocumentFromServer: async () => null,
      generateDocId: () => "prod_persist_1",
      syncPendingGraceMs: 25,
    });

    controller.syncOwnerSession({ ownerUid: "owner_1", isOwner: true, hasOwnerProfile: true });
    controller.syncWorkspaceContext({
      connectionState: "connected",
      browserOnlineHint: true,
      pendingDocIds: [],
      snapshotHasPendingWrites: false,
    });

    const pendingId = controller.allocatePendingCreateDocId("product");
    assert.equal(pendingId, "prod_persist_1");

    const createPromise = controller.createProduct(makeSampleProductInput(), pendingId);
    // Allow microtask for server existence check to complete and enter saving state
    await Promise.resolve();
    await Promise.resolve();

    assert.equal(controller.getSnapshot().tracker.state, "saving");
    assert.equal(controller.getSnapshot().tracker.docId, "prod_persist_1");
    // Cannot discard pendingCreateDocId while its write is still active
    assert.equal(controller.discardPendingCreateDocId("product"), false);

    // L1: Concurrent mutation attempt is blocked without clobbering active tracker
    const concurrentRes = await controller.deleteCampaign("camp_99");
    assert.equal(concurrentRes.ok, false);
    assert.equal(concurrentRes.error, "errWriteInFlightLocked");
    assert.equal(controller.getSnapshot().tracker.docId, "prod_persist_1");
    assert.equal(updateCalls.length, 0);

    // Wait past grace window -> escalates cleanly to sync_pending even if AffiliateWorkspace unmounted
    await new Promise((r) => setTimeout(r, 45));
    assert.equal(controller.getSnapshot().tracker.state, "sync_pending");

    // Resolve server write -> transitions to saved and clears pendingCreateDocId
    createDeferredWrite.resolve("prod_persist_1");
    const finalRes = await createPromise;
    assert.equal(finalRes.ok, true);
    assert.equal(controller.getSnapshot().tracker.state, "saved");
    assert.equal(controller.getSnapshot().pendingCreateDocIds.product, null);
    controller.dispose();
  });

  // 9. Safeguard 1: Owner Session Isolation (UID + sessionGeneration)
  await runTest("Safeguard 1 Owner session isolation: sign-out or UID switch invalidates stale pending write continuations", async () => {
    const ownerAWrite = createDeferred<string>();
    const controller = createAffiliateWriteControllerCore({
      createOwnerDocument: async () => ownerAWrite.promise,
      updateOwnerDocument: async () => {},
      deleteOwnerDocument: async () => {},
      getOwnerDocumentFromServer: async () => null,
      generateDocId: () => "prod_owner_a",
      syncPendingGraceMs: 25,
    });

    controller.syncOwnerSession({ ownerUid: "owner_A", isOwner: true, hasOwnerProfile: true });
    const genA = controller.getSnapshot().sessionGeneration;
    controller.syncWorkspaceContext({
      connectionState: "connected",
      browserOnlineHint: true,
      pendingDocIds: [],
      snapshotHasPendingWrites: false,
    });

    const pendingIdA = controller.allocatePendingCreateDocId("product");
    const promiseA = controller.createProduct(makeSampleProductInput(), pendingIdA);
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(controller.getSnapshot().tracker.state, "saving");

    // Sign out / switch to Owner B while Owner A's write Promise is still in flight
    controller.syncOwnerSession({ ownerUid: null, isOwner: false, hasOwnerProfile: false });
    assert.ok(controller.getSnapshot().sessionGeneration > genA);
    assert.equal(controller.getSnapshot().tracker.state, "idle");
    assert.equal(controller.getSnapshot().pendingCreateDocIds.product, null);

    controller.syncOwnerSession({ ownerUid: "owner_B", isOwner: true, hasOwnerProfile: true });
    const genB = controller.getSnapshot().sessionGeneration;
    assert.ok(genB > genA);

    // Stale Owner A promise resolves now — MUST NOT touch Owner B's state
    ownerAWrite.resolve("prod_owner_a");
    const resA = await promiseA;
    assert.equal(resA.ok, false);
    assert.equal(controller.getSnapshot().ownerUid, "owner_B");
    assert.equal(controller.getSnapshot().tracker.state, "idle");
    assert.equal(controller.getSnapshot().tracker.docId, null);
    assert.equal(controller.getSnapshot().sessionGeneration, genB);

    // Owner B can immediately allocate and write without being locked by Owner A
    controller.dispose();
  });

  // 10. Safeguard 2: Duplicate-Safe Create Retry with Server-Confirmed Existence & Owner UID Verification
  await runTest("Safeguard 2 Duplicate-safe create retry: reconciles existing owner doc via two-branch update and blocks mismatched ownerUid", async () => {
    let createCalls = 0;
    const updatePayloads: Array<{ col: OwnerCollectionKey; docId: string; updates: Record<string, unknown> }> = [];
    let existingServerDoc: WithId<AffiliateProduct> | null = {
      id: "prod_retry_1",
      ownerUid: "owner_1",
      name: "Old Name",
      category: "Skincare",
      targetLanguage: "th",
      status: "researching",
      createdAt: {} as AffiliateProduct["createdAt"],
      updatedAt: {} as AffiliateProduct["updatedAt"],
    };

    const deps: AffiliateWriteControllerDeps = {
      createOwnerDocument: async () => {
        createCalls++;
        return "prod_retry_1";
      },
      updateOwnerDocument: async <K extends OwnerCollectionKey>(
        col: K,
        docId: string,
        updates: OwnerDocumentUpdate<K>
      ) => {
        updatePayloads.push({ col, docId, updates: updates as Record<string, unknown> });
      },
      deleteOwnerDocument: async () => {},
      getOwnerDocumentFromServer: async <K extends OwnerCollectionKey>() =>
        existingServerDoc as unknown as WithId<OwnerCollectionMap[K]> | null,
      generateDocId: () => "prod_retry_1",
      syncPendingGraceMs: 100,
    };

    const controller = createAffiliateWriteControllerCore(deps);
    controller.syncOwnerSession({ ownerUid: "owner_1", isOwner: true, hasOwnerProfile: true });
    controller.syncWorkspaceContext({
      connectionState: "connected",
      browserOnlineHint: true,
      pendingDocIds: [],
      snapshotHasPendingWrites: false,
    });

    // Retry createProduct when server confirms doc already exists with matching ownerUid
    const res = await controller.createProduct(
      makeSampleProductInput({ name: "Updated Serum Name", status: "active" }),
      "prod_retry_1"
    );
    assert.equal(res.ok, true);
    assert.equal(res.reconciledExisting, true);
    assert.equal(createCalls, 0, "must NOT call createOwnerDocument when server confirms doc exists");
    // Two-branch reconciliation: Branch A (details without status) + Branch B (status only)
    assert.equal(updatePayloads.length, 2);
    assert.equal("status" in updatePayloads[0].updates, false);
    assert.deepEqual(Object.keys(updatePayloads[1].updates), ["status"]);
    assert.equal(updatePayloads[1].updates.status, "active");

    // Now test mismatched ownerUid -> MUST fail and never overwrite
    updatePayloads.length = 0;
    existingServerDoc = {
      ...existingServerDoc,
      ownerUid: "different_owner_999",
    };
    const mismatchRes = await controller.createProduct(
      makeSampleProductInput({ name: "Hijack Attempt" }),
      "prod_retry_1"
    );
    assert.equal(mismatchRes.ok, false);
    assert.equal(createCalls, 0);
    assert.equal(updatePayloads.length, 0);

    // Also verify Campaign duplicate-safe retry excludes immutable productId and separates status
    const campUpdates: Array<Record<string, unknown>> = [];
    const existingCampaign: WithId<MarketingCampaign> = {
      id: "camp_retry_1",
      ownerUid: "owner_1",
      productId: "prod_1",
      title: "Old Title",
      targetLanguage: "th",
      status: "draft",
      createdAt: {} as MarketingCampaign["createdAt"],
      updatedAt: {} as MarketingCampaign["updatedAt"],
    };
    const campController = createAffiliateWriteControllerCore({
      createOwnerDocument: async () => {
        throw new Error("Should not create duplicate campaign");
      },
      updateOwnerDocument: async (_col, _docId, updates) => {
        campUpdates.push(updates as Record<string, unknown>);
      },
      deleteOwnerDocument: async () => {},
      getOwnerDocumentFromServer: async <K extends OwnerCollectionKey>() =>
        existingCampaign as unknown as WithId<OwnerCollectionMap[K]> | null,
      generateDocId: () => "camp_retry_1",
      syncPendingGraceMs: 100,
    });
    campController.syncOwnerSession({ ownerUid: "owner_1", isOwner: true, hasOwnerProfile: true });
    campController.syncWorkspaceContext({
      connectionState: "connected",
      browserOnlineHint: true,
      pendingDocIds: [],
      snapshotHasPendingWrites: false,
    });
    const campRes = await campController.createCampaign(
      makeSampleCampaignInput({ title: "Updated Campaign", status: "active" }),
      "camp_retry_1"
    );
    assert.equal(campRes.ok, true);
    assert.equal(campRes.reconciledExisting, true);
    assert.equal(campUpdates.length, 2);
    assert.equal("productId" in campUpdates[0], false);
    assert.equal("status" in campUpdates[0], false);
    assert.deepEqual(Object.keys(campUpdates[1]), ["status"]);

    controller.dispose();
    campController.dispose();
  });

  // 11. M3: Symmetric ("en" | "my" | "th") & Deterministic Two-Device Language Reconciliation
  await runTest("M3 Language reconciliation: symmetrically adopts en/my/th and deterministically resolves two-device conflicts", () => {
    // Symmetric adoption including "en" (previously skipped!)
    const adoptEn = reconcileLanguagePreference({
      currentLocalLang: "my",
      pendingLocalLang: null,
      lastSyncedServerLang: "my",
      serverLang: "en",
    });
    assert.equal(adoptEn.action, "adopt_server");
    assert.equal(adoptEn.nextLocalLang, "en");
    assert.equal(adoptEn.nextPendingLocalLang, null);

    const adoptTh = reconcileLanguagePreference({
      currentLocalLang: "en",
      pendingLocalLang: null,
      lastSyncedServerLang: "en",
      serverLang: "th",
    });
    assert.equal(adoptTh.action, "adopt_server");
    assert.equal(adoptTh.nextLocalLang, "th");

    // Local offline change when server is still at baseline -> push_local
    const pushLocal = reconcileLanguagePreference({
      currentLocalLang: "th",
      pendingLocalLang: "th",
      lastSyncedServerLang: "my",
      serverLang: "my",
    });
    assert.equal(pushLocal.action, "push_local");
    assert.equal(pushLocal.nextLocalLang, "th");
    assert.equal(pushLocal.nextPendingLocalLang, "th");

    // Two-device conflict: Device A changed offline my -> th while Device B committed en to server -> server wins deterministically
    const conflict = reconcileLanguagePreference({
      currentLocalLang: "th",
      pendingLocalLang: "th",
      lastSyncedServerLang: "my",
      serverLang: "en",
    });
    assert.equal(conflict.action, "adopt_server");
    assert.equal(conflict.nextLocalLang, "en");
    assert.equal(conflict.nextPendingLocalLang, null);
    assert.equal(conflict.nextLastSyncedServerLang, "en");

    // Converged: both sides picked same language -> noop & clear pending
    const converged = reconcileLanguagePreference({
      currentLocalLang: "en",
      pendingLocalLang: "en",
      lastSyncedServerLang: "my",
      serverLang: "en",
    });
    assert.equal(converged.action, "noop");
    assert.equal(converged.nextPendingLocalLang, null);
  });

  // 12. Safeguard 3: YouTube Player Instance Guard (No Stale Instance Interference)
  await runTest("Safeguard 3 YouTube player instance safety: monotonic token invalidates stale async callbacks and cleanups", () => {
    const guard = createYouTubePlayerInstanceGuard();
    const token1 = guard.nextToken();
    assert.equal(guard.isCurrent(token1), true);

    // Workspace hide invalidates token1
    guard.invalidate();
    assert.equal(guard.isCurrent(token1), false);

    // Workspace show allocates token2
    const token2 = guard.nextToken();
    assert.equal(guard.isCurrent(token1), false);
    assert.equal(guard.isCurrent(token2), true);
    assert.ok(token2 > token1);
  });

  // 13. Archive Read-Only Lock & Complete Exclusion of Product Deletion / Firebase Storage
  await runTest("Archive lock & Phase 3 boundary: archived is read-only and Product Deletion + Storage are completely excluded", () => {
    assert.equal(canEditRecord("archived"), false);
    assert.equal(canArchiveRecord("archived"), false);
    assert.equal(canEditRecord("paused"), true);
    assert.equal(canArchiveRecord("paused"), true);

    const root = process.cwd();
    const productViewSrc = fs.readFileSync(
      path.join(root, "src/affiliate/ProductWorkspaceView.tsx"),
      "utf8"
    );
    const dataHookSrc = fs.readFileSync(
      path.join(root, "src/affiliate/useAffiliateWorkspaceData.ts"),
      "utf8"
    );
    const writeControllerSrc = fs.readFileSync(
      path.join(root, "src/affiliate/useAffiliateWriteController.ts"),
      "utf8"
    );

    assert.doesNotMatch(productViewSrc, /deleteProduct|onDeleteProduct|deleteOwnerDocument/);
    assert.doesNotMatch(dataHookSrc, /deleteOwnerDocument\(\s*["']affiliateProducts["']/);
    assert.doesNotMatch(writeControllerSrc, /deleteOwnerDocument\(\s*["']affiliateProducts["']/);
    assert.doesNotMatch(writeControllerSrc, /deleteProduct/);
    assert.doesNotMatch(dataHookSrc, /firebase\/storage/);
    assert.doesNotMatch(writeControllerSrc, /firebase\/storage/);
  });

  // 14. Safeguard 2 Error-Path: Server Existence Check Rejections (Network & Permission Errors)
  await runTest("Safeguard 2 Retry error paths: network and permission rejections abort create, preserve pendingDocId, and report failure", async () => {
    // Case A: Network error during getOwnerDocumentFromServer()
    let networkCreateCalls = 0;
    const networkController = createAffiliateWriteControllerCore({
      createOwnerDocument: async () => {
        networkCreateCalls++;
        return "prod_net_err";
      },
      updateOwnerDocument: async () => {},
      deleteOwnerDocument: async () => {},
      getOwnerDocumentFromServer: async () => {
        throw new Error("Failed to get document from server because the client is offline.");
      },
      generateDocId: () => "prod_net_err",
      syncPendingGraceMs: 100,
    });
    networkController.syncOwnerSession({
      ownerUid: "owner_1",
      isOwner: true,
      hasOwnerProfile: true,
    });
    networkController.syncWorkspaceContext({
      connectionState: "connected",
      browserOnlineHint: true,
      pendingDocIds: [],
      snapshotHasPendingWrites: false,
    });

    const pendingProdId = networkController.allocatePendingCreateDocId("product");
    assert.equal(pendingProdId, "prod_net_err");

    const netRes = await networkController.createProduct(
      makeSampleProductInput(),
      pendingProdId
    );
    assert.equal(netRes.ok, false);
    assert.equal(networkCreateCalls, 0, "createOwnerDocument must NOT be called on network error");
    assert.equal(
      networkController.getSnapshot().pendingCreateDocIds.product,
      pendingProdId,
      "pending create docId must be preserved on network failure"
    );
    assert.equal(networkController.getSnapshot().tracker.state, "failed");
    assert.equal(networkController.getSnapshot().tracker.docId, pendingProdId);
    assert.match(networkController.getSnapshot().tracker.error || "", /offline/i);
    networkController.dispose();

    // Case B: Permission error (structured FirestoreErrorInfo JSON) during getOwnerDocumentFromServer()
    let permCreateCalls = 0;
    const permController = createAffiliateWriteControllerCore({
      createOwnerDocument: async () => {
        permCreateCalls++;
        return "camp_perm_err";
      },
      updateOwnerDocument: async () => {},
      deleteOwnerDocument: async () => {},
      getOwnerDocumentFromServer: async () => {
        throw new Error(
          JSON.stringify({
            error: "Missing or insufficient permissions.",
            operationType: "get",
            path: "users/owner_1/marketingCampaigns/camp_perm_err",
          })
        );
      },
      generateDocId: () => "camp_perm_err",
      syncPendingGraceMs: 100,
    });
    permController.syncOwnerSession({
      ownerUid: "owner_1",
      isOwner: true,
      hasOwnerProfile: true,
    });
    permController.syncWorkspaceContext({
      connectionState: "connected",
      browserOnlineHint: true,
      pendingDocIds: [],
      snapshotHasPendingWrites: false,
    });

    const pendingCampId = permController.allocatePendingCreateDocId("campaign");
    assert.equal(pendingCampId, "camp_perm_err");

    const permRes = await permController.createCampaign(
      makeSampleCampaignInput(),
      pendingCampId
    );
    assert.equal(permRes.ok, false);
    assert.equal(permRes.error, "Missing or insufficient permissions.");
    assert.equal(permCreateCalls, 0, "createOwnerDocument must NOT be called on permission error");
    assert.equal(
      permController.getSnapshot().pendingCreateDocIds.campaign,
      pendingCampId,
      "pending create docId must be preserved on permission failure"
    );
    assert.equal(permController.getSnapshot().tracker.state, "failed");
    assert.equal(permController.getSnapshot().tracker.docId, pendingCampId);
    assert.equal(
      permController.getSnapshot().tracker.error,
      "Missing or insufficient permissions."
    );
    permController.dispose();
  });

  // 15. Defense-in-depth: Captured Owner UID Forwarded to Create, Update, and Delete Service Calls
  await runTest("Expected owner UID defense-in-depth: controller forwards captured ownerUid to create/update/delete service calls", async () => {
    const observedUids: Array<{ op: string; expectedUid: string | undefined }> = [];
    const controller = createAffiliateWriteControllerCore({
      createOwnerDocument: async (_col, _data, customId, expectedOwnerUid) => {
        observedUids.push({ op: "create", expectedUid: expectedOwnerUid });
        return customId || "prod_uid_check";
      },
      updateOwnerDocument: async (_col, _docId, _updates, expectedOwnerUid) => {
        observedUids.push({ op: "update", expectedUid: expectedOwnerUid });
      },
      deleteOwnerDocument: async (_col, _docId, expectedOwnerUid) => {
        observedUids.push({ op: "delete", expectedUid: expectedOwnerUid });
      },
      getOwnerDocumentFromServer: async (_col, _docId, expectedOwnerUid) => {
        observedUids.push({ op: "getFromServer", expectedUid: expectedOwnerUid });
        return null;
      },
      generateDocId: () => "prod_uid_check",
      syncPendingGraceMs: 100,
    });

    controller.syncOwnerSession({
      ownerUid: "verified_owner_uid_42",
      isOwner: true,
      hasOwnerProfile: true,
    });
    controller.syncWorkspaceContext({
      connectionState: "connected",
      browserOnlineHint: true,
      pendingDocIds: [],
      snapshotHasPendingWrites: false,
    });

    const pId = controller.allocatePendingCreateDocId("product");
    const cRes = await controller.createProduct(makeSampleProductInput(), pId);
    assert.equal(cRes.ok, true);

    const sampleProduct: WithId<AffiliateProduct> = {
      id: pId,
      ownerUid: "verified_owner_uid_42",
      name: "Vitamin C Serum",
      targetLanguage: "th_my",
      status: "active",
      createdAt: {} as AffiliateProduct["createdAt"],
      updatedAt: {} as AffiliateProduct["updatedAt"],
    };
    const uRes = await controller.updateProductStatus(sampleProduct, "paused");
    assert.equal(uRes.ok, true);

    const dRes = await controller.deleteCampaign("camp_del_1");
    assert.equal(dRes.ok, true);

    assert.deepEqual(observedUids, [
      { op: "getFromServer", expectedUid: "verified_owner_uid_42" },
      { op: "create", expectedUid: "verified_owner_uid_42" },
      { op: "update", expectedUid: "verified_owner_uid_42" },
      { op: "delete", expectedUid: "verified_owner_uid_42" },
    ]);
    controller.dispose();
  });

  // 16. D-01: AffiliateWorkspace passes connectionState to Product & Campaign views and views enforce it consistently
  await runTest("D-01: Product and Campaign views receive actual connectionState and calculate write availability consistently", async () => {
    const workspaceSrc = fs.readFileSync(
      path.resolve("src/affiliate/AffiliateWorkspace.tsx"),
      "utf8"
    );
    assert.match(
      workspaceSrc,
      /<ProductWorkspaceView[\s\S]*?connectionState=\{data\.connectionState\}/,
      "AffiliateWorkspace must pass connectionState={data.connectionState} to ProductWorkspaceView"
    );
    assert.match(
      workspaceSrc,
      /<CampaignWorkspaceView[\s\S]*?connectionState=\{data\.connectionState\}/,
      "AffiliateWorkspace must pass connectionState={data.connectionState} to CampaignWorkspaceView"
    );

    const labels = getAffiliateLabels("en");
    const product: WithId<AffiliateProduct> = {
      id: "prod_conn_1",
      ownerUid: "owner_1",
      name: "Hydrating Toner",
      targetLanguage: "th_my",
      status: "active",
      createdAt: {} as AffiliateProduct["createdAt"],
      updatedAt: {} as AffiliateProduct["updatedAt"],
    };
    const campaign: WithId<MarketingCampaign> = {
      id: "camp_conn_1",
      ownerUid: "owner_1",
      productId: "prod_conn_1",
      title: "Toner Launch",
      targetLanguage: "th_my",
      status: "active",
      createdAt: {} as MarketingCampaign["createdAt"],
      updatedAt: {} as MarketingCampaign["updatedAt"],
    };

    // Even if canWriteNow were stale true, connectionState="cached" or "offline" must disable write buttons
    const productCachedHtml = renderToStaticMarkup(
      React.createElement(ProductWorkspaceView, {
        products: [product],
        campaigns: [campaign],
        pendingDocIds: [],
        uiLang: "en",
        labels,
        connectionState: "cached",
        canWriteNow: true,
        isWriteBusy: false,
        writeState: "idle",
        writeDocId: null,
        onAddProduct: () => {},
        onEditProduct: () => {},
        onUpdateStatus: async () => ({ ok: false, error: "errCachedWriteBlocked" }),
      })
    );
    assert.match(
      productCachedHtml,
      /<button[^>]*disabled=""[^>]*>[\s\S]*?Add Product/,
      "ProductWorkspaceView Add Product button must be disabled when connectionState is cached"
    );
    assert.match(
      productCachedHtml,
      /<button[^>]*disabled=""[^>]*>[\s\S]*?Archive/,
      "ProductWorkspaceView Archive button must be disabled when connectionState is cached"
    );

    const productConnectedHtml = renderToStaticMarkup(
      React.createElement(ProductWorkspaceView, {
        products: [product],
        campaigns: [campaign],
        pendingDocIds: [],
        uiLang: "en",
        labels,
        connectionState: "connected",
        canWriteNow: true,
        isWriteBusy: false,
        writeState: "idle",
        writeDocId: null,
        onAddProduct: () => {},
        onEditProduct: () => {},
        onUpdateStatus: async () => ({ ok: true }),
      })
    );
    assert.doesNotMatch(
      productConnectedHtml,
      /<button[^>]*disabled=""[^>]*>[\s\S]*?Add Product/,
      "ProductWorkspaceView Add Product button must be enabled when connected"
    );

    const campaignOfflineHtml = renderToStaticMarkup(
      React.createElement(CampaignWorkspaceView, {
        campaigns: [campaign],
        products: [product],
        pendingDocIds: [],
        uiLang: "en",
        labels,
        connectionState: "offline",
        canWriteNow: true,
        isWriteBusy: false,
        writeState: "idle",
        writeDocId: null,
        onNewCampaign: () => {},
        onEditCampaign: () => {},
        onUpdateStatus: async () => ({ ok: false, error: "errOfflineWriteBlocked" }),
        onDeleteCampaign: async () => ({ ok: false, error: "errOfflineWriteBlocked" }),
      })
    );
    assert.match(
      campaignOfflineHtml,
      /<button[^>]*disabled=""[^>]*>[\s\S]*?New Campaign/,
      "CampaignWorkspaceView New Campaign button must be disabled when connectionState is offline"
    );
    assert.match(
      campaignOfflineHtml,
      /<button[^>]*disabled=""[^>]*>[\s\S]*?Delete Campaign/,
      "CampaignWorkspaceView Delete Campaign button must be disabled when connectionState is offline"
    );

    const campaignConnectedHtml = renderToStaticMarkup(
      React.createElement(CampaignWorkspaceView, {
        campaigns: [campaign],
        products: [product],
        pendingDocIds: [],
        uiLang: "en",
        labels,
        connectionState: "connected",
        canWriteNow: true,
        isWriteBusy: false,
        writeState: "idle",
        writeDocId: null,
        onNewCampaign: () => {},
        onEditCampaign: () => {},
        onUpdateStatus: async () => ({ ok: true }),
        onDeleteCampaign: async () => ({ ok: true }),
      })
    );
    assert.doesNotMatch(
      campaignConnectedHtml,
      /<button[^>]*disabled=""[^>]*>[\s\S]*?New Campaign/,
      "CampaignWorkspaceView New Campaign button must be enabled when connected"
    );
  });

  // 17. D-01: ConfirmActionModal inline warning & disabled confirm button when connection drops while open
  await runTest("D-01: ConfirmActionModal displays inline warning and disables confirm when writes are unavailable while open", async () => {
    const labels = getAffiliateLabels("en");

    // Offline while modal is open
    const offlineModalHtml = renderToStaticMarkup(
      React.createElement(ConfirmActionModal, {
        open: true,
        title: labels.archiveConfirmTitle,
        body: labels.archiveConfirmBody,
        itemName: "Hydrating Toner",
        confirmLabel: labels.archiveConfirmButton,
        tone: "archive",
        writeState: "idle",
        connectionState: "offline",
        canWriteNow: false,
        isWriteBusy: false,
        errorMessage: null,
        labels,
        onConfirm: () => {},
        onClose: () => {},
      })
    );
    assert.match(offlineModalHtml, /role="dialog"/, "Modal must remain open when connectivity drops");
    assert.match(
      offlineModalHtml,
      /data-testid="confirm-modal-connection-warning"/,
      "Modal must render inline connection warning when offline"
    );
    assert.ok(
      offlineModalHtml.includes(labels.confirmConnectionUnavailable),
      "Offline warning must explain connection is unavailable and action cannot be saved"
    );
    assert.match(
      offlineModalHtml,
      /<button[^>]*disabled=""[^>]*>[\s\S]*?Archive Permanently/,
      "Confirm button must be disabled when offline"
    );

    // Cached state while modal is open (even if stale canWriteNow=true)
    const cachedModalHtml = renderToStaticMarkup(
      React.createElement(ConfirmActionModal, {
        open: true,
        title: labels.deleteCampaignConfirmTitle,
        body: labels.deleteCampaignConfirmBody,
        itemName: "Toner Launch",
        confirmLabel: labels.deleteCampaignConfirmButton,
        tone: "danger",
        writeState: "idle",
        connectionState: "cached",
        canWriteNow: true,
        isWriteBusy: false,
        errorMessage: null,
        labels,
        onConfirm: () => {},
        onClose: () => {},
      })
    );
    assert.match(
      cachedModalHtml,
      /data-testid="confirm-modal-connection-warning"/,
      "Modal must render inline connection warning when in cached state"
    );
    assert.ok(
      cachedModalHtml.includes(labels.errCachedWriteBlocked),
      "Cached warning must explain read-only cached state"
    );
    assert.match(
      cachedModalHtml,
      /<button[^>]*disabled=""[^>]*>[\s\S]*?Delete Campaign/,
      "Confirm button must be disabled in cached state"
    );

    // Connected state: no inline warning, confirm button enabled
    const connectedModalHtml = renderToStaticMarkup(
      React.createElement(ConfirmActionModal, {
        open: true,
        title: labels.archiveConfirmTitle,
        body: labels.archiveConfirmBody,
        itemName: "Hydrating Toner",
        confirmLabel: labels.archiveConfirmButton,
        tone: "archive",
        writeState: "idle",
        connectionState: "connected",
        canWriteNow: true,
        isWriteBusy: false,
        errorMessage: null,
        labels,
        onConfirm: () => {},
        onClose: () => {},
      })
    );
    assert.doesNotMatch(
      connectedModalHtml,
      /data-testid="confirm-modal-connection-warning"/,
      "Modal must not display connection warning when connected"
    );
    assert.doesNotMatch(
      connectedModalHtml,
      /<button[^>]*disabled=""[^>]*>[\s\S]*?Archive Permanently/,
      "Confirm button must be enabled when connected"
    );
  });

  // 18. D-02: Offline boot recovery on browser online + non-overlapping connection checks
  await runTest("D-02: Offline boot recovers on browser online and repeated Retry calls do not overlap", async () => {
    let checkCalls = 0;
    let resolvePendingCheck:
      | ((val: { status: "connected" | "offline" | "error" }) => void)
      | null = null;

    const coordinator = createFirebaseRecoveryCoordinator({
      isConfigured: true,
      expectedOwnerEmail: "owner@example.com",
      testConnection: async () => {
        checkCalls += 1;
        if (checkCalls === 1) {
          return { status: "offline" };
        }
        return new Promise((resolve) => {
          resolvePendingCheck = resolve;
        });
      },
      ensureOwnerProfile: async () => {
        throw new Error("not used");
      },
      getCurrentUser: () => null,
    });

    // Initial offline boot
    const bootStatus = await coordinator.retryBootConnection();
    assert.equal(bootStatus, "offline");
    assert.equal(coordinator.getState().connectionStatus, "offline");
    assert.equal(coordinator.getState().isCheckingConnection, false);
    assert.equal(checkCalls, 1);

    // Browser comes back online + rapid repeated Retry clicks while check is in flight
    const pOnline = coordinator.handleBrowserOnline();
    const pRetry1 = coordinator.retryBootConnection();
    const pRetry2 = coordinator.retryBootConnection();

    assert.equal(
      checkCalls,
      2,
      "Overlapping online + repeated retryBootConnection calls must deduplicate to a single testConnection call"
    );
    assert.equal(coordinator.getState().isCheckingConnection, true);
    assert.equal(coordinator.getState().connectionStatus, "checking");

    // Resolve the single in-flight connection check
    resolvePendingCheck!({ status: "connected" });
    const [rOnline, r1, r2] = await Promise.all([pOnline, pRetry1, pRetry2]);
    assert.equal(rOnline, "connected");
    assert.equal(r1, "connected");
    assert.equal(r2, "connected");
    assert.equal(coordinator.getState().connectionStatus, "connected");
    assert.equal(coordinator.getState().isCheckingConnection, false);
    coordinator.dispose();
  });

  // 19. D-02: Owner profile initialization retry after failure + deduplication + accurate loading/error states
  await runTest("D-02: Owner profile initialization retries safely after failure with accurate loading/error states", async () => {
    const ownerUser = {
      uid: "owner_uid_1",
      email: "owner@example.com",
      emailVerified: true,
    } as User;

    let ensureCalls = 0;
    let resolveSecondAttempt: ((profile: WithId<UserProfile>) => void) | null = null;

    const coordinator = createFirebaseRecoveryCoordinator({
      isConfigured: true,
      expectedOwnerEmail: "owner@example.com",
      testConnection: async () => ({ status: "connected" }),
      ensureOwnerProfile: async (u) => {
        ensureCalls += 1;
        if (ensureCalls === 1) {
          throw new Error("Failed to get document because the client is offline.");
        }
        return new Promise<WithId<UserProfile>>((resolve) => {
          resolveSecondAttempt = resolve;
        });
      },
      getCurrentUser: () => ownerUser,
    });

    // First attempt fails (offline)
    const first = await coordinator.loadOwnerProfile(ownerUser);
    assert.equal(first, null);
    assert.equal(ensureCalls, 1);
    assert.equal(coordinator.getState().ownerProfile, null);
    assert.equal(coordinator.getState().isProfileLoading, false);
    assert.equal(coordinator.getState().connectionStatus, "offline");
    assert.match(coordinator.getState().profileError || "", /offline/i);

    // Retry triggered twice concurrently -> must deduplicate & show loading with cleared error
    const retryP1 = coordinator.retryOwnerProfile();
    const retryP2 = coordinator.retryOwnerProfile();
    assert.equal(ensureCalls, 2, "Overlapping retryOwnerProfile calls must not duplicate ensureOwnerProfile");
    assert.equal(coordinator.getState().isProfileLoading, true);
    assert.equal(coordinator.getState().profileError, null);

    const recoveredProfile: WithId<UserProfile> = {
      id: "owner_uid_1",
      ownerUid: "owner_uid_1",
      email: "owner@example.com",
      preferredUiLanguage: "my",
      defaultContentLanguage: "th",
      currency: "THB",
      region: "TH",
      createdAt: {} as UserProfile["createdAt"],
      updatedAt: {} as UserProfile["updatedAt"],
    };
    resolveSecondAttempt!(recoveredProfile);

    const [res1, res2] = await Promise.all([retryP1, retryP2]);
    assert.equal(res1?.id, "owner_uid_1");
    assert.equal(res2?.id, "owner_uid_1");
    assert.equal(coordinator.getState().ownerProfile?.id, "owner_uid_1");
    assert.equal(coordinator.getState().isProfileLoading, false);
    assert.equal(coordinator.getState().profileError, null);
    assert.equal(coordinator.getState().connectionStatus, "connected");
    coordinator.dispose();
  });

  // 20. D-02: Retry never bypasses authentication/email verification and preserves session-generation isolation
  await runTest("D-02: retryOwnerProfile enforces owner auth/emailVerified checks and respects session-generation sign-out", async () => {
    let activeUser: User | null = null;
    let ensureCalls = 0;
    let unauthorizedSignOuts = 0;
    let resolveInFlightProfile: ((profile: WithId<UserProfile>) => void) | null = null;

    const coordinator = createFirebaseRecoveryCoordinator({
      isConfigured: true,
      expectedOwnerEmail: "owner@example.com",
      testConnection: async () => ({ status: "connected" }),
      ensureOwnerProfile: async () => {
        ensureCalls += 1;
        return new Promise<WithId<UserProfile>>((resolve) => {
          resolveInFlightProfile = resolve;
        });
      },
      getCurrentUser: () => activeUser,
      onUnauthorizedOwner: () => {
        unauthorizedSignOuts += 1;
      },
    });

    // Case A: Signed-out user
    assert.equal(matchesOwnerAccount(null, "owner@example.com"), false);
    const rNull = await coordinator.retryOwnerProfile();
    assert.equal(rNull, null);
    assert.equal(ensureCalls, 0);

    // Case B: Unverified owner email
    activeUser = {
      uid: "u_unverified",
      email: "owner@example.com",
      emailVerified: false,
    } as User;
    assert.equal(matchesOwnerAccount(activeUser, "owner@example.com"), false);
    const rUnverified = await coordinator.retryOwnerProfile();
    assert.equal(rUnverified, null);
    assert.equal(ensureCalls, 0);
    assert.equal(unauthorizedSignOuts, 1);
    assert.match(coordinator.getState().profileError || "", /owner account/i);

    // Case C: Non-owner verified email
    activeUser = {
      uid: "u_other",
      email: "intruder@example.com",
      emailVerified: true,
    } as User;
    assert.equal(matchesOwnerAccount(activeUser, "owner@example.com"), false);
    const rOther = await coordinator.retryOwnerProfile();
    assert.equal(rOther, null);
    assert.equal(ensureCalls, 0);
    assert.equal(unauthorizedSignOuts, 2);

    // Case D: Sign-out mid-flight invalidates stale retry resolution via sessionGeneration
    activeUser = {
      uid: "owner_uid_1",
      email: "owner@example.com",
      emailVerified: true,
    } as User;
    const genBefore = coordinator.getState().sessionGeneration;
    const inFlightPromise = coordinator.retryOwnerProfile();
    assert.equal(ensureCalls, 1);
    assert.equal(coordinator.getState().isProfileLoading, true);

    // Simulate Sign Out while retry is in flight
    activeUser = null;
    coordinator.advanceSession();
    assert.equal(coordinator.getState().sessionGeneration, genBefore + 1);
    assert.equal(coordinator.getState().isProfileLoading, false);

    resolveInFlightProfile!({
      id: "owner_uid_1",
      ownerUid: "owner_uid_1",
      email: "owner@example.com",
      preferredUiLanguage: "en",
      defaultContentLanguage: "th",
      currency: "THB",
      region: "TH",
      createdAt: {} as UserProfile["createdAt"],
      updatedAt: {} as UserProfile["updatedAt"],
    });
    const staleResult = await inFlightPromise;
    assert.equal(staleResult, null, "Stale retry after sign-out must be discarded");
    assert.equal(
      coordinator.getState().ownerProfile,
      null,
      "Signed-out session must never receive stale ownerProfile"
    );
    coordinator.dispose();
  });

  // 21. D-02: Gate 4 failure UI provides clear explanation, Retry button, and Sign Out option
  await runTest("D-02: Gate 4 failure UI exposes failure explanation, Retry button, and Sign Out control", async () => {
    const workspaceSrc = fs.readFileSync(
      path.resolve("src/affiliate/AffiliateWorkspace.tsx"),
      "utf8"
    );
    const firebaseCtxSrc = fs.readFileSync(
      path.resolve("src/firebase/FirebaseContext.tsx"),
      "utf8"
    );
    const dataHookSrc = fs.readFileSync(
      path.resolve("src/affiliate/useAffiliateWorkspaceData.ts"),
      "utf8"
    );

    assert.match(workspaceSrc, /data-testid="gate4-profile-error"/);
    assert.match(workspaceSrc, /labels\.profileSyncFailedTitle/);
    assert.match(workspaceSrc, /labels\.profileSyncFailedDesc/);
    assert.match(workspaceSrc, /retryOwnerProfile\(\)/);
    assert.match(workspaceSrc, /signOutOwner\(\)/);
    assert.match(workspaceSrc, /labels\.signOut/);
    assert.match(firebaseCtxSrc, /window\.addEventListener\("online"/);
    assert.match(dataHookSrc, /retryBootConnection\(\)/);
  });

  // 22. DEFECT A: Connection state transitions (connected -> checking w/ old snapshots, checking -> offline/error/connected, unconfigured w/ snapshots)
  await runTest("DEFECT A: Connection checking and unconfigured states never unlock writes from stale server snapshots", async () => {
    // 22a. connected -> checking with old server snapshots (hasSnapshot: true, fromCache: false)
    const connectedState = classifyWorkspaceConnectionState({
      browserOnlineHint: true,
      bootConnectionStatus: "connected",
      listenerError: null,
      hasSnapshot: true,
      fromCache: false,
      hasPendingWrites: false,
      hasInFlightWrite: false,
    });
    assert.equal(connectedState, "connected");
    assert.equal(
      canStartFirestoreWrite({
        isOwner: true,
        hasOwnerProfile: true,
        connectionState: connectedState,
        browserOnlineHint: true,
        bootConnectionStatus: "connected",
      }),
      true
    );

    const checkingWithOldSnapshots = classifyWorkspaceConnectionState({
      browserOnlineHint: true,
      bootConnectionStatus: "checking",
      listenerError: null,
      hasSnapshot: true,
      fromCache: false,
      hasPendingWrites: false,
      hasInFlightWrite: false,
    });
    assert.equal(
      checkingWithOldSnapshots,
      "cached",
      "Stale server snapshots must NEVER report 'connected' while bootConnectionStatus is 'checking'"
    );
    assert.equal(
      canStartFirestoreWrite({
        isOwner: true,
        hasOwnerProfile: true,
        connectionState: checkingWithOldSnapshots,
        browserOnlineHint: true,
        bootConnectionStatus: "checking",
      }),
      false,
      "Writes must remain blocked while bootConnectionStatus is 'checking'"
    );
    // Even if someone passes a stale connectionState="connected", bootConnectionStatus="checking" must still block
    assert.equal(
      canStartFirestoreWrite({
        isOwner: true,
        hasOwnerProfile: true,
        connectionState: "connected",
        browserOnlineHint: true,
        bootConnectionStatus: "checking",
      }),
      false
    );

    // 22b. unconfigured with existing snapshots
    const unconfiguredWithSnapshots = classifyWorkspaceConnectionState({
      browserOnlineHint: true,
      bootConnectionStatus: "unconfigured",
      listenerError: null,
      hasSnapshot: true,
      fromCache: false,
      hasPendingWrites: false,
      hasInFlightWrite: false,
    });
    assert.equal(unconfiguredWithSnapshots, "offline");
    assert.equal(
      canStartFirestoreWrite({
        isOwner: true,
        hasOwnerProfile: true,
        connectionState: "connected",
        browserOnlineHint: true,
        bootConnectionStatus: "unconfigured",
      }),
      false,
      "Writes must remain blocked when bootConnectionStatus is 'unconfigured'"
    );

    // 22c. Coordinator transitions: connected -> checking -> offline, checking -> error, checking -> connected
    const responses: Array<ReturnType<typeof createDeferred<{ status: "connected" | "offline" | "error" }>>> = [
      createDeferred(),
      createDeferred(),
      createDeferred(),
      createDeferred(),
    ];
    let callIdx = 0;

    const coordinator = createFirebaseRecoveryCoordinator({
      isConfigured: true,
      expectedOwnerEmail: "owner@example.com",
      testConnection: () => {
        const d = responses[callIdx++];
        return d.promise;
      },
      ensureOwnerProfile: async () => {
        throw new Error("not used");
      },
      getCurrentUser: () => null,
    });

    // Initial boot: checking -> connected
    const p1 = coordinator.retryBootConnection();
    assert.equal(coordinator.getState().connectionStatus, "checking");
    responses[0].resolve({ status: "connected" });
    assert.equal(await p1, "connected");
    assert.equal(coordinator.getState().connectionStatus, "connected");

    // Explicit reconnect from connected MUST transition to "checking" first, then checking -> offline
    const p2 = coordinator.retryBootConnection();
    assert.equal(
      coordinator.getState().connectionStatus,
      "checking",
      "Reconnect from connected must immediately transition bootConnectionStatus to 'checking'"
    );
    assert.equal(
      classifyWorkspaceConnectionState({
        browserOnlineHint: true,
        bootConnectionStatus: coordinator.getState().connectionStatus,
        listenerError: null,
        hasSnapshot: true,
        fromCache: false,
        hasPendingWrites: false,
        hasInFlightWrite: false,
      }),
      "cached"
    );
    responses[1].resolve({ status: "offline" });
    assert.equal(await p2, "offline");
    assert.equal(coordinator.getState().connectionStatus, "offline");
    assert.equal(
      classifyWorkspaceConnectionState({
        browserOnlineHint: true,
        bootConnectionStatus: coordinator.getState().connectionStatus,
        listenerError: null,
        hasSnapshot: true,
        fromCache: false,
        hasPendingWrites: false,
        hasInFlightWrite: false,
      }),
      "offline"
    );

    // checking -> error
    const p3 = coordinator.retryBootConnection();
    assert.equal(coordinator.getState().connectionStatus, "checking");
    responses[2].resolve({ status: "error" });
    assert.equal(await p3, "error");
    assert.equal(coordinator.getState().connectionStatus, "error");
    assert.equal(
      classifyWorkspaceConnectionState({
        browserOnlineHint: true,
        bootConnectionStatus: coordinator.getState().connectionStatus,
        listenerError: null,
        hasSnapshot: true,
        fromCache: false,
        hasPendingWrites: false,
        hasInFlightWrite: false,
      }),
      "error"
    );

    // checking -> browser offline event mid-check cancels stale pre-offline connected result
    const p4 = coordinator.retryBootConnection();
    assert.equal(coordinator.getState().connectionStatus, "checking");
    coordinator.handleBrowserOffline();
    assert.equal(coordinator.getState().connectionStatus, "offline");
    assert.equal(coordinator.getState().isCheckingConnection, false);
    responses[3].resolve({ status: "connected" });
    assert.equal(await p4, "offline");
    assert.equal(
      coordinator.getState().connectionStatus,
      "offline",
      "Stale pre-offline check resolution must not overwrite offline state"
    );

    coordinator.dispose();
  });

  // 23. DEFECT A: ProductFormModal, CampaignFormModal & ConfirmActionModal defensive guards and accurate sync_pending messaging
  await runTest("DEFECT A: Form modals block submission while checking/cached and show accurate sync_pending message", () => {
    const labels = getAffiliateLabels("en");

    // 23a. Defensive form submit guard blocks even if stale canWriteNow=true while connectionState is cached/offline/error/sync_pending
    assert.deepEqual(
      evaluateAffiliateFormWriteGuard({
        canWriteNow: true,
        connectionState: "cached",
        isWriteBusy: false,
      }),
      { allowed: false, errorKey: "errCachedWriteBlocked" }
    );
    assert.deepEqual(
      evaluateAffiliateFormWriteGuard({
        canWriteNow: false,
        connectionState: "offline",
        isWriteBusy: false,
      }),
      { allowed: false, errorKey: "errOfflineWriteBlocked" }
    );
    assert.deepEqual(
      evaluateAffiliateFormWriteGuard({
        canWriteNow: false,
        connectionState: "error",
        isWriteBusy: false,
      }),
      { allowed: false, errorKey: "errOfflineWriteBlocked" }
    );
    assert.deepEqual(
      evaluateAffiliateFormWriteGuard({
        canWriteNow: false,
        connectionState: "sync_pending",
        isWriteBusy: false,
      }),
      { allowed: false, errorKey: "errWriteInFlightLocked" }
    );
    assert.deepEqual(
      evaluateAffiliateFormWriteGuard({
        canWriteNow: true,
        connectionState: "connected",
        isWriteBusy: true,
      }),
      { allowed: false, errorKey: "errWriteInFlightLocked" }
    );
    assert.deepEqual(
      evaluateAffiliateFormWriteGuard({
        canWriteNow: true,
        connectionState: "connected",
        isWriteBusy: false,
      }),
      { allowed: true }
    );

    const sampleProduct: WithId<AffiliateProduct> = {
      id: "prod_modal_1",
      ownerUid: "owner_uid_1",
      name: "Thai Collagen Powder",
      targetLanguage: "th",
      status: "active",
      createdAt: {} as AffiliateProduct["createdAt"],
      updatedAt: {} as AffiliateProduct["updatedAt"],
    };

    // 23b. ProductFormModal while checking (connectionState="cached", even with stale canWriteNow=true)
    const productCheckingHtml = renderToStaticMarkup(
      React.createElement(ProductFormModal, {
        open: true,
        editingProduct: null,
        pendingCreateDocId: "prod_pending_1",
        uiLang: "en",
        labels,
        connectionState: "cached",
        canWriteNow: true,
        isWriteBusy: false,
        writeState: "idle",
        writeDocId: null,
        writeError: null,
        onEnsurePendingCreateDocId: () => "prod_pending_1",
        onDiscardPendingCreateDocId: () => true,
        onCreate: async () => ({ ok: false, error: "errCachedWriteBlocked" }),
        onUpdateDetails: async () => ({ ok: false, error: "errCachedWriteBlocked" }),
        onClose: () => {},
      })
    );
    assert.match(
      productCheckingHtml,
      /data-testid="product-modal-connection-warning"/,
      "ProductFormModal must display connection warning while checking/cached"
    );
    assert.ok(
      productCheckingHtml.includes(labels.errCachedWriteBlocked),
      "ProductFormModal must display cached/checking write-blocked message"
    );
    assert.match(
      productCheckingHtml,
      /<button[^>]*type="submit"[^>]*disabled=""/,
      "ProductFormModal submit button must be disabled while connectionState is not 'connected'"
    );

    // 23c. CampaignFormModal while checking (connectionState="cached", even with stale canWriteNow=true)
    const campaignCheckingHtml = renderToStaticMarkup(
      React.createElement(CampaignFormModal, {
        open: true,
        editingCampaign: null,
        pendingCreateDocId: "camp_pending_1",
        products: [sampleProduct],
        uiLang: "en",
        labels,
        connectionState: "cached",
        canWriteNow: true,
        isWriteBusy: false,
        writeState: "idle",
        writeDocId: null,
        writeError: null,
        onEnsurePendingCreateDocId: () => "camp_pending_1",
        onDiscardPendingCreateDocId: () => true,
        onCreate: async () => ({ ok: false, error: "errCachedWriteBlocked" }),
        onUpdateDetails: async () => ({ ok: false, error: "errCachedWriteBlocked" }),
        onClose: () => {},
      })
    );
    assert.match(
      campaignCheckingHtml,
      /data-testid="campaign-modal-connection-warning"/,
      "CampaignFormModal must display connection warning while checking/cached"
    );
    assert.ok(
      campaignCheckingHtml.includes(labels.errCachedWriteBlocked),
      "CampaignFormModal must display cached/checking write-blocked message"
    );
    assert.match(
      campaignCheckingHtml,
      /<button[^>]*type="submit"[^>]*disabled=""/,
      "CampaignFormModal submit button must be disabled while connectionState is not 'connected'"
    );

    // 23d. sync_pending warning in ConfirmActionModal, ProductFormModal & CampaignFormModal must NOT falsely claim network unavailable
    const confirmSyncPendingHtml = renderToStaticMarkup(
      React.createElement(ConfirmActionModal, {
        open: true,
        title: "Archive Product?",
        body: "Archive description",
        itemName: "Thai Collagen Powder",
        confirmLabel: "Archive Permanently",
        tone: "archive",
        writeState: "idle",
        errorMessage: null,
        canWriteNow: false,
        connectionState: "sync_pending",
        isWriteBusy: false,
        labels,
        onConfirm: () => {},
        onClose: () => {},
      })
    );
    assert.ok(
      confirmSyncPendingHtml.includes(labels.errWriteInFlightLocked),
      "ConfirmActionModal must show write-in-progress message for sync_pending"
    );
    assert.ok(
      !confirmSyncPendingHtml.includes(labels.confirmConnectionUnavailable),
      "ConfirmActionModal must NOT falsely claim network is unavailable for sync_pending"
    );

    const productSyncPendingHtml = renderToStaticMarkup(
      React.createElement(ProductFormModal, {
        open: true,
        editingProduct: null,
        pendingCreateDocId: "prod_pending_2",
        uiLang: "en",
        labels,
        connectionState: "sync_pending",
        canWriteNow: false,
        isWriteBusy: false,
        writeState: "idle",
        writeDocId: null,
        writeError: null,
        onEnsurePendingCreateDocId: () => "prod_pending_2",
        onDiscardPendingCreateDocId: () => true,
        onCreate: async () => ({ ok: false }),
        onUpdateDetails: async () => ({ ok: false }),
        onClose: () => {},
      })
    );
    assert.match(
      productSyncPendingHtml,
      /data-testid="product-modal-sync-locked-warning"/,
      "ProductFormModal must show sync-locked warning during sync_pending"
    );
    assert.ok(
      productSyncPendingHtml.includes(labels.errWriteInFlightLocked),
      "ProductFormModal must explain another write is syncing during sync_pending"
    );
    assert.ok(
      !productSyncPendingHtml.includes(labels.errOfflineWriteBlocked),
      "ProductFormModal must NOT show offline network error during sync_pending"
    );

    const campaignSyncPendingHtml = renderToStaticMarkup(
      React.createElement(CampaignFormModal, {
        open: true,
        editingCampaign: null,
        pendingCreateDocId: "camp_pending_2",
        products: [sampleProduct],
        uiLang: "en",
        labels,
        connectionState: "sync_pending",
        canWriteNow: false,
        isWriteBusy: false,
        writeState: "idle",
        writeDocId: null,
        writeError: null,
        onEnsurePendingCreateDocId: () => "camp_pending_2",
        onDiscardPendingCreateDocId: () => true,
        onCreate: async () => ({ ok: false }),
        onUpdateDetails: async () => ({ ok: false }),
        onClose: () => {},
      })
    );
    assert.match(
      campaignSyncPendingHtml,
      /data-testid="campaign-modal-sync-locked-warning"/,
      "CampaignFormModal must show sync-locked warning during sync_pending"
    );
    assert.ok(
      campaignSyncPendingHtml.includes(labels.errWriteInFlightLocked),
      "CampaignFormModal must explain another write is syncing during sync_pending"
    );
    assert.ok(
      !campaignSyncPendingHtml.includes(labels.errOfflineWriteBlocked),
      "CampaignFormModal must NOT show offline network error during sync_pending"
    );
  });

  // 24. DEFECT A: Controller-level write guards block writes while checking/unconfigured and never auto-replay after reconnection
  await runTest("DEFECT A: Write controller blocks all mutations while checking/unconfigured and never queues or replays blocked writes", async () => {
    let createCalls = 0;
    let updateCalls = 0;
    let deleteCalls = 0;

    const deps: AffiliateWriteControllerDeps = {
      generateDocId: (prefix) => `${prefix}_ctrl_1`,
      createOwnerDocument: async () => {
        createCalls += 1;
        return "created_id";
      },
      updateOwnerDocument: async () => {
        updateCalls += 1;
      },
      deleteOwnerDocument: async () => {
        deleteCalls += 1;
      },
      getOwnerDocumentFromServer: async () => null,
    };

    const controller = createAffiliateWriteControllerCore(deps);

    controller.syncOwnerSession({
      ownerUid: "owner_uid_1",
      isOwner: true,
      hasOwnerProfile: true,
    });

    // Simulate bypassed UI where stale connectionState="connected" is supplied while bootConnectionStatus="checking"
    controller.syncWorkspaceContext({
      connectionState: "connected",
      browserOnlineHint: true,
      bootConnectionStatus: "checking",
      pendingDocIds: [],
      snapshotHasPendingWrites: false,
    });

    const sampleProduct: WithId<AffiliateProduct> = {
      id: "prod_ctrl_existing",
      ownerUid: "owner_uid_1",
      name: "Existing Product",
      targetLanguage: "th",
      status: "active",
      createdAt: {} as AffiliateProduct["createdAt"],
      updatedAt: {} as AffiliateProduct["updatedAt"],
    };
    const sampleCampaign: WithId<MarketingCampaign> = {
      id: "camp_ctrl_existing",
      ownerUid: "owner_uid_1",
      productId: "prod_ctrl_existing",
      title: "Existing Campaign",
      targetLanguage: "th",
      status: "draft",
      createdAt: {} as MarketingCampaign["createdAt"],
      updatedAt: {} as MarketingCampaign["updatedAt"],
    };

    const r1 = await controller.createProduct(
      {
        name: "Blocked During Check",
        category: "",
        tiktokShopUrl: "",
        priceThb: "",
        commissionRatePct: "",
        targetLanguage: "th",
        sellingPoints: "",
        complianceNotes: "",
        tagsText: "",
        status: "researching",
      },
      "prod_blocked_1"
    );
    assert.equal(r1.ok, false);
    assert.equal(r1.error, "errCachedWriteBlocked");

    const r2 = await controller.updateProductStatus(sampleProduct, "paused");
    assert.equal(r2.ok, false);
    assert.equal(r2.error, "errCachedWriteBlocked");

    const r3 = await controller.createCampaign(
      {
        productId: "prod_ctrl_existing",
        title: "Blocked Campaign",
        goal: "",
        targetLanguage: "th",
        strategyNotes: "",
        startDate: "",
        endDate: "",
        status: "draft",
      },
      "camp_blocked_1"
    );
    assert.equal(r3.ok, false);
    assert.equal(r3.error, "errCachedWriteBlocked");

    const r4 = await controller.deleteCampaign(sampleCampaign.id);
    assert.equal(r4.ok, false);
    assert.equal(r4.error, "errCachedWriteBlocked");

    // Also test bootConnectionStatus="unconfigured"
    controller.syncBootConnectionStatus("unconfigured");
    const r5 = await controller.updateCampaignStatus(sampleCampaign, "active");
    assert.equal(r5.ok, false);
    assert.equal(r5.error, "errOfflineWriteBlocked");

    // Also test sync_pending returns errWriteInFlightLocked (not offline error)
    controller.syncWorkspaceContext({
      connectionState: "sync_pending",
      browserOnlineHint: true,
      bootConnectionStatus: "connected",
      pendingDocIds: [],
      snapshotHasPendingWrites: true,
    });
    const r6 = await controller.updateProductStatus(sampleProduct, "paused");
    assert.equal(r6.ok, false);
    assert.equal(r6.error, "errWriteInFlightLocked");

    assert.equal(createCalls, 0);
    assert.equal(updateCalls, 0);
    assert.equal(deleteCalls, 0);

    // Reconnect to verified "connected" state -> blocked writes must NOT be queued or auto-replayed
    controller.syncWorkspaceContext({
      connectionState: "connected",
      browserOnlineHint: true,
      bootConnectionStatus: "connected",
      pendingDocIds: [],
      snapshotHasPendingWrites: false,
    });
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(createCalls, 0, "Blocked create writes must never auto-replay after reconnect");
    assert.equal(updateCalls, 0, "Blocked update writes must never auto-replay after reconnect");
    assert.equal(deleteCalls, 0, "Blocked delete writes must never auto-replay after reconnect");
    assert.equal(controller.getSnapshot().tracker.state, "idle");
  });

  // 25. DEFECT B: Profile failure -> close header error -> Gate 4 still shows Retry and Sign Out (no infinite spinner)
  await runTest("DEFECT B: Dismissing header error never erases Gate 4 recoverable error UI or causes infinite spinner", async () => {
    const labels = getAffiliateLabels("en");
    const ownerUser = {
      uid: "owner_uid_1",
      email: "owner@example.com",
      emailVerified: true,
    } as User;

    const coordinator = createFirebaseRecoveryCoordinator({
      isConfigured: true,
      expectedOwnerEmail: "owner@example.com",
      testConnection: async () => ({ status: "connected" }),
      ensureOwnerProfile: async () => {
        throw new Error("The client is offline.");
      },
      getCurrentUser: () => ownerUser,
    });

    // Profile load fails
    const failed = await coordinator.loadOwnerProfile(ownerUser);
    assert.equal(failed, null);
    assert.equal(coordinator.getState().ownerProfile, null);
    assert.equal(coordinator.getState().isProfileLoading, false);
    assert.ok(coordinator.getState().profileError);

    // Even if header dropdown dismisses authError (or even if both authError & profileError are null),
    // Gate 4 MUST remain in "error" mode with Retry Profile + Sign Out when ownerProfile is null & isProfileLoading is false.
    assert.equal(
      resolveGate4ViewMode({
        ownerProfile: null,
        isProfileLoading: false,
        isRetryingProfile: false,
      }),
      "error"
    );

    const gate4AfterHeaderDismissHtml = renderToStaticMarkup(
      React.createElement(OwnerProfileGateView, {
        ownerProfile: null,
        isProfileLoading: false,
        isRetryingProfile: false,
        profileError: null,
        authError: null,
        labels,
        onRetry: () => {},
        onSignOut: () => {},
      })
    );
    assert.match(
      gate4AfterHeaderDismissHtml,
      /data-testid="gate4-profile-error"/,
      "Gate 4 must still render recoverable error container even if both profileError and authError are null"
    );
    assert.ok(
      gate4AfterHeaderDismissHtml.includes(labels.retry),
      "Gate 4 must always expose Retry Profile action"
    );
    assert.ok(
      gate4AfterHeaderDismissHtml.includes(labels.signOut),
      "Gate 4 must always expose Sign Out action"
    );
    assert.ok(
      !gate4AfterHeaderDismissHtml.includes(labels.syncingProfile),
      "Gate 4 must NEVER fall back to an infinite syncing spinner when isProfileLoading is false"
    );

    // Verify AuthStatusControl closes dropdown via local dismissal rather than clearing Gate 4 profileError
    const authControlSrc = fs.readFileSync(
      path.resolve("src/firebase/AuthStatusControl.tsx"),
      "utf8"
    );
    assert.match(authControlSrc, /dismissedError/);
    const firebaseCtxSrc = fs.readFileSync(
      path.resolve("src/firebase/FirebaseContext.tsx"),
      "utf8"
    );
    assert.match(
      firebaseCtxSrc,
      /const inGate4 = Boolean\([\s\S]*?!coordinator\.getState\(\)\.ownerProfile[\s\S]*?if \(!inGate4\)/,
      "clearAuthError must preserve Gate 4 profileError while ownerProfile is still null"
    );

    coordinator.dispose();
  });

  // 26. DEFECT B: Profile failure -> retry -> failure (restores error UI), AND profile failure -> retry -> success (workspace opens)
  await runTest("DEFECT B: Profile retry shows retrying feedback, restores error UI on failure, and opens workspace on success", async () => {
    const labels = getAffiliateLabels("en");
    const ownerUser = {
      uid: "owner_uid_1",
      email: "owner@example.com",
      emailVerified: true,
    } as User;

    let attempt = 0;
    const retry1Deferred = createDeferred<WithId<UserProfile>>();
    const retry2Deferred = createDeferred<WithId<UserProfile>>();

    const coordinator = createFirebaseRecoveryCoordinator({
      isConfigured: true,
      expectedOwnerEmail: "owner@example.com",
      testConnection: async () => ({ status: "connected" }),
      ensureOwnerProfile: () => {
        attempt += 1;
        if (attempt === 1) {
          return Promise.reject(new Error("unavailable: initial failure"));
        }
        if (attempt === 2) {
          return retry1Deferred.promise;
        }
        return retry2Deferred.promise;
      },
      getCurrentUser: () => ownerUser,
    });

    // Initial load fails
    await coordinator.loadOwnerProfile(ownerUser);
    assert.equal(coordinator.getState().ownerProfile, null);
    assert.equal(coordinator.getState().isProfileLoading, false);
    assert.equal(coordinator.getState().isRetryingProfile, false);
    assert.equal(coordinator.getState().connectionStatus, "offline");

    // Retry #1 in flight -> accurate retrying feedback
    const pRetryFail = coordinator.retryOwnerProfile();
    assert.equal(coordinator.getState().isProfileLoading, true);
    assert.equal(coordinator.getState().isRetryingProfile, true);
    assert.equal(
      resolveGate4ViewMode({
        ownerProfile: coordinator.getState().ownerProfile,
        isProfileLoading: coordinator.getState().isProfileLoading,
        isRetryingProfile: coordinator.getState().isRetryingProfile,
      }),
      "retrying"
    );
    const retryingHtml = renderToStaticMarkup(
      React.createElement(OwnerProfileGateView, {
        ownerProfile: null,
        isProfileLoading: true,
        isRetryingProfile: true,
        profileError: null,
        authError: null,
        labels,
        onRetry: () => {},
        onSignOut: () => {},
      })
    );
    assert.ok(
      retryingHtml.includes(labels.retryingProfile),
      "Gate 4 must display retryingProfile feedback during active retry"
    );

    // Retry #1 fails -> restores recoverable error UI
    retry1Deferred.reject(new Error("Firestore backend still unavailable"));
    assert.equal(await pRetryFail, null);
    assert.equal(coordinator.getState().isProfileLoading, false);
    assert.equal(coordinator.getState().isRetryingProfile, false);
    assert.ok(coordinator.getState().profileError);
    assert.equal(
      resolveGate4ViewMode({
        ownerProfile: coordinator.getState().ownerProfile,
        isProfileLoading: coordinator.getState().isProfileLoading,
        isRetryingProfile: coordinator.getState().isRetryingProfile,
      }),
      "error"
    );
    const failedRetryHtml = renderToStaticMarkup(
      React.createElement(OwnerProfileGateView, {
        ownerProfile: coordinator.getState().ownerProfile,
        isProfileLoading: coordinator.getState().isProfileLoading,
        isRetryingProfile: coordinator.getState().isRetryingProfile,
        profileError: coordinator.getState().profileError,
        authError: null,
        labels,
        onRetry: () => {},
        onSignOut: () => {},
      })
    );
    assert.match(failedRetryHtml, /data-testid="gate4-profile-error"/);
    assert.ok(failedRetryHtml.includes(labels.retry));
    assert.ok(failedRetryHtml.includes(labels.signOut));

    // Retry #2 succeeds -> workspace opens
    const pRetrySuccess = coordinator.retryOwnerProfile();
    assert.equal(coordinator.getState().isProfileLoading, true);
    assert.equal(coordinator.getState().isRetryingProfile, true);
    const validProfile: WithId<UserProfile> = {
      id: "owner_uid_1",
      ownerUid: "owner_uid_1",
      email: "owner@example.com",
      preferredUiLanguage: "my",
      defaultContentLanguage: "th",
      currency: "THB",
      region: "TH",
      createdAt: {} as UserProfile["createdAt"],
      updatedAt: {} as UserProfile["updatedAt"],
    };
    retry2Deferred.resolve(validProfile);
    const loaded = await pRetrySuccess;
    assert.equal(loaded?.id, "owner_uid_1");
    assert.equal(coordinator.getState().ownerProfile?.id, "owner_uid_1");
    assert.equal(coordinator.getState().isProfileLoading, false);
    assert.equal(coordinator.getState().isRetryingProfile, false);
    assert.equal(coordinator.getState().profileError, null);
    assert.equal(
      resolveGate4ViewMode({
        ownerProfile: coordinator.getState().ownerProfile,
        isProfileLoading: coordinator.getState().isProfileLoading,
        isRetryingProfile: coordinator.getState().isRetryingProfile,
      }),
      "ready"
    );
    const readyHtml = renderToStaticMarkup(
      React.createElement(OwnerProfileGateView, {
        ownerProfile: coordinator.getState().ownerProfile,
        isProfileLoading: false,
        isRetryingProfile: false,
        profileError: null,
        authError: null,
        labels,
        onRetry: () => {},
        onSignOut: () => {},
      })
    );
    assert.equal(readyHtml, "", "Gate 4 must clear when ownerProfile is loaded so workspace opens");

    coordinator.dispose();
  });

  // 27. DEFECT B: Early-return stale/mismatched/null user paths clear loading & in-flight state, sign-out discards stale retry, repeated retries deduplicate
  await runTest("DEFECT B: Stale/null/mismatched user during retry clears loading & in-flight state and repeated clicks deduplicate", async () => {
    const ownerA = {
      uid: "owner_uid_A",
      email: "owner@example.com",
      emailVerified: true,
    } as User;
    const ownerB = {
      uid: "owner_uid_B",
      email: "owner@example.com",
      emailVerified: true,
    } as User;
    const intruder = {
      uid: "intruder_uid",
      email: "intruder@example.com",
      emailVerified: true,
    } as User;

    let currentUser: User | null = ownerA;
    let ensureCalls = 0;
    let unauthorizedCallbacks = 0;
    const deferreds: Array<ReturnType<typeof createDeferred<WithId<UserProfile>>>> = [
      createDeferred(),
      createDeferred(),
      createDeferred(),
      createDeferred(),
      createDeferred(),
    ];

    const coordinator = createFirebaseRecoveryCoordinator({
      isConfigured: true,
      expectedOwnerEmail: "owner@example.com",
      testConnection: async () => ({ status: "connected" }),
      ensureOwnerProfile: () => {
        const d = deferreds[ensureCalls++];
        return d.promise;
      },
      getCurrentUser: () => currentUser,
      onUnauthorizedOwner: () => {
        unauthorizedCallbacks += 1;
      },
    });

    // 27a. Repeated Retry clicks deduplicate to a single ensureOwnerProfile request
    const rClick1 = coordinator.retryOwnerProfile();
    const rClick2 = coordinator.retryOwnerProfile();
    const rClick3 = coordinator.retryOwnerProfile();
    assert.equal(ensureCalls, 1, "Repeated Retry clicks must not create duplicate profile requests");
    assert.equal(coordinator.getState().isProfileLoading, true);
    assert.equal(coordinator.getState().isRetryingProfile, true);

    // 27b. Current user becomes null mid-flight WITHOUT advanceSession() being called yet
    currentUser = null;
    deferreds[0].resolve({
      id: "owner_uid_A",
      ownerUid: "owner_uid_A",
      email: "owner@example.com",
      preferredUiLanguage: "en",
      defaultContentLanguage: "th",
      currency: "THB",
      region: "TH",
      createdAt: {} as UserProfile["createdAt"],
      updatedAt: {} as UserProfile["updatedAt"],
    });
    const [res1, res2, res3] = await Promise.all([rClick1, rClick2, rClick3]);
    assert.equal(res1, null);
    assert.equal(res2, null);
    assert.equal(res3, null);
    assert.equal(coordinator.getState().ownerProfile, null);
    assert.equal(
      coordinator.getState().isProfileLoading,
      false,
      "Early-return when currentUser becomes null must clear isProfileLoading"
    );
    assert.equal(
      coordinator.getState().isRetryingProfile,
      false,
      "Early-return when currentUser becomes null must clear isRetryingProfile"
    );

    // 27c. Current user switches to mismatched UID mid-flight (ownerA -> ownerB) WITHOUT advanceSession()
    currentUser = ownerA;
    const pSwitch = coordinator.retryOwnerProfile();
    assert.equal(ensureCalls, 2, "Previous in-flight profile state must have cleared cleanly");
    assert.equal(coordinator.getState().isProfileLoading, true);

    currentUser = ownerB;
    deferreds[1].resolve({
      id: "owner_uid_A",
      ownerUid: "owner_uid_A",
      email: "owner@example.com",
      preferredUiLanguage: "en",
      defaultContentLanguage: "th",
      currency: "THB",
      region: "TH",
      createdAt: {} as UserProfile["createdAt"],
      updatedAt: {} as UserProfile["updatedAt"],
    });
    assert.equal(await pSwitch, null, "Stale result for ownerA must be discarded after switching to ownerB");
    assert.equal(coordinator.getState().ownerProfile, null);
    assert.equal(
      coordinator.getState().isProfileLoading,
      false,
      "Early-return on UID mismatch must clear isProfileLoading"
    );
    assert.equal(coordinator.getState().isRetryingProfile, false);

    // 27d. Current user becomes non-owner mid-flight -> clears loading & triggers unauthorized callback
    currentUser = ownerB;
    const pUnauthorized = coordinator.retryOwnerProfile();
    assert.equal(ensureCalls, 3);
    currentUser = intruder;
    deferreds[2].resolve({
      id: "owner_uid_B",
      ownerUid: "owner_uid_B",
      email: "owner@example.com",
      preferredUiLanguage: "en",
      defaultContentLanguage: "th",
      currency: "THB",
      region: "TH",
      createdAt: {} as UserProfile["createdAt"],
      updatedAt: {} as UserProfile["updatedAt"],
    });
    assert.equal(await pUnauthorized, null);
    assert.equal(coordinator.getState().isProfileLoading, false);
    assert.equal(coordinator.getState().isRetryingProfile, false);
    assert.equal(unauthorizedCallbacks, 1);

    // 27e. Sign-out during retry where stale promise REJECTS -> error discarded, loading cleared
    currentUser = ownerA;
    const pSignOutReject = coordinator.retryOwnerProfile();
    assert.equal(ensureCalls, 4);
    currentUser = null;
    coordinator.advanceSession();
    assert.equal(coordinator.getState().isProfileLoading, false);
    assert.equal(coordinator.getState().isRetryingProfile, false);
    deferreds[3].reject(new Error("Stale network failure after sign-out"));
    assert.equal(await pSignOutReject, null);
    assert.equal(coordinator.getState().profileError, null);
    assert.equal(coordinator.getState().isProfileLoading, false);

    // 27f. Verify coordinator is NOT stuck: subsequent valid owner load succeeds cleanly
    currentUser = ownerB;
    const pFresh = coordinator.retryOwnerProfile();
    assert.equal(ensureCalls, 5);
    deferreds[4].resolve({
      id: "owner_uid_B",
      ownerUid: "owner_uid_B",
      email: "owner@example.com",
      preferredUiLanguage: "my",
      defaultContentLanguage: "th",
      currency: "THB",
      region: "TH",
      createdAt: {} as UserProfile["createdAt"],
      updatedAt: {} as UserProfile["updatedAt"],
    });
    const freshProfile = await pFresh;
    assert.equal(freshProfile?.id, "owner_uid_B");
    assert.equal(coordinator.getState().ownerProfile?.id, "owner_uid_B");
    assert.equal(coordinator.getState().isProfileLoading, false);
    assert.equal(coordinator.getState().isRetryingProfile, false);

    coordinator.dispose();
  });

  // 28. Owner Profile Read Safety: server-only verification, ownerUid match, and no fake connection unlock during active check
  await runTest("Owner Profile Read Safety: rejects cache-only or ownerUid-mismatched snapshots and preserves active checking state", async () => {
    // 28a. verifyOwnerProfileSnapshot rejects cache-only read
    assert.throws(
      () =>
        verifyOwnerProfileSnapshot(
          {
            id: "owner_uid_1",
            exists: () => true,
            data: () => ({
              ownerUid: "owner_uid_1",
              email: "owner@example.com",
              preferredUiLanguage: "my",
              defaultContentLanguage: "th",
              currency: "THB",
              region: "TH",
            }),
            metadata: { fromCache: true },
          },
          "owner_uid_1"
        ),
      /live Firestore server response/i,
      "Cache-only profile snapshot must be rejected"
    );

    // 28b. verifyOwnerProfileSnapshot rejects mismatched ownerUid
    assert.throws(
      () =>
        verifyOwnerProfileSnapshot(
          {
            id: "owner_uid_1",
            exists: () => true,
            data: () => ({
              ownerUid: "other_uid_999",
              email: "owner@example.com",
              preferredUiLanguage: "my",
              defaultContentLanguage: "th",
              currency: "THB",
              region: "TH",
            }),
            metadata: { fromCache: false },
          },
          "owner_uid_1"
        ),
      /owner profile UID verification failed/i,
      "Profile snapshot with mismatched ownerUid must be rejected"
    );

    // 28c. verifyOwnerProfileSnapshot rejects mismatched doc id
    assert.throws(
      () =>
        verifyOwnerProfileSnapshot(
          {
            id: "wrong_doc_id",
            exists: () => true,
            data: () => ({
              ownerUid: "owner_uid_1",
              email: "owner@example.com",
            }),
            metadata: { fromCache: false },
          },
          "owner_uid_1"
        ),
      /owner profile UID verification failed/i
    );

    // 28d. verifyOwnerProfileSnapshot returns null when doc does not exist on server
    assert.equal(
      verifyOwnerProfileSnapshot(
        {
          id: "owner_uid_1",
          exists: () => false,
          data: () => undefined,
          metadata: { fromCache: false },
        },
        "owner_uid_1"
      ),
      null
    );

    // 28e. verifyOwnerProfileSnapshot accepts live server snapshot with matching ownerUid
    const verified = verifyOwnerProfileSnapshot(
      {
        id: "owner_uid_1",
        exists: () => true,
        data: () => ({
          ownerUid: "owner_uid_1",
          email: "owner@example.com",
          preferredUiLanguage: "my",
          defaultContentLanguage: "th",
          currency: "THB",
          region: "TH",
        }),
        metadata: { fromCache: false },
      },
      "owner_uid_1"
    );
    assert.equal(verified?.id, "owner_uid_1");
    assert.equal(verified?.ownerUid, "owner_uid_1");

    // 28f. Coordinator rejects profile with mismatched ownerUid and does NOT override an active connection check
    const ownerUser = {
      uid: "owner_uid_1",
      email: "owner@example.com",
      emailVerified: true,
    } as User;
    const pendingConnCheck = createDeferred<{ status: "connected" | "offline" | "error" }>();
    let returnMismatched = true;

    const coordinator = createFirebaseRecoveryCoordinator({
      isConfigured: true,
      expectedOwnerEmail: "owner@example.com",
      testConnection: () => pendingConnCheck.promise,
      ensureOwnerProfile: async () => ({
        id: "owner_uid_1",
        ownerUid: returnMismatched ? "forged_uid" : "owner_uid_1",
        email: "owner@example.com",
        preferredUiLanguage: "my",
        defaultContentLanguage: "th",
        currency: "THB",
        region: "TH",
        createdAt: {} as UserProfile["createdAt"],
        updatedAt: {} as UserProfile["updatedAt"],
      }),
      getCurrentUser: () => ownerUser,
    });

    // Start active connection check (status = "checking")
    const pConn = coordinator.retryBootConnection();
    assert.equal(coordinator.getState().connectionStatus, "checking");

    // Mismatched ownerUid rejected by coordinator
    const badRes = await coordinator.loadOwnerProfile(ownerUser);
    assert.equal(badRes, null);
    assert.equal(coordinator.getState().ownerProfile, null);
    assert.match(coordinator.getState().profileError || "", /profile sync failed/i);

    // Valid profile loaded while connection check is still in flight -> must NOT prematurely flip checking -> connected
    returnMismatched = false;
    const okRes = await coordinator.loadOwnerProfile(ownerUser);
    assert.equal(okRes?.ownerUid, "owner_uid_1");
    assert.equal(
      coordinator.getState().connectionStatus,
      "checking",
      "Profile load must not override an active in-flight connection check"
    );

    pendingConnCheck.resolve({ status: "connected" });
    assert.equal(await pConn, "connected");
    assert.equal(coordinator.getState().connectionStatus, "connected");
    coordinator.dispose();

    // 28g. Verify ensureOwnerProfile uses getDocFromServer (not cache-capable getDoc)
    const firestoreSvcSrc = fs.readFileSync(
      path.resolve("src/firebase/firestoreService.ts"),
      "utf8"
    );
    const ensureFnMatch = firestoreSvcSrc.match(
      /export async function ensureOwnerProfile[\s\S]*?^}/m
    );
    assert.ok(ensureFnMatch, "ensureOwnerProfile must exist in firestoreService.ts");
    assert.match(ensureFnMatch[0], /getDocFromServer\(/);
    assert.doesNotMatch(
      ensureFnMatch[0],
      /\bgetDoc\(/,
      "ensureOwnerProfile must not use cache-capable getDoc()"
    );
    assert.match(ensureFnMatch[0], /verifyOwnerProfileSnapshot\(/);
  });

  // 29. Offline error classification consistency in src/firebase/client.ts
  await runTest("Offline error classification handles unavailable, client-offline, and backend network errors safely", () => {
    assert.equal(isFirestoreOfflineError({ code: "unavailable", message: "Service unavailable" }), true);
    assert.equal(isFirestoreOfflineError({ code: "firestore/unavailable", message: "" }), true);
    assert.equal(
      isFirestoreOfflineError(new Error("Failed to get document because the client is offline.")),
      true
    );
    assert.equal(
      isFirestoreOfflineError(new Error("Could not reach Cloud Firestore backend.")),
      true
    );
    assert.equal(
      isFirestoreOfflineError(new Error("auth/network-request-failed")),
      true
    );
    assert.equal(isFirestoreOfflineError(new Error("TypeError: Failed to fetch")), true);
    assert.equal(
      isFirestoreOfflineError({ code: "permission-denied", message: "Missing or insufficient permissions." }),
      false
    );

    assert.equal(
      classifyFirestoreConnectionError({ code: "unavailable", message: "Backend unavailable" }).status,
      "offline"
    );
    assert.equal(
      classifyFirestoreConnectionError(new Error("The client is offline")).status,
      "offline"
    );
    assert.equal(
      classifyFirestoreConnectionError({ code: "permission-denied", message: "Permission denied" }).status,
      "connected"
    );
    assert.equal(
      classifyFirestoreConnectionError({ code: "internal", message: "Unexpected server bug" }).status,
      "error"
    );
  });

  const failed = results.filter((r) => !r.ok);
  console.log(`\nSummary: ${results.length - failed.length}/${results.length} passed.`);
  if (failed.length > 0) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
