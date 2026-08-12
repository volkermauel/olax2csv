import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { loadApp, blobToU8, XLSX } from './harness.mjs';
import { buildOlax } from './fixtures/build-olax.mjs';

let app;
let fx; // synthetic .olax WITH processed results (.rx)
let fxNoRx; // synthetic .olax WITHOUT .rx

before(() => {
  app = loadApp();
  fx = buildOlax({ withRx: true });
  fxNoRx = buildOlax({ withRx: false });
});

function reset() {
  app.store.files.length = 0; // mutate in place: the app closure holds this object
  app.activeTab = 'traces';
  app.captured = null;
}

function col(header, name) {
  const i = header.indexOf(name);
  if (i < 0) throw new Error(`column not found: ${name}`);
  return i;
}

/* ---------------- raw trace (CSV) extraction ---------------- */

test('raw traces: extracts both signals with correct sample name', async () => {
  reset();
  await app.parseOlax(fx.buffer, 'synthetic.olax');
  const traces = app.allTraces();
  assert.equal(traces.length, 2);
  assert.equal(traces[0].sample, 'Test');
  assert.equal(traces.map((t) => t.channel).sort().join(','), 'SIM1A,SIM1Z');
  assert.equal(traces[0].device, 'SIMDEV');
});

test('raw trace: gaussian CSV values match the source array (bestFloatSegment path)', async () => {
  reset();
  await app.parseOlax(fx.buffer, 'synthetic.olax');
  const g = app.allTraces().find((t) => t.channel === 'SIM1A');
  await app.buildCSVForTrace(g);
  assert.equal(g.extractedOffset, 0, 'float64 segment found at offset 0');

  const lines = g.csvText.trim().split('\n');
  assert.equal(lines[0], 'time_ms,time_s,time_min,SIM1A_mAU');
  assert.equal(lines.length - 1, fx.expected.N1);

  const dt = fx.expected.dt1;
  for (const idx of [0, 1, 250, 500, 750, fx.expected.N1 - 1]) {
    const cells = lines[idx + 1].split(',');
    assert.equal(Number(cells[0]), fx.expected.tStart1 + idx * dt, `time_ms @${idx}`);
    assert.ok(
      Math.abs(Number(cells[3]) - fx.expected.gaussian[idx]) < 1e-9,
      `value @${idx}: ${Number(cells[3])} vs ${fx.expected.gaussian[idx]}`,
    );
  }
});

test('raw trace: all-zero trace handled via findAllZeroSegment fallback', async () => {
  reset();
  await app.parseOlax(fx.buffer, 'synthetic.olax');
  const z = app.allTraces().find((t) => t.channel === 'SIM1Z');
  await app.buildCSVForTrace(z);
  const lines = z.csvText.trim().split('\n');
  assert.equal(lines.length - 1, fx.expected.N2);
  for (let i = 1; i <= Math.min(5, fx.expected.N2); i++) {
    assert.equal(Number(lines[i].split(',')[3]), 0, `zero @row ${i}`);
  }
});

/* ---------------- processed results (.rx) extraction ---------------- */

test('results: peak row with resolved signal name and known values', async () => {
  reset();
  await app.parseOlax(fx.buffer, 'synthetic.olax');
  const res = app.allResults();
  assert.equal(res.peaks.length, 1);

  const h = app.PEAK_HEADER;
  const p = res.peaks[0];
  assert.equal(p[col(h, 'Sample')], 'Test');
  assert.equal(p[col(h, 'Signal')], fx.expected.signalName); // signal GUID resolved via .acaml registry
  assert.equal(p[col(h, 'Peak type')], fx.expected.peak.type);
  assert.equal(p[col(h, 'Retention time (min)')], fx.expected.peak.rt);
  assert.equal(p[col(h, 'Start time (min)')], fx.expected.peak.begin);
  assert.equal(p[col(h, 'End time (min)')], fx.expected.peak.end);
  assert.equal(p[col(h, 'Area')], fx.expected.peak.area);
  assert.equal(p[col(h, 'Area unit')], fx.expected.peak.areaUnit);
  assert.equal(p[col(h, 'Signal/noise')], fx.expected.peak.sn);
});

test('results: compound row with amount and ExpectedSignal', async () => {
  reset();
  await app.parseOlax(fx.buffer, 'synthetic.olax');
  const h = app.COMPOUND_HEADER;
  const c = app.allResults().compounds[0];
  assert.equal(c[col(h, 'Compound')], fx.expected.compound.name);
  assert.equal(c[col(h, 'Type')], fx.expected.compound.type);
  assert.equal(c[col(h, 'Qualified')], 'yes');
  assert.equal(c[col(h, 'Amount')], fx.expected.compound.amount);
  assert.equal(c[col(h, 'Amount unit')], fx.expected.compound.amountUnit);
  assert.equal(c[col(h, 'Expected signal')], fx.expected.compound.expSignal);
  assert.equal(c[col(h, 'Expected RT (min)')], fx.expected.compound.expRT);
  assert.equal(c[col(h, 'Area')], fx.expected.compound.area);
});

test('results: calibration curve joined to compound via InjectionCompound', async () => {
  reset();
  await app.parseOlax(fx.buffer, 'synthetic.olax');
  const cl = app.allResults().calibration;
  assert.equal(cl.length, 1);
  const h = app.CALIB_HEADER;
  assert.equal(cl[0][col(h, 'Compound')], fx.expected.calibration.compound);
  assert.equal(cl[0][col(h, 'Curve type')], fx.expected.calibration.type);
  assert.equal(cl[0][col(h, 'Corr. coeff')], fx.expected.calibration.r);
  assert.equal(cl[0][col(h, 'Coeff A')], fx.expected.calibration.a);
  assert.equal(cl[0][col(h, 'Coeff B')], fx.expected.calibration.b);
  assert.equal(cl[0][col(h, 'Level')], fx.expected.calibration.level);
  assert.equal(cl[0][col(h, 'Amount')], fx.expected.calibration.levelAmount);
});

test('results: injection summary row (user, order, standards, counts)', async () => {
  reset();
  await app.parseOlax(fx.buffer, 'synthetic.olax');
  const h = app.INJ_HEADER;
  const ij = app.allResults().injections[0];
  assert.equal(ij[col(h, 'Sample')], 'Test');
  assert.equal(ij[col(h, 'Processed by')], 'TEST_USER');
  assert.equal(ij[col(h, 'Order no')], 42);
  assert.equal(ij[col(h, 'Sample bracketing')], 'None');
  assert.equal(ij[col(h, '# standards')], 2);
  assert.equal(ij[col(h, '# peaks')], 1);
  assert.equal(ij[col(h, '# compounds')], 1);
});

/* ---------------- XLSX export ---------------- */

test('xlsx: workbook has the 4 sheets with the expected cells', async () => {
  reset();
  await app.parseOlax(fx.buffer, 'synthetic.olax');
  app.downloadExcel();
  assert.ok(app.captured, 'xlsx was produced');
  assert.match(app.captured.name, /_results\.xlsx$/);

  const wb = XLSX.read(blobToU8(app.captured.blob), { type: 'array' });
  assert.deepEqual(wb.SheetNames, ['Injections', 'Peaks', 'Compounds', 'Calibration']);

  const peaks = XLSX.utils.sheet_to_json(wb.Sheets['Peaks']);
  assert.equal(peaks.length, 1);
  assert.equal(peaks[0].Signal, fx.expected.signalName);
  assert.equal(peaks[0]['Retention time (min)'], fx.expected.peak.rt);
  assert.equal(peaks[0].Area, fx.expected.peak.area);

  const compounds = XLSX.utils.sheet_to_json(wb.Sheets['Compounds']);
  assert.equal(compounds[0].Compound, fx.expected.compound.name);
  assert.equal(compounds[0].Amount, fx.expected.compound.amount);

  const calib = XLSX.utils.sheet_to_json(wb.Sheets['Calibration']);
  assert.equal(calib[0]['Corr. coeff'], fx.expected.calibration.r);
});

/* ---------------- multi-file aggregation ---------------- */

test('multi-file: results and traces aggregate across files', async () => {
  reset();
  await app.parseOlax(fx.buffer, 'file-A.olax');
  await app.parseOlax(fx.buffer, 'file-B.olax');
  assert.equal(app.store.files.length, 2);
  assert.equal(app.allTraces().length, 4);
  assert.equal(app.allResults().peaks.length, 2);
  assert.equal(app.allResults().compounds.length, 2);
  assert.equal(app.allResults().calibration.length, 2);
  assert.equal(app.allResults().injections.length, 2);

  app.downloadExcel();
  const wb = XLSX.read(blobToU8(app.captured.blob), { type: 'array' });
  assert.equal(XLSX.utils.sheet_to_json(wb.Sheets['Peaks']).length, 2);
});

/* ---------------- graceful handling ---------------- */

test('no-rx file: traces still extracted, results empty', async () => {
  reset();
  await app.parseOlax(fxNoRx.buffer, 'no-rx.olax');
  assert.equal(app.allTraces().length, 2);
  const res = app.allResults();
  assert.equal(res.peaks.length, 0);
  assert.equal(res.compounds.length, 0);
  assert.equal(res.calibration.length, 0);
  assert.equal(res.injections.length, 0);
});

test('xlsx button stays disabled when there are no results', async () => {
  reset();
  await app.parseOlax(fxNoRx.buffer, 'no-rx.olax');
  app.captured = null;
  app.downloadExcel();
  assert.equal(app.captured, null, 'no xlsx should be produced');
});

/* ---------------- CSV ZIP export (STORE zip round-trip) ---------------- */

test('csv zip export: store-zip round-trips through parseZip/readZipFile', async () => {
  reset();
  await app.parseOlax(fx.buffer, 'synthetic.olax');
  await app.downloadSelectedZip();
  assert.ok(app.captured, 'zip was produced');
  assert.match(app.captured.name, /_traces\.zip$/);

  const u8 = blobToU8(app.captured.blob);
  assert.equal(u8[0], 0x50, 'zip magic');

  const zip = app.parseZip(u8);
  const csvNames = [...zip.files.keys()].filter((n) => n.endsWith('.csv'));
  assert.equal(csvNames.length, 2);

  // read one CSV back (STORE -> method 0) and verify content
  const name = csvNames.find((n) => n.includes('SIM1A'));
  const bytes = await app.readZipFile(zip, name);
  const text = new TextDecoder().decode(bytes);
  const lines = text.trim().split('\n');
  assert.equal(lines[0], 'time_ms,time_s,time_min,SIM1A_mAU');
  assert.equal(lines.length - 1, fx.expected.N1);
  // value column round-trips through the STORE zip intact
  assert.ok(
    Math.abs(Number(lines[501].split(',')[3]) - fx.expected.gaussian[500]) < 1e-9,
    'value preserved after store-zip round-trip',
  );
});
