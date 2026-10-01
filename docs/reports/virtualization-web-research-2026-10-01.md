# Virtualization and layout research, October 1, 2026

The most promising remaining research direction is reducing the content work
inside a large row. Replacing the list engine has no demonstrated advantage.
Other libraries offer useful design alternatives, but several save work by
accepting estimated geometry, replacing content during scrolling, or reusing
nodes across different items. Those choices change this project's contracts.

This is a web-research and source-review report at revision `77e1d18`, with a
clean starting working tree. It follows the
[Firefox-first methodology](../firefox-profiling.md) and uses the recent
reports as historical evidence. No new profile, browser comparison, runtime
patch, or performance improvement is claimed. The priorities below are
hypotheses to investigate, not approved performance patches. Web sources were
accessed on October 1, 2026; linked main branches and latest documentation can
change. No third-party benchmark establishes performance in this application.

## Existing evidence and runtime design

The [September 30 audit](runtime-performance-audit-2026-09-30.md), at `db1104c`,
used Firefox 157.0 on the LU28R55 at 1920 × 1080 logical pixels, 2× scaling,
60 Hz, and a 1900 × 964 content area. Its five workloads recorded no animation
frame over 25 ms. Runtime attribution in the four sampled scrolling workloads
was 0.38–0.62% of content-thread samples. This is historical attribution, not
the maximum possible saving from all DOM changes.

During its complex stream, the host message update had 695 ms of self time
over 467 calls, versus roughly 375 ms across runtime operations. Layout charged
to a runtime viewport read can originate in an earlier host mutation. Moving
the read does not necessarily eliminate that layout.

The current source already implements much of the standard virtualization
toolkit:

- [`onScrolled` and `reconcileWindow`](../../src/virtual-list.ts) calculate a
  window, skip unchanged ranges, and process entering and leaving rows.
- Measured rows retain their own DOM when detached. Ordinary scrollback
  remounts these nodes; it does not rebuild every message. Declared-height
  rows are materialized on entry and destroyed on retirement.
- Firefox's native anchoring path uses normal flow and two spacers.
  Independently translated slots serve the runtime-anchoring/positioned path.
- Height reads are batched before height writes. Resize observation and
  hidden preparation already exist. The optional `stage` hook divides initial
  layout of a large completed reply into slices.
- Chat messages already use `contain: layout style`; assistant content uses
  the previously measured block/flow-root arrangement. Slots prefer
  `overflow: clip`. Known-size image suspension preserves image geometry.
- The [core contract](../core-contract.md) uses measured or declared heights
  before reveal, with a documented old-width exception for detached rows.
  An estimate-and-correct design would be a separate mode or contract change.

## What other virtualizers contribute

These projects are references for mechanisms and comparison controls. Their
documentation does not show that migrating would make this runtime faster.

| Solution and primary source | Relevant mechanism | Fit here |
| --- | --- | --- |
| [TanStack Virtual](https://tanstack.com/virtual/latest/docs/api/virtualizer) | Estimated sizes, measurement snapshots, configurable overscan, and rendered-block translation for dynamic smooth scrolling. Its documentation advises against routinely deferring ResizeObserver processing through rAF. | Useful estimate-based control for large history. Native Firefox flow already avoids independently positioning each mounted row. Snapshot restoration would need width/content/font invalidation. |
| [Virtuoso](https://virtuoso.dev/react-virtuoso/api-reference/common/) | Scroll-seek mode replaces content with placeholders, with separate velocity thresholds for entering and exiting. | A rendering-quality tradeoff for expensive fast-scroll content, not a free scheduler optimization. |
| [Vue Virtual Scroller](https://raw.githubusercontent.com/Akryum/vue-virtual-scroller/master/docs/guide/recycle-scroller.md) | Pools reusable views by item type and reassigns them to new items. Inactive views can skip rendering work. | Distinct from this runtime's reuse by stable item key. Most plausible for homogeneous declared-height feeds, where retirement currently destroys the row. |
| [virtua](https://github.com/inokawa/virtua) | Dynamic sizing and reverse-scroll handling; its guidance emphasizes child-rendering cost, buffer size, and reserving space for resizing content. | Supports investigating host rendering and resource geometry. React element memoization does not transfer directly to this imperative DOM runtime. |
| [react-window](https://raw.githubusercontent.com/bvaughn/react-window/master/README.md) | Supports predetermined and dynamic heights; explicitly describes dynamic heights as less efficient. | A useful simple declared-height control. The existing declared mode already removes measurement; this is not a new chat optimization. |
| [Lit virtualizer](https://raw.githubusercontent.com/lit/lit/main/packages/labs/virtualizer/README.md) | Variable-size flow layout, ResizeObserver, and native scrolling APIs. Its flow layout supports a restricted block-layout model. | Useful reference for browser-native behavior. A layout named “flow” does not establish identical DOM or anchoring behavior, or a faster implementation. |

## Ranked investigation candidates

Start with one workload that exposes the proposed mechanism. A candidate earns
an implementation only after a fresh baseline shows meaningful relevant cost.

### 1. Render less inside very large completed messages

One message can span many viewports. Keeping only a few messages mounted still
leaves all of that message's code, tables, math, and other descendants eligible
for layout. The [staged-row report](staged-row-layout-2026-09-26.md) explicitly
leaves a single huge top-level block indivisible. Its slicing reduces the worst
task but increases total preparation work.

Research two alternatives separately:

- Browser skipping on completed, independent blocks using
  `content-visibility: auto` and suitable intrinsic-size fallbacks.
- Renderer-owned windowing inside an unusually large code block or table,
  preserving a measured outer box and logical content identity.

The [containment specification](https://www.w3.org/TR/css-contain-2/) defines
the first mechanism. Skipped contents can avoid rendering work, but their DOM
and application data still exist. This does not remove Markdown parsing.
The browser can keep nearby blocks rendered; skipping is not guaranteed for
every offscreen block. Descendant geometry queries can also force skipped
work, as the browser team's
[content-visibility guidance](https://web.dev/articles/content-visibility?authuser=2)
explains.

This differs from adding skipping to whole mounted slots, which the
[fast-scroll experiment](fast-scroll-exploration-2026-09-29.md) rejected.
It is only plausible when substantial offscreen content remains *inside* a
mounted row. That prior negative result raises the evidence bar.

Exact geometry is the hard part. Remembered block sizes can become stale
after width, font, image, or content changes. An initial estimate can shift the
outer row and reading anchor; premeasuring every block spends the initial
layout cost. Begin with completed content and repeat traversal, separately
report cold preparation and revisit cost, and exclude the active streaming
tail from the first experiment. Verify selection, copy, find, focus, tool
expansion, and accessibility. DOM-removing windowing needs explicit behavior
for content absent from the DOM.

### 2. Constrain expensive HTML layout where the content permits it

A narrower experiment is a large table with known column rules.
[`table-layout: fixed`](https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/Properties/table-layout)
avoids deriving horizontal column sizing from all cell contents when the table
has an explicit width. It does not eliminate cell layout or make arbitrary
Markdown tables cheap. Test it only for a table design that can accept fixed
columns and deliberate wrapping/overflow behavior. Compare long cells, code,
images, narrow windows, and streaming additions. Do not apply it globally to
author-controlled Markdown tables.

Similarly, reserve image dimensions when reliable metadata exists. The
[virtua performance guidance](https://github.com/inokawa/virtua#readme)
identifies repeated size changes as extra virtualizer work. This repository
already does substantial image reservation and suspension, so first establish
a missing case, such as content without usable dimensions. Supplying guesses
as exact heights can simply exchange layout work for corrections.

This candidate targets host/renderer layout, not scroll-handler instructions.
If the change belongs to `markdown-viewer`, follow the owning-repository
regression, release, tag, and dependency-pin workflow.

### 3. Use cheaper content during fast travel, if acceptable

Virtuoso's scroll-seek API offers a concrete alternative: substitute an
equal-height placeholder when velocity exceeds an entry threshold, then
restore content below a lower exit threshold. The two thresholds avoid rapid
toggling. See its
[scroll-seek configuration](https://virtuoso.dev/react-virtuoso/api-reference/common/).

For this project, investigate costly newly entering content first. Swapping
every already-mounted measured message would add DOM churn and could lose
selection or focus. Preserve measured outer geometry and exclude focused,
selected, expanding, and actively streaming content. Start with a deterministic
image-heavy or huge-block fixture where full-content rendering is measurably
expensive.

Treat time to restore readable content after release as a first-class metric.
Lower scrolling CPU is not sufficient if restoration produces a long task or
the user sees placeholders after stopping. This changes visible behavior and
does not follow from evidence of expensive generic scroll callbacks.

### 4. Compare cross-item pooling in declared-height feeds

The subsequent [pooling measurement](declared-pooling-2026-10-01.md) avoids
240 card-tree creations but finds no total CPU or frame-timing improvement
against its restored Firefox control. Production behavior remains unchanged.

Vue's pool can reuse a compatible view for a different item. Here,
`mountWindow` destroys leaving declared rows, whereas measured rows retain
their own elements. A bounded pool could reduce creation and destruction for
simple cards with known geometry.

First attribute declared-row render/destroy time and allocation in a heavier
feed; the September 30 declared-row control has little runtime cost. A pool
requires an explicit rebinding contract for events, images, forms, focus,
accessibility IDs, and item-local state. The existing `render(item, existing)`
hook does not by itself authorize reuse across different keys. Compare retained
memory as well as CPU. Keep this separate from rich-chat row caching, which
already preserves nodes and avoids that creation work during scrollback.

### 5. Estimate geometry for much larger loaded histories

TanStack's estimate-and-measure model can defer work on unvisited rows.
Measurement snapshots can reduce repeat work. Those mechanisms may improve
initialization or restoration when retaining thousands of rich rows, but
require correction as real sizes arrive. They do not imply faster traversal
of an already measured bounded page.

Compare an isolated estimate-based prototype against the current exact
preparation model before proposing an API. Keep content, renderer, viewport,
retention, and overscan comparable. Count renders and measurements; record
scrollbar drift, anchor displacement, jump-to-end accuracy, width changes,
and correction writes during momentum. Do not pass estimates through the
existing declared `height` option, whose contract promises actual heights.

## CSS and browser ideas with little new headroom

Several attractive general recommendations are already present, have contrary
local evidence, or move work without removing it:

| Idea | Decision from source and local evidence |
| --- | --- |
| Add `content-visibility: auto` to all row slots | Already rejected in the matched fast-scroll workload: 31–41% more content main-thread CPU in those trials. Block-level use needs a different workload and separate evidence. |
| Add `contain: strict` or `contain: content` everywhere | Size containment prevents content from determining the outer size; paint containment clips descendants and changes rendering semantics. `contain: style` is not selector isolation. Chat already has layout/style containment and documents an iPad paint-containment regression. See the [containment specification](https://www.w3.org/TR/css-contain-2/). |
| Replace clipping wrappers with `overflow: clip` | Already used by runtime slots. The [overflow specification](https://www.w3.org/TR/css-overflow/) distinguishes clip from hidden: clip is not a scroll container. Keep real horizontal scrollers for wide code and tables. |
| Add/remove GPU hints broadly | The [compositing investigation](compositing-memory-2026-09-29.md) found no meaningful Firefox memory saving from removing the canvas hint, and adverse Safari process peaks. A transform or hint is not proof of a dedicated GPU layer. |
| Simplify every selector or replace all flex/grid layout | The [CSS audit](css-layout-performance-2026-09-29.md) already found little selector headroom and retained a specific block/flow-root improvement. Layout semantics and intrinsic sizing matter more than a general ranking of layout systems. |
| Wrap all resize work in rAF | TanStack's current documentation cautions that ResizeObserver already delivers after layout and batches entries. Deferral can add latency; it is not automatically a batching improvement. |
| Increase overscan to fix jitter | More rendered content trades memory/layout work for coverage. It cannot fix every presentation issue. Separate missing application content from browser rendering coverage. |

Firefox's [APZ architecture](https://firefox-source-docs.mozilla.org/gfx/AsyncPanZoom.html)
explains why the last distinction matters: scrolling can proceed asynchronously
from main-thread updates, and the browser renders a displayport beyond the
viewport. Application overscan and that displayport are different mechanisms.
More DOM does not force a larger displayport or establish smooth presentation.
Regular rAF callbacks are still insufficient evidence of a jitter fix.

## Next steps

The best first investigation is a synthetic completed message containing one
very large code block or table, plus a second case with many independent blocks.
Compare cold preparation, repeated traversal, width changes, and bottom
restoration. Use the existing ordinary rich-chat workload as a control so a
special-case improvement does not become an unjustified global policy.

Before editing runtime or renderer code:

1. Profile the unchanged fixture in installed Firefox with a fresh temporary
   profile and closed DevTools. Record the actual build and match the LU28R55
   geometry, scaling, and refresh rate used by the relevant historical work.
2. Attribute parsing, first layout, subsequent layout, display-list work,
   node churn, and retained resources separately. Use `profile:boot` for cold
   and warm boot marks; do not call a scroll capture a startup measurement.
3. Select one candidate only if its targeted cost is substantial. Compare
   baseline, candidate, and restored baseline, at most three timing trials per
   browser. Use `profile:firefox` for native input and manual capture for real
   trackpad momentum; preserve the workload and source hashes.
4. Verify actual movement, viewport coverage, scroll-end events, and paging
   progress where the fixture pages. Record restoration latency and reading
   position. Keep geometry reads out of the animation-frame sampler.
5. Run `pnpm run check`, `pnpm test`, and relevant browser regressions after
   code changes; also run `pnpm run test:firefox-profile` for profiler changes.
   Check other engines for behavior before retaining a cross-browser change.

Keep reusable synthetic fixtures in `scripts/firefox-profile/`, compact
evidence under ignored `browser-artifacts/`, and conclusions here in the report
index. Delete raw profiles and close owned browsers, helpers, and servers.
This research session started none of those processes and changed only docs.
