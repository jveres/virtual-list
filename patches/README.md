# Renderer cursor-spacing patch

`markdown-viewer@0.8.0.patch` replaces two cursor-spacing `:has()` selectors
with a marker managed by the renderer's existing update. Chrome invalidates
large Markdown subtrees through the relational rules during unrelated stream
mutations. The marker keeps the same margin behavior local to the block before
a trailing, top-level cursor.

The patch applies to the pinned package's distributed JavaScript and CSS.
`pnpm-workspace.yaml` registers it, and `pnpm-lock.yaml` records its hash. Use
`pnpm install --frozen-lockfile` to apply it. The modified JavaScript omits its
original source-map reference because that map describes the unpatched code.

The renderer updates the marker after morphing and clears it when the cursor
moves inline, the stream finishes, the viewer resets, rendering fails, or the
viewer is destroyed. It uses DOM relationships without reading layout and
avoids writing an unchanged marker. Morphing can remove attributes, so the
renderer checks the marker even when the preceding block keeps its identity.

When updating the renderer dependency, review whether the upstream version
contains this behavior before carrying the patch forward. Run the cursor,
image-spacing, footer, and streaming regressions, then repeat installed-browser
profiles. The [measurement report](../docs/reports/streaming-cursor-restyles-2026-09-25.md)
records the baseline, controls, and validation.
