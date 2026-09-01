## Context

`buildCSVForTrace` turns a trace's `<TraceId>.CH` payload (from the `.dx`
zip inside the container) into `time_ms,…,<value>` CSV rows. The payload
arrives as a zero-copy `Uint8Array` subarray whose `byteOffset` is whatever
the zip layout dictates — alignment to 8 bytes is never guaranteed. The
`.CH` format is Agilent's "Signal179" 2D chromatogram: a binary header
followed by little-endian float64 Y values. Authoritative layout facts come from
OpenLab's own reader/writer behavior (`HeaderData`, `SignalData.Read2DSignal`,
`SignalData.Create`):

- standard file header at 244 (all big-endian): `DirOffset @260`,
  `DataOffset @264`, `NumRecords @278` (= `int(len/512) − 1`),
  `StartTime @282`, `EndTime @286`, `MaxSignal @290`, `MinSignal @294`;
- signal info block from 4096: `Zero1 = valuesY[0]` (BE float32 `@4110`),
  `Slope` (BE float64 `@4732`);
- values read as LE float64 directly after the signal-info block.

The DLL's own constant says that block ends at 6144 — but every real trace
in both test exports has its values at **6136** (`len = 6136 + n·8 + 8`),
i.e. these files were written by the ChemStation-legacy layout. The proof:
`Zero1` (the writer's stamp of `valuesY[0]`) equals the f64 at 6136 on all
42 traces, while the f64 at 6144 is the *second* value.

## Goals / Non-Goals

Goal: every trace's CSV values come from the correct byte window, at any
alignment, chosen from file-internal evidence rather than `.acmd` extrema.
Non-goal: interpreting or re-basing values (slope scaling stays as-is);
non-goal: InstrumentTrace/NonEquidistant179 encodings (none observed).

## Real-World Constraints

- `.acmd` `Minimum`/`Maximum` are unreliable (garbage `E-98` maxima
  observed); `MinSignal`/`MaxSignal` in the `.CH` header can be stale 0.
  Only `Slope`, `EndTime` and `Zero1` proved trustworthy anchors.
- When `valuesY[0] = 0` the legacy (6136) and native (6144) layouts are
  byte-for-byte indistinguishable — `0.0` data vs zero padding, and the
  total lengths coincide (`6136 + n·8 + 8 === 6144 + n·8`). Legacy-first
  candidate order resolves this; worst case is an 8-byte shift.
- The scan fallback must stay O(file): real exports are 260 KB per trace
  and a naive per-candidate re-scan is O(file × n) ≈ minutes.

## Proposal

Extraction is a two-stage choice in `buildCSVForTrace`:

1. **Anchored (preferred):** `ch179DataOffset` validates tag `0x03+"179"`,
   `Slope @4732` ≈ acmd slope, `EndTime @286` ≈ acmd time end, then returns
   the first candidate offset in `[6136, 6144]` whose f64 equals `Zero1`.
   The window is materialised with `f64Copy` (DataView — alignment-free).
2. **Fallback (scanners):** `bestFloatSegment` / `findAllZeroSegment`
   slide a window over each of the 8 byte-alignment residue classes with
   monotonic min/max deques (O(1) amortized per candidate), scored against
   the acmd extrema as before. Used when the header does not validate
   (e.g. non-179 traces); logs a warning.

## Risks / Trade-offs

- A hypothetical OpenLab-native file with `valuesY[0] = 0` would extract
  from 6136 (8 bytes early): one extra leading 0, last real value dropped
  into the ignored tail. Accepted — no such file observed; every anchor is
  cross-checked before the offset is trusted.
- Anchor tolerances: slope exact to 1e-9 relative (observed exact), end
  time `max(2 ms, 0.1%)` (float32 storage), `Zero1` to float32 precision.
