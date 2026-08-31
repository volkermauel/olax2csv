# OpenSpec project context — olax2csv

## Purpose

Single-file offline HTML tool that converts Agilent OpenLab CDS exports
(`.olax` OPC packages and Content-Manager `.zip` exports containing `.rslt`
result-set folders) into CSV traces and XLSX result tables.

## Tech constraints

- Everything ships inside `index.html` (no build step, runs offline in a browser;
  SheetJS and @xmldom/xmldom are embedded).
- Parsing runs on the main thread and, for ≥8 result sets, in a Web Worker pool
  built from the same function sources via `.toString()`.
- Tests: `node --test` against the shipped `index.html` through `test/harness.mjs`
  (VM + shims). Synthetic containers come from `test/fixtures/`.

## Domain model

- One `.rslt` folder = one result set. Each measurement is a `<name>.dx`
  (raw trace package: `injection.acmd` + `<traceId>.CH`) plus an optional
  `<name>.rx` (processed results package: `Base/InjectionACAML`).
- The root `.acaml` is the result-set manifest (signal registry + indexed
  injections via `DataFileReference`).
- "Snapshot" mode: while acquiring, OpenLab writes partial copies named
  `snapshot-<ts>-<original name>.dx/.rx`. If the session is closed properly the
  completed run replaces them; if left unclosed, measurements can exist *only*
  as snapshot files and/or lack their regular `.rx`.
