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
- [x] 10. Container-level repair plan (`computeContainerRepairPlan`): promote
       snapshot files whose counterpart is missing, drop partial duplicates —
       computed from entry names on the main thread (works for the worker path).
- [x] 11. "Download repaired container(s)" button: rebuilds the container
       (entry order/names preserved, re-stored zip) and downloads
       `<stem>.repaired.olax|.zip` (wrapped into one zip when multiple).
- [x] 12. `store.containers` records per input file: plan + File ref for
       re-reading at download time (never sent to workers).
- [x] 13. Synthetic tests extended to 13: plan unit tests (flat / OPC `%5c` /
       CM `/`, `+`/space ts forms, mixed promote+drop), repaired-container
       round-trips re-parsed with repair OFF (proves native completeness),
       grouped CM `.rslt` round-trip. 48/48 green.
- [x] 14. Real-file proof: RAD zip repairs to 7 injections (r005.rx promoted,
       3 partial snapshots dropped); Berlin `.olax` unchanged (10/10/72).
