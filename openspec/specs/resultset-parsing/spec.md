# `resultset-parsing`

## Requirements

### RS-1: Result-set discovery

The tool SHALL discover every `.rslt` folder inside an `.olax` (OPC, `%5c`
separator) or Content-Manager `.zip` container and treat each as one result
set; a flat zip of `.dx` files is treated as a single result set.

### RS-2: Measurement enumeration

The tool SHALL enumerate one measurement per `.dx` file in the result set.
Files whose name starts with `snapshot-<ts>-` are PARTIAL captures and SHALL be
ignored whenever the completed counterpart run (same name without the
`snapshot-<ts>-` prefix) is present.

### RS-3: Snapshot repair (default ON)

When a snapshot session was left unclosed, the tool SHALL silently recover
acquired measurements:

- RS-3.1: a `snapshot-<ts>-<name>.dx` whose counterpart `<name>.dx` is absent
  SHALL be parsed as that measurement (traces + results);
- RS-3.2: for a measurement whose regular `<name>.rx` is absent, a matching
  `snapshot-<ts>-<name>.rx` SHALL be used for the processed results;
- RS-3.3: recovered measurements SHALL be placed in acquisition order using
  the time stamp embedded in the file name (stable zip order as fallback);
- RS-3.4: repair MUST NOT alter output schemas — recovered rows/files are
  indistinguishable from native ones (user decision: "silent repair");
- RS-3.5: the repair option MUST be user-toggleable (checkbox, pre-checked);
  disabled restores strict legacy filtering (skip any name containing
  `snapshot-`);
- RS-3.6: classification (`detectGroupMeta`) MAY fall back to a snapshot `.amx`
  when no regular method file exists;
- RS-3.7: the option SHALL reach the Web Worker path via the worker message;
- RS-3.8: the tool SHALL offer downloading repaired archives as .olax — one
  per result set, also when the input was a Content-Manager .zip: snapshot
  files whose counterpart is missing are renamed to their regular names,
  partial snapshot duplicates are removed, all other entries are kept
  byte-identical; a .zip result-set folder `X.rslt/a.dx` is re-encoded as the
  OPC part `X.rslt%5ca.dx`. The repaired archive MUST parse natively with
  repair disabled (the repair is baked in, not re-applied on read).
- RS-3.9: the repaired .olax SHALL keep its OPC package consistent:
  `_rels/.rels` is rewritten to reference exactly the shipped parts (dropped
  targets removed, promoted targets renamed) and `[Content_Types].xml` is
  carried over verbatim or synthesized; zip CRC32 is recomputed for every
  written entry. In the `.acaml`/`.mfx` manifests, `<Path>` references to
  snapshot files SHALL be retargeted to the regular file names (promoted and
  dropped snapshots alike — the regular counterpart ships either way) and the
  `.acaml` MD5 `<Checksum>` SHALL be recomputed over the canonical
  re-serialization of the edited `<Doc>` subtree. When the stored checksum
  algorithm is not MD5, the manifest SHALL be left byte-identical.
- RS-3.10: the repaired .olax SHALL commit acquired-but-uncommitted
  injections into the `.acaml` manifest: a `.dx` part shipped in the
  package but referenced by no `InjectionMetaData` entry is given an
  `<InjectionMetaData>` record, an `Injections/MeasData` row (Signal rows
  derived from the dx's own `injection.acmd` trace metadata, restricted to
  trace files actually present in the dx) and the sample-row
  `InjectionMeasData_ID` link, using the last committed injection of the
  same sample as the template for method/container references. Facts come
  from the dx itself (acquisition time, sample name, replicate number);
  times are converted to the UTC millisecond form. No `ExternalResultPath`
  is written — the injection keeps its honest 'acquired, not yet
  processed' state until reprocessed in OpenLab. The MD5 checksum is
  recomputed, and the `.mfx` fileset gains `<File>` entries (MD5 hex
  digest of the shipped bytes) for every newly registered part, with the
  `.acaml` entry updated to the repaired digest. When all injections are
  already committed the manifest SHALL be byte-identical.

### RS-4: Results extraction

For every measurement with (regular or repaired) `.rx`, the tool SHALL extract
peak, compound, calibration and injection-summary rows, joined with the signal
registry from the root `.acaml`.
