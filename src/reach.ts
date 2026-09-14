export type Edge = "start" | "end";

export interface ReachContext {
  /**
   * Each reach gets its own signal. Reaching the opposite edge or disposing
   * aborts all outstanding signals for this edge. Overlapping proximity zones
   * do not cancel each other until the viewport leaves the original zone.
   * Pass it to fetch to cancel
   * unwanted loads; ignore it to keep a scrollback fetch alive.
   */
  signal: AbortSignal;
  /** Release this reach when its work finishes or is skipped. Idempotent; does not abort the signal. */
  complete(): void;
}

type ReachOptions = {
  start?: (context: ReachContext) => void;
  end?: (context: ReachContext) => void;
};

const ENTER_PX = 800;
const EXIT_PX = 1200;

/** Edge proximity hysteresis and the lifetime of loads started at each edge. */
export class ReachController {
  private disposed = false;
  private readonly armed = { start: true, end: true };
  private readonly aborts = {
    start: new Set<AbortController>(),
    end: new Set<AbortController>(),
  };

  constructor(private readonly callbacks: ReachOptions) {}

  update(scrollTop: number, maxScrollTop: number): void {
    const endDistance = maxScrollTop - scrollTop;
    this.check("start", scrollTop, endDistance);
    this.check("end", endDistance, scrollTop);
  }

  canLoad(edge: Edge): boolean {
    return this.callbacks[edge] !== undefined;
  }

  dispose(): void {
    this.disposed = true;
    this.abort("start");
    this.abort("end");
  }

  private check(edge: Edge, distance: number, oppositeDistance: number): void {
    if (this.disposed) return;
    // Overlapping reach zones do not establish opposite-edge intent. Wait
    // until the viewport leaves the other zone, even if this edge already
    // fired while both were near. Otherwise short lists cancel their own load.
    if (distance <= ENTER_PX && oppositeDistance > ENTER_PX) {
      this.abort(edge === "start" ? "end" : "start");
      if (this.disposed) return;
    }
    if (distance <= ENTER_PX && this.armed[edge]) {
      this.armed[edge] = false;
      const callback = this.callbacks[edge];
      if (!callback || this.disposed) return;
      const abort = new AbortController();
      this.aborts[edge].add(abort);
      const complete = () => {
        this.aborts[edge].delete(abort);
      };
      try {
        callback({ signal: abort.signal, complete });
      } catch (error) {
        complete();
        throw error;
      }
    } else if (distance > EXIT_PX) {
      this.armed[edge] = true;
    }
  }

  private abort(edge: Edge): void {
    for (const controller of this.aborts[edge]) controller.abort();
    this.aborts[edge].clear();
  }
}
