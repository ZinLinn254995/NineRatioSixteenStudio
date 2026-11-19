import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  GoogleAuthProvider,
  onAuthStateChanged,
  signInWithPopup,
  signOut,
  type User,
} from "firebase/auth";
import { getFirebaseClientServices, testConnection } from "./client";
import { getExpectedOwnerEmail } from "./config";
import { buildFirestoreQuotaGuidance } from "./errors";
import {
  ensureOwnerProfile,
  getOwnerProfileFromServer,
  updateOwnerProfileSettings,
} from "./firestoreService";
import type { FirebaseConnectionStatus, UiLanguage, UserProfile, WithId } from "./types";

export interface FirebaseContextValue {
  isConfigured: boolean;
  configReason: string | null;
  projectId: string | null;
  databaseId: string | null;
  authReady: boolean;
  isSigningIn: boolean;
  isCheckingConnection: boolean;
  isProfileLoading: boolean;
  user: User | null;
  ownerProfile: WithId<UserProfile> | null;
  isOwner: boolean;
  connectionStatus: FirebaseConnectionStatus;
  authError: string | null;
  signInWithGoogle: () => Promise<void>;
  signOutOwner: () => Promise<void>;
  clearAuthError: () => void;
  retryBootConnection: () => Promise<FirebaseConnectionStatus>;
  retryOwnerProfile: () => Promise<WithId<UserProfile> | null>;
  refreshOwnerProfile: () => Promise<WithId<UserProfile> | null>;
  updatePreferredUiLanguage: (lang: UiLanguage) => Promise<void>;
}

const FirebaseContext = createContext<FirebaseContextValue | null>(null);

export function matchesOwnerAccount(
  user: Pick<User, "email" | "emailVerified"> | null | undefined,
  expectedEmailOverride?: string
): boolean {
  if (!user || !user.email || !user.emailVerified) {
    return false;
  }
  const expectedEmail = (expectedEmailOverride ?? getExpectedOwnerEmail()).trim().toLowerCase();
  return user.email.trim().toLowerCase() === expectedEmail;
}

export interface FirebaseRecoveryState {
  connectionStatus: FirebaseConnectionStatus;
  isCheckingConnection: boolean;
  ownerProfile: WithId<UserProfile> | null;
  isProfileLoading: boolean;
  profileError: string | null;
  sessionGeneration: number;
}

export interface FirebaseRecoveryCoordinatorDeps {
  isConfigured: boolean;
  expectedOwnerEmail?: string;
  projectId?: string | null;
  databaseId?: string | null;
  testConnection: () => Promise<{ status: FirebaseConnectionStatus; message?: string }>;
  ensureOwnerProfile: (user: User) => Promise<WithId<UserProfile>>;
  getCurrentUser: () => User | null;
  onUnauthorizedOwner?: () => void | Promise<void>;
}

/**
 * Pure, testable recovery coordinator for Firebase boot connection checks and
 * owner profile initialization/retry.
 *
 * Guarantees:
 * - Single-flight deduplication for retryBootConnection() and browser online recovery.
 * - Single-flight deduplication for ensureOwnerProfile() per owner UID + sessionGeneration.
 * - Strict owner email + emailVerified + live UID + sessionGeneration verification on every retry.
 */
export function createFirebaseRecoveryCoordinator(deps: FirebaseRecoveryCoordinatorDeps) {
  let state: FirebaseRecoveryState = {
    connectionStatus: deps.isConfigured ? "checking" : "unconfigured",
    isCheckingConnection: false,
    ownerProfile: null,
    isProfileLoading: false,
    profileError: null,
    sessionGeneration: 0,
  };

  let disposed = false;
  let inFlightConnectionPromise: Promise<FirebaseConnectionStatus> | null = null;
  let inFlightProfile: {
    uid: string;
    generation: number;
    promise: Promise<WithId<UserProfile> | null>;
  } | null = null;

  const listeners = new Set<() => void>();

  const notify = () => {
    if (disposed) return;
    for (const listener of listeners) {
      listener();
    }
  };

  const getState = (): FirebaseRecoveryState => ({ ...state });

  const subscribe = (listener: () => void): (() => void) => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  };

  const clearProfileError = () => {
    if (state.profileError !== null) {
      state = { ...state, profileError: null };
      notify();
    }
  };

  const setOwnerProfile = (
    updater:
      | WithId<UserProfile>
      | null
      | ((prev: WithId<UserProfile> | null) => WithId<UserProfile> | null)
  ) => {
    const nextProfile =
      typeof updater === "function" ? updater(state.ownerProfile) : updater;
    state = { ...state, ownerProfile: nextProfile };
    notify();
  };

  const advanceSession = () => {
    inFlightProfile = null;
    state = {
      ...state,
      sessionGeneration: state.sessionGeneration + 1,
      ownerProfile: null,
      isProfileLoading: false,
      profileError: null,
    };
    notify();
  };

  const retryBootConnection = (): Promise<FirebaseConnectionStatus> => {
    if (!deps.isConfigured) {
      state = {
        ...state,
        connectionStatus: "unconfigured",
        isCheckingConnection: false,
      };
      notify();
      return Promise.resolve("unconfigured");
    }

    if (inFlightConnectionPromise) {
      return inFlightConnectionPromise;
    }

    state = {
      ...state,
      isCheckingConnection: true,
      connectionStatus:
        state.connectionStatus === "connected" ? "connected" : "checking",
    };
    notify();

    const runPromise = (async (): Promise<FirebaseConnectionStatus> => {
      try {
        const result = await deps.testConnection();
        if (disposed) return result.status;
        inFlightConnectionPromise = null;
        state = {
          ...state,
          connectionStatus: result.status,
          isCheckingConnection: false,
        };
        notify();
        return result.status;
      } catch {
        if (disposed) return "error";
        inFlightConnectionPromise = null;
        state = {
          ...state,
          connectionStatus: "error",
          isCheckingConnection: false,
        };
        notify();
        return "error";
      }
    })();

    inFlightConnectionPromise = runPromise;
    return runPromise;
  };

  const handleBrowserOnline = (): Promise<FirebaseConnectionStatus> => {
    if (!deps.isConfigured) {
      return Promise.resolve("unconfigured");
    }
    return retryBootConnection();
  };

  const loadOwnerProfile = (
    candidateUser?: User | null
  ): Promise<WithId<UserProfile> | null> => {
    if (!deps.isConfigured) {
      return Promise.resolve(null);
    }

    const liveUser = deps.getCurrentUser();
    const targetUser = candidateUser ?? liveUser;

    if (!targetUser || !liveUser || targetUser.uid !== liveUser.uid) {
      if (state.isProfileLoading) {
        state = { ...state, isProfileLoading: false };
        notify();
      }
      return Promise.resolve(null);
    }

    if (!matchesOwnerAccount(liveUser, deps.expectedOwnerEmail)) {
      inFlightProfile = null;
      state = {
        ...state,
        sessionGeneration: state.sessionGeneration + 1,
        ownerProfile: null,
        isProfileLoading: false,
        profileError: "Access restricted to the verified owner account only.",
      };
      notify();
      void deps.onUnauthorizedOwner?.();
      return Promise.resolve(null);
    }

    const targetUid = liveUser.uid;
    const capturedGen = state.sessionGeneration;

    if (
      inFlightProfile &&
      inFlightProfile.uid === targetUid &&
      inFlightProfile.generation === capturedGen
    ) {
      return inFlightProfile.promise;
    }

    state = {
      ...state,
      isProfileLoading: true,
      profileError: null,
    };
    notify();

    const runPromise = (async (): Promise<WithId<UserProfile> | null> => {
      try {
        const profile = await deps.ensureOwnerProfile(liveUser);
        const current = deps.getCurrentUser();
        if (
          disposed ||
          capturedGen !== state.sessionGeneration ||
          !current ||
          current.uid !== targetUid ||
          !matchesOwnerAccount(current, deps.expectedOwnerEmail)
        ) {
          return null;
        }
        inFlightProfile = null;
        state = {
          ...state,
          ownerProfile: profile,
          isProfileLoading: false,
          profileError: null,
          connectionStatus: "connected",
        };
        notify();
        return profile;
      } catch (err) {
        const current = deps.getCurrentUser();
        if (
          disposed ||
          capturedGen !== state.sessionGeneration ||
          !current ||
          current.uid !== targetUid
        ) {
          return null;
        }
        inFlightProfile = null;

        const quotaMsg = buildFirestoreQuotaGuidance(
          err,
          deps.projectId ?? undefined,
          deps.databaseId ?? undefined
        );
        let nextError: string;
        let nextConnectionStatus = state.connectionStatus;

        if (quotaMsg) {
          nextError = quotaMsg;
        } else {
          const msg = err instanceof Error ? err.message : "Could not sync owner profile.";
          if (
            msg.toLowerCase().includes("the client is offline") ||
            msg.toLowerCase().includes("unavailable")
          ) {
            nextConnectionStatus = "offline";
            nextError =
              "Firestore is currently offline. Check your connection and retry, or sign out.";
          } else {
            nextError =
              "Signed in, but Firestore profile sync failed. Please retry or sign out.";
          }
        }

        state = {
          ...state,
          isProfileLoading: false,
          profileError: nextError,
          connectionStatus: nextConnectionStatus,
        };
        notify();
        return null;
      }
    })();

    inFlightProfile = {
      uid: targetUid,
      generation: capturedGen,
      promise: runPromise,
    };
    return runPromise;
  };

  const retryOwnerProfile = (): Promise<WithId<UserProfile> | null> => {
    return loadOwnerProfile(deps.getCurrentUser());
  };

  const dispose = () => {
    disposed = true;
    inFlightConnectionPromise = null;
    inFlightProfile = null;
    listeners.clear();
  };

  return {
    getState,
    subscribe,
    clearProfileError,
    setOwnerProfile,
    advanceSession,
    retryBootConnection,
    handleBrowserOnline,
    loadOwnerProfile,
    retryOwnerProfile,
    dispose,
  };
}

export function FirebaseProvider({ children }: { children: ReactNode }) {
  const services = useMemo(() => getFirebaseClientServices(), []);
  const isConfigured = services.resolution.configured && Boolean(services.auth && services.db);

  const [authReady, setAuthReady] = useState<boolean>(!isConfigured);
  const [isSigningIn, setIsSigningIn] = useState<boolean>(false);
  const [user, setUser] = useState<User | null>(null);
  const [signInError, setSignInError] = useState<string | null>(services.initError);

  const prevAuthUidRef = useRef<string | null>(null);

  const coordinatorRef = useRef<ReturnType<typeof createFirebaseRecoveryCoordinator> | null>(null);
  if (!coordinatorRef.current) {
    coordinatorRef.current = createFirebaseRecoveryCoordinator({
      isConfigured,
      projectId: services.resolution.config?.projectId,
      databaseId: services.resolution.config?.firestoreDatabaseId,
      testConnection,
      ensureOwnerProfile,
      getCurrentUser: () => services.auth?.currentUser ?? null,
      onUnauthorizedOwner: async () => {
        setUser(null);
        prevAuthUidRef.current = null;
        if (services.auth) {
          try {
            await signOut(services.auth);
          } catch {
            // ignore sign-out error
          }
        }
      },
    });
  }

  const coordinator = coordinatorRef.current;
  const [recoveryState, setRecoveryState] = useState<FirebaseRecoveryState>(() =>
    coordinator.getState()
  );

  useEffect(() => {
    const unsub = coordinator.subscribe(() => {
      setRecoveryState(coordinator.getState());
    });
    return () => {
      unsub();
    };
  }, [coordinator]);

  useEffect(() => {
    return () => {
      coordinator.dispose();
    };
  }, [coordinator]);

  // Boot-time Firestore connectivity validation + automatic browser online recovery (D-02)
  useEffect(() => {
    if (!isConfigured) {
      void coordinator.retryBootConnection();
      return;
    }

    void coordinator.retryBootConnection();

    if (typeof window === "undefined") return;
    const onOnline = () => {
      void coordinator.handleBrowserOnline();
    };
    window.addEventListener("online", onOnline);
    return () => {
      window.removeEventListener("online", onOnline);
    };
  }, [isConfigured, coordinator]);

  // Listen for Firebase Auth state changes (owner-only single-user enforcement)
  useEffect(() => {
    if (!isConfigured || !services.auth) {
      setAuthReady(true);
      setUser(null);
      prevAuthUidRef.current = null;
      coordinator.advanceSession();
      return;
    }

    const unsubscribe = onAuthStateChanged(services.auth, async (nextUser) => {
      if (!nextUser) {
        prevAuthUidRef.current = null;
        setUser(null);
        coordinator.advanceSession();
        setAuthReady(true);
        return;
      }

      if (!matchesOwnerAccount(nextUser)) {
        prevAuthUidRef.current = null;
        setUser(null);
        coordinator.advanceSession();
        setSignInError("Access restricted to the verified owner account only.");
        setAuthReady(true);
        try {
          await signOut(services.auth!);
        } catch {
          // ignore sign-out error
        }
        return;
      }

      const uidChanged = prevAuthUidRef.current !== nextUser.uid;
      prevAuthUidRef.current = nextUser.uid;
      if (uidChanged) {
        coordinator.advanceSession();
      }

      setUser(nextUser);
      setSignInError(null);
      setAuthReady(true);

      await coordinator.loadOwnerProfile(nextUser);
    });

    return () => unsubscribe();
  }, [isConfigured, services, coordinator]);

  const signInWithGoogle = useCallback(async () => {
    if (!services.auth || !isConfigured) {
      setSignInError("Firebase is not configured. Local Video Studio remains available.");
      return;
    }

    setIsSigningIn(true);
    setSignInError(null);
    coordinator.clearProfileError();
    try {
      const provider = new GoogleAuthProvider();
      provider.setCustomParameters({ prompt: "select_account" });
      const cred = await signInWithPopup(services.auth, provider);
      if (!matchesOwnerAccount(cred.user)) {
        await signOut(services.auth);
        setSignInError("Access restricted to the verified owner account only.");
      }
    } catch (err) {
      const code = (err as { code?: string })?.code || "";
      if (code === "auth/popup-closed-by-user" || code === "auth/cancelled-popup-request") {
        // User intentionally closed sign-in popup
      } else if (code === "auth/popup-blocked") {
        setSignInError(
          "Sign-in popup was blocked by the browser. Please allow popups and try again."
        );
      } else {
        setSignInError(err instanceof Error ? err.message : "Google Sign-In failed.");
      }
    } finally {
      setIsSigningIn(false);
    }
  }, [isConfigured, services.auth, coordinator]);

  const signOutOwner = useCallback(async () => {
    if (!services.auth) return;
    prevAuthUidRef.current = null;
    coordinator.advanceSession();
    setSignInError(null);
    try {
      await signOut(services.auth);
      setUser(null);
    } catch (err) {
      setSignInError(err instanceof Error ? err.message : "Sign-out failed.");
    }
  }, [services.auth, coordinator]);

  const clearAuthError = useCallback(() => {
    setSignInError(null);
    coordinator.clearProfileError();
  }, [coordinator]);

  const retryBootConnection = useCallback(() => {
    return coordinator.retryBootConnection();
  }, [coordinator]);

  const retryOwnerProfile = useCallback(async (): Promise<WithId<UserProfile> | null> => {
    setSignInError(null);
    return coordinator.retryOwnerProfile();
  }, [coordinator]);

  const refreshOwnerProfile = useCallback(async (): Promise<WithId<UserProfile> | null> => {
    if (!isConfigured || !user || !matchesOwnerAccount(user)) return null;
    const targetUid = user.uid;
    const capturedGen = coordinator.getState().sessionGeneration;
    const latest = await getOwnerProfileFromServer(targetUid);
    if (
      services.auth?.currentUser?.uid !== targetUid ||
      coordinator.getState().sessionGeneration !== capturedGen
    ) {
      return null;
    }
    if (latest) {
      coordinator.setOwnerProfile(latest);
    }
    return latest;
  }, [isConfigured, services.auth, user, coordinator]);

  const updatePreferredUiLanguage = useCallback(
    async (lang: UiLanguage) => {
      if (!isConfigured || !user || !matchesOwnerAccount(user)) return;
      const targetUid = user.uid;
      const capturedGen = coordinator.getState().sessionGeneration;
      await updateOwnerProfileSettings({ preferredUiLanguage: lang }, targetUid);
      if (
        services.auth?.currentUser?.uid !== targetUid ||
        coordinator.getState().sessionGeneration !== capturedGen
      ) {
        return;
      }
      coordinator.setOwnerProfile((prev) =>
        prev && prev.ownerUid === targetUid
          ? { ...prev, preferredUiLanguage: lang }
          : prev
      );
    },
    [isConfigured, services.auth, user, coordinator]
  );

  const authError = signInError ?? recoveryState.profileError;

  const value = useMemo<FirebaseContextValue>(
    () => ({
      isConfigured,
      configReason: services.resolution.reason ?? null,
      projectId: services.resolution.config?.projectId ?? null,
      databaseId: services.resolution.config?.firestoreDatabaseId ?? null,
      authReady,
      isSigningIn,
      isCheckingConnection: recoveryState.isCheckingConnection,
      isProfileLoading: recoveryState.isProfileLoading,
      user,
      ownerProfile: recoveryState.ownerProfile,
      isOwner: matchesOwnerAccount(user),
      connectionStatus: recoveryState.connectionStatus,
      authError,
      signInWithGoogle,
      signOutOwner,
      clearAuthError,
      retryBootConnection,
      retryOwnerProfile,
      refreshOwnerProfile,
      updatePreferredUiLanguage,
    }),
    [
      isConfigured,
      services.resolution,
      authReady,
      isSigningIn,
      recoveryState.isCheckingConnection,
      recoveryState.isProfileLoading,
      user,
      recoveryState.ownerProfile,
      recoveryState.connectionStatus,
      authError,
      signInWithGoogle,
      signOutOwner,
      clearAuthError,
      retryBootConnection,
      retryOwnerProfile,
      refreshOwnerProfile,
      updatePreferredUiLanguage,
    ]
  );

  return <FirebaseContext.Provider value={value}>{children}</FirebaseContext.Provider>;
}

export function useFirebase(): FirebaseContextValue {
  const ctx = useContext(FirebaseContext);
  if (!ctx) {
    throw new Error("useFirebase must be used inside a FirebaseProvider.");
  }
  return ctx;
}
