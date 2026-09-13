# Streaming integration checkpoint

The approved optional-trimming API and streaming integration are implemented
on `feat/streaming-integration`, based on `main` commit `7caef9a`. These are
September 13, 2026 working-tree results, not verification of a committed
release candidate. The implementation was subsequently committed and pushed
as `732e143`; see the [later cleanup audit](clean-code-audit-2026-09-13.md)
for subsequent fixes and verification. Nothing has been published or tagged.

## API and ownership review

The runtime adds one optional `updateWindow` flag: `protectPin`. Its default
is unchanged. The opt-in path rejects eviction of visible/overscan rows or
explicit targets and revalidates staged work. It adds no scroll-event or
animation-frame observer.

The paging companion adds `trim` policy and a narrow `live` adapter with
`updateItemLive`. Structural edits still use the idle transaction. A live
update preserves overlapping source ownership, retries invalidated page
preparation, and fails closed if runtime submission throws. A committed
window clears the cached reconciliation range: equal numeric ranges may
otherwise hide different source pages.

The supported source entry points are `src/index.ts`,
`src/companions/index.ts`, and `integrations/index.ts`. Optional companions
cover sticky headers and replacement anchors. Separate integration helpers
and CSS cover textarea sizing, collapsed messages, streaming display text,
and Markdown layout. The core imports no demo, integration, or renderer.

The full demo uses the pager for both history directions and live updates.
It matches the actual latest prompt ID, not an arbitrary retained user row.
Explicit branch/tail navigation replaces pager ownership through existing
runtime APIs. A normal send preserves the current window when it fits the
budget. Source text, branches, timestamps, fake fetch latency, loading UI,
persistence, and provider requests remain application-owned.

The tree archive receives tokens even when a reply is evicted. On a page
commit, the demo reconciles any source changes received after the page was
fetched through `updateItemLive`. This is data freshness reconciliation, not
a second scrolling controller. Eviction releases rendered HTML caches;
the full transcript archive is intentionally not bounded by the pager.

## Verification matrix

The following results apply to the working tree. Browser checks use the
repository's owned temporary-server harness and synthetic/offline data.
Playwright input is correctness evidence, not native performance evidence.

| Area | Evidence | Result |
| --- | --- | --- |
| Types and formatting | `pnpm run check` | Passed. |
| Unit behavior | `pnpm test` | 909 tests, 39 files passed. |
| Test types | Direct `tsc --ignoreConfig --noEmit` on the six changed/new test files | Passed with strict ES2022/bundler settings. |
| Production output | `pnpm run build` | Passed, including all three examples. |
| Source distribution | `pnpm run test:consumer` | Copied basic and paged examples built without demos or workspace links. |
| Profiling tools | `pnpm run test:firefox-profile` | 24 passed. |
| Send, follow, keep-start, explicit rearm, stall, stop, reset | `runtime/streaming-consumer` | Chromium, Firefox, WebKit passed. |
| Pinned history, live updates, eviction, archived token restoration | `runtime/paged-streaming-consumer` | All three engines passed. |
| Markdown code/table/list rendering, cursor removal, composer sizing | `runtime/markdown-streaming-consumer` | All three engines passed. |
| Full-demo bounded traversal and explicit latest restoration | `chat-scrolling/chat-paged-history` | All three engines passed. |
| Editing, anchoring, scrolling, tree navigation | `chat-editing,chat-scrolling,chat-tree` | 20 of 22 passed initially; send/version and all eight tree scripts passed after corrections. |
| Rich content and shared integrations | `chat-content,shared` | 13 of 14 passed initially; date-pill rerun passed in all three engines at both widths. |

The direct test-type command covered `virtual-list`, `composer`,
`consumer-boundary`, `reading-anchor`, `sticky-headers`, and `streaming-text`.
Tests follow the repository's `tests/unit` organization. Existing upstream
Markdown viewer sourcemap warnings remain; no dependency code was changed.

The initial send/version failure exposed unnecessary source-window replacement
on send; preserving a window that still fits resolved it. The tree assertion
was updated to expect bounded loading after explicit navigation. Three older
sticky assertions expected visibility changes, although the baseline already
used transparent paint suppression; the updated checks test that contract.
The Markdown cursor check uses the renderer's actual `.cursor` class.

## Native Firefox comparison

Four valid captures used installed Firefox 155.0.1 on the external LU28R55:
1900 by 965 inner CSS pixels, 2x scaling, and a reported 60 Hz display.
DevTools stayed closed. Each used a fresh temporary browser profile and the
same 160-turn synthetic rich-chat fixture, including tables, code, math,
tool panels, and local images. Each profile includes renderer/compositor
tracks. No user transcript or normal browser profile was used.

The command for the candidate and original baseline was:

```sh
pnpm run profile:firefox -- --display=LU28R55 \
  --url=http://127.0.0.1:4193/demos/streaming/ --layout=none \
  --setup=scripts/firefox-profile/fixtures/rich-chat.js \
  --warmup-ms=10000 --down=0 --up=12 --ticks=90 --delta=60 --live
```

The fresh control served an exported `main` snapshot at port 4194. Its only
configuration change permitted serving the shared installed renderer assets.
The original baseline preceded the integration changes. Both candidate runs
used the same unchanged implementation; the control was repeated afterward
because CPU results varied. Default input interval and settle pause were
16.667 ms and 700 ms. Scripted gestures have no real trackpad momentum tail.

| Measurement | Original main | Candidate 1 | Candidate 2 | Fresh main control |
| --- | ---: | ---: | ---: | ---: |
| Local run ID | `run-VzmvwF` | `run-TQ7HXW` | `run-LQHWvB` | `run-AlQcz6` |
| Sampled frame duration, seconds | 30.82 | 30.77 | 29.80 | 30.70 |
| Frame interval p95, ms | 17.02 | 17.04 | 17.22 | 17.12 |
| Frame interval maximum, ms | 17.56 | 17.64 | 17.54 | 17.56 |
| Intervals above 25 ms | 0 | 0 | 0 | 0 |
| Scroll events | 767 | 822 | 820 | 823 |
| Scroll-end events | 13 | 12 | 12 | 12 |
| Scroll-handler p95, ms | 0.443 | 0.595 | 0.777 | 0.554 |
| Average content-thread CPU, % of one core | 2.42 | 3.07 | 4.31 | 2.96 |
| Active-input 100 ms CPU-bin p95, % | 5.55 | 7.18 | 10.97 | 6.71 |
| Maximum 100 ms CPU bin, % | 38.21 | 40.27 | 43.52 | 34.09 |

Movement and page progress were verified: each run followed the same
scroll-position sequence, including two settled prepends. Every run made
exactly two recorded scroll-position assignments, both during settle, and
none during active input. Candidate height progressed from 21,393 to 39,651
to 36,608 pixels as its offscreen tail was evicted. Main instead ended at
57,909 pixels because it retained that tail. This is an intended retention
difference, not a stationary capture being treated as successful movement.

The frame-interval result is consistent across these captures. CPU neutrality
is not established: the first candidate resembles the fresh control, while
the second has higher sampled CPU and handler duration. Peak CPU bins occur
during settled page work. These are sampled thread CPU deltas, not whole-system
utilization or continuous JavaScript tasks; telemetry was available in all
four runs. Do not describe the result as CPU-spike-free or proof of smooth
physical presentation. Further interleaved captures and attribution remain
a performance signoff item. Live-token throughput needs its own native
workload; this capture measures rich-history scrolling and paging.

Raw profiles, metadata, and generated screenshots remain local under ignored
`browser-artifacts/`. The refused-connection attempt `run-pZU3iy` and the
asset-loading/focus failure `run-Q3jaJz` are invalid and excluded, as are the
earlier setup failures `run-DbHlyA` and `run-xuM0Ld`.

The runner removed each launched browser's temporary profile. Task-owned
servers were stopped, and the reproducible temporary main source export was
removed. The separate user-started development server was preserved.

## Remaining release gates

The later [UI verification report](streaming-ui-verification-2026-09-13.md)
covers installed-Safari composer behavior and custom scoped typography.
The [interleaved Firefox comparison](streaming-integration-firefox-profile-2026-09-13.md)
adds fast-streaming scrollback evidence and doesn't reproduce the earlier
candidate CPU increase. These are scoped results, not universal compositor
or CPU guarantees.

The implementation is not a claim that every release-plan acceptance item
has been signed off. Keep these items open:

- Signoff of the new UI and Firefox evidence on the committed release
  candidate, with the reports' workload and visual-verification limits.
- Signoff of the [companion and UI API reference](integration-api.md).
  Additional standalone examples are out of scope by the September 13, 2026
  decision; retain existing consumer and full-demo tests as behavior evidence.
- Final API and app/runtime ownership review, commit references, and
  verification of the exact merge candidate. The source-based package stays
  private; publishing is a separate action.
- Final performance and release approval. The newer fast-reply capture
  covers live generation during scrollback, not maximum throughput or every
  hands-off follow workload.

See the [trackable release plan](streaming-integration-plan.md) for the full
acceptance checklist and the [consumer guide](streaming-consumer.md) for
run commands and integration contracts.

The user confirmed the reported top-button/page-load shift is gone. The
[anchor-shift investigation](prepend-anchor-shift-2026-09-13.md) records the
rounding fix, exact-transcript tests, and matched Firefox captures; this closes
that specific visual gate, not universal compositor or CPU signoff.
