const UNIFIED_CUT_FLOW_STORAGE_KEY = "unifiedCutFlow";

export function resolveUnifiedCutFlowFlag(): boolean {
  if (typeof window === "undefined") return false;
  try {
    const params = new URLSearchParams(window.location.search);
    const param = params.get("unified");
    if (param === "1") {
      try {
        window.localStorage.setItem(UNIFIED_CUT_FLOW_STORAGE_KEY, "1");
      } catch {
        // Ignore storage errors (private mode / quota)
      }
      return true;
    }
    if (param === "0") {
      try {
        window.localStorage.setItem(UNIFIED_CUT_FLOW_STORAGE_KEY, "0");
      } catch {
        // Ignore storage errors (private mode / quota)
      }
      return false;
    }
    const stored = window.localStorage.getItem(UNIFIED_CUT_FLOW_STORAGE_KEY);
    return stored === "1" || stored === "true";
  } catch {
    return false;
  }
}

export const UNIFIED_CUT_FLOW: boolean = resolveUnifiedCutFlowFlag();
