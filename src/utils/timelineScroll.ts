export function hasVerticalScrollRoom(startEl: HTMLElement | null): boolean {
  if (!startEl) return false;
  let cur: HTMLElement | null = startEl.parentElement;

  while (cur) {
    const style = window.getComputedStyle(cur);
    const overflowY = style.overflowY;
    if (
      (overflowY === "auto" || overflowY === "scroll" || overflowY === "overlay") &&
      cur.scrollHeight > cur.clientHeight + 2
    ) {
      return true;
    }
    cur = cur.parentElement;
  }

  const scrollingEl = document.scrollingElement || document.documentElement;
  if (!scrollingEl) return false;
  return scrollingEl.scrollHeight > window.innerHeight + 2;
}

export function scrollVerticalAncestors(startEl: HTMLElement | null, deltaY: number): void {
  if (!startEl || Math.abs(deltaY) < 0.05) return;
  let remaining = deltaY;
  let cur: HTMLElement | null = startEl.parentElement;

  while (cur && Math.abs(remaining) >= 0.05) {
    const style = window.getComputedStyle(cur);
    const overflowY = style.overflowY;
    const isScrollable =
      (overflowY === "auto" || overflowY === "scroll" || overflowY === "overlay") &&
      cur.scrollHeight > cur.clientHeight + 1;

    if (isScrollable) {
      const prevTop = cur.scrollTop;
      const maxTop = cur.scrollHeight - cur.clientHeight;
      const nextTop = Math.max(0, Math.min(maxTop, prevTop + remaining));
      cur.scrollTop = nextTop;
      remaining -= cur.scrollTop - prevTop;
    }
    cur = cur.parentElement;
  }

  if (Math.abs(remaining) >= 0.1) {
    window.scrollBy(0, remaining);
  }
}
