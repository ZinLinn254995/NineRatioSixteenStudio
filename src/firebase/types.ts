import type { Timestamp } from "firebase/firestore";

export type UiLanguage = "en" | "th" | "my";
export type ContentLanguage = "th" | "my" | "th_my";
export type CurrencyCode = "THB" | "MMK" | "USD";

export type AffiliateProductStatus =
  | "researching"
  | "shortlisted"
  | "active"
  | "paused"
  | "archived";

export type CampaignStatus =
  | "draft"
  | "active"
  | "paused"
  | "completed"
  | "archived";

export type ContentPlanStage =
  | "idea"
  | "scripted"
  | "symphony_handoff"
  | "video_studio_edit"
  | "ready_to_post"
  | "posted"
  | "archived";

export type ScriptTone =
  | "casual"
  | "polite"
  | "urgent"
  | "storytelling"
  | "review";

export type StorageAssetCategory =
  | "product-images"
  | "reference-images"
  | "generated-videos"
  | "symphony-videos"
  | "creative-assets";

export type CreativeAssetSource =
  | "local"
  | "symphony"
  | "video_studio"
  | "external";

export type SymphonyWorkflowType =
  | "none"
  | "video_gen"
  | "avatar"
  | "dubbing"
  | "creative_edit";

export type VideoProductionStatus =
  | "planned"
  | "symphony_prepared"
  | "symphony_imported"
  | "editing_in_studio"
  | "exported"
  | "published"
  | "archived";

export type SettlementStatus =
  | "estimated"
  | "pending"
  | "settled"
  | "cancelled";

export interface OwnedFirestoreDoc {
  ownerUid: string;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

export interface UserProfile extends OwnedFirestoreDoc {
  email: string;
  displayName?: string;
  photoUrl?: string;
  preferredUiLanguage: UiLanguage;
  defaultContentLanguage: ContentLanguage;
  currency: CurrencyCode;
  region?: string;
}

export interface AffiliateProduct extends OwnedFirestoreDoc {
  name: string;
  category?: string;
  tiktokShopUrl?: string;
  priceThb?: number;
  commissionRatePct?: number;
  targetLanguage: ContentLanguage;
  sellingPoints?: string;
  complianceNotes?: string;
  tags?: string[];
  primaryImageAssetId?: string;
  status: AffiliateProductStatus;
}

export interface ProductResearch extends OwnedFirestoreDoc {
  productId: string;
  title: string;
  language: ContentLanguage;
  audiencePainPoints?: string;
  buyerObjections?: string;
  winningAngles?: string;
  sourceNotes?: string;
}

export interface CompetitorResearch extends OwnedFirestoreDoc {
  productId?: string;
  creatorHandle: string;
  videoUrl?: string;
  language: ContentLanguage;
  hookSummary?: string;
  structureNotes?: string;
  ctaStyle?: string;
  keyTakeaways?: string;
}

export interface MarketingCampaign extends OwnedFirestoreDoc {
  productId: string;
  title: string;
  goal?: string;
  targetLanguage: ContentLanguage;
  status: CampaignStatus;
  strategyNotes?: string;
  startDate?: string;
  endDate?: string;
}

export interface ContentPlan extends OwnedFirestoreDoc {
  campaignId?: string;
  productId?: string;
  title: string;
  language: ContentLanguage;
  stage: ContentPlanStage;
  scheduledDate?: string;
  scriptId?: string;
  assetId?: string;
  postedUrl?: string;
  notes?: string;
}

export interface AffiliateScript extends OwnedFirestoreDoc {
  campaignId?: string;
  productId?: string;
  title: string;
  language: ContentLanguage;
  tone: ScriptTone;
  hook?: string;
  body?: string;
  cta?: string;
  onScreenCaptions?: string;
  symphonyPrompt?: string;
  version: number;
}

export interface CreativeAssetMetadata extends OwnedFirestoreDoc {
  campaignId?: string;
  productId?: string;
  category: StorageAssetCategory;
  source: CreativeAssetSource;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  durationSec?: number;
  storagePath?: string;
  downloadUrl?: string;
  notes?: string;
}

export interface VideoProductionRecord extends OwnedFirestoreDoc {
  campaignId?: string;
  scriptId?: string;
  title: string;
  symphonyWorkflow: SymphonyWorkflowType;
  status: VideoProductionStatus;
  sourceAssetId?: string;
  outputAssetId?: string;
  localStudioProjectId?: string;
  notes?: string;
}

export interface AnalyticsRecord extends OwnedFirestoreDoc {
  campaignId?: string;
  contentPlanId?: string;
  recordedDate: string;
  views: number;
  likes?: number;
  comments?: number;
  shares?: number;
  productClicks: number;
  orders: number;
  sourceNote?: string;
}

export interface EarningsRecord extends OwnedFirestoreDoc {
  campaignId?: string;
  productId?: string;
  recordedDate: string;
  currency: CurrencyCode;
  gmvAmount: number;
  commissionAmount: number;
  ordersCount: number;
  settlementStatus: SettlementStatus;
  sourceNote?: string;
}

export type WithId<T> = T & { id: string };

export type OwnerCollectionKey =
  | "affiliateProducts"
  | "productResearch"
  | "competitorResearch"
  | "marketingCampaigns"
  | "contentPlans"
  | "scripts"
  | "creativeAssets"
  | "videoProductions"
  | "analyticsRecords"
  | "earningsRecords";

export interface OwnerCollectionMap {
  affiliateProducts: AffiliateProduct;
  productResearch: ProductResearch;
  competitorResearch: CompetitorResearch;
  marketingCampaigns: MarketingCampaign;
  contentPlans: ContentPlan;
  scripts: AffiliateScript;
  creativeAssets: CreativeAssetMetadata;
  videoProductions: VideoProductionRecord;
  analyticsRecords: AnalyticsRecord;
  earningsRecords: EarningsRecord;
}

export type FirebaseConnectionStatus =
  | "unconfigured"
  | "checking"
  | "connected"
  | "offline"
  | "error";
