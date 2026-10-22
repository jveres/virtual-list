# Clean code audit after the Highlights migration

The audit starts at `bef1710` (`v0.6.0`). It corrects current documentation and
finds no confirmed unused implementation, file, or dependency to remove.
A second pass finds no remaining actionable finding within the checks below.

## Scope and method

The static audit covers `src/`, companions, `integrations/`, `demos/`,
`examples/`, scripts, tests, and configuration. Documentation review compares
current consumer and tree-layout instructions with the implementation and
checks local Markdown link targets. Historical reports and the completed
integration release record remain revision-specific evidence.

Reproduce the reachability and clone checks with:

```sh
pnpm dlx knip@6.39.0
pnpm dlx knip@6.39.0 --production
pnpm dlx knip@6.39.0 --include-entry-exports
pnpm dlx jscpd@5.4.0 src integrations demos examples \
  --min-lines 8 --min-tokens 65 --reporters console \
  --output /tmp/virtual-list-clones
```

Normal and production Knip scans report zero issues. The entry-export scan
reports 30 type exports; review confirms that each belongs to a supported
public entry point or its re-exported types. These declarations remain part of
the consumer API. TypeScript checks unused locals and parameters. Additional
reference searches review internal exports, controller methods, CSS selectors,
and custom properties against production callers and dependency styles.

The clone scan reports zero TypeScript clones at the stated threshold. Its
12 HTML/CSS matches are repeated page structure, small style groups, and
explicit/system dark-theme declarations. Those have live consumers and do not
justify introducing new page-generation or theme infrastructure in this audit.

## Findings and corrections

| Finding | Correction |
| --- | --- |
| The README describes equal-width conversation-tree bands. | Describe content-sized bands and parent-relative placement. |
| The tree guide omits the independent vertical placement introduced in `38ffee1`. | Explain that each turn starts below its own parent and that sibling subtrees pack against vertically overlapping rows. |
| The consumer guide promises legacy demo helper wrappers that no longer exist. | Point consumers to `integrations/index.ts` and identify the removed paths. |
| The consumer guide omits the Highlights migration contract. | Document shared WASM loading, language preloading, stylesheet variables, custom HTML callbacks, and unsupported-language fallback. |
| The README's demo list omits the feed and newspaper entries already exposed by the landing page and build. | Add both demos and their current roles. |

No runtime removal is warranted by this audit. In particular,
`ScrollOptions.duration` remains an explicitly documented, tested compatibility
field whose value is ignored. Removing it would break TypeScript callers.
Test-consumed helper exports, dynamically generated feed classes, and renderer
CSS variables also remain in use. The lockfile contains Highlights and no
Highlight.js dependency.

## Verification

All checks pass after the documentation corrections:

- `pnpm run check` and `pnpm run build`.
- `pnpm test`: 55 files, 5,674 tests.
- `pnpm run test:firefox-profile`: 197 checks.
- `pnpm run test:regression-runner`: 11 checks.
- `pnpm run test:consumer`: isolated basic and paged consumer builds.
- `pnpm run test:regression -- --match=markdown-streaming-consumer`:
  Chromium, Firefox, and WebKit pass highlighting and streaming finalization.
- `pnpm run test:regression -- --group=chat-tree --match=placement`:
  Firefox, WebKit, and Chromium pass sizing, gutter placement, resizing,
  branches, and mobile checks.
- Local Markdown file targets and `git diff --check` pass.

This is a static cleanup and documentation audit with targeted browser
verification, not an exhaustive proof that every runtime path is defect-free.
The full browser regression matrix and native performance profiling were not
run. No runtime behavior or performance claim changes.
