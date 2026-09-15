# Renderer hardening audit, September 15, 2026

The audit found and fixed three medium-severity issues in the recent renderer
changes. A second review found no remaining high or medium findings within
this scope. This result is not a guarantee for arbitrary Markdown or host CSS.

## Scope and findings

The review covers the uncommitted changes after markdown-viewer `dd9d511`
and virtual-list `0c11103`. These include trail tracking, cursor spacing,
table menus, the geometry-page migration, demo controls, and host CSS.

| Severity | Finding | Fix and evidence |
| --- | --- | --- |
| Medium | Removing an open table during streaming leaves its menu marked open and its document listeners attached. | An observer exists only while the menu is open. Removing its menu or panel closes it and removes listeners. Unit tests and Firefox/WebKit regressions cover both removals. |
| Medium | Trimming each fade group independently leaves spaces between streamed chunks unpainted. | Trimming uses the bounded line context. Browser tests cover spaces across separate fade groups and inline elements, unchanged animation age, and excluded code indentation/trailing whitespace. |
| Medium | Block tracking skips bare text returned by custom render hooks. | Tracking accepts text nodes and skips empty blocks. A public `onRender` regression covers an unwrapped paragraph. A unit test makes sure that text-node traversal excludes siblings. |

The cleanup also releases trail snapshots and source references on destruction.
Calls to a destroyed trail cannot retain another source string. Duplicate
rectangle-bound calculations, style caches, and menu wrappers were consolidated.

## Verification

Both repositories passed formatting and static checks. Markdown-viewer passed
1,096 unit tests across 40 files. Virtual-list passed 997 tests across 44 files
before and after the release pin update.

The renderer package retains six production dependencies. The candidate build
contains 499,973 bytes of distribution output and 270,214 bytes of runtime
assets. The existing limits remain 500,000 and 280,000 bytes, respectively.
The distribution limit has only 27 bytes of headroom.

Firefox 153.0 and Playwright WebKit 26.5 cover geometry, table-menu placement
and dismissal, complex showcase streaming, bounded rewrite invariants, final
chunks, whitespace boundaries, custom hooks, and demo controls. WebKit automation
does not substitute for an installed-Safari manual test.

The final repeat uses temporary servers owned by the test runners. Attempts
against the stopped port-5174 dev server failed before navigation and provide
no test evidence. Each runner closes its browsers and temporary server.

## Limits and release

This is a correctness audit, not a new performance profile. It provides no
CPU-gain or physical-scroll-smoothness claim. The trail retains its documented
best-effort behavior when a rewrite cannot be matched safely.

The pre-existing nested-list/setext/table parsing behavior is outside these
recent changes and remains unchanged. Renderer work targets the requested
minor release, v0.3.0. Virtual-list keeps geometry tooling in the renderer
repository and consumes the release through its GitHub tag pin.

The published tag resolves to renderer commit `d2340f2`. The virtual-list
lockfile and revision-specific build approval use that same commit. A frozen
install, static checks, unit tests, and production demo build passed against
the installed v0.3.0 package, without the local renderer alias. Image spacing
and table-menu typography regressions also passed in Firefox and WebKit.
The image samples retain equal 16px gaps and unchanged heights at stream end.

Existing jsdom canvas notices and installed-package source-map warnings remain
non-fatal. No profiling captures or generated screenshots are included in the
release commits.
