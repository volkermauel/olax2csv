- [x] 1. `index.html`: remove `align8`; add `f64Copy(dv, byteOff, n)`
       (DataView copy — safe at any alignment). Rewrite
       `bestFloatSegment`/`findAllZeroSegment` as sliding-window scans over
       all 8 byte-alignment residue classes (monotonic deques, O(file)).
- [x] 2. `index.html`: add `ch179DataOffset(dv, n, slope, timeEnd)` —
       Signal179 header anchors (tag, `Slope @4732`, `EndTime @286`,
       `Zero1 @4110`) resolving the value window to 6136 (legacy) or 6144
       (native); `buildCSVForTrace` tries it first, falls back to the
       scanners with a logged warning.
- [x] 3. Fixtures: `makeZip` per-entry `method` (store/deflate);
       `acmdInjection` optional `slopeA`/`slopeB`. New
       `test/ch-alignment.test.mjs`: misaligned scanner units, stored-entry
       container (counts never negative, exact window), Signal179 anchoring
       (legacy/native/rejection), garbage-acmd-extrema container.
- [x] 4. Real-file verification: all 22 RAD traces extract at 6136 with
       exact count ranges (linearity series 107609→77, H2O blanks 5109);
       all 20 berlin traces extract at 6136 with sane VWD baselines
       (−0.45…0 mAU) and real peaks — no negatives, no denormals.
       Suite 78/78 green.
