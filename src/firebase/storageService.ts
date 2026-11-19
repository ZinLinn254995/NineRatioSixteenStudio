import {
  deleteObject,
  getDownloadURL,
  ref,
  uploadBytesResumable,
  type UploadTask,
} from "firebase/storage";
import { getFirebaseClientServices } from "./client";
import {
  isValidDocumentId,
  sanitizeStorageFileName,
  validateStorageFile,
} from "./schema";
import type { StorageAssetCategory } from "./types";

export interface StorageUploadProgress {
  bytesTransferred: number;
  totalBytes: number;
  percent: number;
}

export interface StorageUploadResult {
  storagePath: string;
  downloadUrl: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  category: StorageAssetCategory;
}

function requireStorageAndUid() {
  const { storage, auth } = getFirebaseClientServices();
  if (!storage || !auth) {
    throw new Error("Firebase Storage is not configured.");
  }
  const uid = auth.currentUser?.uid;
  if (!uid || !isValidDocumentId(uid)) {
    throw new Error("Authenticated owner UID is required to access Firebase Storage.");
  }
  return { storage, uid };
}

export function buildOwnerStoragePath(
  uid: string,
  category: StorageAssetCategory,
  safeFileName: string
): string {
  return `users/${uid}/${category}/${safeFileName}`;
}

export function uploadOwnerStorageAsset(
  category: StorageAssetCategory,
  file: File,
  onProgress?: (progress: StorageUploadProgress) => void
): { task: UploadTask; promise: Promise<StorageUploadResult> } {
  const validation = validateStorageFile(category, file);
  if (!validation.ok) {
    throw new Error(validation.reason);
  }

  const { storage, uid } = requireStorageAndUid();
  const safeFileName = sanitizeStorageFileName(file.name);
  const storagePath = buildOwnerStoragePath(uid, category, safeFileName);
  const storageRef = ref(storage, storagePath);

  const task = uploadBytesResumable(storageRef, file, {
    contentType: file.type,
    customMetadata: {
      ownerUid: uid,
      category,
      originalName: file.name.slice(0, 180),
    },
  });

  const promise = new Promise<StorageUploadResult>((resolve, reject) => {
    task.on(
      "state_changed",
      (snapshot) => {
        if (!onProgress) return;
        const total = Math.max(1, snapshot.totalBytes || file.size);
        const percent = Math.min(100, Math.round((snapshot.bytesTransferred / total) * 100));
        onProgress({
          bytesTransferred: snapshot.bytesTransferred,
          totalBytes: snapshot.totalBytes,
          percent,
        });
      },
      (error) => {
        reject(error);
      },
      async () => {
        try {
          const downloadUrl = await getDownloadURL(task.snapshot.ref);
          resolve({
            storagePath,
            downloadUrl,
            fileName: safeFileName,
            mimeType: file.type,
            sizeBytes: file.size,
            category,
          });
        } catch (err) {
          reject(err);
        }
      }
    );
  });

  return { task, promise };
}

export async function resolveOwnerStorageUrl(storagePath: string): Promise<string> {
  const { storage, uid } = requireStorageAndUid();
  if (!storagePath.startsWith(`users/${uid}/`)) {
    throw new Error("Access denied: storage path does not belong to the authenticated owner.");
  }
  return getDownloadURL(ref(storage, storagePath));
}

export async function deleteOwnerStorageAsset(storagePath: string): Promise<void> {
  const { storage, uid } = requireStorageAndUid();
  if (!storagePath.startsWith(`users/${uid}/`)) {
    throw new Error("Access denied: storage path does not belong to the authenticated owner.");
  }
  await deleteObject(ref(storage, storagePath));
}
