import { getApp, getApps, initializeApp, type FirebaseApp } from "firebase/app";
import { getAuth, type Auth } from "firebase/auth";
import { doc, getDocFromServer, getFirestore, type Firestore } from "firebase/firestore";
import { getStorage, type FirebaseStorage } from "firebase/storage";
import { resolveFirebaseConfig, type FirebaseConfigResolution } from "./config";
import type { FirebaseConnectionStatus } from "./types";

export interface FirebaseClientServices {
  resolution: FirebaseConfigResolution;
  app: FirebaseApp | null;
  auth: Auth | null;
  db: Firestore | null;
  storage: FirebaseStorage | null;
  initError: string | null;
}

let cachedServices: FirebaseClientServices | null = null;

export function getFirebaseClientServices(): FirebaseClientServices {
  if (cachedServices) {
    return cachedServices;
  }

  const resolution = resolveFirebaseConfig();
  if (!resolution.configured || !resolution.config) {
    cachedServices = {
      resolution,
      app: null,
      auth: null,
      db: null,
      storage: null,
      initError: null,
    };
    return cachedServices;
  }

  try {
    const cfg = resolution.config;
    const app = getApps().length > 0 ? getApp() : initializeApp(cfg);
    const auth = getAuth(app);
    // CRITICAL: Always pass firestoreDatabaseId when provisioned for a named database.
    const db = cfg.firestoreDatabaseId
      ? getFirestore(app, cfg.firestoreDatabaseId)
      : getFirestore(app);
    const storage = cfg.storageBucket ? getStorage(app) : null;

    cachedServices = {
      resolution,
      app,
      auth,
      db,
      storage,
      initError: null,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to initialize Firebase SDK.";
    console.error("Firebase initialization failed:", message);
    cachedServices = {
      resolution,
      app: null,
      auth: null,
      db: null,
      storage: null,
      initError: message,
    };
  }

  return cachedServices;
}

const initial = getFirebaseClientServices();
export const firebaseApp = initial.app;
export const auth = initial.auth;
export const db = initial.db;
export const storage = initial.storage;

/**
 * Consistently classifies Firestore network/offline errors across client checks,
 * profile initialization, and workspace snapshot listeners.
 */
export function isFirestoreOfflineError(error: unknown): boolean {
  const code =
    typeof (error as { code?: unknown })?.code === "string"
      ? ((error as { code: string }).code || "").toLowerCase()
      : "";
  if (code === "unavailable" || code === "firestore/unavailable") {
    return true;
  }
  const message = (error instanceof Error ? error.message : String(error ?? "")).toLowerCase();
  return (
    message.includes("the client is offline") ||
    message.includes("unavailable") ||
    message.includes("could not reach cloud firestore backend") ||
    message.includes("network-request-failed") ||
    message.includes("failed to fetch")
  );
}

/**
 * Pure classifier for getDocFromServer("test/connection") errors.
 * Permission-denied confirms the Firestore server responded normally.
 */
export function classifyFirestoreConnectionError(error: unknown): {
  status: FirebaseConnectionStatus;
  message?: string;
} {
  const rawMessage = error instanceof Error ? error.message : String(error ?? "Unknown error.");
  const lower = rawMessage.toLowerCase();
  const code =
    typeof (error as { code?: unknown })?.code === "string"
      ? ((error as { code: string }).code || "").toLowerCase()
      : "";

  if (isFirestoreOfflineError(error)) {
    if (lower.includes("the client is offline")) {
      console.error("Please check your Firebase configuration.");
    }
    return {
      status: "offline",
      message: "Firestore client is offline. Local Video Studio remains available.",
    };
  }

  if (
    code === "permission-denied" ||
    code === "firestore/permission-denied" ||
    lower.includes("missing or insufficient permissions") ||
    lower.includes("permission-denied")
  ) {
    // Expected for unauthenticated/denied health-check document: server responded cleanly.
    return { status: "connected" };
  }

  return { status: "error", message: rawMessage };
}

/**
 * Validates server connectivity to Firestore on boot using getDocFromServer.
 * Permission-denied on the non-public test/connection path confirms the server
 * responded normally (not offline).
 */
export async function testConnection(): Promise<{
  status: FirebaseConnectionStatus;
  message?: string;
}> {
  const services = getFirebaseClientServices();
  if (!services.resolution.configured || !services.db) {
    return {
      status: "unconfigured",
      message: services.resolution.reason || "Firebase configuration is not set.",
    };
  }

  try {
    await getDocFromServer(doc(services.db, "test", "connection"));
    return { status: "connected" };
  } catch (error) {
    return classifyFirestoreConnectionError(error);
  }
}
