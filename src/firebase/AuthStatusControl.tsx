import { useEffect, useRef, useState } from "react";
import { Cloud, CloudOff, Loader2, LogIn, LogOut, ShieldCheck, X } from "lucide-react";
import { useFirebase } from "./FirebaseContext";

/**
 * Compact header button for single-owner Firebase Authentication.
 * Preserves existing Video Studio header design and allows offline/local-only
 * operation even when signed out or when Firebase is unavailable.
 */
export function AuthStatusControl() {
  const {
    isConfigured,
    authReady,
    isSigningIn,
    user,
    isOwner,
    connectionStatus,
    authError,
    signInWithGoogle,
    signOutOwner,
    clearAuthError,
  } = useFirebase();

  const [open, setOpen] = useState(false);
  const [dismissedError, setDismissedError] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!authError && dismissedError !== null) {
      setDismissedError(null);
    }
  }, [authError, dismissedError]);

  const hasUndismissedError = Boolean(authError && dismissedError !== authError);
  const isDropdownVisible = open || hasUndismissedError;

  useEffect(() => {
    if (!isDropdownVisible) return;
    const onOutsideClick = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
        if (authError) {
          setDismissedError(authError);
        }
      }
    };
    document.addEventListener("mousedown", onOutsideClick);
    return () => document.removeEventListener("mousedown", onOutsideClick);
  }, [isDropdownVisible, authError]);

  if (!isConfigured) {
    return (
      <div className="relative" ref={containerRef}>
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          title="Local offline mode (Firebase not configured)"
          aria-label="Local offline mode"
          className="h-9 w-9 md:w-auto md:px-2.5 rounded-lg border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-950 hover:bg-neutral-100 dark:hover:bg-neutral-900 text-xs font-medium text-neutral-500 dark:text-neutral-400 flex items-center justify-center gap-1.5 whitespace-nowrap shrink-0 cursor-pointer transition-colors"
        >
          <CloudOff className="w-3.5 h-3.5" />
          <span className="hidden md:inline">Local</span>
        </button>
        {open && (
          <div className="absolute right-0 mt-2 w-64 max-w-[calc(100vw-1.5rem)] rounded-xl border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 shadow-lg p-3 z-50 text-xs space-y-1.5">
            <div className="flex items-center justify-between">
              <span className="font-semibold text-neutral-900 dark:text-neutral-100">
                Offline Studio Mode
              </span>
              <button
                type="button"
                onClick={() => setOpen(false)}
                aria-label="Close"
                className="p-0.5 text-neutral-400 hover:text-neutral-700 dark:hover:text-neutral-200 cursor-pointer"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            </div>
            <p className="text-neutral-500 dark:text-neutral-400 leading-relaxed">
              Firebase cloud sync is not configured. Video Studio and local IndexedDB projects work normally.
            </p>
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="relative" ref={containerRef}>
      {isOwner && user ? (
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          title={`Signed in as ${user.email}`}
          aria-label="Owner account menu"
          className="h-9 w-9 md:w-auto md:px-2.5 rounded-lg border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-950 hover:bg-neutral-100 dark:hover:bg-neutral-900 text-xs font-medium flex items-center justify-center gap-1.5 whitespace-nowrap shrink-0 cursor-pointer transition-colors"
        >
          {connectionStatus === "offline" ? (
            <CloudOff className="w-3.5 h-3.5 text-amber-500" />
          ) : (
            <ShieldCheck className="w-3.5 h-3.5 text-emerald-600 dark:text-emerald-400" />
          )}
          <span className="hidden md:inline max-w-[100px] truncate">
            {user.displayName || "Owner"}
          </span>
        </button>
      ) : (
        <button
          type="button"
          disabled={!authReady || isSigningIn}
          onClick={() => {
            if (authError) {
              setOpen((v) => !v);
            } else {
              void signInWithGoogle();
            }
          }}
          title="Owner Sign In (Google)"
          aria-label="Owner Sign In"
          className="h-9 w-9 md:w-auto md:px-2.5 rounded-lg border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-950 hover:bg-neutral-100 dark:hover:bg-neutral-900 text-xs font-medium flex items-center justify-center gap-1.5 whitespace-nowrap shrink-0 disabled:opacity-50 cursor-pointer transition-colors"
        >
          {isSigningIn || !authReady ? (
            <Loader2 className="w-3.5 h-3.5 animate-spin" />
          ) : (
            <LogIn className="w-3.5 h-3.5" />
          )}
          <span className="hidden md:inline">Sign In</span>
        </button>
      )}

      {isDropdownVisible && (
        <div className="absolute right-0 mt-2 w-72 max-w-[calc(100vw-1.5rem)] rounded-xl border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 shadow-lg p-3.5 z-50 space-y-3 text-xs">
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0">
              <div className="flex items-center gap-1.5 font-semibold text-neutral-900 dark:text-neutral-100">
                <Cloud className="w-3.5 h-3.5 shrink-0" />
                <span>{isOwner ? "Owner Account" : "Cloud Access"}</span>
              </div>
              {isOwner && user?.email && (
                <p className="text-[11px] text-neutral-500 dark:text-neutral-400 truncate mt-0.5">
                  {user.email}
                </p>
              )}
            </div>
            <button
              type="button"
              onClick={() => {
                setOpen(false);
                if (authError) {
                  setDismissedError(authError);
                }
                clearAuthError();
              }}
              aria-label="Close account panel"
              className="p-0.5 text-neutral-400 hover:text-neutral-700 dark:hover:text-neutral-200 cursor-pointer"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          </div>

          {authError && (
            <div className="p-2.5 rounded-lg border border-red-200 dark:border-red-900 bg-red-50 dark:bg-red-950/40 text-[11px] text-red-700 dark:text-red-300 leading-relaxed">
              {authError}
            </div>
          )}

          {isOwner && user ? (
            <button
              type="button"
              onClick={async () => {
                await signOutOwner();
                setOpen(false);
              }}
              className="w-full h-8 px-3 rounded-lg border border-neutral-200 dark:border-neutral-700 bg-white dark:bg-neutral-950 hover:bg-neutral-100 dark:hover:bg-neutral-800 text-xs font-medium flex items-center justify-center gap-1.5 cursor-pointer transition-colors"
            >
              <LogOut className="w-3.5 h-3.5" />
              <span>Sign Out</span>
            </button>
          ) : (
            <button
              type="button"
              disabled={isSigningIn}
              onClick={async () => {
                await signInWithGoogle();
                setOpen(false);
              }}
              className="w-full h-8 px-3 rounded-lg bg-neutral-950 text-white dark:bg-white dark:text-neutral-950 text-xs font-semibold flex items-center justify-center gap-1.5 disabled:opacity-50 cursor-pointer hover:opacity-90 transition-opacity"
            >
              {isSigningIn ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
              ) : (
                <LogIn className="w-3.5 h-3.5" />
              )}
              <span>Sign In with Google</span>
            </button>
          )}
        </div>
      )}
    </div>
  );
}
