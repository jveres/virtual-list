import type { CapturePolicy } from "./geometry";

export type FollowMode = "end" | "keep-start" | "keep-content";

type FollowHost = {
  maxScrollTop(): number;
  lastItemTop(content: boolean): number | null;
  lastItemKey(): string | null;
  hidden(): boolean;
  now(): number;
};

const AT_EDGE_PX = 1;
const RESUME_CATCH_UP_MS = 300;

function normalizeInset(inset: number): number {
  return Number.isFinite(inset) ? Math.max(0, inset) : 0;
}

/** Chat follow intent and destination policy. Motion and DOM writes belong to the runtime. */
export class FollowController {
  private following = false;
  private resumeUntil = 0;
  private endOverrideKey: string | null = null;

  get armed(): boolean {
    return this.following;
  }

  /** Effective end-follow intent, including a command overriding bounded follow. */
  get followingEnd(): boolean {
    return this.following && this.followsEnd;
  }

  /** A measured start can move while following is paused short of the end. */
  get followingContent(): boolean {
    return this.following && this.mode === "keep-content" && !this.followsEnd;
  }

  /** An explicit end command overrides bounded follow for this tail only. */
  start(): void {
    this.endOverrideKey = this.host.lastItemKey();
    this.following = true;
  }

  stop(): boolean {
    const wasFollowing = this.following;
    this.following = false;
    this.endOverrideKey = null;
    return wasFollowing;
  }

  constructor(
    private readonly host: FollowHost,
    private mode: FollowMode = "end",
    private inset = 0,
  ) {
    this.inset = normalizeInset(inset);
  }

  setMode(mode: FollowMode, inset = 0): void {
    if (mode !== this.mode) this.endOverrideKey = null;
    this.mode = mode;
    this.inset = normalizeInset(inset);
  }

  private get followsEnd(): boolean {
    if (
      this.endOverrideKey !== null &&
      this.endOverrideKey !== this.host.lastItemKey()
    ) {
      this.endOverrideKey = null;
    }
    return this.mode === "end" || this.endOverrideKey !== null;
  }

  /** Stop at the row or content start, but never move backwards to reach it. */
  target(current: number, end = this.host.maxScrollTop()): number {
    if (this.followsEnd) return end;
    const top = this.host.lastItemTop(this.mode === "keep-content");
    if (top === null) return end;
    return Math.min(end, Math.max(current, Math.max(0, top - this.inset)));
  }

  atLimit(position: number): boolean {
    return (
      !this.followsEnd && Math.abs(this.target(0) - position) <= AT_EDGE_PX
    );
  }

  needsMotion(current: number): boolean {
    const delta = this.target(current) - current;
    return this.followsEnd ? Math.abs(delta) > AT_EDGE_PX : delta > AT_EDGE_PX;
  }

  resolveCommit(policy: CapturePolicy, target: number): void {
    this.following =
      (policy === "auto" || policy === "end") &&
      (this.host.maxScrollTop() - target <= AT_EDGE_PX || this.atLimit(target));
    if (!this.following) this.endOverrideKey = null;
  }

  /** Re-evaluate intent after held work and any parked command have settled. */
  resolveSettle(state: {
    takingOver: boolean;
    atEnd: boolean;
    endCommand: boolean;
    gliding: boolean;
    position: number;
  }): boolean {
    if (!state.takingOver && state.endCommand) {
      this.endOverrideKey = this.host.lastItemKey();
    }
    const following =
      !state.takingOver &&
      (state.atEnd ||
        state.endCommand ||
        state.gliding ||
        this.atLimit(state.position));
    const changed = this.following !== following;
    this.following = following;
    if (!following) this.endOverrideKey = null;
    return changed;
  }

  resume(): void {
    this.resumeUntil = this.host.now() + RESUME_CATCH_UP_MS;
  }

  get catchingUp(): boolean {
    return this.host.hidden() || this.host.now() < this.resumeUntil;
  }
}
