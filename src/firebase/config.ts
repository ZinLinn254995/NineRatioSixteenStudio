import appletConfig from "../../firebase-applet-config.json";

export interface FirebaseClientConfig {
  apiKey: string;
  authDomain: string;
  projectId: string;
  storageBucket: string;
  messagingSenderId: string;
  appId: string;
  firestoreDatabaseId?: string;
  measurementId?: string;
}

export interface FirebaseConfigResolution {
  configured: boolean;
  source: "env" | "applet-config" | "none";
  config: FirebaseClientConfig | null;
  missingFields: string[];
  reason?: string;
}

const PLACEHOLDER_MARKERS = [
  "remixed-project-id",
  "remixed-firestore-database-id",
  "your-api-key",
  "your-project-id",
];

// Single-owner verified email allowlist (public identifier only, never passwords/secrets).
export const DEFAULT_OWNER_EMAIL = "zla264995@gmail.com";

function readViteEnv(key: string): string {
  try {
    const env = (import.meta as unknown as { env?: Record<string, string | undefined> }).env;
    return (env?.[key] || "").trim();
  } catch {
    return "";
  }
}

export function getExpectedOwnerEmail(): string {
  const envOwner = readViteEnv("VITE_FIREBASE_OWNER_EMAIL").toLowerCase();
  return envOwner || DEFAULT_OWNER_EMAIL;
}

function isPlaceholder(value: string): boolean {
  const lower = value.trim().toLowerCase();
  return !lower || PLACEHOLDER_MARKERS.some((marker) => lower.includes(marker));
}

export function validateFirebaseConfigObject(
  candidate: Partial<FirebaseClientConfig> | null | undefined
): { valid: boolean; missingFields: string[]; reason?: string } {
  if (!candidate || typeof candidate !== "object") {
    return {
      valid: false,
      missingFields: ["apiKey", "authDomain", "projectId", "appId"],
      reason: "Firebase configuration object is missing.",
    };
  }

  const requiredKeys: (keyof FirebaseClientConfig)[] = [
    "apiKey",
    "authDomain",
    "projectId",
    "appId",
  ];
  const missingFields: string[] = [];

  for (const key of requiredKeys) {
    const val = typeof candidate[key] === "string" ? candidate[key]!.trim() : "";
    if (!val || isPlaceholder(val)) {
      missingFields.push(key);
    }
  }

  if (
    typeof candidate.firestoreDatabaseId === "string" &&
    candidate.firestoreDatabaseId.trim() !== "" &&
    isPlaceholder(candidate.firestoreDatabaseId)
  ) {
    missingFields.push("firestoreDatabaseId");
  }

  if (missingFields.length > 0) {
    return {
      valid: false,
      missingFields,
      reason: `Missing or placeholder Firebase config fields: ${missingFields.join(", ")}`,
    };
  }

  return { valid: true, missingFields: [] };
}

export function resolveFirebaseConfig(): FirebaseConfigResolution {
  // 1. Optional Vite public env override (for manual external Firebase projects)
  const envCandidate: Partial<FirebaseClientConfig> = {
    apiKey: readViteEnv("VITE_FIREBASE_API_KEY"),
    authDomain: readViteEnv("VITE_FIREBASE_AUTH_DOMAIN"),
    projectId: readViteEnv("VITE_FIREBASE_PROJECT_ID"),
    storageBucket: readViteEnv("VITE_FIREBASE_STORAGE_BUCKET"),
    messagingSenderId: readViteEnv("VITE_FIREBASE_MESSAGING_SENDER_ID"),
    appId: readViteEnv("VITE_FIREBASE_APP_ID"),
    firestoreDatabaseId: readViteEnv("VITE_FIREBASE_DATABASE_ID") || undefined,
  };

  const hasAnyEnvOverride = Boolean(
    envCandidate.apiKey || envCandidate.projectId || envCandidate.appId
  );

  if (hasAnyEnvOverride) {
    const envCheck = validateFirebaseConfigObject(envCandidate);
    if (envCheck.valid) {
      return {
        configured: true,
        source: "env",
        config: {
          apiKey: envCandidate.apiKey!,
          authDomain: envCandidate.authDomain!,
          projectId: envCandidate.projectId!,
          storageBucket: envCandidate.storageBucket || `${envCandidate.projectId}.firebasestorage.app`,
          messagingSenderId: envCandidate.messagingSenderId || "",
          appId: envCandidate.appId!,
          firestoreDatabaseId: envCandidate.firestoreDatabaseId,
        },
        missingFields: [],
      };
    }
    return {
      configured: false,
      source: "none",
      config: null,
      missingFields: envCheck.missingFields,
      reason: envCheck.reason,
    };
  }

  // 2. Provisioned firebase-applet-config.json
  const fileCandidate = appletConfig as Partial<FirebaseClientConfig>;
  const fileCheck = validateFirebaseConfigObject(fileCandidate);
  if (fileCheck.valid) {
    return {
      configured: true,
      source: "applet-config",
      config: {
        apiKey: fileCandidate.apiKey!,
        authDomain: fileCandidate.authDomain!,
        projectId: fileCandidate.projectId!,
        storageBucket:
          fileCandidate.storageBucket || `${fileCandidate.projectId}.firebasestorage.app`,
        messagingSenderId: fileCandidate.messagingSenderId || "",
        appId: fileCandidate.appId!,
        firestoreDatabaseId: fileCandidate.firestoreDatabaseId || undefined,
        measurementId: fileCandidate.measurementId || undefined,
      },
      missingFields: [],
    };
  }

  return {
    configured: false,
    source: "none",
    config: null,
    missingFields: fileCheck.missingFields,
    reason: fileCheck.reason,
  };
}
