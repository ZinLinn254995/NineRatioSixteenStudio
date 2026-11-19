# Phase 0 Security Specification — NineRatioSixteenStudio Firebase Foundation

## 1. Data Invariants
1. **Single-Owner Zero-Trust Access**: Every read and write across `/users/{userId}` and all 10 owner subcollections requires an authenticated user with `request.auth.token.email_verified == true`, `request.auth.uid == userId`, and `request.auth.token.email == 'zla264995@gmail.com'`. No public registration or cross-user reads exist.
2. **Master Gate Parent Existence**: Every subcollection document creation under `/users/{userId}/{collection}/{docId}` requires the parent owner profile `/users/{userId}` to exist via `exists(...)`.
3. **Identity Integrity & Immutability**: Every document MUST store `ownerUid == request.auth.uid`. `ownerUid` and `createdAt` are immutable after creation.
4. **Temporal Integrity**: On `create`, `createdAt == request.time` and `updatedAt == request.time`. On `update`, `createdAt == existing().createdAt` and `updatedAt == request.time`.
5. **Strict Key & Size Enforcement**: Every create enforces `hasAll(...) && hasOnly(...)`; every update enforces `isValid[Entity](incoming())` plus action-based `affectedKeys().hasOnly(...)`. Every string has a `.size()` bound matching `firebase-blueprint.json`, and arrays (e.g., `AffiliateProduct.tags`) are bounded (`size() <= 15`) with element validation.
6. **Path ID Poisoning Guard**: Every single-document operation (`get`, `create`, `update`, `delete`) validates `isValidId(docId)` (`^[a-zA-Z0-9_\-]+$`, max 128 chars). `list` rules never call `get()`/`exists()` and explicitly check `resource.data.ownerUid == request.auth.uid`.
7. **Terminal State Locking**: Once `MarketingCampaign.status == 'archived'`, `ContentPlan.stage == 'archived'`, `VideoProductionRecord.status == 'archived'`, or `EarningsRecord.settlementStatus == 'settled'`, further client updates are denied.
8. **No Binary Blobs in Firestore**: `CreativeAssetMetadata` stores metadata pointers (`storagePath`, `downloadUrl`, `mimeType`, `sizeBytes`) only; media binaries are stored in Firebase Storage under `/users/{userId}/{category}/{fileName}` with strict MIME and size rules.

## 2. The "Dirty Dozen" Adversarial Payloads
1. **Unauthenticated Read/Write**: `request.auth == null` reading `/users/owner-uid/affiliateProducts/prod-1` -> MUST BE DENIED.
2. **Non-Owner Verified User Access**: Authenticated verified user `attacker@example.com` attempting to create `/users/attacker-uid` -> MUST BE DENIED (no public registration).
3. **Unverified Owner Email Spoof**: Authenticated token with `email == 'zla264995@gmail.com'` and `email_verified == false` -> MUST BE DENIED.
4. **Cross-UID Ownership Spoofing**: Owner writing `ownerUid: "other-uid"` inside `/users/owner-uid/affiliateProducts/prod-1` -> MUST BE DENIED.
5. **Shadow / Ghost Field Injection (Create)**: Owner creating `AffiliateProduct` with extra key `isAdmin: true` -> MUST BE DENIED by `hasOnly(...)`.
6. **Shadow / Ghost Field Injection (Update)**: Owner updating `AffiliateProduct` with extra key `ghostField: "x"` -> MUST BE DENIED by `affectedKeys().hasOnly(...)`.
7. **Immutable Field Tampering (`createdAt` / `ownerUid`)**: Owner attempting to alter `createdAt` or `ownerUid` on update -> MUST BE DENIED.
8. **Client-Spoofed Timestamp**: Owner creating a document with client timestamp `createdAt != request.time` -> MUST BE DENIED.
9. **Path Variable ID Poisoning**: Document ID containing spaces/slashes or >128 characters -> MUST BE DENIED by `isValidId()`.
10. **Value Poisoning / Resource Exhaustion**: Setting `AffiliateScript.body` > 8000 chars or `AffiliateProduct.tags` with >15 items or non-string element -> MUST BE DENIED.
11. **Terminal State Mutation**: Updating an `EarningsRecord` whose existing `settlementStatus == 'settled'` -> MUST BE DENIED.
12. **Blanket List Query / Unscoped Collection Access**: Listing `/users` or reading `/unlistedCollection/doc1` -> MUST BE DENIED by explicit `allow list: if false` and global default-deny catch-all.
