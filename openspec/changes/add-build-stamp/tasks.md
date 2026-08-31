- [x] 1. `index.html`: `.buildInfo` styles, hidden `<span id="buildInfo">`
       next to the `<h1>`, `BUILD` const with `__COMMIT__`/`__BUILT__`
       placeholders, `renderBuildInfo()` guard (SHA-shaped commit only,
       links to the commit page, shows the UTC build time).
- [x] 2. `.github/workflows/ci.yml`: `deploy` job gated on main pushes —
       sed-stamp short SHA + UTC time, sanity-grep the replacement, upload
       Pages artifact, `deploy-pages@v4`. PII guard split to stay within
       lint line length.
- [x] 3. Harness exposes `BUILD`; `test/build-stamp.test.mjs` locks the
       deploy contract (tokens exactly once, hidden anchor, placeholder not
       SHA-shaped). 58/58 green.
- [x] 4. Push, confirm the deploy job green, switch Pages build_type to
       `workflow`, verify the live badge. (Done: live page stamped `0e89b88 / 2026-08-31 15:08 UTC`.)
