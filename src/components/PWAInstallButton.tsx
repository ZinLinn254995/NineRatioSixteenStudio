import { useState } from "react";
import { Download, Share, WifiOff, X } from "lucide-react";
import { useOnlineStatus, usePWAInstall } from "../hooks/usePWAInstall";

export function PWAInstallButton() {
  const { isInstallable, isInstalled, isIOS, install } = usePWAInstall();
  const [showIOSGuide, setShowIOSGuide] = useState(false);

  if (isInstalled) return null;

  if (isInstallable) {
    return (
      <button
        type="button"
        onClick={() => void install()}
        title="Install 9:16 Studio as an App"
        aria-label="Install 9:16 Studio as an App"
        className="h-8 px-2.5 rounded-md border border-teal-600/50 dark:border-teal-400/50 bg-teal-50/75 dark:bg-teal-950/45 hover:bg-teal-100/85 dark:hover:bg-teal-900/55 text-xs font-semibold text-teal-800 dark:text-teal-200 flex items-center justify-center gap-1.5 whitespace-nowrap shrink-0 cursor-pointer transition-colors"
      >
        <Download className="w-3.5 h-3.5 shrink-0" />
        <span className="hidden sm:inline">Install App</span>
      </button>
    );
  }

  if (isIOS) {
    return (
      <>
        <button
          type="button"
          onClick={() => setShowIOSGuide(true)}
          title="Install on iPhone or iPad"
          aria-label="Install on iPhone or iPad"
          className="h-8 px-2.5 rounded-md border border-[#d2dcf0] dark:border-[#21284c] bg-[#f3f5fc] dark:bg-[#141933] hover:bg-[#e7ecf8] dark:hover:bg-[#1a2142] text-xs font-medium text-[#0c1026] dark:text-[#f3f5fc] flex items-center justify-center gap-1.5 whitespace-nowrap shrink-0 cursor-pointer transition-colors"
        >
          <Download className="w-3.5 h-3.5 shrink-0" />
          <span className="hidden sm:inline">Install</span>
        </button>

        {showIOSGuide && (
          <div
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/55 backdrop-blur-[2px] p-4"
            onMouseDown={(e) => {
              if (e.target === e.currentTarget) setShowIOSGuide(false);
            }}
            role="dialog"
            aria-modal="true"
            aria-label="Install on iPhone or iPad"
          >
            <div className="w-full max-w-sm rounded-lg border border-[#d2dcf0] dark:border-[#21284c] bg-white dark:bg-[#0d1022] p-5 shadow-2xl space-y-3 text-[#0c1026] dark:text-[#f3f5fc]">
              <div className="flex items-center justify-between gap-2">
                <h3 className="font-display text-sm font-semibold">
                  Install 9:16 Studio on iOS
                </h3>
                <button
                  type="button"
                  onClick={() => setShowIOSGuide(false)}
                  aria-label="Close install instructions"
                  className="h-7 w-7 rounded-md border border-[#d2dcf0] dark:border-[#21284c] flex items-center justify-center text-[#4d597d] dark:text-[#919ec4] cursor-pointer"
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              </div>
              <ol className="text-xs text-[#4d597d] dark:text-[#919ec4] space-y-2 list-decimal list-inside leading-relaxed">
                <li>
                  Tap the{" "}
                  <span className="inline-flex items-center gap-1 font-semibold text-[#0c1026] dark:text-[#f3f5fc]">
                    <Share className="w-3 h-3" /> Share
                  </span>{" "}
                  button in Safari.
                </li>
                <li>
                  Scroll down and tap{" "}
                  <strong className="text-[#0c1026] dark:text-[#f3f5fc]">
                    Add to Home Screen
                  </strong>
                  .
                </li>
              </ol>
              <button
                type="button"
                onClick={() => setShowIOSGuide(false)}
                className="w-full h-9 rounded-md bg-teal-700 hover:bg-teal-800 dark:bg-teal-400 dark:hover:bg-teal-300 text-white dark:text-[#060918] text-xs font-semibold cursor-pointer transition-colors"
              >
                Got it
              </button>
            </div>
          </div>
        )}
      </>
    );
  }

  return null;
}

export function OfflineIndicator() {
  const isOnline = useOnlineStatus();
  if (isOnline) return null;

  return (
    <div className="fixed bottom-16 lg:bottom-4 left-3 z-50 flex items-center gap-1.5 rounded-md border border-amber-400/70 bg-amber-600/95 px-3 py-1.5 text-xs font-medium text-white shadow-lg">
      <WifiOff className="w-3.5 h-3.5 shrink-0" />
      <span>Offline — Cached studio mode</span>
    </div>
  );
}
