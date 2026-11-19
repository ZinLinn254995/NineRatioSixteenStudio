import type {
  AffiliateProductStatus,
  CampaignStatus,
  ContentLanguage,
  UiLanguage,
} from "../firebase";

export type WorkspaceConnectionState =
  | "connected"
  | "offline"
  | "cached"
  | "sync_pending"
  | "error";

export type WriteOperationState =
  | "idle"
  | "saving"
  | "sync_pending"
  | "saved"
  | "failed";

export interface AffiliateUiDictionary {
  studioTitle: string;
  studioSubtitle: string;
  navDashboard: string;
  navProducts: string;
  navCampaigns: string;
  switchToVideoStudio: string;
  authenticatedOwner: string;
  ownerAccount: string;
  manualEntry: string;
  systemRecord: string;
  readOnlyArchived: string;
  // Auth & loading gates
  signInRequiredTitle: string;
  signInRequiredDesc: string;
  signInWithGoogle: string;
  signOut: string;
  unconfiguredTitle: string;
  unconfiguredDesc: string;
  syncingProfile: string;
  retryingProfile: string;
  profileSyncFailedTitle: string;
  profileSyncFailedDesc: string;
  loadingWorkspace: string;
  // Connection & write states
  connConnected: string;
  connOffline: string;
  connCached: string;
  connSyncPending: string;
  connError: string;
  connOfflineBanner: string;
  connCachedBanner: string;
  connSyncPendingBanner: string;
  writeSaving: string;
  writeSyncPending: string;
  writeSyncPendingWarning: string;
  writeSaved: string;
  writeFailed: string;
  dismissWhilePendingButton: string;
  dismissWhilePendingNotice: string;
  retry: string;
  dismiss: string;
  // Dashboard
  savedProductsLabel: string;
  savedCampaignsLabel: string;
  savedRecordsNote: string;
  upcomingDatesTitle: string;
  upcomingDatesEmpty: string;
  recentProductsTitle: string;
  recentCampaignsTitle: string;
  quickAddProduct: string;
  quickNewCampaign: string;
  needProductForCampaignHint: string;
  viewAll: string;
  // Products
  productsTitle: string;
  addProduct: string;
  editProduct: string;
  searchProductsPlaceholder: string;
  noProductsYet: string;
  noProductsMatch: string;
  productArchiveOnlyNote: string;
  productNameLabel: string;
  categoryLabel: string;
  tiktokShopUrlLabel: string;
  priceThbLabel: string;
  commissionRateLabel: string;
  contentLanguageLabel: string;
  sellingPointsLabel: string;
  complianceNotesLabel: string;
  tagsLabel: string;
  tagsHint: string;
  statusLabel: string;
  linkedCampaignsCount: string;
  copyUrl: string;
  copied: string;
  openLink: string;
  // Campaigns
  campaignsTitle: string;
  newCampaign: string;
  editCampaign: string;
  searchCampaignsPlaceholder: string;
  noCampaignsYet: string;
  noCampaignsMatch: string;
  manualPublishingNotice: string;
  campaignTitleLabel: string;
  linkedProductLabel: string;
  linkedProductImmutableHint: string;
  missingLinkedProduct: string;
  goalLabel: string;
  strategyNotesLabel: string;
  startDateLabel: string;
  endDateLabel: string;
  allProducts: string;
  allStatuses: string;
  allLanguages: string;
  // Common actions
  save: string;
  cancel: string;
  editDetails: string;
  pauseAction: string;
  resumeAction: string;
  archiveAction: string;
  deleteCampaignAction: string;
  changeStatus: string;
  updatedLabel: string;
  createdLabel: string;
  // Confirm modals
  archiveConfirmTitle: string;
  archiveConfirmBody: string;
  archiveConfirmButton: string;
  deleteCampaignConfirmTitle: string;
  deleteCampaignConfirmBody: string;
  deleteCampaignConfirmButton: string;
  // Validation messages
  errNameRequired: string;
  errTitleRequired: string;
  errProductRequired: string;
  errInvalidUrl: string;
  errInvalidPrice: string;
  errInvalidCommission: string;
  errInvalidStartDate: string;
  errInvalidEndDate: string;
  errEndBeforeStart: string;
  errOfflineWriteBlocked: string;
  errCachedWriteBlocked: string;
  confirmConnectionUnavailable: string;
  errWriteInFlightLocked: string;
  errArchivedReadOnly: string;
}

const MY_DICT: AffiliateUiDictionary = {
  studioTitle: "Affiliate Studio",
  studioSubtitle: "TikTok Shop Thailand Creator Workspace",
  navDashboard: "Dashboard",
  navProducts: "Products",
  navCampaigns: "Campaigns",
  switchToVideoStudio: "Video Studio သို့ပြန်သွားမည်",
  authenticatedOwner: "Authenticated Owner",
  ownerAccount: "Owner Account",
  manualEntry: "Manual Entry",
  systemRecord: "System Record",
  readOnlyArchived: "Archived (Read-only)",
  signInRequiredTitle: "Owner Sign-In လိုအပ်ပါသည်",
  signInRequiredDesc:
    "Affiliate Studio ရှိ Firestore data များကို ကြည့်ရှုသိမ်းဆည်းရန် သတ်မှတ်ထားသော Owner Google Account ဖြင့် ဝင်ရောက်ပါ။ Video Studio offline projects များကို Sign-In မလုပ်ဘဲ ဆက်လက်အသုံးပြုနိုင်ပါသည်။",
  signInWithGoogle: "Google ဖြင့် ဝင်ရောက်မည်",
  signOut: "ထွက်မည် (Sign Out)",
  unconfiguredTitle: "Firebase ချိတ်ဆက်မှု မပြည့်စုံသေးပါ",
  unconfiguredDesc:
    "Cloud Firestore config မရှိသေးသောကြောင့် Affiliate Studio ကို ဖွင့်၍မရသေးပါ။ Video Studio နှင့် IndexedDB offline projects များ ပုံမှန်အလုပ်လုပ်နေပါသည်။",
  syncingProfile: "Owner profile ကို စစ်ဆေးချိတ်ဆက်နေပါသည်...",
  retryingProfile: "Owner profile ကို ပြန်လည်ချိတ်ဆက်နေပါသည်...",
  profileSyncFailedTitle: "Owner Profile ချိတ်ဆက်မှု မအောင်မြင်ပါ",
  profileSyncFailedDesc:
    "Firestore နှင့် Owner Profile ကို စတင်အတည်ပြု၍မရသေးပါ။ အင်တာနက်ချိတ်ဆက်မှုကို စစ်ဆေးပြီး ပြန်စမ်းပါ သို့မဟုတ် Sign Out ပြုလုပ်နိုင်ပါသည်။",
  loadingWorkspace: "Firestore records များကို ဖတ်နေပါသည်...",
  connConnected: "Connected",
  connOffline: "Offline",
  connCached: "Cached Data",
  connSyncPending: "Sync Pending",
  connError: "Connection Error",
  connOfflineBanner:
    "Offline ဖြစ်နေပါသည် — Cloud write များကို ခေတ္တပိတ်ထားပါသည်။ Video Studio offline projects များကို ပုံမှန်ဆက်သုံးနိုင်ပါသည်။",
  connCachedBanner:
    "Cached Data (Read-only) — Server မှ နောက်ဆုံး confirmation မရသေးသော cached records များကို ပြသနေပါသည်။ Connected မဖြစ်မီ အသစ်သိမ်းဆည်း၍မရပါ။",
  connSyncPendingBanner:
    "Sync Pending — Server confirmation စောင့်ဆိုင်းနေပါသည်။ Saved မပေါ်မီ Page ကို refresh သို့မဟုတ် close မလုပ်ပါနှင့်။",
  writeSaving: "Saving...",
  writeSyncPending: "Sync Pending",
  writeSyncPendingWarning:
    "Server confirmation မရသေးပါ (Sync Pending)။ Duplicate မဖြစ်စေရန် ခလုတ်ကို lock ထားပြီး Saved မပေါ်မီ Page မပိတ်ပါနှင့်။",
  writeSaved: "Saved (Server Confirmed)",
  writeFailed: "Failed",
  dismissWhilePendingButton: "ပိတ်ပြီး နောက်ကွယ်မှ ဆက်စောင့်မည်",
  dismissWhilePendingNotice:
    "ဤ Dialog ကို ပိတ်သော်လည်း Firestore write ကို cancel မလုပ်ပါ — မူလ Record ID အတိုင်း နောက်ကွယ်မှ ဆက်လက် sync လုပ်နေမည်ဖြစ်ပြီး Saved မပေါ်မီ Page ကို refresh သို့မဟုတ် close မလုပ်ပါနှင့်။",
  retry: "ပြန်စမ်းမည် (Retry)",
  dismiss: "ပိတ်မည်",
  savedProductsLabel: "Saved Products",
  savedCampaignsLabel: "Saved Campaigns",
  savedRecordsNote:
    "အောက်ပါကိန်းဂဏန်းများသည် Firestore တွင် အမှန်တကယ်သိမ်းထားသော records အရေအတွက်သာဖြစ်ပြီး Sales / Views / Commission အချက်အလက်အတုများ မပါဝင်ပါ။",
  upcomingDatesTitle: "စီစဉ်ထားသော Publishing Dates",
  upcomingDatesEmpty: "စီစဉ်ထားသော Campaign ရက်စွဲ မရှိသေးပါ။",
  recentProductsTitle: "နောက်ဆုံးပြင်ဆင်ထားသော Products",
  recentCampaignsTitle: "နောက်ဆုံးပြင်ဆင်ထားသော Campaigns",
  quickAddProduct: "+ Product အသစ်ထည့်မည်",
  quickNewCampaign: "+ Campaign အသစ်ဖန်တီးမည်",
  needProductForCampaignHint: "Campaign ဖန်တီးရန် Product အနည်းဆုံး (၁) ခု အရင်ထည့်ပါ။",
  viewAll: "အားလုံးကြည့်မည်",
  productsTitle: "Product Workspace",
  addProduct: "Product ထည့်မည်",
  editProduct: "Product Details ပြင်မည်",
  searchProductsPlaceholder: "Product အမည်၊ Category၊ Tag ရှာရန် (TH / MY / EN)...",
  noProductsYet: "သိမ်းထားသော Affiliate Product မရှိသေးပါ။",
  noProductsMatch: "ရှာဖွေမှုနှင့် ကိုက်ညီသော Product မတွေ့ပါ။",
  productArchiveOnlyNote:
    "Data integrity အတွက် Phase 3 တွင် Product များကို ဖျက်၍မရဘဲ Paused (ယာယီရပ်) သို့မဟုတ် Archived (အပြီးဖယ်ရှား / Read-only) သာ ပြောင်းလဲနိုင်ပါသည်။",
  productNameLabel: "Product Name *",
  categoryLabel: "Category",
  tiktokShopUrlLabel: "TikTok Shop URL (https://...)",
  priceThbLabel: "Reference Price (THB)",
  commissionRateLabel: "Reference Commission (%)",
  contentLanguageLabel: "Content Language",
  sellingPointsLabel: "Selling Points / Product Notes",
  complianceNotesLabel: "Compliance Notes (Policy / Claims)",
  tagsLabel: "Tags (ကော်မာ , ခံပြီး ရေးပါ)",
  tagsHint: "အများဆုံး 15 ခု (တစ်ခုလျှင် 50 စာလုံး)",
  statusLabel: "Status",
  linkedCampaignsCount: "ချိတ်ဆက်ထားသော Campaigns",
  copyUrl: "URL ကူးမည်",
  copied: "ကူးပြီးပါပြီ",
  openLink: "Link ဖွင့်မည်",
  campaignsTitle: "Campaign Workspace",
  newCampaign: "Campaign အသစ်",
  editCampaign: "Campaign Details ပြင်မည်",
  searchCampaignsPlaceholder: "Campaign ခေါင်းစဉ် သို့မဟုတ် Goal ရှာရန်...",
  noCampaignsYet: "သိမ်းထားသော Content Campaign မရှိသေးပါ။",
  noCampaignsMatch: "ရှာဖွေမှုနှင့် ကိုက်ညီသော Campaign မတွေ့ပါ။",
  manualPublishingNotice:
    "Manual Publishing Tracking — ဤနေရာသည် Publishing အစီအစဉ်မှတ်တမ်းအတွက်သာဖြစ်ပြီး TikTok သို့ အလိုအလျောက် Post မတင်ပါ။",
  campaignTitleLabel: "Campaign Title *",
  linkedProductLabel: "Linked Affiliate Product *",
  linkedProductImmutableHint:
    "Campaign ဖန်တီးပြီးနောက် Linked Product ကို Firestore rules အရ ပြောင်းလဲ၍မရပါ။",
  missingLinkedProduct: "Linked Product မတွေ့ပါ",
  goalLabel: "Campaign Goal / Angle",
  strategyNotesLabel: "Strategy & Publishing Notes",
  startDateLabel: "Planned Start Date",
  endDateLabel: "Planned End Date",
  allProducts: "Products အားလုံး",
  allStatuses: "Status အားလုံး",
  allLanguages: "ဘာသာစကားအားလုံး",
  save: "သိမ်းဆည်းမည်",
  cancel: "မလုပ်တော့ပါ",
  editDetails: "Details ပြင်မည်",
  pauseAction: "Pause လုပ်မည်",
  resumeAction: "Active ပြန်လုပ်မည်",
  archiveAction: "Archive လုပ်မည်",
  deleteCampaignAction: "Campaign ဖျက်မည်",
  changeStatus: "Status ပြောင်းမည်",
  updatedLabel: "Updated",
  createdLabel: "Created",
  archiveConfirmTitle: "Archive လုပ်ရန် အတည်ပြုပါ",
  archiveConfirmBody:
    "Archive လုပ်ပြီးပါက ဤ Record သည် အပြီးတိုင် Read-only ဖြစ်သွားမည်ဖြစ်ပြီး ပြန်ပြင်၍ သို့မဟုတ် Unarchive လုပ်၍ မရတော့ပါ။ ယာယီရပ်နားလိုပါက Paused ကိုသာ ရွေးချယ်ပါ။",
  archiveConfirmButton: "Archive အပြီးလုပ်မည်",
  deleteCampaignConfirmTitle: "Campaign ဖျက်ရန် အတည်ပြုပါ",
  deleteCampaignConfirmBody:
    "ဤ Campaign မှတ်တမ်းကို Firestore မှ အပြီးဖျက်ပါမည်။ ချိတ်ဆက်ထားသော Product ကို မထိခိုက်ပါ။",
  deleteCampaignConfirmButton: "Campaign ဖျက်မည်",
  errNameRequired: "Product Name ဖြည့်သွင်းရန် လိုအပ်ပါသည် (1–200 စာလုံး)။",
  errTitleRequired: "Campaign Title ဖြည့်သွင်းရန် လိုအပ်ပါသည် (1–200 စာလုံး)။",
  errProductRequired: "ချိတ်ဆက်မည့် Saved Affiliate Product တစ်ခု ရွေးချယ်ပါ။",
  errInvalidUrl: "URL သည် http:// သို့မဟုတ် https:// ဖြင့် စတင်ရမည်။",
  errInvalidPrice: "Price (THB) သည် 0 မှ 10,000,000 အတွင်း ဂဏန်းဖြစ်ရမည်။",
  errInvalidCommission: "Commission (%) သည် 0 မှ 100 အတွင်း ဂဏန်းဖြစ်ရမည်။",
  errInvalidStartDate: "Start Date သည် YYYY-MM-DD ပုံစံ မှန်ကန်ရမည်။",
  errInvalidEndDate: "End Date သည် YYYY-MM-DD ပုံစံ မှန်ကန်ရမည်။",
  errEndBeforeStart: "End Date သည် Start Date ထက် စော၍မရပါ။",
  errOfflineWriteBlocked:
    "လက်ရှိ Firestore Server နှင့် Connected မဖြစ်သေးသောကြောင့် အသစ်သိမ်းဆည်း၍မရသေးပါ။",
  errCachedWriteBlocked:
    "Cached Data (Read-only) အခြေအနေဖြစ်နေပါသည် — Server connection ပြန်ရမှသာ သိမ်းဆည်းနိုင်ပါမည်။",
  confirmConnectionUnavailable:
    "ချိတ်ဆက်မှု မရရှိနိုင်သေးပါ — Firestore Server နှင့် ပြန်လည် Connected မဖြစ်မီ ဤလုပ်ဆောင်ချက်ကို လက်ရှိတွင် သိမ်းဆည်း၍မရပါ။",
  errWriteInFlightLocked:
    "အခြား Firestore write တစ်ခု Server confirmation စောင့်ဆိုင်းနေပါသည်။ ပြီးဆုံးမှ ထပ်မံပြုလုပ်ပါ။",
  errArchivedReadOnly: "Archived Record ဖြစ်သောကြောင့် ပြင်ဆင်၍မရပါ။",
};

const EN_DICT: AffiliateUiDictionary = {
  studioTitle: "Affiliate Studio",
  studioSubtitle: "TikTok Shop Thailand Creator Workspace",
  navDashboard: "Dashboard",
  navProducts: "Products",
  navCampaigns: "Campaigns",
  switchToVideoStudio: "Back to Video Studio",
  authenticatedOwner: "Authenticated Owner",
  ownerAccount: "Owner Account",
  manualEntry: "Manual Entry",
  systemRecord: "System Record",
  readOnlyArchived: "Archived (Read-only)",
  signInRequiredTitle: "Owner Sign-In Required",
  signInRequiredDesc:
    "Sign in with the configured Owner Google Account to view and save Firestore Affiliate records. Video Studio offline projects remain available without signing in.",
  signInWithGoogle: "Sign In with Google",
  signOut: "Sign Out",
  unconfiguredTitle: "Firebase Not Configured",
  unconfiguredDesc:
    "Cloud Firestore configuration is unavailable. Video Studio and local IndexedDB offline projects continue working normally.",
  syncingProfile: "Verifying owner profile...",
  retryingProfile: "Retrying owner profile verification...",
  profileSyncFailedTitle: "Owner Profile Sync Failed",
  profileSyncFailedDesc:
    "Could not initialize or verify your owner profile in Firestore. Check your connection and retry, or sign out.",
  loadingWorkspace: "Loading Firestore records...",
  connConnected: "Connected",
  connOffline: "Offline",
  connCached: "Cached Data",
  connSyncPending: "Sync Pending",
  connError: "Connection Error",
  connOfflineBanner:
    "Offline — New Firestore writes are paused. Video Studio offline projects remain available.",
  connCachedBanner:
    "Cached Data (Read-only) — Showing locally cached snapshot awaiting server confirmation. New writes stay disabled until Connected.",
  connSyncPendingBanner:
    "Sync Pending — Waiting for server confirmation. Do not refresh or close this page until Saved appears.",
  writeSaving: "Saving...",
  writeSyncPending: "Sync Pending",
  writeSyncPendingWarning:
    "Waiting for server confirmation (Sync Pending). Submission is locked to prevent duplicates — do not close or refresh until Saved appears.",
  writeSaved: "Saved (Server Confirmed)",
  writeFailed: "Failed",
  dismissWhilePendingButton: "Close (Keep Syncing)",
  dismissWhilePendingNotice:
    "Closing this dialog does not cancel the pending Firestore write. It keeps the same record ID and continues syncing in the background — do not refresh or close the browser tab until Saved appears.",
  retry: "Retry",
  dismiss: "Dismiss",
  savedProductsLabel: "Saved Products",
  savedCampaignsLabel: "Saved Campaigns",
  savedRecordsNote:
    "Counts reflect real saved Firestore records only. No simulated sales, views, orders, or commission metrics.",
  upcomingDatesTitle: "Planned Publishing Dates",
  upcomingDatesEmpty: "No planned campaign dates yet.",
  recentProductsTitle: "Recently Updated Products",
  recentCampaignsTitle: "Recently Updated Campaigns",
  quickAddProduct: "+ Add Product",
  quickNewCampaign: "+ New Campaign",
  needProductForCampaignHint: "Add at least one affiliate product before creating a campaign.",
  viewAll: "View all",
  productsTitle: "Product Workspace",
  addProduct: "Add Product",
  editProduct: "Edit Product Details",
  searchProductsPlaceholder: "Search product name, category, or tag (TH / MY / EN)...",
  noProductsYet: "No saved affiliate products yet.",
  noProductsMatch: "No products match your search or filters.",
  productArchiveOnlyNote:
    "To preserve campaign references, products cannot be deleted in Phase 3. Use Paused (temporary) or Archived (permanent read-only).",
  productNameLabel: "Product Name *",
  categoryLabel: "Category",
  tiktokShopUrlLabel: "TikTok Shop URL (https://...)",
  priceThbLabel: "Reference Price (THB)",
  commissionRateLabel: "Reference Commission (%)",
  contentLanguageLabel: "Content Language",
  sellingPointsLabel: "Selling Points / Product Notes",
  complianceNotesLabel: "Compliance Notes (Policy / Claims)",
  tagsLabel: "Tags (comma-separated)",
  tagsHint: "Up to 15 tags (max 50 chars each)",
  statusLabel: "Status",
  linkedCampaignsCount: "Linked Campaigns",
  copyUrl: "Copy URL",
  copied: "Copied",
  openLink: "Open Link",
  campaignsTitle: "Campaign Workspace",
  newCampaign: "New Campaign",
  editCampaign: "Edit Campaign Details",
  searchCampaignsPlaceholder: "Search campaign title or goal...",
  noCampaignsYet: "No saved content campaigns yet.",
  noCampaignsMatch: "No campaigns match your search or filters.",
  manualPublishingNotice:
    "Manual Publishing Tracking — Plans publishing dates only. Does not auto-publish to TikTok.",
  campaignTitleLabel: "Campaign Title *",
  linkedProductLabel: "Linked Affiliate Product *",
  linkedProductImmutableHint:
    "Linked product cannot be changed after campaign creation per Firestore security rules.",
  missingLinkedProduct: "Linked product unavailable",
  goalLabel: "Campaign Goal / Angle",
  strategyNotesLabel: "Strategy & Publishing Notes",
  startDateLabel: "Planned Start Date",
  endDateLabel: "Planned End Date",
  allProducts: "All Products",
  allStatuses: "All Statuses",
  allLanguages: "All Languages",
  save: "Save",
  cancel: "Cancel",
  editDetails: "Edit Details",
  pauseAction: "Pause",
  resumeAction: "Set Active",
  archiveAction: "Archive",
  deleteCampaignAction: "Delete Campaign",
  changeStatus: "Change Status",
  updatedLabel: "Updated",
  createdLabel: "Created",
  archiveConfirmTitle: "Confirm Archive",
  archiveConfirmBody:
    "Archiving is permanent and makes this record read-only. It cannot be edited or unarchived later. Use Paused if you only want to stop it temporarily.",
  archiveConfirmButton: "Archive Permanently",
  deleteCampaignConfirmTitle: "Confirm Delete Campaign",
  deleteCampaignConfirmBody:
    "This permanently deletes the campaign record from Firestore. The linked product is not affected.",
  deleteCampaignConfirmButton: "Delete Campaign",
  errNameRequired: "Product name is required (1–200 characters).",
  errTitleRequired: "Campaign title is required (1–200 characters).",
  errProductRequired: "Please select a saved affiliate product.",
  errInvalidUrl: "URL must start with http:// or https://.",
  errInvalidPrice: "Price (THB) must be a number between 0 and 10,000,000.",
  errInvalidCommission: "Commission (%) must be a number between 0 and 100.",
  errInvalidStartDate: "Start date must be a valid YYYY-MM-DD date.",
  errInvalidEndDate: "End date must be a valid YYYY-MM-DD date.",
  errEndBeforeStart: "End date cannot be earlier than start date.",
  errOfflineWriteBlocked:
    "Firestore server connection is not confirmed yet. Writes are enabled only when Connected.",
  errCachedWriteBlocked:
    "Showing cached data (read-only). Writes unlock once Firestore server connection is confirmed.",
  confirmConnectionUnavailable:
    "Connection is unavailable. This action cannot be saved right now until Firestore is Connected.",
  errWriteInFlightLocked:
    "Another write is currently waiting for server confirmation. Please wait until it finishes.",
  errArchivedReadOnly: "Archived records are read-only and cannot be modified.",
};

const TH_DICT: AffiliateUiDictionary = {
  studioTitle: "Affiliate Studio",
  studioSubtitle: "พื้นที่ทำงานครีเอเตอร์ TikTok Shop Thailand",
  navDashboard: "Dashboard",
  navProducts: "สินค้า",
  navCampaigns: "แคมเปญ",
  switchToVideoStudio: "กลับไปที่ Video Studio",
  authenticatedOwner: "Authenticated Owner",
  ownerAccount: "บัญชีเจ้าของระบบ",
  manualEntry: "Manual Entry",
  systemRecord: "System Record",
  readOnlyArchived: "Archived (อ่านอย่างเดียว)",
  signInRequiredTitle: "ต้องเข้าสู่ระบบด้วยบัญชีเจ้าของ",
  signInRequiredDesc:
    "เข้าสู่ระบบด้วยบัญชี Google ของเจ้าของเพื่อดูและบันทึกข้อมูล Firestore (Video Studio แบบออฟไลน์ยังคงใช้งานได้ตามปกติ)",
  signInWithGoogle: "เข้าสู่ระบบด้วย Google",
  signOut: "ออกจากระบบ",
  unconfiguredTitle: "ยังไม่ได้ตั้งค่า Firebase",
  unconfiguredDesc:
    "ไม่สามารถเชื่อมต่อ Cloud Firestore ได้ในขณะนี้ แต่ Video Studio และโปรเจกต์ IndexedDB ออฟไลน์ยังใช้งานได้ตามปกติ",
  syncingProfile: "กำลังตรวจสอบโปรไฟล์เจ้าของ...",
  retryingProfile: "กำลังลองตรวจสอบโปรไฟล์เจ้าของอีกครั้ง...",
  profileSyncFailedTitle: "ไม่สามารถซิงค์โปรไฟล์เจ้าของได้",
  profileSyncFailedDesc:
    "ไม่สามารถเริ่มต้นหรือยืนยันโปรไฟล์เจ้าของใน Firestore ได้ กรุณาตรวจสอบการเชื่อมต่อแล้วลองใหม่ หรือออกจากระบบ",
  loadingWorkspace: "กำลังโหลดข้อมูล Firestore...",
  connConnected: "Connected",
  connOffline: "Offline",
  connCached: "Cached Data",
  connSyncPending: "Sync Pending",
  connError: "Connection Error",
  connOfflineBanner:
    "ออฟไลน์ — ปิดการบันทึกข้อมูล Firestore ชั่วคราว (Video Studio ออฟไลน์ยังใช้งานได้)",
  connCachedBanner:
    "Cached Data (อ่านอย่างเดียว) — แสดงข้อมูลแคชในเครื่อง รอการยืนยันจากเซิร์ฟเวอร์ ปิดการบันทึกชั่วคราวจนกว่าจะ Connected",
  connSyncPendingBanner:
    "Sync Pending — กำลังรอการยืนยันจากเซิร์ฟเวอร์ อย่าเพิ่งรีเฟรชหรือปิดหน้าจนกว่าจะขึ้น Saved",
  writeSaving: "กำลังบันทึก...",
  writeSyncPending: "Sync Pending",
  writeSyncPendingWarning:
    "กำลังรอการยืนยันจากเซิร์ฟเวอร์ (Sync Pending) ล็อกปุ่มเพื่อป้องกันข้อมูลซ้ำ อย่าปิดหรือรีเฟรชหน้า",
  writeSaved: "Saved (ยืนยันจากเซิร์ฟเวอร์แล้ว)",
  writeFailed: "บันทึกไม่สำเร็จ",
  dismissWhilePendingButton: "ปิดหน้าต่าง (ซิงค์ต่อเบื้องหลัง)",
  dismissWhilePendingNotice:
    "การปิดหน้าต่างนี้ไม่ได้ยกเลิกการบันทึก Firestore ระบบยังคงใช้ Record ID เดิมและซิงค์ต่อเบื้องหลัง อย่ารีเฟรชหรือปิดแท็บจนกว่าจะขึ้น Saved",
  retry: "ลองใหม่",
  dismiss: "ปิด",
  savedProductsLabel: "สินค้าที่บันทึกไว้",
  savedCampaignsLabel: "แคมเปญที่บันทึกไว้",
  savedRecordsNote:
    "ตัวเลขแสดงเฉพาะรายการจริงที่บันทึกใน Firestore ไม่มีข้อมูลยอดขายหรือคอมมิชชันจำลอง",
  upcomingDatesTitle: "กำหนดการเผยแพร่ที่วางแผนไว้",
  upcomingDatesEmpty: "ยังไม่มีกำหนดการเผยแพร่แคมเปญ",
  recentProductsTitle: "สินค้าที่อัปเดตล่าสุด",
  recentCampaignsTitle: "แคมเปญที่อัปเดตล่าสุด",
  quickAddProduct: "+ เพิ่มสินค้า",
  quickNewCampaign: "+ สร้างแคมเปญ",
  needProductForCampaignHint: "กรุณาเพิ่มสินค้าอย่างน้อย 1 รายการก่อนสร้างแคมเปญ",
  viewAll: "ดูทั้งหมด",
  productsTitle: "จัดการสินค้า Affiliate",
  addProduct: "เพิ่มสินค้า",
  editProduct: "แก้ไขรายละเอียดสินค้า",
  searchProductsPlaceholder: "ค้นหาชื่อสินค้า หมวดหมู่ หรือแท็ก (TH / MY / EN)...",
  noProductsYet: "ยังไม่มีสินค้าที่บันทึกไว้",
  noProductsMatch: "ไม่พบสินค้าที่ตรงกับตัวกรอง",
  productArchiveOnlyNote:
    "เพื่อป้องกันแคมเปญอ้างอิงผิดพลาด Phase 3 ไม่มีปุ่มลบสินค้า สามารถใช้ Paused (พักชั่วคราว) หรือ Archived (เก็บถาวร อ่านอย่างเดียว)",
  productNameLabel: "ชื่อสินค้า *",
  categoryLabel: "หมวดหมู่",
  tiktokShopUrlLabel: "ลิงก์สินค้า TikTok Shop (https://...)",
  priceThbLabel: "ราคาอ้างอิง (THB)",
  commissionRateLabel: "ค่าคอมมิชชันอ้างอิง (%)",
  contentLanguageLabel: "ภาษาคอนเทนต์",
  sellingPointsLabel: "จุดขาย / บันทึกสินค้า",
  complianceNotesLabel: "ข้อควรระวังนโยบาย (Compliance Notes)",
  tagsLabel: "แท็ก (คั่นด้วยเครื่องหมาย ,)",
  tagsHint: "สูงสุด 15 แท็ก (ไม่เกิน 50 ตัวอักษร/แท็ก)",
  statusLabel: "สถานะ",
  linkedCampaignsCount: "แคมเปญที่เชื่อมโยง",
  copyUrl: "คัดลอก URL",
  copied: "คัดลอกแล้ว",
  openLink: "เปิดลิงก์",
  campaignsTitle: "จัดการแคมเปญคอนเทนต์",
  newCampaign: "สร้างแคมเปญ",
  editCampaign: "แก้ไขรายละเอียดแคมเปญ",
  searchCampaignsPlaceholder: "ค้นหาชื่อแคมเปญหรือเป้าหมาย...",
  noCampaignsYet: "ยังไม่มีแคมเปญที่บันทึกไว้",
  noCampaignsMatch: "ไม่พบแคมเปญที่ตรงกับตัวกรอง",
  manualPublishingNotice:
    "Manual Publishing Tracking — ใช้ติดตามแผนวันลงคลิปเท่านั้น ไม่มีการโพสต์ลง TikTok อัตโนมัติ",
  campaignTitleLabel: "ชื่อแคมเปญ *",
  linkedProductLabel: "สินค้าที่เชื่อมโยง *",
  linkedProductImmutableHint:
    "ไม่สามารถเปลี่ยนสินค้าที่เชื่อมโยงหลังสร้างแคมเปญตาม Firestore Rules",
  missingLinkedProduct: "ไม่พบสินค้าที่เชื่อมโยง",
  goalLabel: "เป้าหมาย / มุมคอนเทนต์",
  strategyNotesLabel: "บันทึกกลยุทธ์และแผนการลงคลิป",
  startDateLabel: "วันเริ่มต้นที่วางแผน",
  endDateLabel: "วันสิ้นสุดที่วางแผน",
  allProducts: "สินค้าทั้งหมด",
  allStatuses: "ทุกสถานะ",
  allLanguages: "ทุกภาษา",
  save: "บันทึก",
  cancel: "ยกเลิก",
  editDetails: "แก้ไขรายละเอียด",
  pauseAction: "พักชั่วคราว",
  resumeAction: "เปิดใช้งาน",
  archiveAction: "เก็บถาวร (Archive)",
  deleteCampaignAction: "ลบแคมเปญ",
  changeStatus: "เปลี่ยนสถานะ",
  updatedLabel: "อัปเดต",
  createdLabel: "สร้างเมื่อ",
  archiveConfirmTitle: "ยืนยันการเก็บถาวร (Archive)",
  archiveConfirmBody:
    "เมื่อ Archive แล้วจะกลายเป็นอ่านอย่างเดียวถาวร ไม่สามารถแก้ไขหรือนำกลับมาได้ หากต้องการพักชั่วคราวให้เลือก Paused",
  archiveConfirmButton: "ยืนยัน Archive ถาวร",
  deleteCampaignConfirmTitle: "ยืนยันการลบแคมเปญ",
  deleteCampaignConfirmBody:
    "ลบแคมเปญนี้ออกจาก Firestore ถาวร โดยไม่กระทบสินค้าที่เชื่อมโยง",
  deleteCampaignConfirmButton: "ลบแคมเปญ",
  errNameRequired: "กรุณาระบุชื่อสินค้า (1–200 ตัวอักษร)",
  errTitleRequired: "กรุณาระบุชื่อแคมเปญ (1–200 ตัวอักษร)",
  errProductRequired: "กรุณาเลือกสินค้าที่บันทึกไว้",
  errInvalidUrl: "URL ต้องขึ้นต้นด้วย http:// หรือ https://",
  errInvalidPrice: "ราคา (THB) ต้องเป็นตัวเลขระหว่าง 0 ถึง 10,000,000",
  errInvalidCommission: "ค่าคอมมิชชัน (%) ต้องเป็นตัวเลขระหว่าง 0 ถึง 100",
  errInvalidStartDate: "วันเริ่มต้นต้องเป็นรูปแบบ YYYY-MM-DD ที่ถูกต้อง",
  errInvalidEndDate: "วันสิ้นสุดต้องเป็นรูปแบบ YYYY-MM-DD ที่ถูกต้อง",
  errEndBeforeStart: "วันสิ้นสุดต้องไม่ก่อนวันเริ่มต้น",
  errOfflineWriteBlocked:
    "ยังไม่ยืนยันการเชื่อมต่อเซิร์ฟเวอร์ Firestore สามารถบันทึกได้เฉพาะเมื่อสถานะเป็น Connected",
  errCachedWriteBlocked:
    "กำลังแสดงข้อมูลแคช (อ่านอย่างเดียว) จะบันทึกได้เมื่อเชื่อมต่อเซิร์ฟเวอร์แล้ว",
  confirmConnectionUnavailable:
    "การเชื่อมต่อไม่พร้อมใช้งาน ไม่สามารถบันทึกการดำเนินการนี้ได้ในขณะนี้จนกว่า Firestore จะ Connected",
  errWriteInFlightLocked:
    "กำลังรอการยืนยันการบันทึกอีกรายการอยู่ กรุณารอให้เสร็จสิ้นก่อน",
  errArchivedReadOnly: "รายการที่ Archive แล้วไม่สามารถแก้ไขได้",
};

export const AFFILIATE_DICTIONARIES: Record<UiLanguage, AffiliateUiDictionary> = {
  my: MY_DICT,
  en: EN_DICT,
  th: TH_DICT,
};

export function getAffiliateLabels(lang: UiLanguage): AffiliateUiDictionary {
  return AFFILIATE_DICTIONARIES[lang] || MY_DICT;
}

export const CONTENT_LANGUAGE_LABELS: Record<ContentLanguage, string> = {
  th: "ไทย (TH)",
  my: "မြန်မာ (MY)",
  th_my: "ไทย + မြန်မာ",
};

export const PRODUCT_STATUS_LABELS: Record<AffiliateProductStatus, Record<UiLanguage, string>> = {
  researching: { my: "Researching", en: "Researching", th: "กำลังศึกษา" },
  shortlisted: { my: "Shortlisted", en: "Shortlisted", th: "คัดเลือกไว้" },
  active: { my: "Active", en: "Active", th: "กำลังทำคอนเทนต์" },
  paused: { my: "Paused", en: "Paused", th: "พักชั่วคราว" },
  archived: { my: "Archived", en: "Archived", th: "เก็บถาวร" },
};

export const CAMPAIGN_STATUS_LABELS: Record<CampaignStatus, Record<UiLanguage, string>> = {
  draft: { my: "Draft", en: "Draft", th: "ฉบับร่าง" },
  active: { my: "Active", en: "Active", th: "กำลังดำเนินการ" },
  paused: { my: "Paused", en: "Paused", th: "พักชั่วคราว" },
  completed: { my: "Completed", en: "Completed", th: "เสร็จสิ้น" },
  archived: { my: "Archived", en: "Archived", th: "เก็บถาวร" },
};
