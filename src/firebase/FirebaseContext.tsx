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
import {
  getFirebaseClientServices,
  isFirestoreOfflineError,
  testConnection,
} from "./client";
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
  isRetryingProfile: boolean;
  user: User | null;
  ownerProfile: WithId<UserProfile> | null;
  isOwner: boolean;
  connectionStatus: FirebaseConnectionStatus;
  authError: string | null;
  profileError: string | null;
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
  isRetryingProfile: boolean;
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
    isRetryingProfile: false,
    profileError: null,
    sessionGeneration: 0,
  };

  let disposed = false;
  let connectionCheckGeneration = 0;
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
      isRetryingProfile: false,
      profileError: null,
    };
    notify();
  };

  const handleBrowserOffline = () => {
    if (!deps.isConfigured || disposed) return;
    connectionCheckGeneration += 1;
    inFlightConnectionPromise = null;
    state = {
      ...state,
      connectionStatus: "offline",
      isCheckingConnection: false,
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

    const capturedCheckGen = ++connectionCheckGeneration;
    state = {
      ...state,
      isCheckingConnection: true,
      connectionStatus: "checking",
    };
    notify();

    const runPromise = (async (): Promise<FirebaseConnectionStatus> => {
      try {
        const result = await deps.testConnection();
        if (disposed || capturedCheckGen !== connectionCheckGeneration) {
          return state.connectionStatus;
        }
        inFlightConnectionPromise = null;
        state = {
          ...state,
          connectionStatus: result.status,
          isCheckingConnection: false,
        };
        notify();
        return result.status;
      } catch {
        if (disposed || capturedCheckGen !== connectionCheckGeneration) {
          return state.connectionStatus;
        }
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
    candidateUser?: User | null,
    options?: { isRetry?: boolean }
  ): Promise<WithId<UserProfile> | null> => {
    if (!deps.isConfigured) {
      return Promise.resolve(null);
    }

    const liveUser = deps.getCurrentUser();
    const targetUser = candidateUser ?? liveUser;

    if (!targetUser || !liveUser || targetUser.uid !== liveUser.uid) {
      inFlightProfile = null;
      if (state.isProfileLoading || state.isRetryingProfile) {
        state = { ...state, isProfileLoading: false, isRetryingProfile: false };
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
        isRetryingProfile: false,
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
      isRetryingProfile: Boolean(options?.isRetry),
      profileError: null,
    };
    notify();

    let runPromise: Promise<WithId<UserProfile> | null> | null = null;
    runPromise = (async (): Promise<WithId<UserProfile> | null> => {
      try {
        const profile = await deps.ensureOwnerProfile(liveUser);
        if (disposed || capturedGen !== state.sessionGeneration) {
          return null;
        }
        const current = deps.getCurrentUser();
        if (
          !current ||
          current.uid !== targetUid ||
          !matchesOwnerAccount(current, deps.expectedOwnerEmail)
        ) {
          if (inFlightProfile?.promise === runPromise) {
            inFlightProfile = null;
          }
          const isUnauthorized = Boolean(
            current && !matchesOwnerAccount(current, deps.expectedOwnerEmail)
          );
          state = {
            ...state,
            sessionGeneration: state.sessionGeneration + 1,
            ownerProfile: null,
            isProfileLoading: false,
            isRetryingProfile: false,
            profileError: isUnauthorized
              ? "Access restricted to the verified owner account only."
              : null,
          };
          notify();
          if (isUnauthorized) {
            void deps.onUnauthorizedOwner?.();
          }
          return null;
        }

        if (!profile || profile.ownerUid !== targetUid) {
          throw new Error("Owner profile UID verification failed.");
        }

        if (inFlightProfile?.promise === runPromise) {
          inFlightProfile = null;
        }
        state = {
          ...state,
          ownerProfile: profile,
          isProfileLoading: false,
          isRetryingProfile: false,
          profileError: null,
          // ensureOwnerProfile uses server-only getDocFromServer; do not override
          // an actively running boot connection check while it is still in flight.
          connectionStatus: inFlightConnectionPromise ? state.connectionStatus : "connected",
        };
        notify();
        return profile;
      } catch (err) {
        if (disposed || capturedGen !== state.sessionGeneration) {
          return null;
        }
        const current = deps.getCurrentUser();
        if (
          !current ||
          current.uid !== targetUid ||
          !matchesOwnerAccount(current, deps.expectedOwnerEmail)
        ) {
          if (inFlightProfile?.promise === runPromise) {
            inFlightProfile = null;
          }
          const isUnauthorized = Boolean(
            current && !matchesOwnerAccount(current, deps.expectedOwnerEmail)
          );
          state = {
            ...state,
            sessionGeneration: state.sessionGeneration + 1,
            ownerProfile: null,
            isProfileLoading: false,
            isRetryingProfile: false,
            profileError: isUnauthorized
              ? "Access restricted to the verified owner account only."
              : null,
          };
          notify();
          if (isUnauthorized) {
            void deps.onUnauthorizedOwner?.();
          }
          return null;
        }
        if (inFlightProfile?.promise === runPromise) {
          inFlightProfile = null;
        }

        const quotaMsg = buildFirestoreQuotaGuidance(
          err,
          deps.projectId ?? undefined,
          deps.databaseId ?? undefined
        );
        let nextError: string;
        let nextConnectionStatus = state.connectionStatus;

        if (quotaMsg) {
          nextError = quotaMsg;
        } else if (isFirestoreOfflineError(err)) {
          nextConnectionStatus = "offline";
          nextError =
            "Firestore is currently offline. Check your connection and retry, or sign out.";
        } else {
          nextError =
            "Signed in, but Firestore profile sync failed. Please retry or sign out.";
        }

        state = {
          ...state,
          isProfileLoading: false,
          isRetryingProfile: false,
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
    return loadOwnerProfile(deps.getCurrentUser(), { isRetry: true });
  };

  const activate = () => {
    disposed = false;
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
    handleBrowserOffline,
    retryBootConnection,
    handleBrowserOnline,
    loadOwnerProfile,
    retryOwnerProfile,
    activate,
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
    coordinator.activate();
    return () => {
      coordinator.dispose();
    };
  }, [coordinator]);

  // Boot-time Firestore connectivity validation + automatic browser offline/online recovery (D-02)
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
    const onOffline = () => {
      coordinator.handleBrowserOffline();
    };
    window.addEventListener("online", onOnline);
    window.addEventListener("offline", onOffline);
    return () => {
      window.removeEventListener("online", onOnline);
      window.removeEventListener("offline", onOffline);
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
    // Preserve coordinator.profileError while an authenticated owner is still in Gate 4
    // (ownerProfile === null) so dismissing the header dropdown never erases Gate 4's error state.
    const current = services.auth?.currentUser ?? null;
    const inGate4 = Boolean(
      current && matchesOwnerAccount(current) && !coordinator.getState().ownerProfile
    );
    if (!inGate4) {
      coordinator.clearProfileError();
    }
  }, [coordinator, services.auth]);

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
  const profileError = recoveryState.profileError;

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
      isRetryingProfile: recoveryState.isRetryingProfile,
      user,
      ownerProfile: recoveryState.ownerProfile,
      isOwner: matchesOwnerAccount(user),
      connectionStatus: recoveryState.connectionStatus,
      authError,
      profileError,
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
      recoveryState.isRetryingProfile,
      user,
      recoveryState.ownerProfile,
      recoveryState.connectionStatus,
      authError,
      profileError,
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
