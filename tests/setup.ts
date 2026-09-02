// jsdom has no ResizeObserver, which createVirtualList constructs eagerly. A
// no-op stub lets the list mount without ever firing a measurement callback, so
// item heights stay at their premeasured values — exactly what the runtime
// contract tests want: deterministic geometry, no async re-measurement.
class NoopResizeObserver implements ResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

if (!("ResizeObserver" in globalThis)) {
  (globalThis as { ResizeObserver: typeof ResizeObserver }).ResizeObserver =
    NoopResizeObserver;
}
