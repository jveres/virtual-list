export type ScrollBoundary = "top" | "bottom";

const FIREFOX_RELEASE_CONFIRM_MS = 450;
const TRAILING_MARKER_MAX_DELTA = 2;

/**
 * Firefox's candidate-release classification. A decaying pixel tail delays
 * confirmation; renewed energy invalidates the candidate. Wheel silence
 * after a re-grab cannot prove release, so only a later scrollend can make
 * that gesture eligible to commit. The confirmation window is an empirical
 * race buffer, not an APZ acknowledgement.
 */
export class FirefoxWheelPolicy {
  private edge: ScrollBoundary | null = null;
  private sawInput = false;
  private pending = false;
  private lastDelta = 0;
  private lastInputAt = Number.NEGATIVE_INFINITY;
  private commitFrame = 0;

  get protectedEdge(): ScrollBoundary | null {
    return this.edge;
  }

  get inputThisPhase(): boolean {
    return this.sawInput;
  }

  protect(edge: ScrollBoundary | null): void {
    this.edge ??= edge;
  }

  beginPhase(): void {
    this.sawInput = false;
  }

  resetProtection(): void {
    this.edge = null;
  }

  get hasRelease(): boolean {
    return this.pending;
  }

  recordInput(now: number): void {
    this.lastInputAt = now;
    this.sawInput = true;
  }

  /** Returns true when renewed input invalidates the preceding release. */
  observeDelta(delta: number, pixelMode: boolean): boolean {
    if (delta === 0) return false;
    let invalidated = false;
    if (this.pending) {
      const reversed =
        this.lastDelta !== 0 && Math.sign(delta) !== Math.sign(this.lastDelta);
      const addsEnergy =
        Math.abs(delta) >
        Math.max(TRAILING_MARKER_MAX_DELTA, Math.abs(this.lastDelta) + 1);
      if (!pixelMode || reversed || addsEnergy) {
        this.pending = false;
        invalidated = true;
      }
    }
    this.lastDelta = pixelMode ? delta : 0;
    return invalidated;
  }

  setRelease(pending: boolean): void {
    this.pending = pending;
  }

  releaseDelay(now: number): number {
    return Math.max(0, FIREFOX_RELEASE_CONFIRM_MS - (now - this.lastInputAt));
  }

  /** Edge commits get their own render opportunity after the quiet window. */
  scheduleCommit(commit: () => void): void {
    if (this.commitFrame) return;
    this.commitFrame = requestAnimationFrame(() => {
      this.commitFrame = 0;
      commit();
    });
  }

  cancelCommit(): boolean {
    if (!this.commitFrame) return false;
    cancelAnimationFrame(this.commitFrame);
    this.commitFrame = 0;
    return true;
  }
}

/** Chromium's early-scrollend suppression and wheel-idle decision. */
export class ChromiumWheelPolicy {
  private activeEdge: ScrollBoundary | null = null;
  private waiting = false;
  private suppressing = false;

  get edge(): ScrollBoundary | null {
    return this.activeEdge;
  }
  get awaitingEnd(): boolean {
    return this.waiting;
  }
  get suppressed(): boolean {
    return this.suppressing;
  }
  private sawEnd = false;

  reset(): void {
    this.activeEdge = null;
    this.beginPhase();
  }

  beginPhase(): void {
    this.sawEnd = false;
    this.waiting = false;
    this.suppressing = false;
  }

  cancelPendingEnd(): void {
    this.sawEnd = false;
  }

  scrollEnd(wheelActive: boolean): void {
    this.sawEnd = true;
    if (!wheelActive && this.waiting) {
      this.waiting = false;
      this.activeEdge = null;
    }
  }

  wheel(boundary: ScrollBoundary | null): void {
    this.waiting = boundary !== null;
    if (boundary !== null) this.suppressing = true;
    this.activeEdge = boundary;
  }

  idle(boundary: ScrollBoundary | null): "edge" | "release" | "stall" {
    if (boundary !== null) {
      this.waiting = true;
      return "edge";
    }
    if (this.sawEnd) {
      this.waiting = false;
      this.suppressing = false;
      return "release";
    }
    return "stall";
  }

  releaseEdge(): void {
    this.waiting = false;
    this.suppressing = false;
    this.activeEdge = null;
  }
}
