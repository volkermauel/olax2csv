// Regression: .CH float64 extraction must work at ANY byte alignment.
//
// Real-world failure (2026-08): zip entries are zero-copy subarray views at
// arbitrary byteOffsets, and the scan used to probe only offsets 8-aligned to
// the view's backing buffer — one residue class mod 8. When the data start
// fell outside it, bestFloatSegment found nothing and buildCSVForTrace fell
// back to offset 0, shipping .CH header bytes as data: negative "counts" and
// 1e+300 garbage. These tests pin the fixed behavior:
//   - scanners find data behind a header at a misaligned view offset,
//   - a full container with STORED (uncompressed) entries at odd offsets
//     extracts the exact window (extractedOffset === header + dataStart),
//   - emitted CSV values match the .acmd min/max and are never negative for
//     an all-positive trace.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadApp } from './harness.mjs';
import { makeZip, enc, acmdInjection, acamlRegistry, TRACE1, TRACE2 } from './fixtures/build-olax.mjs';

/* ---------- helpers ---------- */

const LFH = 30; // zip local file header fixed part (no extra field)

// Nonzero junk that decodes to garbage (incl. negative denormals) if misread
// as float64 — like a real .CH header.
function junkHeader(len) {
  const h = new Uint8Array(len);
  for (let i = 0; i < len; i++) h[i] = (i % 2 === 0 ? 0x80 : (i % 251) + 1);
  return h;
}

function concat(...parts) {
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

function f64Bytes(arr) {
  const out = new Uint8Array(arr.length * 8);
  new Float64Array(out.buffer).set(arr);
  return out;
}

function csvValues(csvText) {
  return csvText.split('\n')
    .filter((l) => l && !l.startsWith('time_ms'))
    .map((l) => parseFloat(l.split(',')[3]));
}

/* ---------- unit: scanners on a misaligned view ---------- */

test('unit: bestFloatSegment finds data at a misaligned view offset', () => {
  const app = loadApp();
  const n = 300;
  const data = new Float64Array(n);
  for (let i = 0; i < n; i++) data[i] = 5 + 395 * Math.exp(-((i - 150) ** 2) / (2 * 40 * 40));
  let mn = Infinity, mx = -Infinity;
  for (const v of data) { if (v < mn) mn = v; if (v > mx) mx = v; }

  const header = junkHeader(90);
  const buf = concat(header, f64Bytes(data));
  const shift = 3; // view starts 3 bytes into the buffer: byteOffset % 8 !== 0
  const view = buf.subarray(shift);

  const seg = app.bestFloatSegment(view, n, 1, mn, mx);
  assert.ok(seg, 'segment found');
  assert.equal(seg.off, header.length - shift, 'window starts at the data, not the header');
  assert.equal(seg.arr[0], data[0]);
  assert.equal(seg.arr[n - 1], data[n - 1]);
});

test('unit: findAllZeroSegment finds a zero run at a misaligned view offset', () => {
  const app = loadApp();
  const n = 120;
  const header = junkHeader(66);
  const zeros = new Uint8Array(n * 8);
  const buf = concat(header, zeros);
  const shift = 5;
  const view = buf.subarray(shift);

  const seg = app.findAllZeroSegment(view, n);
  assert.ok(seg, 'zero segment found');
  assert.equal(seg.off, header.length - shift);
  assert.equal(seg.arr.length, n);
  assert.ok(seg.arr.every((v) => v === 0));
});

/* ---------- integration: container with STORED entries at odd offsets ---------- */

test('stored-entry container: traces extract exactly; counts never negative', async () => {
  const app = loadApp();

  // Trace 1: all-positive "detector counts" (min ≈ 20, max ≈ 5020)
  const N1 = 900, tEnd1 = 540000;
  const counts = new Float64Array(N1);
  for (let i = 0; i < N1; i++) {
    const t = (i / N1) * tEnd1;
    counts[i] = Math.round(20 + 5000 * Math.exp(-((t - 270000) ** 2) / (2 * 60000 * 60000)));
  }
  let min1 = Infinity, max1 = -Infinity;
  for (const v of counts) { if (v < min1) min1 = v; if (v > max1) max1 = v; }

  // Trace 2: all zeros
  const N2 = 400, tEnd2 = 240000;

  const H1 = 82, H2 = 90; // junk header lengths, both ≢ 0 mod 8 relative to data
  const ch1 = concat(junkHeader(H1), f64Bytes(counts));
  const ch2 = concat(junkHeader(H2), f64Bytes(new Float64Array(N2)));

  const acmdBytes = enc(acmdInjection(N1, min1, max1, tEnd1, N2, tEnd2, 'Align'));
  const ch1Name = `${TRACE1}.CH`, ch2Name = `${TRACE2}.CH`;

  // .dx inner zip, every entry STORED — layout arithmetic is fully deterministic
  const dxEntries = [
    { name: 'injection.acmd', data: acmdBytes, method: 0 },
    { name: ch1Name, data: ch1, method: 0 },
    { name: ch2Name, data: ch2, method: 0 },
    { name: '[Content_Types].xml', data: enc('<Types/>'), method: 0 },
  ];
  const dxZip = makeZip(dxEntries);

  // dataStart of each stored entry: previous entry start + LFH + name + data
  const acmdStart = LFH + 'injection.acmd'.length;
  const ch1Start = acmdStart + acmdBytes.length + LFH + ch1Name.length;

  // Outer .olax: the .dx itself STORED too (Content-Manager export shape) —
  // the .dx is then a subarray view at an arbitrary byteOffset.
  const olax = makeZip([
    { name: 'Run_Test.dx', data: dxZip, method: 0 },
    { name: 'Run.acaml', data: enc(acamlRegistry()) },
  ]);
// Fixture sanity: the .CH data really must sit at a byte position that is
  // NOT 8-aligned in the .dx (outer dx dataStart 30+12, then ch1Start) —
  // otherwise this would regress to testing the easy aligned case.
  const dxDataStart = LFH + 'Run_Test.dx'.length;
  assert.notEqual((dxDataStart + ch1Start + H1) % 8, 0, 'CH data is misaligned in the fixture');
  await app.parseContainer(olax, 'align.olax');
  assert.equal(app.store.files.length, 1, 'one result-set group');

  const byId = Object.fromEntries(app.allTraces().map((t) => [t.traceId, t]));
  assert.ok(byId[TRACE1] && byId[TRACE2], 'both traces parsed');

  // --- trace 1: counts ---
  const t1 = byId[TRACE1];
  await app.buildCSVForTrace(t1);
  assert.equal(t1.extractedOffset, H1, 'extracted the exact data window (header skipped)');
  const vals = csvValues(t1.csvText);
  assert.equal(vals.length, N1);
  const vMin = Math.min(...vals), vMax = Math.max(...vals);
  assert.ok(vMin >= 0, `no negative counts (min was ${vMin})`);
  assert.ok(Math.abs(vMin - min1) < 1e-6, `csv min ${vMin} ≈ acmd min ${min1}`);
  assert.ok(Math.abs(vMax - max1) < 1e-6, `csv max ${vMax} ≈ acmd max ${max1}`);

  // --- trace 2: zeros ---
  const t2 = byId[TRACE2];
  await app.buildCSVForTrace(t2);
  assert.equal(t2.extractedOffset, H2, 'zero window starts at the data (header skipped)');
  const zvals = csvValues(t2.csvText);
  assert.equal(zvals.length, N2);
  assert.ok(zvals.every((v) => v === 0), 'all zeros');
});

/* ---------- unit: Signal179 header-anchored extraction ---------- */

// ChemStation-legacy .CH layout: tag + BE anchors + LE float64 values at
// 6136 (+ 8 tail bytes). OpenLab-native variant: values at 6144, no tail.
function signal179CH(values, slope, timeStart, timeEnd, minSignal, maxSignal, dataOff = 6136, tailBytes = 8) {
  const n = values.length;
  const buf = new Uint8Array(dataOff + n * 8 + tailBytes);
  const dv = new DataView(buf.buffer);
  buf[0] = 0x03;
  buf.set(enc('179'), 1);
  dv.setFloat32(282, timeStart, false);
  dv.setFloat32(286, timeEnd, false);
  dv.setFloat32(290, maxSignal, false);
  dv.setFloat32(294, minSignal, false);
  dv.setFloat32(4110, values[0], false); // Zero1 = valuesY[0]
  dv.setFloat64(4732, slope, false);
  for (let i = 0; i < n; i++) dv.setFloat64(dataOff + i * 8, values[i], true);
  return buf;
}

test('unit: ch179DataOffset anchors on the Signal179 header', () => {
  const app = loadApp();
  const vals = new Float64Array(64);
  for (let i = 0; i < vals.length; i++) vals[i] = Math.round(200 * Math.sin(i / 9));
  vals[0] = 0; // detectors start at zero — Zero1 must match exactly

  const legacy = signal179CH(vals, 1, 0, 640000, -120, 199);
  // zip-entry style misalignment: the .CH starts 3 bytes into the backing
  // buffer, but the .CH's own offsets (282, 4110, 4732, 6136…) are unchanged
  // relative to its start.
  const holder = new Uint8Array(3 + legacy.length);
  holder.set(legacy, 3);
  const view = holder.subarray(3);
  const dvL = new DataView(view.buffer, view.byteOffset, view.byteLength);
  assert.equal(app.ch179DataOffset(dvL, vals.length, 1, 640000), 6136, 'legacy layout → 6136');

  // OpenLab-native variant, v0 ≠ 0: the 8 bytes at 6136 are zero padding
  // there, so Zero1 rejects 6136 and the search lands on 6144. (With
  // v0 = 0 the two layouts are byte-for-byte indistinguishable — and
  // identical in length: 6136 + n*8 + 8 === 6144 + n*8. Legacy-first
  // ordering resolves that corner, matching every real trace observed.)
  const nativeVals = new Float64Array(vals);
  nativeVals[0] = 199;
  const native = signal179CH(nativeVals, 2 ** -14, 43.75, 1590000, -5432, 0, 6144, 0);
  const dvN = new DataView(native.buffer, native.byteOffset, native.byteLength);
  assert.equal(app.ch179DataOffset(dvN, vals.length, 2 ** -14, 1590000), 6144, 'OpenLab-native layout → 6144');

  // anchors must reject mismatches → caller falls back to scanning
  assert.equal(app.ch179DataOffset(dvL, vals.length, 0.01, 640000), null, 'slope mismatch rejected');
  assert.equal(app.ch179DataOffset(dvL, vals.length, 1, 999), null, 'end-time mismatch rejected');
  holder[3] = 0x02; // corrupt the .CH tag byte (holder[3] == legacy[0])
  assert.equal(app.ch179DataOffset(dvL, vals.length, 1, 640000), null, 'non-179 tag rejected');
});

test('stored-entry container: Signal179 header wins over garbage .acmd extrema', async () => {
  const app = loadApp();

  // Berlin-style VWD trace: raw counts, slope 2^-14 → mAU. The .acmd
  // extrema are deliberately garbage (min plausible, max 1.59e-98) as
  // observed in real exports — the header anchors must not care.
  const slope = 2 ** -14;
  const N = 600, tEnd = 300000;
  const raw = new Float64Array(N);
  for (let i = 0; i < N; i++) raw[i] = Math.round(-100 + 4000 * Math.exp(-((i - 300) ** 2) / (2 * 60 * 60)));
  raw[0] = 0;
  const garbageMax = 1.59e-98;
  const ch1 = signal179CH(raw, slope, 0, tEnd, -100, 0); // MinSignal/MaxSignal can be stale too
  const ch2 = concat(junkHeader(90), f64Bytes(new Float64Array(200))); // zero trace via scan path

  const dxZip = makeZip([
    { name: 'injection.acmd', data: enc(acmdInjection(N, -0.006103515625, garbageMax, tEnd, 200, 100000, 'Sig179', undefined, undefined, undefined, slope)), method: 0 },
    { name: `${TRACE1}.CH`, data: ch1, method: 0 },
    { name: `${TRACE2}.CH`, data: ch2, method: 0 },
    { name: '[Content_Types].xml', data: enc('<Types/>'), method: 0 },
  ]);
  const olax = makeZip([
    { name: 'Run_Sig.dx', data: dxZip, method: 0 },
    { name: 'Run.acaml', data: enc(acamlRegistry(['Run_Sig.dx'])) },
  ]);

  await app.parseContainer(olax, 'sig179.olax');
  const byId = Object.fromEntries(app.allTraces().map((t) => [t.traceId, t]));

  const t1 = byId[TRACE1];
  await app.buildCSVForTrace(t1);
  assert.equal(t1.extractedOffset, 6136, 'header-anchored window at the Signal179 data start');
  const vals = csvValues(t1.csvText);
  assert.equal(vals.length, N);
  assert.equal(vals[0], 0, 'first value is valuesY[0] (= Zero1), not header padding');
  assert.ok(Math.abs(vals[300] - raw[300] * slope) < 1e-12, 'values are slope-scaled raw counts');
  const vMax = Math.max(...vals);
  assert.ok(vMax > 0.1 && vMax < 1, `scaled max ${vMax} is real signal, not the 1.59e-98 acmd maximum`);

  const t2 = byId[TRACE2];
  await app.buildCSVForTrace(t2);
  assert.equal(t2.extractedOffset, 90, 'non-179 trace still uses the scan fallback');
});
