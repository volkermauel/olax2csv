// Tests for Content-Manager (.zip of .rslt folders) support + GC/HPLC split.
// Runs against the SHIPPED index.html via the VM harness, on PII-free synthetic
// fixtures built at test time by test/fixtures/build-results-zip.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadApp, blobToU8 } from './harness.mjs';
import { makeZip } from './fixtures/build-olax.mjs';
import { buildResultsZip, buildOlaxOpc, buildNoRxZip, amxZip } from './fixtures/build-results-zip.mjs';

const XLSX = loadApp().XLSX; // XLSX is stable on the context
let app;
const reset = () => { app.store.files.length = 0; app.captured = null; };

test.beforeEach(() => { app = loadApp(); });

/* ---------------- grouping ---------------- */

test('CM zip: discovers both .rslt groups incl. a deeply-nested one', async () => {
  const { buffer } = buildResultsZip();
  await app.parseContainer(buffer, '2025-export.zip');
  assert.equal(app.store.files.length, 2);
  const folders = app.store.files.map((f) => f.name);
  assert.ok(folders.some((n) => n.includes('HPLC-01')), 'HPLC group present');
  assert.ok(folders.some((n) => n.includes('GC-02')), 'GC group present');
});

/* ---------------- instrument detection ---------------- */

test('unit: classifyAmx reads DeviceMethodSettings driver names', () => {
  assert.equal(app.classifyAmx(amxZip('HPLC')), 'HPLC');
  assert.equal(app.classifyAmx(amxZip('GC')), 'GC');
});

test('instrument detection via .amx: HPLC and GC classified correctly', async () => {
  const { buffer } = buildResultsZip();
  await app.parseContainer(buffer, '2025-export.zip');
  const byType = {};
  for (const f of app.store.files) byType[f.instrumentType] = (byType[f.instrumentType] || 0) + 1;
  assert.equal(byType.HPLC, 1);
  assert.equal(byType.GC, 1);
});

test('every result row carries Instrument / Instrument type / Result set', async () => {
  const { buffer } = buildResultsZip();
  await app.parseContainer(buffer, '2025-export.zip');
  const res = app.allResults();
  assert.ok(res.peaks.length >= 2);
  const pti = app.PEAK_HEADER.indexOf('Instrument type');
  const ili = app.PEAK_HEADER.indexOf('Instrument');
  const rsi = app.PEAK_HEADER.indexOf('Result set');
  for (const r of res.peaks) {
    assert.ok(['HPLC', 'GC'].includes(r[pti]), `peak type tagged: ${r[pti]}`);
    assert.ok(r[ili], 'instrument label set');
    assert.ok(r[rsi], 'result set label set');
  }
});

test('sample name comes from .dx <SampleName> (CM .dx is timestamp-only)', async () => {
  const { buffer } = buildResultsZip();
  await app.parseContainer(buffer, '2025-export.zip');
  const samples = app.allTraces().map((t) => t.sample).sort();
  assert.equal(samples.join(','), 'Blank,Std-A');
});

/* ---------------- xlsx per-instrument split ---------------- */

test('xlsx: per-instrument sheets when both GC and HPLC present', async () => {
  const { buffer } = buildResultsZip();
  await app.parseContainer(buffer, '2025-export.zip');
  app.downloadExcel();
  assert.ok(app.captured, 'xlsx produced');
  assert.match(app.captured.name, /results_by_instrument\.xlsx$/);
  const wb = XLSX.read(blobToU8(app.captured.blob), { type: 'array' });
  for (const base of ['Peaks', 'Compounds', 'Injections']) {
    assert.ok(wb.SheetNames.includes(`${base} (HPLC)`), `${base} (HPLC)`);
    assert.ok(wb.SheetNames.includes(`${base} (GC)`), `${base} (GC)`);
  }
  const hplcPeaks = XLSX.utils.sheet_to_json(wb.Sheets['Peaks (HPLC)']);
  assert.ok(hplcPeaks.length >= 1);
  assert.ok(hplcPeaks.every((r) => r['Instrument type'] === 'HPLC'));
});

test('xlsx: single instrument type -> plain sheet names, _results.xlsx', async () => {
  const { buffer } = buildOlaxOpc();
  await app.parseContainer(buffer, 'single.olax');
  app.downloadExcel();
  assert.match(app.captured.name, /_results\.xlsx$/);
  const wb = XLSX.read(blobToU8(app.captured.blob), { type: 'array' });
  assert.deepEqual(wb.SheetNames, ['Injections', 'Peaks', 'Compounds', 'Calibration']);
});

/* ---------------- OPC path + graceful handling ---------------- */

test('OPC "%5c" single-.olax still parses via the same grouper', async () => {
  const { buffer, expected } = buildOlaxOpc();
  await app.parseContainer(buffer, 'single.olax');
  assert.equal(app.store.files.length, expected.groups);
  assert.equal(app.store.files[0].instrumentType, expected.type);
  assert.equal(app.store.files[0].instrument, expected.instrument);
});

test('graceful: .rslt with .dx but no .rx -> traces only, no peaks', async () => {
  const { buffer } = buildNoRxZip();
  await app.parseContainer(buffer, 'noRx.zip');
  assert.ok(app.allTraces().length >= 1, 'traces extracted');
  assert.equal(app.allResults().peaks.length, 0, 'no peaks');
});

test('error: a zip with neither .rslt nor .dx throws', async () => {
  const empty = makeZip([{ name: 'readme.txt', data: new TextEncoder().encode('hi') }]);
  await assert.rejects(() => app.parseContainer(empty, 'empty.zip'), /No \.rslt folders and no \.dx/);
});
