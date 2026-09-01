## Why

CSV traces exported from real instruments shipped `.CH` header bytes as
data: negative "counts" (denormals) and 1e+300 garbage. Two independent
defects, both reproduced on `20260828_liniowosc_detektora_RAD.rslt.zip`
(22 traces) and `10072026-berlin-fps.olax` (20 traces):

1. **Unaligned access.** Zip entries are zero-copy subarray views at
   arbitrary `byteOffset`s. The old scanner trimmed leading bytes until the
   data start was 8-aligned to the *backing buffer* (`align8`), so it only
   ever probed one residue class mod 8 — the real data usually fell outside
   it, and the offset-0 fallback shipped the header as data.
2. **Untrustworthy anchors.** The scan scored candidate windows against the
   `.acmd` `Minimum`/`Maximum`. Real exports carry garbage extrema there
   (e.g. `Maximum=1.59…E-98` for a VWD trace whose true peak is ~4541 mAU),
   so the matcher matched garbage to garbage — or nothing at all.

## What Changes

- `index.html` gains `f64Copy(dv, byteOff, n)` — DataView-based, so a
  window at any byte alignment is read correctly. `align8` is removed.
- New `ch179DataOffset(dv, n, slope, timeEnd)` locates the Y-value region
  from the `.CH` file's own header (layout established against
  OpenLab's own reader/writer behavior and validated on all 42 real
  traces):
  - byte 0 `0x03` + ASCII tag `179`;
  - BE float32 anchors: `EndTime @286` (ms), `Zero1 = valuesY[0] @4110`;
  - BE float64 `Slope @4732` must equal the `.acmd` slope;
  - values = little-endian float64 at `6136` (ChemStation-legacy layout,
    `len = 6136 + n*8 + 8`) or `6144` (OpenLab-native). When `valuesY[0]=0`
    the two are byte-identical — legacy wins, matching every observed file.
  - `.acmd` min/max are no longer used for window identification.
- `bestFloatSegment` / `findAllZeroSegment` remain as **fallback** when the
  header does not validate, rewritten as O(n) sliding-window scans
  (monotonic min/max deques per byte-alignment residue class) that probe
  every byte offset, not one residue class.
- `buildCSVForTrace` logs a warning whenever it falls back.
- Tests: `test/ch-alignment.test.mjs` (misaligned scanners, stored-entry
  container, Signal179 header anchoring incl. garbage acmd extrema, anchor
  rejection). Fixture `acmdInjection` gains per-trace `Slope`; `makeZip`
  supports per-entry `method` (store/deflate).

## Impact

Affected spec: `resultset-parsing` — adds RS-5 (raw trace extraction).
Risk: low; the anchored path is additive, the fallback preserves prior
behavior for non-`179` traces, and all 42 real traces now extract at byte
6136 with instrument-plausible values (RAD linearity series 107609→77
counts; berlin VWD baselines −0.45…0 mAU with real peaks).
