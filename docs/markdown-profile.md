# Measured markdown history profile

This follow-up to the [runtime checkpoint](performance-checkpoint.md) profiles
generated history with the streaming demo's static markdown renderer and chat
row builder. Runtime code remains at `822a026`; the checkpoint and lab fix
are committed as `f6eba34`. No row-lifetime behavior changed during profiling.

## Method and limits

Each reply contains a heading, paragraph, list, highlighted TypeScript fence,
table, and link. The fixture imports the demo's markdown and chat styles,
initializes its parser and languages, and creates a measured virtual list
in a 600px-wide, 600px-high viewport. It runs 100 and 1,000 replies three
times per engine, sequentially. This is generated static history, not private
conversation data or the live incremental markdown-viewer component.

Parser initialization is excluded from constructor timing. Parser caches and
JIT state are shared across repetitions; these are not independent cold-start
trials. At 100 replies, later HTML-render times fall near timer resolution,
while the 1,000-reply workload continues to incur substantial render cost.

The renderer records HTML-generation and DOM-building durations. Remaining
constructor time includes measurement/layout, geometry, slots, mounting, and
bookkeeping. It is not an isolated layout measurement. Timers are quantized,
especially in Firefox and WebKit; small per-row timings are approximate.

## Startup results

For 1,000 generated replies, the three-run measurements were:

| Engine | Constructor median | HTML generation range | DOM building range | Other constructor work range |
| --- | ---: | ---: | ---: | ---: |
| Chromium 151.0.7922.34 | 301ms | 80–100ms | 40–43ms | 158–185ms |
| Firefox 153.0 | 508ms | 149–173ms | 47–63ms | 288–290ms |
| WebKit 26.5 | 626ms | 76–83ms | 65–66ms | 468–484ms |

The 100-reply constructor medians were 25ms, 39ms, and 56ms respectively.
Every list retained all its rows while mounting only three in this fixture.
This confirms that optimizing token updates alone does not address large
history startup or retained DOM.

## Chromium heap observations

After forced garbage collection, Chromium reported the following values.
MB here means decimal megabytes. These are protocol-reported heap buckets,
not total browser process memory, and they must not be interpreted as a
complete accounting of renderer or WASM allocations.

| Stage | DOM nodes | JS event listeners | JS used heap | Embedder used heap |
| --- | ---: | ---: | ---: | ---: |
| Initialized fixture | 13 | 7 | 5.36MB | 0.93MB |
| 1,000 replies retained | 124,028 | 18 | 8.06MB | 29.09MB |
| List disposed | 16 | 7 | 7.19MB | 2.02MB |

All row render/destruction counts balanced after disposal. The retained heap
snapshot contains roughly 64,000 native text nodes and large SVG/style
populations from the rendered content; these no longer dominate the disposed
snapshot. These observations support intentional live-list retention rather
than a row-disposal leak in this workload. The nonzero post-disposal heap
delta does not by itself establish a leak: initialized libraries, caches,
and browser state remain. Full retained-path attribution of that residual
heap is outside this checkpoint.

## Reproduce and inspect

Start the server and run the profiler in another terminal:

```sh
pnpm exec vite --host 127.0.0.1 --port 4175 --strictPort
node scripts/markdown-profile.mjs
```

The script creates these ignored artifacts under `browser-artifacts/`:

- `markdown-profile.json`: raw timings, versions, timestamp, and heap counters.
- `markdown-baseline.heapsnapshot`: initialized fixture.
- `markdown-retained-1000.heapsnapshot`: live 1,000-reply list.
- `markdown-disposed.heapsnapshot`: after list disposal and garbage collection.

Load snapshots into Chromium DevTools' Memory panel for retained-path analysis.
Snapshots total roughly 47MB in this run. Rerunning replaces these files.

## Recommended next decision

Consider an opt-in bounded cache for offscreen measured DOM, while preserving
current retention by default. Evicted rows would be rendered again on entry;
hosts would need to keep persistent state in their item data. Pending rows,
mounted rows, and rollback ownership would need protection from eviction.

Eviction reduces retained DOM but does not avoid initial exact premeasurement.
It can also introduce work while scrolling and discrepancies when rerendering
produces a different height. Those costs need explicit semantics and browser
acceptance before implementation. Reducing initial history size or providing
known heights remains the simpler route when the application can support it.
