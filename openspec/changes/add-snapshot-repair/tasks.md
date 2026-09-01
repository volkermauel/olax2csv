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
- [x] 15. Repaired download ALWAYS emits .olax (one per result set; CM .zip
       folder paths re-encoded `/` -> `%5c`; OPC inputs keep part names
       verbatim; multi-output wrapped into one zip).
- [x] 16. Package consistency: `_rels/.rels` rewritten to match shipped parts
       exactly (dropped targets removed, promoted renamed, synthesized for CM
       zips); `[Content_Types].xml` carried over or synthesized; zip CRC32
       recomputed.
- [x] 18. ACAML checksum: derived the MD5 `<Checksum>` algorithm (canonical
       re-serialization of `<Doc>`) and replicated it in the app; validated
       against two real-world manifests and one synthetic reference vector,
       plus Agilent's own calculator on a repaired archive.
- [x] 19. Manifest repair: `.acaml`/`.mfx` snapshot `<Path>` refs retargeted
       to regular names with the checksum recomputed; non-MD5 manifests left
       byte-identical; `appVersion="SNAPSHOT-…"` build metadata untouched.
- [x] 17. Verified on real data: RAD `.rslt.zip` -> 35.6 MB
       `.repaired.olax` (7 injections, re-parse with repair OFF, all CRCs OK,
       0 dangling rels targets); berlin `.olax` -> identical results (10
       injections / 72 peaks), 3 snapshot rels removed. After task 19: RAD
       acaml fully retargeted (0 snapshot `<Path>`s) with the recomputed
       checksum validated by Agilent's own calculator.
- [x] 20. Manifest commit: `.dx` files shipped but never registered by an
       unclosed snapshot session are committed into the `.acaml` manifest —
       `<InjectionMetaData>`, `Injections/MeasData` (Signal rows derived from
       the dx's own `injection.acmd` TraceId/DeviceName/ChannelName metadata,
       only for trace files actually present in the dx) and the sample
       `InjectionMeasData_ID` link, templated on the last committed sibling
       of the same sample (SampleName from acmd). No `ExternalResultPath`:
       the injection is honestly 'acquired, not yet processed' until
       reprocessed in OpenLab.
- [x] 21. Package consistency for committed injections: ACAML MD5 `<Checksum>`
       recomputed over the canonical `<Doc>`; `.mfx` `<File>` entries added
       for newly registered `.dx` parts with `IdentifierAlgorithm="MD5"`
       hex digests of the shipped bytes; the acaml's own entry updated to
       the repaired digest.
- [x] 22. Fixture `buildCommitOlax` (3 runs, r001 committed, r002/r003
       acquired-only) + 3 tests: commit correctness (GUID reused across all
       three record types, acq time UTC-ms conversion, replicate/order
       numbers, trace GUID wiring, checksum self-consistency, mfx digests),
       healthy no-op (all committed -> unchanged manifest), and uncommitted
       detection. 57/57 green.
- [x] 23. Real-file proof on the RAD archive: repaired `.olax` lists 22
       injections (7 committed + 15 recovered) with 0 snapshot refs; verified
       with Agilent's own `MD5ChecksumCalculatorV1` (checksum VALID) and the
       Agilent ACAML object model (22 MeasData rows, 22 InjectionMetaData
       items deserialize cleanly); our own parser still reports 22/22
       measurements on the repaired archive.
- [x] 24. Fileset exactness: the `.mfx` `<File>` list is rebuilt against the
       parts actually shipped — identifiers are the MD5 of the bytes written
       (repaired `.acaml` included), snapshot entries whose completed run
       ships are removed instead of retargeted onto the regular name (which
       had left a second, stale-identifier entry — the "invalid or missing
       checksum" import error), promoted snapshots are renamed to their
       regular name, and missing entries appended. A fileset already
       matching the shipped bytes stays byte-identical. Locked by two new
       fixture tests (drop+promote, no-op); RAD re-audit: 34 entries,
       0 mismatches, 0 duplicates; Agilent checksum calculator VALID on the
       rebuilt archive. 60/60 green.
- [x] 25. End-to-end regression guard for the re-import failure report: the
       repaired archive was rebuilt in a REAL Chromium (deployed Pages
       artifact) and re-audited — 22 InjectionMetaData rows, acaml checksum
       valid per Agilent's own `AcamlChecksum.VerifyStream`, fileset 34
       entries / 0 mismatches / 0 duplicates, every entry shaped like a
       native `<File>` (appVersion property present), and our own parser
       re-lists all 22 measurements from the repaired bytes. Three new
       tests lock the invariants down: fileset mirrors the shipped parts
       exactly (bidirectional, one entry per data part, MD5 per entry,
       appVersion property on every entry), repaired archive re-parsed by
       the app lists every committed measurement (the 7-vs-22 regression),
       and non-manifest parts ship byte-identically. 63/63 green.
- [x] 26. Native archive parity: repaired packages now synthesize the OPC
       core-properties part (`package/services/metadata/core-properties/
       <md5>.psmdcp`, category "Agilent OpenLab Archive File", title from
       the result set, creator/created from the manifest DocInfo) plus the
       trailing core-properties relationship and the psmdcp content-type
       default — the one structural delta left against native .olax
       exports. Verified with native `System.IO.Packaging.Package.Open`:
       Title/Category/Creator/Created read exactly like a native archive.
- [x] 27. Import-bisection variants (temporary, `?variant=` on the page,
       filename-tagged): `nocommit` (everything but manifest rows),
       `origacaml` (manifest byte-identical), `freshid` (full repair with
       a freshly minted `<DocID>`, checksum recomputed over the new
       identity). Agilent `AcamlChecksum.VerifyStream = True` on all four
       artifacts built from the real RAD input; `System.IO.Packaging`
       opens all four; fileset identifiers track the shipped bytes in
       every variant. 67/67 green.
- [x] 28. Repaired result sets carry their own name (import never
       collides with the original): `.rslt` folder gets a `-repaired`
       suffix in every part name and relationship target, the manifest's
       `<Description>` and the psmdcp `dc:title` state the repaired name
       (checksum/fileset identifiers track it), and folder-less OPC inputs
       keep their names verbatim. Verified with Agilent
       `AcamlChecksum.VerifyString` + `System.IO.Packaging` on all four
       RAD artifacts; 69/69 green.
- [x] 29. Fixed the CSV-zip export crash on repaired archives
       ("start offset of Float64Array should be a multiple of 8"):
       stored (uncompressed) entries are zero-copy subarray views at
       arbitrary offsets, so the float64 trace access now aligns the view
       once (`align8`/`f64Of`) instead of crashing; regression test drives
       both the all-zero and gaussian paths through deliberately unaligned
       views.
