import { useEffect, useMemo, useState } from "react";
import { createAdversarialOverlayTileDataUrl } from "../utils/videoFilters";

interface AdversarialNoiseOverlayProps {
  enabled: boolean;
  strength: number;
  animate?: boolean;
}

export function AdversarialNoiseOverlay({
  enabled,
  strength,
  animate = false,
}: AdversarialNoiseOverlayProps) {
  const [phaseIdx, setPhaseIdx] = useState(0);

  const tileUrls = useMemo(() => {
    if (!enabled) return [];
    return [0, 1, 2, 3].map((p) => createAdversarialOverlayTileDataUrl(p));
  }, [enabled]);

  useEffect(() => {
    if (!enabled || !animate || tileUrls.length === 0) {
      setPhaseIdx(0);
      return;
    }
    const id = window.setInterval(() => {
      setPhaseIdx((prev) => (prev + 1) % tileUrls.length);
    }, 125);
    return () => window.clearInterval(id);
  }, [enabled, animate, tileUrls.length]);

  if (!enabled || tileUrls.length === 0) return null;

  const activeUrl = tileUrls[phaseIdx] || tileUrls[0];
  const clampedStrength = Math.max(2, Math.min(30, strength));
  const opacity = Math.min(0.45, Math.max(0.06, clampedStrength / 68));

  return (
    <div
      aria-hidden="true"
      className="pointer-events-none absolute inset-0"
      style={{
        backgroundImage: `url(${activeUrl})`,
        backgroundRepeat: "repeat",
        backgroundSize: "128px 128px",
        mixBlendMode: "hard-light",
        opacity,
      }}
    />
  );
}
