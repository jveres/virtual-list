# Runtime performance audit, September 28, 2026

This audit profiled the virtual-list runtime at revision `23867f4` in three
Firefox workloads. It found no runtime bottleneck with a user-visible benefit.
It applied no runtime change. One candidate reduced timer work, but it
changed settle behavior and was reverted. The long frames in the chat workload
came from host rendering, which audit scope excludes. A
[second round](runtime-architecture-performance-2026-09-28.md) the same day
examined costs that grow with list size and applied three runtime changes.

## Conditions

The runs used installed Firefox 156.0.1, build 20260921121718. Each run had a
fresh temporary profile and closed DevTools. The LU28R55 display used
1920 × 1080 logical pixels at 2× and 60 Hz. The browser content area was
1900 × 965. Each run used scripted native gestures: 90 ticks of 24 pixels
at 16.667 ms intervals, followed by a 700 ms pause. The `--live` profile
capture ran against the user's Vite development server. No regular browser
profile was modified.

| Workload | Run | Gestures | Moving frames | p95 | Longest frame | Frames over 25 ms |
| --- | --- | --- | ---: | ---: | ---: | ---: |
| `declared-rows.html`, 10,000 rows | `run-299oyf` | 6 down, 4 up | 863 | 17.30 ms | 84.1 ms | 1 |
| Gallery masonry, paging | `run-kbGUJR` | 6 down, 4 up | 882 | 17.12 ms | 17.64 ms | 0 |
| Streaming chat, imported 46-turn transcript | `run-bPOhOP` | 6 up | 520 | 17.26 ms | 49.56 ms | 4 |

Every run recorded actual movement and scroll-end events. None recorded
programmatic scroll-position writes. The chat run loaded one older page,
increasing scroll height from 10,740 to 20,530 pixels. An earlier gallery
attempt, `run-R8XsHO`, could not focus the test browser and is invalid. The
private transcript was copied under ignored `browser-artifacts/` for the chat
run and deleted afterward.

## Findings

JavaScript appeared in 1.1–2.0% of content-thread samples. Scroll handling
reconciled the cached window through `reconcileWindow` and `mountWindow`.
Per-event costs stayed below a millisecond.

- The 84 ms frame in the 10,000-row run occurred once, at the first
  measured scroll. It contained 35 ms of styling and 28 ms of synchronous
  reflow while mounting a new batch of rows. Its sampled stack was the
  fixture's `render`, which sets a CSS `background`. The rest of the run
  stayed at p95 17.3 ms.
- The four chat frames over 25 ms, up to 50 ms, occurred during older-page
  staging. Each idle slice checks `timeRemaining()` before starting a row, but
  cannot divide one row's render. The sampled time was the demo's `render`:
  `buildStaticRow` and `renderMarkdown` for large messages. This is host
  cost. A host can reduce it with `stage` or cheaper rendering. The runtime
  was not changed.
- In the gallery, `boundaryAtNativeEdge` in `src/scroll-settle.ts` had the
  largest runtime self-time: 51 of 283 script samples. It reads `scrollTop`
  and `scrollHeight` on each wheel event. Attribution found 33 invalidations
  attributed to its `scrollTop` read, totaling 2.1 ms in a 25-second run. The
  gallery had no frame over 17.64 ms, so no fix was justified.
- `armWheelIdle` clears and recreates a timer on each wheel event. It had
  20–26 self-samples in every run, or under 0.1% of samples.

## Rejected candidate

A deadline timer let wheel and scroll events move a pending timeout later
instead of recreating it, for both wheel-idle and settle-fallback timers. The
chromium mid-list trace replay then settled before 200 ms, although its
contract requires wheel idle plus cooldown. When two deadlines coincided, the
original firing order depended on which timer had been recreated last.
Preserving that order would add complexity to a sensitive state machine for
under 0.1% CPU. The change was reverted before any repeat capture. The unit
suite returned to 51 of 51 passing scroll-settle tests.

## Reproduce

Start the demo server, then run these commands from the repository root:

```sh
pnpm run profile:firefox -- --display=LU28R55 --live --layout=none \
  --url=http://127.0.0.1:5173/scripts/firefox-profile/fixtures/declared-rows.html
pnpm run profile:firefox -- --display=LU28R55 --live --layout=masonry \
  --url=http://127.0.0.1:5173/demos/gallery/
pnpm run profile:firefox -- --display=LU28R55 --live --layout=none \
  --url="http://127.0.0.1:5173/demos/streaming/?profile-transcript=/browser-artifacts/<file>.md" \
  --setup=scripts/firefox-profile/fixtures/imported-chat-wheel.js \
  --warmup-ms=6000 --down=0 --up=6
```

Compact summaries and reproduction metadata remain under ignored
`browser-artifacts/firefox/`. The runner deleted raw profiles. Scripted
gestures do not reproduce trackpad momentum. Regular animation-frame
callbacks do not prove smooth physical presentation. Each workload had one
capture, so these results support no speedup claim.
