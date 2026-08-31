# Tasks — add-snapshot-repair

- [x] 1. Research: verify snapshot naming, partiality, and manifest behaviour
       against `20260828_liniowosc_detektora_RAD.rslt.zip` and
       `10072026-berlin-fps.olax`.
- [x] 2. `processResultSet(view, meta, opts)`: counterpart-rule enumeration +
       chronological slotting (repair mode); legacy filter when disabled.
- [x] 3. `parseMeasurementResults`: fall back to `snapshot-<ts>-<name>.rx`.
- [x] 4. `detectGroupMeta`: snapshot `.amx` fallback for classification.
- [x] 5. Thread `opts` through `parseContainer` / `parseOlax` /
       `parseContainerParallel` / `buildWorkerMessage` / worker dispatcher.
- [x] 6. UI checkbox `#repairChk` (pre-checked) wired into the Parse handler.
- [x] 7. Fixtures: `snapshot: none|only|duplicate|rxOnly` in `build-olax.mjs`.
- [x] 8. Tests: `test/snapshot-repair.test.mjs` (recovery on/off, duplicate
       skip, rx fallback, ordering, worker option threading).
- [x] 9. Full suite green (`node --test`, 41/41) and real-file verification:
       RAD zip 6→7 injection rows with repair, Berlin `.olax` unchanged.
