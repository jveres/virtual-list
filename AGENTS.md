# Repository workflow

Use the following workflow when investigating or changing this repository.

## Performance investigations

Start performance investigations with the Firefox-first methodology in
[docs/firefox-profiling.md](docs/firefox-profiling.md). Firefox is the primary
performance target for this project. Exceptions, such as an exclusively
WebKit-specific issue, must be stated explicitly.

- Profile before proposing a performance patch. Use the installed Firefox,
  a fresh temporary browser profile, and closed DevTools.
- Match the reported monitor, window size, display scaling, and refresh rate.
  A fast built-in-display result does not resolve an external-display issue.
- Use `pnpm run profile:firefox` for native macOS scroll input. Use manual
  capture for real trackpad momentum. Do not substitute Playwright wheel
  events for native gesture-release behavior in Firefox.
- Keep measurement lightweight: no DOM layout reads in the animation-frame
  sampler. Verify actual movement, scroll-end events, and paging progress.
- Save a baseline and a comparable repeat after a change. Report browser
  version, display geometry, workload, timing, and limitations. Do not infer
  smooth physical presentation from regular animation-frame callbacks.
- Keep raw profiles and metadata locally under ignored `browser-artifacts/`
  while their investigation is open. Once its report is committed, they may
  be pruned; keep irreproducible inputs, such as manual recordings, until
  the user approves removal. Never upload captures or modify the user's
  regular browser profile without explicit authorization.
- Keep durable reports in `docs/reports/` and index them in its `README.md`.
  Keep reusable profiling scripts and synthetic fixtures in
  `scripts/firefox-profile/`, and browser regressions in
  `scripts/regressions/`. Do not leave reusable work only in ignored
  `browser-artifacts/`. Remove personal paths and private inputs before
  promoting exploratory probes.
- Treat failed, stationary, interrupted, or mismatched-display runs as
  invalid evidence. Do not claim a jitter fix without reproducing it and
  measuring the relevant improvement.
- Own the test-process lifecycle. Close profiling browsers, native helpers,
  automation sessions, and servers you started when work ends. Audit for
  leftovers. Preserve pre-existing user processes unless asked to stop them.

## Verification

Use `pnpm run check`, `pnpm test`, and relevant browser regressions after code
changes. The profiling tools have an additional portable check:
`pnpm run test:firefox-profile`. Keep unrelated working-tree changes intact.
