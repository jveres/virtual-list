# Streaming integration release plan

Make the streaming chat reproducible through supported library APIs and
optional companions, without copying demo-owned scrolling infrastructure.
Keep the runtime generic: applications still own message data, branch
relationships, providers, persistence, rendering, and product choices.

Status: implementation in progress on `feat/streaming-integration`; release
gates remain open. The review baseline is
commit `7caef9a` on `main`, reviewed on September 13, 2026. The baseline passed
`pnpm run check` and 877 unit tests. Those results are not release-candidate
verification or new browser/performance evidence.

## Branch and tracking workflow

The integration branch `feat/streaming-integration` was created from the
verified `main`. Implementation changes are currently uncommitted. Pushing
and tagging remain separate actions; this document performs neither.

- Keep `main` available for verified fixes while contracts evolve here.
- Use small commits labeled with the task IDs below. Keep each change
  buildable and include its tests and documentation.
- Update a task's status when work starts. Mark it done only with a commit
  reference and verification evidence. Record blockers and scope decisions.
- Review API changes before implementation, then review the final public
  surface before merging. Do not promise unfinished APIs through a tag.
- After integration passes, merge to `main` and verify that exact commit
  before tagging the next minor version. Any prerelease tag is explicit,
  optional, and not evidence that the gates passed.

## API constraints

The acceptance target is no host-owned list scroll correction, pin-reserve
arithmetic, follow-intent tracking, or settle scheduling. Normal UI layout,
application state, and calls that express user intent remain host concerns.

1. Try existing public APIs first, then an optional companion, and only then
   a core extension. Extraction alone does not make an API supported.
2. For every proposed core extension, record the failing consumer case, why
   composition is insufficient, lifecycle semantics, compatibility impact,
   and a non-chat use case. Require explicit design approval.
3. Keep one owner for geometry, scrolling, and follow state: the runtime.
   Companions must not write the list viewport's scroll position or create
   parallel correction/follow controllers.
4. Keep one authoritative owner for paged source data. A live update must
   not bypass that owner or be overwritten by a queued page commit.
5. Keep Markdown, composer behavior, section rendering, and chat models out
   of the core dependency graph. Optional integrations have separate imports.
6. Preserve existing consumers unless a compatibility change is explicitly
   approved and documented. Do not change `updateWindow` globally to make
   all structural work run during gestures.

## Workstreams

Workstream checklists remain open until their completion criteria are met.
Evidence entries must identify what ran,
the tested commit, the result, and any limitations; an unchecked item is not
an implied pass.

### SI-01: Consumer contract and executable reference

Status: implemented, awaiting final signoff. Dependencies: none for the initial reference; SI-02 through
SI-05 for final parity. This is the acceptance harness for the other tasks.

- [ ] Define a behavior matrix covering send/pin, token growth, interruption,
  keep-start limits, explicit end rearm, stalled/resumed streams,
  stop/finalize, scrollback, branch replacement, and conversation disposal.
- [ ] Create a small runnable consumer with synthetic data and a fake stream.
  Its basic example uses only the public runtime surface; advanced examples
  add supported companions without importing `demos/shared` or
  `demos/streaming` implementation files.
- [ ] Separate minimal streaming from optional paging, sticky headers,
  branching, and Markdown/composer examples. Share behavior assertions with
  the full demo where practical, not demo implementations.
- [ ] Add an import-boundary check and document exact run commands,
  required styles, render/update/destroy wiring, and ownership rules.

Done when a fresh consumer can run the examples without extracting code from
the full demo or knowing runtime internals. Record setup steps and all matrix
results. Do not use a line-count target as a substitute for clarity.

Evidence: [consumer and API checkpoint](streaming-integration-checkpoint.md).
Basic, paged, and Markdown consumers pass the browser matrix. Standalone
sticky/branch examples and the final release review remain open.

### SI-02: Live updates with bounded paging

Status: in progress. Dependency: SI-01's behavior contract. The branch has a
pager-owned live-update path, an optionally trimmed pinned consumer, and
full-demo integration. The
[optional trimming proposal](optional-trimming-proposal.md) tracks the
extension as SI-02a through SI-02d. The user approved it on September 13,
2026; implementation and verification are in progress.

The baseline [pager](../src/paging.ts) routes edits through the idle-only
`updateWindow` path. The [streaming demo](../demos/streaming/streaming.ts) now
uses `updateItemLive` and the pager's bounded scrollback window. The tree is
the authoritative archive, including tokens received while a row is evicted.

- [ ] Reproduce the composition gap in the consumer: stream into a retained
  row while scrolling, with a fetched page waiting to commit.
- [ ] Design a pager-owned live update path, preferring existing runtime
  primitives. Define same-key updates versus structural projection changes,
  source ownership, cancellation, failure, and notification timing.
- [ ] Cover append/send, finalization, eviction and restoration of edited
  data, overlapping pages, and updates racing with page preparation.
- [ ] Integrate bounded paging into the streaming demo without losing live
  rendering. Define how the active reply and pin interact with the soft
  budget and how branch changes reset or replace page ownership.
- [ ] Verify protected rows survive trimming and late work cannot enter a
  replacement conversation. Explain legitimate over-budget windows.
- [ ] Update [bounded paging guidance](bounded-paging.md) and check existing
  gallery, feed, and chat-history consumers for compatibility.

Done when live tokens remain visible during scrolling, queued pages cannot
overwrite newer data, and repeated history traversal has a tested retention
policy. Distinguish bounded runtime resources from app-owned archival data.

Evidence: [paging tests and browser checkpoint](streaming-integration-checkpoint.md).
The core safety tests, pager modes, evicted-source restoration, and full-demo
history traversal pass. Native comparison and final signoff are tracked there.

### SI-03: Supported sticky-header companion

Status: implemented, awaiting final signoff. Dependency: SI-01's example/import boundary.

The supported implementation lives in `src/companions/sticky-headers.ts`.
The [old demo helper](../demos/shared/sticky-headers.ts) preserves the legacy
native-listener default; migrated demos use runtime snapshots instead.

- [ ] Promote a generic optional companion with documented exports, CSS
  ownership, callback wiring, enable/disable behavior, and disposal.
- [ ] Review the native scroll/rAF fallback against `onState` and
  `onViewport`. Prefer runtime snapshots; retain a fallback only with a
  documented need and tests. Do not assume it can be deleted safely.
- [ ] Migrate existing demo consumers to the same supported implementation.
- [ ] Verify handoff, duplicate suppression, loader edges, glides, variable
  header sizes, replacement, resize, and disposal in the browser matrix.

Done when a consumer supplies keys and header rendering, without copying a
scroll scheduler or geometry cache into its application.

Evidence: [sticky-header checkpoint](streaming-integration-checkpoint.md).
Unit, shared sticky, scroll-work, scrollback, and date-pill checks pass.

### SI-04: Replacement-anchor composition

Status: implemented, awaiting final signoff. Dependency: SI-01's replacement cases; coordinate with SI-02
for replacement during queued page work.

The companion now calculates visibility and viewport-relative coordinates
for the demo's replacement and edit/send paths. Applications still supply semantic
old-to-new relationships; the library cannot infer conversation branches.

- [ ] Enumerate visible, clipped, offscreen, deleted, and replaced anchors,
  including a visible reply beneath a clipped prompt and changing insets.
- [ ] Try a generic helper over existing public geometry/anchor APIs before
  proposing new runtime state or commands. Keep branch traversal app-owned.
- [ ] Define whether geometry is captured before or after interrupting held
  work. Test that queued pages and newer commands cannot stale the capture.
- [ ] Use the supported path for version switching, deletion, and editing;
  remove duplicated coordinate-preservation logic from the demo.
- [ ] Verify shorter and longer replacements, pin reserve, missing keys,
  user interruption, and separator changes.

Done when the host names replacements and chooses a reading policy without
reimplementing visibility tests and offset preservation in each action.

Evidence: [replacement-anchor checkpoint](streaming-integration-checkpoint.md).
Unit, edit/version, partial-prompt, and tree-navigation regressions pass.

### SI-05: Renderer and composer integration boundary

Status: implemented with verification gaps. Dependency: SI-01's optional UI examples.

The demo includes a WebKit composer-size guard, collapsed-message preparation,
and Markdown cursor/footer/overflow rules. These are not all core defects.

- [ ] Inventory every browser/layout workaround and assign it to the
  runtime, an optional UI integration, or the renderer's upstream contract.
- [ ] Provide reusable, documented UI helpers or adapter styles where
  needed. Keep input sizing and Markdown dependencies outside the core.
- [ ] Review the extra collapsed-message probe against runtime measurement
  containers, scoped typography, and lifecycle hooks. Define the supported
  preparation contract without adding a generic hook speculatively.
- [ ] Make cursor reservation, finalization, tool disclosure intent, and
  nested code/table scrolling explicit integration contracts.
- [ ] Verify composer grow/shrink, scoped styles, collapse/remount, delayed
  images, tools, trailing images/code/tables, stop/finalize, and cleanup.
  Include actual Safari verification for the composer-specific guard.

Done when reproducing the UI needs no undisclosed demo CSS or browser fix.
An upstream dependency fix needs its own authorization; otherwise ship and
test the scoped adapter with its limitation documented.

Evidence: [UI integration checkpoint](streaming-integration-checkpoint.md).
Composer, Markdown, collapse, image, tool, and cursor browser checks pass.
Actual Safari compositor verification and custom scoped-typography coverage
remain open; Playwright WebKit is not claimed as actual Safari evidence.

### SI-06: Distribution and release gate

Status: in progress. Initial dependency: SI-01's import contract. Final dependency:
completed SI-01 through SI-05.

- [ ] Decide and document source-based consumption versus an installable
  package. The current private demo package is not an installable-library
  contract. Package publishing is a separate authorized action.
- [ ] Provide stable public entry points for the core and optional
  companions. Document supported styles and dependency/version requirements.
- [ ] Verify the chosen distribution in an isolated consumer, without
  workspace-relative links. If packaged, test the built/packed artifact,
  declarations, and exports, not just source imports.
- [ ] Audit the final API diff against the constraints above. Record each
  added or changed symbol and migration impact; remove temporary experiments.
- [ ] Re-audit the full demo for duplicated runtime responsibilities and
  unsupported companion imports. Explicitly list legitimate app-owned logic.
- [ ] Run `pnpm run check`, `pnpm test`, `pnpm run test:firefox-profile`, the
  consumer acceptance matrix, and relevant full-demo/browser regressions.
- [ ] Complete a Firefox-first performance comparison for changed scroll
  integration paths, following [the profiling workflow](firefox-profiling.md).
  Capture a comparable baseline before those changes. Preserve profiles
  locally and commit the report; do not claim physical smoothness from rAF.
- [ ] Audit process cleanup, confirm the exact merge candidate passes, and
  record the release decision. Only then request or execute authorized tags.

Done when all acceptance evidence is attached, all five review concerns have
an implemented resolution, and the user approves any remaining scope changes.

Evidence: [distribution and verification checkpoint](streaming-integration-checkpoint.md).
Source-based distribution remains private; basic and paged isolated builds
pass. No package publication, commit, push, or tag is implied by these checks.

## Next steps

The optional trimming design is approved and implemented on this branch. Finish
verification and record evidence for the implemented consumer, companion,
and UI integration work. Resolve SI-02's retention contract before migrating
the full demo, then finalize SI-04 against that paging contract and complete
SI-06's release review. No release gate is implied by branch creation or an
uncommitted implementation.
