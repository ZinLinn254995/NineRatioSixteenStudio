import type { OwnerCollectionKey, StorageAssetCategory } from "./types";

/**
 * Validation constants synchronized verbatim with firebase-blueprint.json,
 * firestore.rules, and storage.rules.
 */
export const VALID_ID_REGEX = /^[a-zA-Z0-9_-]{1,128}$/;
export const SAFE_FILENAME_REGEX = /^[a-zA-Z0-9._-]{1,180}$/;

export const OWNER_SUBCOLLECTIONS: readonly OwnerCollectionKey[] = [
  "affiliateProducts",
  "productResearch",
  "competitorResearch",
  "marketingCampaigns",
  "contentPlans",
  "scripts",
  "creativeAssets",
  "videoProductions",
  "analyticsRecords",
  "earningsRecords",
] as const;

export const FIELD_LIMITS = {
  id: 128,
  email: 254,
  displayName: 120,
  creatorHandle: 120,
  title: 200,
  name: 200,
  fileName: 200,
  mimeType: 100,
  category: 100,
  region: 32,
  dateString: 32,
  goal: 500,
  ctaStyle: 500,
  sourceNote: 500,
  storagePath: 500,
  url: 1000,
  downloadUrl: 1500,
  hook: 1500,
  cta: 1500,
  hookSummary: 2000,
  complianceNotes: 2000,
  assetNotes: 2000,
  notes: 4000,
  sellingPoints: 4000,
  researchText: 4000,
  onScreenCaptions: 4000,
  symphonyPrompt: 4000,
  strategyNotes: 6000,
  scriptBody: 8000,
  maxTags: 15,
  tagLength: 50,
} as const;

export const STORAGE_LIMITS: Record<
  StorageAssetCategory,
  { maxBytes: number; allowedMimeTypes: readonly string[] }
> = {
  "product-images": {
    maxBytes: 10 * 1024 * 1024,
    allowedMimeTypes: ["image/jpeg", "image/png", "image/webp"],
  },
  "reference-images": {
    maxBytes: 10 * 1024 * 1024,
    allowedMimeTypes: ["image/jpeg", "image/png", "image/webp"],
  },
  "generated-videos": {
    maxBytes: 250 * 1024 * 1024,
    allowedMimeTypes: ["video/mp4", "video/webm", "video/quicktime"],
  },
  "symphony-videos": {
    maxBytes: 250 * 1024 * 1024,
    allowedMimeTypes: ["video/mp4", "video/webm", "video/quicktime"],
  },
  "creative-assets": {
    maxBytes: 250 * 1024 * 1024,
    allowedMimeTypes: [
      "image/jpeg",
      "image/png",
      "image/webp",
      "video/mp4",
      "video/webm",
      "video/quicktime",
      "audio/mpeg",
      "audio/mp4",
      "audio/wav",
      "audio/webm",
      "text/plain",
      "text/vtt",
      "application/x-subrip",
    ],
  },
};

export function isValidDocumentId(id: string): boolean {
  return typeof id === "string" && VALID_ID_REGEX.test(id);
}

export function sanitizeBoundedString(value: string, maxLength: number): string {
  return value.trim().slice(0, maxLength);
}

export function sanitizeOptionalString(
  value: string | undefined,
  maxLength: number
): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  return trimmed.slice(0, maxLength);
}

export function sanitizeTags(tags: string[] | undefined): string[] | undefined {
  if (!Array.isArray(tags)) return undefined;
  const cleaned = tags
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim().slice(0, FIELD_LIMITS.tagLength))
    .filter((item) => item.length > 0)
    .slice(0, FIELD_LIMITS.maxTags);
  return cleaned;
}

export function sanitizeStorageFileName(originalName: string): string {
  const trimmed = (originalName || "asset").trim();
  const dotIdx = trimmed.lastIndexOf(".");
  const rawBase = dotIdx > 0 ? trimmed.slice(0, dotIdx) : trimmed;
  const rawExt = dotIdx > 0 ? trimmed.slice(dotIdx).toLowerCase() : "";

  const safeBase = rawBase
    .replace(/[^a-zA-Z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 120) || "asset";
  const safeExt = rawExt.replace(/[^a-zA-Z0-9.]/g, "").slice(0, 16);
  const stamp = Date.now().toString(36);
  const candidate = `${stamp}-${safeBase}${safeExt}`.slice(0, 180);

  return SAFE_FILENAME_REGEX.test(candidate) ? candidate : `${stamp}-asset`;
}

export function validateStorageFile(
  category: StorageAssetCategory,
  file: Pick<File, "name" | "type" | "size">
): { ok: true } | { ok: false; reason: string } {
  const policy = STORAGE_LIMITS[category];
  if (!policy) {
    return { ok: false, reason: `Unknown storage category: ${category}` };
  }
  if (!Number.isFinite(file.size) || file.size <= 0) {
    return { ok: false, reason: "File is empty." };
  }
  if (file.size > policy.maxBytes) {
    const maxMb = Math.round(policy.maxBytes / (1024 * 1024));
    return {
      ok: false,
      reason: `File exceeds the ${maxMb} MB size limit for ${category}.`,
    };
  }
  const normalizedMime = (file.type || "").toLowerCase().trim();
  if (!policy.allowedMimeTypes.includes(normalizedMime)) {
    return {
      ok: false,
      reason: `Unsupported file type "${normalizedMime || "unknown"}" for ${category}.`,
    };
  }
  return { ok: true };
}

export function stripUndefinedFields<T extends Record<string, unknown>>(obj: T): Partial<T> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (value !== undefined) {
      result[key] = value;
    }
  }
  return result as Partial<T>;
}
