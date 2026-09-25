# Stable content when a streaming trail is disabled

The renderer used to remove source-map wrappers from every completed block
when a virtualized reply moved offscreen and disabled its streaming trail.
The next text chunk then replaced a large part of the DOM. The fix belongs in
`markdown-viewer`: keep an established source-map representation for the render
lifetime, while disabling the trail's animation and observers immediately.

The upstream fix is published as
[`markdown-viewer` v0.8.4](https://github.com/jveres/markdown-viewer/tree/v0.8.4),
commit `c929d215f7f97c6746ef4627b448b1e5812d8360`. The consumer manifest,
lockfile, and build permission pin that GitHub tag and commit. The installed
`dist/MarkdownViewer.js` hash matches both measured candidates and the upstream
release build:
`aef306c7a730cc93bd33b8329b971efa43c434afdf6640cb43bd7fa1d43812dd`.

## Finding and profiler improvement

The review found two medium renderer issues: unnecessary completed-content
replacement when disabling the trail, and stale unmapped HTML when enabling it
without changing the text. Both are fixed upstream.

Chrome's earlier slow-window stacks pointed at DOM morphing, but a timer around
individual native mutations did not find a long call. Diagnostic probe 3
recorded thousands of short `insertBefore`, `removeChild`, and `remove` calls;
none explained the stall alone. Probe 4 groups those calls within the innermost
instrumented operation. It also retains expensive sampled leaf frames separately
from inclusive ancestors in Chrome's offline analysis.

The new burst metric identified one 67 ms content update in Chrome containing
1,366 native mutations, with about 58 ms inside native DOM calls. The update
removed source-map spans and replaced formatted descendants across eleven
completed sections. Safari reproduced the same transition in a 40 ms update
with 1,121 mutations. The delivered character counts, 10,272 and 8,352, identify
when each browser scrolled the reply offscreen; they are not size thresholds.

The demo correctly turns the trail off for retained offscreen rows. The renderer
incorrectly tied parser source mapping to the current animation option. Its
render-snapshot cache also omitted mapping mode, so enabling a trail with
unchanged text could reuse unmapped HTML. Both defects reproduce in new upstream
component tests before the implementation change.

The fix keeps mapping enabled after its first successful use, includes it in
the snapshot key, and commits that state only after a successful current render.
Turning the trail off still removes the overlay and stops its work. Resetting
the viewer creates fresh render state and can return to unmapped content.
Tests cover completed-node identity through disable/re-enable and completion,
reset, and enabling a trail without another text chunk.

## Comparable captures

The baseline consumer is `a9e16ae`, pinned to renderer `v0.8.3`. Candidate captures
use an isolated consumer worktree and a package built from the upstream fix.
No installed package was edited. Each recipe includes the upstream base and
patch, build commands, archive hash, and verified JavaScript build hash. Shipping
uses the released GitHub tag `v0.8.4`.

Installed Firefox was measured first for the patch comparison, followed by
Safari and Chrome. The preceding stack-attribution work was a stated Chrome
exception because the intermittent stall was most visible there. Every included
capture uses diagnostic probe 4 with scheduling enabled, the same synthetic
160-turn/48-section reply, a 12-second stream, and a 20-second button sequence.
The workload hash is
`b871a8159e958823e1b309e72bc3ef2f0a48590998de7e3af2b786951cf594d9`.

The LU28R55 is 1920 × 1080 logical pixels, 2×, 60 Hz. The window is 1900 × 1049
at `(1450, 31)`. Browsers are Firefox 156.0.1, Safari 27.0
(22625.1.29.11.27), and Chrome 153.0.8010.53. Their content viewports are
1900 × 965, 1900 × 997, and 1900 × 962 respectively. Safari uses the detached
MCP transport throughout. Each browser has three trials: one released baseline
and two candidate captures. Probe-2/3 exploratory timings are excluded.

The worst synchronous content update during the streaming top-navigation phase
falls from 67 ms to 7.2–8.6 ms in Chrome and from 40 ms to 6–7 ms in Safari.
Firefox's corresponding maximum falls from 7 ms to 4 ms. No candidate has the
completed-prefix mutation burst.

| Browser | Baseline update maximum | Candidate update maxima | Moving-frame p95, baseline → candidates |
| --- | ---: | ---: | --- |
| Firefox | 7 ms | 4 / 4 ms | 17.22 → 17.24 / 17.08 ms |
| Safari, detached | 40 ms | 7 / 6 ms | 20 → 19 / 19 ms |
| Chrome | 67 ms | 8.6 / 7.2 ms | 18.5 → 17.5 / 17.5 ms |

All nine captures are valid, reach all four requested edges, complete the stream,
and report zero uncovered pixels at cached coverage publications. The comparison
command accepts all six baseline/candidate pairs. These are diagnostic samples,
not physical-presentation measurements or a statistically powered speedup claim.

The fix removes an unnecessary full-prefix rewrite. It does not remove the cost
of rendering and measuring the single large evicted reply before idle bottom
navigation. Candidate staging spans remain 36–68 ms, including a roughly 25 ms
Chrome layout read in one sampled task. Chrome also retains occasional ordinary
late-stream updates of 16–24 ms, containing tens of mutations rather than more
than a thousand. One candidate's idle-bottom frame maximum is 49.9 ms versus
33.3 ms in the baseline and repeat. Safari's largest moving intervals remain
54–56 ms across the three trials. These remaining costs are not evidence that
the removed prefix rewrite persists; they prevent a claim that every frame now
fits a 60 Hz refresh interval.

| Browser | Baseline | Candidates |
| --- | --- | --- |
| Firefox | `firefox-diagnostic-9lHzhu` | `firefox-diagnostic-g410JJ`, `firefox-diagnostic-jh2a3L` |
| Safari | `safari-diagnostic-gJZMK4` | `safari-diagnostic-AAbNXO`, `safari-diagnostic-p9CZL9` |
| Chrome | `chrome-diagnostic-eGRM5g` | `chrome-diagnostic-I4r7D8`, `chrome-diagnostic-TRIu8F` |

Earlier probe-3 Chrome attribution control: `chrome-diagnostic-1eQSGe`.
The final probe contains a formatting-only split of one assignment expression;
its behavior matches the captured probe 4. Exact measured source is retained
in each capture's reproduction patch.

## Reproduce and verify

Use the same probe-4 scripts with renderer `v0.8.3` and `v0.8.4`:

```sh
pnpm run profile:chat -- --browser=firefox --scenario=buttons \
  --mode=diagnostic --scheduler --display=LU28R55
pnpm run profile:chat -- --browser=safari --scenario=buttons \
  --mode=diagnostic --scheduler --display=LU28R55 --safari-detached
pnpm run profile:chat -- --browser=chrome --scenario=buttons \
  --mode=diagnostic --scheduler --display=LU28R55
```

For exact historical candidate reconstruction, apply each capture's source
patch and upstream patch in separate temporary checkouts and follow its
`reproduce.json`. The synthetic fixture needs no private transcript. Raw traces
and profiles are discarded after analysis; compact summaries, source hashes,
and rebuild recipes remain. See the [profiling guide](../streaming-chat-profiling.md)
for metric bounds, overhead, and comparison validation.

Upstream verification passes `pnpm run check`, 1,153 tests, the package build
and boundary checks, and all 16 existing browser regression scripts across
Firefox, Chromium, and WebKit through `pnpm run test:cursor`.

Consumer verification passes `pnpm run check`, 1,052 tests, and 123 portable
profiling checks against the installed GitHub release. All 13 chat-scrolling
scripts pass against the isolated candidate whose renderer JavaScript matches
the installed release. The profiler regression also passes six automated
follow/button captures across the three engines and its manual WebKit export
and reload path. Browser automation validates correctness, not physical display
smoothness.

The rejected native listener-order experiment is recorded in its
[control report](native-scroll-listener-control-2026-09-25.md); its application
change was removed. Profiling browsers and servers are closed, and raw captures
are not retained.
