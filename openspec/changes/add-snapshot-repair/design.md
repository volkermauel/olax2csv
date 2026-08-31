# Design — add-snapshot-repair

## Context

OpenLab CDS "snapshot" data lives beside regular run files inside a `.rslt`
folder. Names follow `snapshot-<YYYYMMDD[ +]HHMMSS>-<original file name>` (both
`snapshot-20260710 084732-…` and `snapshot-20260710+084732-…` occur in the
wild). Snapshots are partial captures taken mid-run. The root `.acaml` manifest
never references snapshot files; with an unclosed session the completed
counterpart may never be written.

## Goals / Non-Goals

- Goals: recover acquired-but-uncommitted measurements (traces and/or processed
  results) without changing output schemas for healthy exports.
- Non-Goals: re-integrating or re-processing raw data (r006–r020 in the example
  have no `.rx` anywhere — nothing to recover results from); repairing the
  `.acaml` manifest itself.

## Real-World Constraints

- Single-file offline HTML app; the worker pool is built from the same function
  sources, so all new logic lives inside `processResultSet` /
  `parseMeasurementResults` / `detectGroupMeta` (regex literals inline — top-level
  constants would not survive `.toString()` worker assembly).
- Structured-clone-safe options only → plain `{ repairSnapshots }` object rides
  the existing worker message.

## Decisions

| Decision | Rationale |
| --- | --- |
| Counterpart rule (recover only if `<name>.dx` missing) | Snapshots are partial; when the full run exists the snapshot is redundant. Confirmed byte-level: snapshot r005 = 841 KB vs regular = 1.65 MB. |
| Default ON, checkbox to disable | User decision; the only behavioral delta vs legacy is *adding* previously-lost data. |
| Silent repair (no markers in output) | User decision: repaired output must look like a complete native result set. |
| Chronological slotting only when `recovered > 0` | Keeps healthy exports' ordering byte-stable; the sort falls back to zip order when a name has no parseable time stamp. |
| Repair mode treats a name as snapshot only on the anchored regex; legacy mode keeps the old `includes("snapshot-")` | Unchecked box reproduces today's behavior exactly; checked box stops misclassifying regular files that merely contain "snapshot-" mid-name. |

## Risks / Trade-offs

- A snapshot taken after run completion (before close) is still partial-marked
  by the counterpart rule; if the regular `.dx` is missing we use the snapshot
  even though it may be a *complete* late snapshot — this is strictly better
  than dropping the measurement.
- Recovery cannot fabricate results: measurements with no `.rx` anywhere appear
  as traces only (logged as today).

## Migration Plan

None needed — additive option, default preserves data completeness; legacy mode
one checkbox away.

## Open Questions

None.

## Decision: repaired download is always .olax (zip -> olax conversion)

An .olax holds exactly ONE result set, so a CM .zip with N `.rslt` folders
yields N `.olax` files (single group -> `<stem>.repaired.olax`; multi group ->
`<resultset>.olax`, wrapped into one zip when more than one download). Folder
paths are re-encoded to OPC part names (`/` -> `%5c`); OPC inputs keep their
original encoded part names verbatim.

## Decision: checksum / package-consistency policy

- zip CRC32: recomputed per written entry by `zipStore`; inner .dx/.rx zips
  are carried byte-exact. Verified with Python `zipfile.testzip()` on the
  repaired real-world archives.
- `_rels/.rels` references EVERY part including snapshots -> rewritten (drop
  removed, rename promoted; synthesized for bare CM zips). `.rels` carries no
  checksum, so this is safe.
- `[Content_Types].xml` is extension-based -> renames cannot invalidate it;
  carried over verbatim or synthesized.
- `.acaml`/`.mfx`: byte-identical. Their MD5 `<Checksum>` preimage is an
  unknown canonicalization (dual-sample experiment found no match), so edits
  risk OpenLab rejecting the manifest. Consequence: RAD-style manifest
  `<Path>`s that name `snapshot-…-r005.dx` dangle after repair — accepted,
  because the tool's parser never reads the manifest and data extraction is
  name-driven.
