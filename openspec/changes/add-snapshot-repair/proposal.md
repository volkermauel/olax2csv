# Change: add-snapshot-repair

## Why

Users of OpenLab CDS sometimes leave a "snapshot" session unclosed. The result
set then does not include all measurements that were actually acquired: data
exists in the export only as partial `snapshot-<ts>-<name>.dx/.rx` files, and/or
measurements lack their processed `.rx`. olax2csv previously skipped every name
containing `snapshot-`, silently dropping those acquired measurements and never
using a snapshot `.rx` to fill a missing one.

Evidence: `20260828_liniowosc_detektora_RAD.rslt.zip` — the `.acaml` manifest
indexes only r001–r004 (+2 H₂O blanks) while r005–r020 were acquired; r005's
processed results exist only as `snapshot-…r005.rx` (snapshot `.dx` is a partial
841 KB capture vs 1.65 MB for the completed run).

## What Changes

- `processResultSet` gains a `repairSnapshots` option (default **on**):

  - `snapshot-<ts>-<name>.dx` is recovered when the counterpart `<name>.dx` is
    absent; ignored when the completed run exists (partial duplicate).
  - Measurements are re-ordered chronologically when any recovery happened
    (time stamp from the file name; stable zip order as fallback).
  - `parseMeasurementResults` falls back to a matching `snapshot-<ts>-<name>.rx`
    when the regular `.rx` is absent.
  - `detectGroupMeta` falls back to a snapshot `.amx` for GC/HPLC
    classification when no regular method file exists.
- New checkbox "Repair snapshot result sets" (pre-checked) in the UI; unchecked
  restores strict legacy filtering.
- The option is threaded through `parseContainer` / `parseContainerParallel` /
  `buildWorkerMessage` → worker dispatcher.
- Silent repair (user decision): no badges, no extra columns, no filename
  changes in CSV/XLSX output; recovered measurements look native.
- Fixture builder supports `snapshot: 'none' | 'only' | 'duplicate' | 'rxOnly'`;
  new test suite `test/snapshot-repair.test.mjs` (6 tests).

## Impact

Affected specs: `resultset-parsing` (RS-2 refined, RS-3 added).
Risk: recovery only fires when the completed counterpart is missing, so
well-formed exports parse exactly as before (verified: all 41 tests green and
the Berlin `.olax` sample byte-identical output counts).
