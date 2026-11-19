export {
  DEFAULT_OWNER_EMAIL,
  getExpectedOwnerEmail,
  resolveFirebaseConfig,
  validateFirebaseConfigObject,
  type FirebaseClientConfig,
  type FirebaseConfigResolution,
} from "./config";

export {
  auth,
  db,
  firebaseApp,
  getFirebaseClientServices,
  storage,
  testConnection,
  type FirebaseClientServices,
} from "./client";

export {
  OperationType,
  buildFirestoreQuotaGuidance,
  handleFirestoreError,
  isFirestoreQuotaError,
  type FirestoreErrorInfo,
} from "./errors";

export {
  FIELD_LIMITS,
  OWNER_SUBCOLLECTIONS,
  SAFE_FILENAME_REGEX,
  STORAGE_LIMITS,
  VALID_ID_REGEX,
  isValidDocumentId,
  sanitizeBoundedString,
  sanitizeOptionalString,
  sanitizeStorageFileName,
  sanitizeTags,
  stripUndefinedFields,
  validateStorageFile,
} from "./schema";

export {
  buildOwnerCollectionPath,
  buildOwnerDocPath,
  createOwnerDocument,
  deleteOwnerDocument,
  ensureOwnerProfile,
  generateFirestoreDocId,
  getOwnerDocument,
  getOwnerProfile,
  listOwnerDocuments,
  subscribeOwnerCollection,
  updateOwnerDocument,
  updateOwnerProfileSettings,
  type OwnerCollectionSnapshotMetadata,
  type OwnerDocumentUpdate,
} from "./firestoreService";

export {
  buildOwnerStoragePath,
  deleteOwnerStorageAsset,
  resolveOwnerStorageUrl,
  uploadOwnerStorageAsset,
  type StorageUploadProgress,
  type StorageUploadResult,
} from "./storageService";

export {
  FirebaseProvider,
  useFirebase,
  type FirebaseContextValue,
} from "./FirebaseContext";

export { FirebaseErrorBoundary } from "./FirebaseErrorBoundary";
export { AuthStatusControl } from "./AuthStatusControl";

export type {
  AffiliateProduct,
  AffiliateProductStatus,
  AffiliateScript,
  AnalyticsRecord,
  CampaignStatus,
  CompetitorResearch,
  ContentLanguage,
  ContentPlan,
  ContentPlanStage,
  CreativeAssetMetadata,
  CreativeAssetSource,
  CurrencyCode,
  EarningsRecord,
  FirebaseConnectionStatus,
  MarketingCampaign,
  OwnedFirestoreDoc,
  OwnerCollectionKey,
  OwnerCollectionMap,
  ProductResearch,
  ScriptTone,
  SettlementStatus,
  StorageAssetCategory,
  SymphonyWorkflowType,
  UiLanguage,
  UserProfile,
  VideoProductionRecord,
  VideoProductionStatus,
  WithId,
} from "./types";
