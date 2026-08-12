// Web Worker parallel-parsing tests.
//
// These tests do NOT mock the worker: they take the EXACT worker source string
// that buildWorkerSource() produces for the browser, prepend a 4-line adapter that
// maps the Web-Worker `self.onmessage`/`self.postMessage` API onto Node's
// `worker_threads` parentPort, and run it in a REAL OS thread that has the real
// DecompressionStream/Blob/Response globals. So inflate + @xmldom XML parsing +
// the full per-result-set parse actually execute — if any function the worker
// needs is missing from WORKER_FNS, this throws a ReferenceError and fails CI.
//
// Correctness is checked by comparing worker output against the single-threaded
// parseContainer path on the same fixtures.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';
import fs from 'node:fs';
import vm from 'node:vm';
import { loadApp } from './harness.mjs';
import { buildResultsZip, buildOlaxOpc, buildNoRxZip } from './fixtures/build-results-zip.mjs';

const HTML = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');
// Extract the embedded @xmldom bundle (the same text the browser reads from the
// <script type="text/xmldom" id="xmldom-src"> block and feeds to buildWorkerSource).
const xo = HTML.indexOf('id="xmldom-src"');
const xmldomText = HTML.slice(HTML.indexOf('>', xo) + 1, HTML.indexOf('</script>', xo)).trim();

const app = loadApp();
const PEAK = app.PEAK_HEADER;

// Maps the Web Worker global (`self`) onto a Node worker_thread's parentPort so
// the unmodified browser worker source runs here. Only this adapter is Node-specific;
// the worker source itself is byte-for-byte what the browser executes.
const NODE_ADAPTER = `
const { parentPort } = require('worker_threads');
const self = { postMessage: (m) => parentPort.postMessage(m) };
parentPort.on('message', (m) => { if (typeof self.onmessage === 'function') self.onmessage({ data: m }); });
globalThis.self = self;
`;

const workerSrc = app.buildWorkerSource(xmldomText);

// Run one worker with a process-message, resolve its reply (or reject on error).
function runWorker(message) {
  const w = new Worker(NODE_ADAPTER + workerSrc, { eval: true });
  return new Promise((resolve, reject) => {
    w.once('message', (m) => { w.terminate(); resolve(m); });
    w.once('error', (e) => { w.terminate(); reject(e); });
    w.postMessage(message);
  });
}

// Build per-group work items (same path the browser's parseContainerParallel uses).
function buildMessages(buffer, fileName) {
  const outer = app.parseZip(new Uint8Array(buffer));
  const groups = [...app.groupByRslt(outer).values()];
  return groups.map((g) => app.buildWorkerMessage(outer, g, fileName));
}

// Comparable summary of one parsed file object (traces + result rows).
function fileSummary(f) {
  const iRT = PEAK.indexOf('Retention time (min)');
  const iArea = PEAK.indexOf('Area');
  const iSig = PEAK.indexOf('Signal');
  const iInstType = PEAK.indexOf('Instrument type');
  return {
    instrumentType: f.instrumentType,
    instrument: f.instrument,
    nTraces: f.traces.length,
    nPeaks: f.results.peaks.length,
    nCompounds: f.results.compounds.length,
    nCalib: f.results.calibration.length,
    nInj: f.results.injections.length,
    traceDevices: f.traces.map((t) => t.device).sort(),
    firstPeak: f.results.peaks[0]
      ? { signal: f.results.peaks[0][iSig], rt: f.results.peaks[0][iRT], area: f.results.peaks[0][iArea] }
      : null,
    firstPeakInstType: f.results.peaks[0] ? f.results.peaks[0][iInstType] : null,
  };
}

// The harness evals the app in a separate VM realm, so objects built from the
// serial path carry the VM realm's Array/Object prototypes. The worker output
// is structured-cloned into the main realm. Normalize both sides via JSON so
// deepStrictEqual compares values, not realm identities (browser has one realm).
const clone = (x) => JSON.parse(JSON.stringify(x));

// Single-threaded reference: parse the same buffer serially and summarize.
async function serialSummaries(buffer, fileName) {
  app.store.files.length = 0;
  await app.parseOlax(new Uint8Array(buffer), fileName);
  return app.store.files.map(fileSummary);
}

test('worker source is syntactically valid JS', () => {
  assert.ok(workerSrc.length > 100_000);
  new vm.Script(workerSrc); // throws on syntax error
  assert.match(workerSrc, /self\.onmessage\s*=/);
});

test('worker source contains every function the parse chain needs', () => {
  const needed = [
    'parseZip', 'readZipFile', 'getFileSlice', 'inflateRawOrDeflate', 'inflateBytes',
    'decodeUTF8', 'findEOCD', 'xmlParse', 'getTextNS', 'childNS', 'valOf', 'num',
    'buildSignalMap', 'parseInjectionACAML', 'parseMeasurementTraces',
    'parseMeasurementResults', 'processResultSet', 'detectGroupMeta', 'classifyAmx',
    'classifyByFolderName', 'instrumentLabelFromFolder', 'groupByRslt', 'normZipPath',
    'sanitizeName', 'sampleNameFromDxPath',
  ];
  for (const fn of needed) {
    assert.ok(
      new RegExp(`(async )?function ${fn}\\b`).test(workerSrc),
      `worker source is missing function: ${fn}`,
    );
  }
});

test('worker parses every result set of the CM fixture and matches the serial path (single worker, both groups)', async () => {
  const { buffer } = buildResultsZip();
  const messages = buildMessages(buffer, 'cm.zip');
  assert.equal(messages.length, 2, 'fixture should have 2 result sets');

  const reply = await runWorker({ type: 'process', chunkIndex: 0, groups: messages });
  assert.equal(reply.type, 'done');
  assert.equal(reply.files.length, 2);

  const workerSummaries = reply.files.map(fileSummary).sort((a, b) =>
    (a.instrumentType || '').localeCompare(b.instrumentType || ''));
  const ref = (await serialSummaries(buffer, 'cm.zip')).sort((a, b) =>
    (a.instrumentType || '').localeCompare(b.instrumentType || ''));
  assert.deepEqual(clone(workerSummaries), clone(ref));
  // Sanity: both instrument types present, both non-empty.
  const types = workerSummaries.map((s) => s.instrumentType).sort();
  assert.deepEqual(types, ['GC', 'HPLC']);
  assert.ok(workerSummaries.every((s) => s.nPeaks > 0 && s.nTraces > 0));
});

test('parallel map-reduce (one worker per group) aggregates to the same result as serial', async () => {
  const { buffer } = buildResultsZip();
  const messages = buildMessages(buffer, 'cm.zip');
  // Spawn one worker per group, in parallel — exactly the chunk-fan-out the app does.
  const replies = await Promise.all(messages.map((g, i) =>
    runWorker({ type: 'process', chunkIndex: i, groups: [g] })));
  const aggregated = replies.flatMap((r) => r.files).map(fileSummary).sort((a, b) =>
    (a.instrumentType || '').localeCompare(b.instrumentType || ''));
  const ref = (await serialSummaries(buffer, 'cm.zip')).sort((a, b) =>
    (a.instrumentType || '').localeCompare(b.instrumentType || ''));
  assert.deepEqual(clone(aggregated), clone(ref));
  assert.equal(aggregated.length, 2);
});

test('worker handles the OPC (.olax, %5c separator) single-result-set fixture', async () => {
  const { buffer } = buildOlaxOpc();
  const messages = buildMessages(buffer, 'sample.olax');
  assert.equal(messages.length, 1);
  const reply = await runWorker({ type: 'process', chunkIndex: 0, groups: messages });
  assert.equal(reply.type, 'done');
  assert.equal(reply.files.length, 1);
  const s = fileSummary(reply.files[0]);
  assert.equal(s.instrumentType, 'HPLC');
  assert.ok(s.nPeaks > 0);
  // OPC path must match serial too.
  assert.deepEqual(clone([s]), clone(await serialSummaries(buffer, 'sample.olax')));
});

test('worker gracefully handles a .rslt with .dx but no .rx (traces only, empty results)', async () => {
  const { buffer } = buildNoRxZip();
  const messages = buildMessages(buffer, 'norx.zip');
  assert.equal(messages.length, 1);
  const reply = await runWorker({ type: 'process', chunkIndex: 0, groups: messages });
  assert.equal(reply.type, 'done', `expected done, got ${JSON.stringify(reply).slice(0, 200)}`);
  assert.equal(reply.files.length, 1);
  const f = reply.files[0];
  assert.ok(f.traces.length >= 1, 'should still extract the trace');
  assert.equal(f.results.peaks.length, 0);
});

test('worker returns done with zero files for an empty chunk (no hang, no crash)', async () => {
  const reply = await runWorker({ type: 'process', chunkIndex: 0, groups: [] });
  assert.equal(reply.type, 'done');
  assert.equal(reply.files.length, 0);
});
