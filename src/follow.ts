import type { CapturePolicy } from "./geometry";

export type FollowMode = "end" | "keep-start";

type FollowHost = {
  maxScrollTop(): number;
  lastItemTop(): number | null;
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

  get armed(): boolean {
    return this.following;
  }

  start(): void {
    this.following = true;
  }

  stop(): boolean {
    const wasFollowing = this.following;
    this.following = false;
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
    this.mode = mode;
    this.inset = normalizeInset(inset);
  }

  /** Stop at the last item's start, but never move backwards to reach it. */
  target(current: number, end = this.host.maxScrollTop()): number {
    if (this.mode === "end") return end;
    const top = this.host.lastItemTop();
    if (top === null) return end;
    return Math.min(end, Math.max(current, Math.max(0, top - this.inset)));
  }

  atLimit(position: number): boolean {
    return (
      this.mode === "keep-start" &&
      Math.abs(this.target(0) - position) <= AT_EDGE_PX
    );
  }

  needsMotion(current: number): boolean {
    const delta = this.target(current) - current;
    return this.mode === "end"
      ? Math.abs(delta) > AT_EDGE_PX
      : delta > AT_EDGE_PX;
  }

  resolveCommit(policy: CapturePolicy, target: number): void {
    this.following =
      (policy === "auto" || policy === "end") &&
      (this.host.maxScrollTop() - target <= AT_EDGE_PX || this.atLimit(target));
  }

  /** Re-evaluate intent after held work and any parked command have settled. */
  resolveSettle(state: {
    takingOver: boolean;
    atEnd: boolean;
    endCommand: boolean;
    gliding: boolean;
    position: number;
  }): boolean {
    const following =
      !state.takingOver &&
      (state.atEnd ||
        state.endCommand ||
        state.gliding ||
        this.atLimit(state.position));
    const changed = this.following !== following;
    this.following = following;
    return changed;
  }

  resume(): void {
    this.resumeUntil = this.host.now() + RESUME_CATCH_UP_MS;
  }

  get catchingUp(): boolean {
    return this.host.hidden() || this.host.now() < this.resumeUntil;
  }
}
