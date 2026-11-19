/**
 * Phase 2 Verification Suite for NineRatioSixteenStudio Firebase Foundation.
 *
 * Run with: npx tsx firestore.rules.test.ts
 *
 * Verifies:
 * 1. Firestore & Storage security rule invariants against the Phase 0 security_spec.md "Dirty Dozen"
 * 2. Blueprint <-> Rules <-> Client schema synchronization
 * 3. Graceful handling of missing or placeholder Firebase credentials
 * 4. Storage MIME/size/filename validation (including Thai & Myanmar Unicode file names)
 * 5. Server-side Firebase ID token verifier rejection of malformed/invalid tokens
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import { validateFirebaseConfigObject } from "./src/firebase/config";
import {
  OWNER_SUBCOLLECTIONS,
  SAFE_FILENAME_REGEX,
  isValidDocumentId,
  sanitizeStorageFileName,
  validateStorageFile,
} from "./src/firebase/schema";
import {
  getServerFirebaseProjectId,
  verifyFirebaseIdToken,
} from "./server/firebaseAuth";

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

async function main() {
  const root = process.cwd();
  const firestoreRules = fs.readFileSync(path.join(root, "firestore.rules"), "utf8");
  const storageRules = fs.readFileSync(path.join(root, "storage.rules"), "utf8");
  const blueprint = JSON.parse(
    fs.readFileSync(path.join(root, "firebase-blueprint.json"), "utf8")
  ) as {
    entities: Record<string, unknown>;
    firestore: Record<string, { schema: string; description: string }>;
  };

  // 1. Default-deny catch-all in both rules files
  await runTest("Dirty Dozen #1: Default-deny catch-all present in firestore.rules and storage.rules", () => {
    assert.match(firestoreRules, /match \/\{document=\*\*\}\s*\{\s*allow read, write: if false;\s*\}/);
    assert.match(storageRules, /match \/\{allPaths=\*\*\}\s*\{\s*allow read, write: if false;\s*\}/);
  });

  // 2. Single-owner verified email gate & user listing prohibition
  await runTest("Dirty Dozen #2 & #3: Verified single-owner gate & allow list: if false on /users/{userId}", () => {
    assert.match(firestoreRules, /function isVerifiedOwner\(\)/);
    assert.match(firestoreRules, /request\.auth\.token\.email_verified == true/);
    assert.match(firestoreRules, /request\.auth\.token\.email == 'zla264995@gmail\.com'/);
    assert.match(firestoreRules, /match \/users\/\{userId\}[\s\S]*?allow list: if false;/);
    assert.match(firestoreRules, /match \/users\/\{userId\}[\s\S]*?allow delete: if false;/);
  });

  // 3. Exhaustive Blueprint <-> Firestore Rules coverage for all 10 owner subcollections + profile
  await runTest("Blueprint coverage: All 11 entities and paths match firestore.rules", () => {
    assert.equal(Object.keys(blueprint.entities).length, 11);
    assert.equal(Object.keys(blueprint.firestore).length, 11);
    for (const subcol of OWNER_SUBCOLLECTIONS) {
      const pattern = new RegExp(`match /${subcol}/\\{[a-zA-Z]+\\}`);
      assert.match(firestoreRules, pattern, `Missing rule match block for subcollection ${subcol}`);
    }
  });

  // 4. Anti-update-gap & server-time monotonicity
  await runTest("Dirty Dozen #4, #5, #6: Strict hasOnly, affectedKeys, ownerUid immutability & request.time", () => {
    assert.match(firestoreRules, /data\.createdAt == request\.time && data\.updatedAt == request\.time/);
    assert.match(firestoreRules, /incoming\(\)\.createdAt == existing\(\)\.createdAt && incoming\(\)\.updatedAt == request\.time/);
    assert.match(firestoreRules, /incoming\(\)\.ownerUid == existing\(\)\.ownerUid/);
    assert.match(firestoreRules, /incoming\(\)\.diff\(existing\(\)\)\.affectedKeys\(\)\.hasOnly/);
  });

  // 5. Relational & state-machine locks
  await runTest("Dirty Dozen #7, #8, #9: ownerProfileExists, productExists, archived & settled locks", () => {
    assert.match(firestoreRules, /ownerProfileExists\(userId\)/);
    assert.match(firestoreRules, /productExists\(userId, incoming\(\)\.productId\)/);
    assert.match(firestoreRules, /existing\(\)\.status != 'archived'/);
    assert.match(firestoreRules, /existing\(\)\.stage != 'archived'/);
    assert.match(firestoreRules, /existing\(\)\.settlementStatus != 'settled'/);
  });

  // 6. Storage rules enforce owner UID, verified email, safe filenames, and MIME/size caps
  await runTest("Dirty Dozen #10, #11, #12: Storage rules restrict owner, filename, MIME & size limits", () => {
    const categories = [
      "product-images",
      "reference-images",
      "generated-videos",
      "symphony-videos",
      "creative-assets",
    ];
    for (const cat of categories) {
      assert.match(storageRules, new RegExp(`match /users/\\{userId\\}/${cat}/\\{fileName\\}`));
    }
    assert.match(storageRules, /10 \* 1024 \* 1024/);
    assert.match(storageRules, /250 \* 1024 \* 1024/);
    assert.match(storageRules, /isSafeFileName\(fileName\)/);
  });

  // 7. Graceful handling of missing/placeholder Firebase configuration
  await runTest("Config guard: Rejects null, missing fields, and remixed placeholders gracefully", () => {
    assert.equal(validateFirebaseConfigObject(null).valid, false);
    assert.equal(validateFirebaseConfigObject({}).valid, false);
    assert.equal(
      validateFirebaseConfigObject({
        apiKey: "your-api-key",
        authDomain: "example.firebaseapp.com",
        projectId: "remixed-project-id",
        appId: "1:123:web:abc",
        firestoreDatabaseId: "remixed-firestore-database-id",
      }).valid,
      false
    );
    assert.equal(
      validateFirebaseConfigObject({
        apiKey: "AIzaSyExampleKey123",
        authDomain: "demo.firebaseapp.com",
        projectId: "demo-project",
        appId: "1:123456:web:abcdef",
        firestoreDatabaseId: "demo-db",
      }).valid,
      true
    );
  });

  // 8. Client-side schema & Storage validation (including Thai & Myanmar Unicode file names)
  await runTest("Schema & Storage validation: Rejects bad IDs, oversized files, invalid MIME; sanitizes Thai/Myanmar filenames", () => {
    assert.equal(isValidDocumentId("prod_01-TH"), true);
    assert.equal(isValidDocumentId("../escape"), false);
    assert.equal(isValidDocumentId(""), false);

    assert.equal(
      validateStorageFile("product-images", {
        name: "serum.jpg",
        type: "image/jpeg",
        size: 1024 * 500,
      }).ok,
      true
    );
    assert.equal(
      validateStorageFile("product-images", {
        name: "too-big.png",
        type: "image/png",
        size: 12 * 1024 * 1024,
      }).ok,
      false
    );
    assert.equal(
      validateStorageFile("product-images", {
        name: "script.exe",
        type: "application/x-msdownload",
        size: 1024,
      }).ok,
      false
    );
    assert.equal(
      validateStorageFile("symphony-videos", {
        name: "symphony-avatar.mp4",
        type: "video/mp4",
        size: 50 * 1024 * 1024,
      }).ok,
      true
    );

    const sanitizedThai = sanitizeStorageFileName("สินค้า-เซรั่มบำรุงผิว 2026.png");
    const sanitizedMyanmar = sanitizeStorageFileName("အလှကုန်-ဗီဒီယို.mp4");
    assert.equal(SAFE_FILENAME_REGEX.test(sanitizedThai), true);
    assert.equal(SAFE_FILENAME_REGEX.test(sanitizedMyanmar), true);
    assert.ok(sanitizedThai.endsWith(".png"));
    assert.ok(sanitizedMyanmar.endsWith(".mp4"));
  });

  // 9. Server-side Firebase token verifier checks
  await runTest("Server Auth: Resolves projectId and rejects malformed / non-RS256 tokens", async () => {
    const projectId = getServerFirebaseProjectId();
    assert.ok(projectId && projectId.length > 0, "Expected projectId from firebase-applet-config.json");

    await assert.rejects(
      () => verifyFirebaseIdToken("not-a-jwt", projectId),
      /Malformed Firebase ID token/
    );

    const fakeHeader = Buffer.from(JSON.stringify({ alg: "none", kid: "fake" })).toString("base64url");
    const fakePayload = Buffer.from(JSON.stringify({ sub: "attacker" })).toString("base64url");
    await assert.rejects(
      () => verifyFirebaseIdToken(`${fakeHeader}.${fakePayload}.sig`, projectId),
      /Unsupported Firebase ID token signature algorithm/
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
