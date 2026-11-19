export { AffiliateWorkspace } from "./AffiliateWorkspace";
export { AffiliateDashboardView } from "./AffiliateDashboardView";
export { ProductWorkspaceView } from "./ProductWorkspaceView";
export { CampaignWorkspaceView } from "./CampaignWorkspaceView";
export { ProductFormModal } from "./ProductFormModal";
export { CampaignFormModal } from "./CampaignFormModal";
export { ConfirmActionModal } from "./ConfirmActionModal";
export {
  createAffiliateSubscriptionManager,
  resolveWriteDisplayState,
  useAffiliateWorkspaceData,
} from "./useAffiliateWorkspaceData";
export {
  compareDateOnly,
  formatDateOnlyDisplay,
  formatSystemTimestamp,
  getLocalTodayDateOnly,
  isDateRangeValid,
  isValidDateOnly,
} from "./affiliateDateUtils";
export {
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
  hasExistingDocumentWithId,
  isSafeHttpUrl,
  normalizeSearchText,
  parseFirestoreErrorMessage,
} from "./affiliateValidation";
