## Why

The deployed GitHub Pages app gives no hint which commit it was built from,
so bug reports cannot be matched to code. (User-visible build provenance.)

## What Changes

- `index.html` ships `BUILD = { commit: "__COMMIT__", built: "__BUILT__" }`
  placeholders plus a hidden `<span id="buildInfo">` next to the heading.
- `renderBuildInfo()` un-hides the span only when `commit` matches a SHA
  (7–40 hex chars); a plain local open shows no badge instead of stale info.
  The commit links to its GitHub commit page; the built stamp is a UTC
  string.
- CI gains a `deploy` job (main pushes only): substitutes the real short
  SHA + UTC timestamp into `index.html` via `sed`, uploads the repo as the
  Pages artifact, deploys with `deploy-pages@v4`.
- Harness exposes `BUILD`; `test/build-stamp.test.mjs` locks the deploy
  contract (each token exactly once, badge anchor hidden, placeholder is
  not SHA-shaped).

## Impact

Affected specs: none (presentation only, no parsing behavior).
Risk: Pages must switch from legacy (branch) to workflow deployment after
this lands (`gh api -X PUT repos/volkermauel/olax2csv/pages -f
build_type=workflow`); until then the badge stays hidden exactly as before.
