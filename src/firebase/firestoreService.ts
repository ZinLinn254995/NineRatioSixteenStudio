import {
  collection,
  deleteDoc,
  doc,
  getDoc,
  getDocFromServer,
  getDocs,
  onSnapshot,
  query,
  serverTimestamp,
  setDoc,
  updateDoc,
  where,
  type FieldValue,
  type QueryConstraint,
  type Unsubscribe,
} from "firebase/firestore";
import type { User } from "firebase/auth";
import { getFirebaseClientServices } from "./client";
import { handleFirestoreError, OperationType } from "./errors";
import {
  FIELD_LIMITS,
  isValidDocumentId,
  sanitizeBoundedString,
  sanitizeOptionalString,
  stripUndefinedFields,
} from "./schema";
import type {
  OwnerCollectionKey,
  OwnerCollectionMap,
  OwnedFirestoreDoc,
  UserProfile,
  WithId,
} from "./types";

function requireDbAndUid(explicitUid?: string) {
  const { db, auth } = getFirebaseClientServices();
  if (!db || !auth) {
    throw new Error("Firebase Firestore is not configured.");
  }
  const uid = explicitUid || auth.currentUser?.uid;
  if (!uid || !isValidDocumentId(uid)) {
    throw new Error("Authenticated owner UID is required.");
  }
  return { db, auth, uid };
}

export function buildOwnerCollectionPath(uid: string, col: OwnerCollectionKey): string {
  return `users/${uid}/${col}`;
}

export function buildOwnerDocPath(uid: string, col: OwnerCollectionKey, docId: string): string {
  return `users/${uid}/${col}/${docId}`;
}

export function generateFirestoreDocId(prefix: string): string {
  const safePrefix = prefix.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 24) || "doc";
  const rand =
    typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
      ? crypto.randomUUID().replace(/-/g, "").slice(0, 16)
      : Math.random().toString(36).slice(2, 14);
  return `${safePrefix}_${Date.now().toString(36)}_${rand}`;
}

export interface OwnerProfileSnapshotLike {
  id: string;
  exists: () => boolean;
  data: () => unknown;
  metadata?: { fromCache?: boolean };
}

/**
 * Pure verifier for server-confirmed owner profile snapshots.
 * Rejects cache-only reads and verifies both document ID and ownerUid match expectedUid.
 */
export function verifyOwnerProfileSnapshot(
  snap: OwnerProfileSnapshotLike,
  expectedUid: string
): WithId<UserProfile> | null {
  if (snap.metadata?.fromCache) {
    throw new Error("Owner profile verification requires a live Firestore server response.");
  }
  if (!snap.exists()) {
    return null;
  }
  const data = snap.data() as Partial<UserProfile> | undefined;
  if (!data || data.ownerUid !== expectedUid || snap.id !== expectedUid) {
    throw new Error("Owner profile UID verification failed.");
  }
  return { id: snap.id, ...(data as UserProfile) };
}

/**
 * Ensures the authenticated owner's root profile document exists at /users/{uid}.
 * Uses getDocFromServer so cache-only reads are never mistaken for live server
 * connectivity or an absent profile, and verifies ownerUid matches the live UID.
 * Required by the Master Gate rule before creating subcollection documents.
 */
export async function ensureOwnerProfile(user: User): Promise<WithId<UserProfile>> {
  const { db, auth, uid } = requireDbAndUid(user.uid);
  if (!auth.currentUser || auth.currentUser.uid !== uid) {
    throw new Error("Authenticated owner UID mismatch during profile initialization.");
  }
  const profilePath = `users/${uid}`;
  const ref = doc(db, "users", uid);

  try {
    const snap = await getDocFromServer(ref);
    const existing = verifyOwnerProfileSnapshot(snap, uid);
    if (existing) {
      return existing;
    }

    const email = sanitizeBoundedString(user.email || "", FIELD_LIMITS.email);
    const payload = stripUndefinedFields({
      ownerUid: uid,
      email,
      displayName: sanitizeOptionalString(user.displayName || undefined, FIELD_LIMITS.displayName),
      photoUrl: sanitizeOptionalString(user.photoURL || undefined, FIELD_LIMITS.url),
      preferredUiLanguage: "en" as const,
      defaultContentLanguage: "th" as const,
      currency: "THB" as const,
      region: "TH",
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });

    await setDoc(ref, payload);
    const createdSnap = await getDocFromServer(ref);
    const verifiedCreated = verifyOwnerProfileSnapshot(createdSnap, uid);
    if (!verifiedCreated) {
      throw new Error("Owner profile could not be verified on server after creation.");
    }
    return verifiedCreated;
  } catch (error) {
    handleFirestoreError(error, OperationType.WRITE, profilePath, auth);
  }
}

export async function getOwnerProfile(uid?: string): Promise<WithId<UserProfile> | null> {
  const { db, auth, uid: resolvedUid } = requireDbAndUid(uid);
  const path = `users/${resolvedUid}`;
  try {
    const snap = await getDoc(doc(db, "users", resolvedUid));
    if (!snap.exists()) return null;
    return { id: snap.id, ...(snap.data() as UserProfile) };
  } catch (error) {
    handleFirestoreError(error, OperationType.GET, path, auth);
  }
}

/**
 * Server-confirmed profile fetch (never returns stale local cache).
 * Verifies ownerUid matches the authenticated owner UID.
 */
export async function getOwnerProfileFromServer(
  uid?: string
): Promise<WithId<UserProfile> | null> {
  const { db, auth, uid: resolvedUid } = requireDbAndUid(uid);
  const path = `users/${resolvedUid}`;
  try {
    const snap = await getDocFromServer(doc(db, "users", resolvedUid));
    if (!snap.exists()) return null;
    const data = snap.data() as UserProfile;
    if (data.ownerUid !== resolvedUid) {
      throw new Error("Owner profile UID verification failed.");
    }
    return { id: snap.id, ...data };
  } catch (error) {
    handleFirestoreError(error, OperationType.GET, path, auth);
  }
}

export async function updateOwnerProfileSettings(
  updates: Partial<
    Pick<
      UserProfile,
      | "displayName"
      | "photoUrl"
      | "preferredUiLanguage"
      | "defaultContentLanguage"
      | "currency"
      | "region"
    >
  >,
  uid?: string
): Promise<void> {
  const { db, auth, uid: resolvedUid } = requireDbAndUid(uid);
  const path = `users/${resolvedUid}`;
  const payload = stripUndefinedFields({
    displayName:
      updates.displayName !== undefined
        ? sanitizeOptionalString(updates.displayName, FIELD_LIMITS.displayName)
        : undefined,
    photoUrl:
      updates.photoUrl !== undefined
        ? sanitizeOptionalString(updates.photoUrl, FIELD_LIMITS.url)
        : undefined,
    preferredUiLanguage: updates.preferredUiLanguage,
    defaultContentLanguage: updates.defaultContentLanguage,
    currency: updates.currency,
    region:
      updates.region !== undefined
        ? sanitizeOptionalString(updates.region, FIELD_LIMITS.region)
        : undefined,
    updatedAt: serverTimestamp(),
  });

  try {
    await updateDoc(doc(db, "users", resolvedUid), payload);
  } catch (error) {
    handleFirestoreError(error, OperationType.UPDATE, path, auth);
  }
}

export async function createOwnerDocument<K extends OwnerCollectionKey>(
  col: K,
  data: Omit<OwnerCollectionMap[K], keyof OwnedFirestoreDoc>,
  customId?: string,
  expectedOwnerUid?: string
): Promise<string> {
  const { db, auth, uid } = requireDbAndUid();
  if (expectedOwnerUid !== undefined) {
    if (!isValidDocumentId(expectedOwnerUid) || uid !== expectedOwnerUid) {
      throw new Error("Owner session UID mismatch during document creation.");
    }
  }
  const docId = customId || generateFirestoreDocId(col);
  if (!isValidDocumentId(docId)) {
    throw new Error(`Invalid document ID "${docId}".`);
  }

  const path = buildOwnerDocPath(uid, col, docId);
  const payload = stripUndefinedFields({
    ...(data as Record<string, unknown>),
    ownerUid: uid,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  });

  try {
    await setDoc(doc(db, "users", uid, col, docId), payload);
    return docId;
  } catch (error) {
    handleFirestoreError(error, OperationType.CREATE, path, auth);
  }
}

export async function getOwnerDocument<K extends OwnerCollectionKey>(
  col: K,
  docId: string
): Promise<WithId<OwnerCollectionMap[K]> | null> {
  const { db, auth, uid } = requireDbAndUid();
  if (!isValidDocumentId(docId)) {
    throw new Error(`Invalid document ID "${docId}".`);
  }
  const path = buildOwnerDocPath(uid, col, docId);
  try {
    const snap = await getDoc(doc(db, "users", uid, col, docId));
    if (!snap.exists()) return null;
    return { id: snap.id, ...(snap.data() as OwnerCollectionMap[K]) };
  } catch (error) {
    handleFirestoreError(error, OperationType.GET, path, auth);
  }
}

/**
 * Server-confirmed owner document lookup (never reads local cache).
 * Explicitly verifies that the active UID matches expectedOwnerUid (when supplied)
 * and that the returned document's ownerUid matches the authenticated owner.
 */
export async function getOwnerDocumentFromServer<K extends OwnerCollectionKey>(
  col: K,
  docId: string,
  expectedOwnerUid?: string
): Promise<WithId<OwnerCollectionMap[K]> | null> {
  const { db, auth, uid } = requireDbAndUid();
  if (expectedOwnerUid !== undefined) {
    if (!isValidDocumentId(expectedOwnerUid) || uid !== expectedOwnerUid) {
      throw new Error("Owner session UID mismatch during server document verification.");
    }
  }
  if (!isValidDocumentId(docId)) {
    throw new Error(`Invalid document ID "${docId}".`);
  }
  const path = buildOwnerDocPath(uid, col, docId);
  try {
    const snap = await getDocFromServer(doc(db, "users", uid, col, docId));
    if (!snap.exists()) return null;
    const data = snap.data() as OwnerCollectionMap[K];
    if (data.ownerUid !== uid || (expectedOwnerUid && data.ownerUid !== expectedOwnerUid)) {
      throw new Error("Document owner UID verification failed.");
    }
    return { id: snap.id, ...data };
  } catch (error) {
    handleFirestoreError(error, OperationType.GET, path, auth);
  }
}

export async function listOwnerDocuments<K extends OwnerCollectionKey>(
  col: K,
  constraints: QueryConstraint[] = []
): Promise<WithId<OwnerCollectionMap[K]>[]> {
  const { db, auth, uid } = requireDbAndUid();
  const path = buildOwnerCollectionPath(uid, col);
  try {
    const colRef = collection(db, "users", uid, col);
    // Explicitly scope list queries by ownerUid to satisfy Firestore list rules.
    const q = query(colRef, where("ownerUid", "==", uid), ...constraints);
    const snap = await getDocs(q);
    return snap.docs.map((d) => ({
      id: d.id,
      ...(d.data() as OwnerCollectionMap[K]),
    }));
  } catch (error) {
    handleFirestoreError(error, OperationType.LIST, path, auth);
  }
}

export interface OwnerCollectionSnapshotMetadata {
  fromCache: boolean;
  hasPendingWrites: boolean;
  pendingDocIds: string[];
}

export type OwnerDocumentUpdate<K extends OwnerCollectionKey> = {
  [P in keyof Omit<OwnerCollectionMap[K], keyof OwnedFirestoreDoc>]?:
    | Omit<OwnerCollectionMap[K], keyof OwnedFirestoreDoc>[P]
    | FieldValue;
};

export function subscribeOwnerCollection<K extends OwnerCollectionKey>(
  col: K,
  onData: (
    items: WithId<OwnerCollectionMap[K]>[],
    metadata: OwnerCollectionSnapshotMetadata
  ) => void,
  constraints: QueryConstraint[] = [],
  onError?: (err: Error) => void
): Unsubscribe {
  const { db, auth, uid } = requireDbAndUid();
  const path = buildOwnerCollectionPath(uid, col);
  const colRef = collection(db, "users", uid, col);
  const q = query(colRef, where("ownerUid", "==", uid), ...constraints);

  return onSnapshot(
    q,
    { includeMetadataChanges: true },
    (snap) => {
      const items = snap.docs.map((d) => ({
        id: d.id,
        ...(d.data() as OwnerCollectionMap[K]),
      }));
      const pendingDocIds = snap.docs
        .filter((d) => d.metadata.hasPendingWrites)
        .map((d) => d.id);
      onData(items, {
        fromCache: snap.metadata.fromCache,
        hasPendingWrites: snap.metadata.hasPendingWrites,
        pendingDocIds,
      });
    },
    (error) => {
      try {
        handleFirestoreError(error, OperationType.LIST, path, auth);
      } catch (wrapped) {
        if (onError && wrapped instanceof Error) {
          onError(wrapped);
        } else {
          throw wrapped;
        }
      }
    }
  );
}

export async function updateOwnerDocument<K extends OwnerCollectionKey>(
  col: K,
  docId: string,
  updates: OwnerDocumentUpdate<K>,
  expectedOwnerUid?: string
): Promise<void> {
  const { db, auth, uid } = requireDbAndUid();
  if (expectedOwnerUid !== undefined) {
    if (!isValidDocumentId(expectedOwnerUid) || uid !== expectedOwnerUid) {
      throw new Error("Owner session UID mismatch during document update.");
    }
  }
  if (!isValidDocumentId(docId)) {
    throw new Error(`Invalid document ID "${docId}".`);
  }
  const path = buildOwnerDocPath(uid, col, docId);
  const payload = stripUndefinedFields({
    ...(updates as Record<string, unknown>),
    updatedAt: serverTimestamp(),
  });

  try {
    await updateDoc(doc(db, "users", uid, col, docId), payload);
  } catch (error) {
    handleFirestoreError(error, OperationType.UPDATE, path, auth);
  }
}

export async function deleteOwnerDocument<K extends OwnerCollectionKey>(
  col: K,
  docId: string,
  expectedOwnerUid?: string
): Promise<void> {
  const { db, auth, uid } = requireDbAndUid();
  if (expectedOwnerUid !== undefined) {
    if (!isValidDocumentId(expectedOwnerUid) || uid !== expectedOwnerUid) {
      throw new Error("Owner session UID mismatch during document deletion.");
    }
  }
  if (!isValidDocumentId(docId)) {
    throw new Error(`Invalid document ID "${docId}".`);
  }
  const path = buildOwnerDocPath(uid, col, docId);
  try {
    await deleteDoc(doc(db, "users", uid, col, docId));
  } catch (error) {
    handleFirestoreError(error, OperationType.DELETE, path, auth);
  }
}
