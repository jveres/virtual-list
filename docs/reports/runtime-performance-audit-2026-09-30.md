# Runtime performance audit, September 30, 2026

This audit profiles the virtual-list runtime at revision `db1104c` in five
Firefox workloads. It finds no high or medium runtime finding, so it applies
no runtime change and needs no second round. Every workload has zero frames
over 25 ms. The largest runtime cost is a layout flush that the streaming
update path triggers when it reads the viewport; it is low severity. The
heaviest measured code is demo rendering, which this runtime-only audit
reports and doesn't patch.

## Conditions

All captures use installed Firefox 157.0, fresh temporary browser profiles,
and closed DevTools. The LU28R55 display runs at 1920 × 1080 logical pixels,
2× scaling, and 60 Hz, with a 1900 × 964 content area. The source is
`db1104c` with a clean working tree. The first four runs use scripted native
gestures of 90 ticks of 24 pixels at 16.667 ms intervals, against the user's
Vite development server. The streaming run owns its server. No regular
browser profile is modified, and no private transcript is used.

Firefox updated from 156.0.1 since the September 28 and 29 captures, so
this audit records fresh baselines instead of comparing with those runs.

## Results

Every run records actual movement and scroll-end events, and none records a
programmatic scroll-position write. The long-frame threshold is 25 ms,
1.5 refresh periods.

| Workload | Run (local only) | Frames | p95 | Longest | Over 25 ms | Runtime samples |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| `declared-rows.html`, 10,000 rows, 6 down and 4 up | `run-4PKcbx` | 1,523 | 17.18 ms | 17.62 ms | 0 | 0.58% |
| Gallery masonry, 6 down and 4 up | `run-VCZeP4` | 1,529 | 17.08 ms | 17.62 ms | 0 | 0.62% |
| Rich chat, 6 up, no paging | `run-uTL50V` | 926 | 17.10 ms | 17.66 ms | 0 | 0.38% |
| Rich chat, 12 up, one older page | `run-KVE76f` | 1,824 | 17.22 ms | 17.66 ms | 0 | 0.48% |
| Complex stream, following the end | `firefox-diagnostic-17wMkF` | 1,202 | 17.06 ms | 17.62 ms | 0 | not sampled |

"Runtime samples" is the share of content-thread samples whose nearest
JavaScript frame is in `src/`. The six-gesture chat run stays inside loaded
history. The twelve-gesture run loads an older page, growing the scroll
height from 21,512 to 39,872 pixels. The streaming run delivers all
44,230 characters in 461 chunks over 11.8 seconds, with no uncovered
viewport pixels in 1,209 coverage samples.

## Findings

All findings are low severity. None has a frame-timing effect that justifies
a runtime change.

- **Streaming viewport reads:** `viewportState` has 237 ms of self time over
  1,714 calls, with a 4 ms maximum. Most of it is the first read in
  `liveCommit`, at 203 ms over 503 commits. That read follows the host's row
  update, so it pays the pending layout early rather than adding new work.
  The second read after the runtime's own writes costs 32 ms over the stream.
  Removing it would save about 0.3% of one core and would change anchoring
  code that the September 29 scroll-handler audit already examined.
- **Paging staging:** the longest content-thread interval in the paging run
  is 22.7 ms. It contains three synchronous flushes of 1.7, 2.0, and 8.2 ms,
  and its sampled script is the demo's `mdToHtml` Markdown rendering. The
  interval stays under the long-frame threshold.
- **Wheel handling:** `armWheelIdle` and `boundaryAtNativeEdge` again lead
  runtime self time during scrolling, at 12–33 samples each. The
  [September 28 audit](runtime-performance-audit-2026-09-28.md) rejected a
  timer change for `armWheelIdle` and judged `boundaryAtNativeEdge` too small
  to change. These samples are consistent with that conclusion.

## Host costs outside the audit scope

The demo's streaming message update, `message-content.ts:update`, has 695 ms
of self time over 467 calls during the stream, nearly twice the roughly
375 ms of all runtime operations combined. Demo image-preview binding adds another 60 ms. These are
host rendering costs. A host can reduce them with cheaper rendering or
staged updates; this audit doesn't change them.

## Reproduce

These captures use a running development server on port 5173. To repeat
them, run these commands from the repository root:

```sh
pnpm run profile:firefox -- --display=LU28R55 --live --layout=none \
  --url=http://127.0.0.1:5173/scripts/firefox-profile/fixtures/declared-rows.html
pnpm run profile:firefox -- --display=LU28R55 --live --layout=masonry \
  --url=http://127.0.0.1:5173/demos/gallery/
pnpm run profile:firefox -- --display=LU28R55 --live --layout=none \
  --url=http://127.0.0.1:5173/demos/streaming/ \
  --setup=scripts/firefox-profile/fixtures/rich-chat.js --down=0 --up=12
pnpm run profile:chat -- --browser=firefox --display=LU28R55 --mode=diagnostic
```

Compact summaries and reproduction metadata remain under ignored
`browser-artifacts/`. The runners deleted raw profiles.

## Limitations

Keep these limits in mind when you use the results:

- Each workload has one capture. The results support "no finding," not a
  speed comparison.
- Scripted gestures don't reproduce trackpad momentum, and regular
  animation-frame callbacks don't prove smooth physical presentation.
- The streaming run uses diagnostic mode, whose instrumentation adds a small
  overhead to operation timings.
- The audit doesn't cover Safari or Chrome, or the conversation tree panel,
  which is demo code.
