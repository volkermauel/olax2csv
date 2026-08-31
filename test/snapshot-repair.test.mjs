// Snapshot-repair tests: a result set "left open" in snapshot mode keeps acquired
// measurements only as "snapshot-<ts>-<name>.dx/.rx" (partial captures). With
// repair on (default) those measurements must be recovered when the completed
// counterpart is missing; snapshot duplicates of existing runs must be ignored;
// processed results may come from a snapshot .rx when the regular .rx is absent.

import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { loadApp, blobToU8 } from './harness.mjs';
import { buildOlax, makeZip, enc, acmdInjection, acamlRegistry, rxInjectionACAML, TRACE1, TRACE2 } from './fixtures/build-olax.mjs';

let app;
let fxOnly;       // run exists ONLY as snapshot-…-Run_Test.dx/.rx
let fxDup;        // regular run + snapshot copy (partial duplicate)
let fxRxOnly;     // regular .dx, results only as snapshot .rx

before(() => {
  app = loadApp();
  fxOnly = buildOlax({ snapshot: 'only' });
  fxDup = buildOlax({ snapshot: 'duplicate' });
  fxRxOnly = buildOlax({ snapshot: 'rxOnly' });
});

function reset() {
  app.store.files.length = 0;
  app.store.containers.length = 0;
  app.activeTab = 'traces';
  app.captured = null;
}

function containerOf(name) {
  const c = app.store.containers.find((x) => x.name === name);
  if (!c) throw new Error('container not recorded: ' + name);
  return c;
}

async function repairedU8(fx, name) {
  const outs = await app.buildRepairedOlax(fx.buffer, name);
  assert.equal(outs.length, 1, 'single result set -> exactly one .olax');
  assert.ok(/\.olax$/i.test(outs[0].name), 'output is an .olax: ' + outs[0].name);
  return blobToU8(outs[0].blob);
}

async function relsTargets(u8) {
  const z = app.parseZip(u8);
  const rels = new TextDecoder().decode(await app.readZipFile(z, '_rels/.rels'));
  return [...rels.matchAll(/Target="([^"]*)"/g)].map(m => m[1]);
}

async function contentTypes(u8) {
  const z = app.parseZip(u8);
  return new TextDecoder().decode(await app.readZipFile(z, '[Content_Types].xml'));
}

test('repair ON (default): snapshot-only measurement is recovered with traces and results', async () => {
  reset();
  await app.parseOlax(fxOnly.buffer, 'snap-only.olax');
  const traces = app.allTraces();
  assert.equal(traces.length, 2, 'both signals of the snapshot-only run');
  assert.equal(traces[0].sample, 'Test');
  const res = app.allResults();
  assert.equal(res.injections.length, 1);
  assert.equal(res.peaks.length, 1, 'processed results recovered from snapshot .rx');
  assert.equal(app.store.files[0].measurementCount, 1);
});

test('repair OFF: snapshot-only result set is skipped entirely (legacy behaviour)', async () => {
  reset();
  await app.parseOlax(fxOnly.buffer, 'snap-only.olax', { repairSnapshots: false });
  assert.equal(app.store.files.length, 0, 'no result set without regular .dx');
  assert.equal(app.allTraces().length, 0);
});

test('snapshot duplicate of a completed run is ignored (partial capture)', async () => {
  reset();
  await app.parseOlax(fxDup.buffer, 'snap-dup.olax');
  assert.equal(app.allTraces().length, 2, 'only the completed run, not its snapshot copy');
  const res = app.allResults();
  assert.equal(res.peaks.length, 1);
  assert.equal(res.injections.length, 1);
});

test('missing .rx is recovered from the matching snapshot .rx', async () => {
  reset();
  await app.parseOlax(fxRxOnly.buffer, 'snap-rx.olax');
  assert.equal(app.allTraces().length, 2, 'traces from the regular .dx');
  const res = app.allResults();
  assert.equal(res.peaks.length, 1, 'results parsed from snapshot-…-Run_Test.rx');
  assert.equal(res.injections.length, 1);
});

test('recovered measurement slots into chronological position', async () => {
  reset();
  // Run "A" completed at 10:00; run "B" (09:00) was never committed and exists
  // only as a snapshot. Repair must order B before A.
  const mkDx = (sample) => makeZip([
    { name: 'injection.acmd', data: enc(acmdInjection(10, 0, 1, 6000, 5, 3000, sample)) },
    { name: `${TRACE1}.CH`, data: new Uint8Array(10 * 8) },
    { name: `${TRACE2}.CH`, data: new Uint8Array(5 * 8) },
    { name: '[Content_Types].xml', data: enc('<Types/>') },
  ]);
  const buf = makeZip([
    { name: 'A 2026-08-28 10-00-00+02-00.dx', data: mkDx('Alpha') },
    { name: 'snapshot-20260828 093000-B 2026-08-28 09-00-00+02-00.dx', data: mkDx('Beta') },
    { name: 'Run.acaml', data: enc(acamlRegistry()) },
  ]);
  await app.parseOlax(buf, 'order.zip');
  const traces = app.allTraces();
  assert.equal(traces.length, 4);
  assert.equal(traces[0].sample, 'Beta', 'earlier snapshot-only run first');
  assert.equal(traces[2].sample, 'Alpha');
  const inj = app.allResults().injections; // no .rx anywhere -> no injection rows
  assert.equal(inj.length, 0);
});

test('worker message threads the repair option', async () => {
  const outer = app.parseZip(new Uint8Array(fxDup.buffer));
  const groups = [...app.groupByRslt(outer).values()];
  if (groups.length) {
    const msg = app.buildWorkerMessage(outer, groups[0], 'f.zip', { repairSnapshots: false });
    assert.equal(msg.options.repairSnapshots, false);
  }
  // flat container: exercise the default (no opts) path
  const flat = app.parseZip(new Uint8Array(fxOnly.buffer));
  const g2 = [{ folderName: 'x.rslt', entries: [...flat.files.keys()].map((name) => ({ name, within: name })) }];
  const msg2 = app.buildWorkerMessage(flat, g2[0], 'f.zip');
  assert.ok(msg2.options && typeof msg2.options === 'object' && !('repairSnapshots' in msg2.options), 'no opts -> plain empty options');
});

/* ---------------- repair plan (container level) ---------------- */

test('plan: flat container with snapshot-only run promotes dx+rx', async () => {
  reset();
  await app.parseOlax(fxOnly.buffer, 'snap-only.olax');
  const c = containerOf('snap-only.olax');
  assert.equal(c.applied, true);
  assert.equal(c.olax, true);
  assert.equal(c.plan.promote.map((p) => p.to).sort().join('|'), 'Run_Test.dx|Run_Test.rx');
  assert.equal(c.plan.drop.join('|'), '');
});

test('plan: partial duplicates of completed runs are dropped, nothing promoted', async () => {
  reset();
  await app.parseOlax(fxDup.buffer, 'snap-dup.olax');
  const c = containerOf('snap-dup.olax');
  assert.equal(c.plan.promote.length, 0);
  assert.equal(c.plan.drop.sort().join('|'), [
    'snapshot-20260710 084732-Run_Test.dx',
    'snapshot-20260710 084732-Run_Test.rx',
  ].join('|'));
});

test('plan: OPC "%5c" and CM "/" separators, "+" and space ts forms', () => {
  const names = [
    'A.rslt%5csnapshot-20260710+084732-M 2026-07-10 08-41-14+02-00.dx',
    'A.rslt%5csnapshot-20260710+084732-M 2026-07-10 08-41-14+02-00.rx',
    'A.rslt%5cM 2026-07-10 08-41-14+02-00.pdf', // only the pdf counterpart exists
    'B.rslt/snapshot-20260828 172148-N 2026-08-28 17-18-25+02-00.dx',
    'B.rslt/snapshot-20260828 172148-N 2026-08-28 17-18-25+02-00.rx',
    'B.rslt/N 2026-08-28 17-18-25+02-00.dx', // completed run exists -> drop
    'C.rslt/Run.dx',
  ];
  const plan = app.computeContainerRepairPlan({ files: new Map(names.map((n) => [n, {}])) });
  // A: both counterparts missing -> promote dx+rx.
  // B: completed run's .dx exists (snapshot dx dropped) but its .rx is missing
  //    (snapshot rx promoted) — the real-world "r005" mixed scenario.
  assert.equal(plan.promote.map((p) => p.to).sort().join('|'), [
    'A.rslt%5cM 2026-07-10 08-41-14+02-00.dx',
    'A.rslt%5cM 2026-07-10 08-41-14+02-00.rx',
    'B.rslt/N 2026-08-28 17-18-25+02-00.rx',
  ].sort().join('|'));
  assert.equal(plan.drop.join('|'), 'B.rslt/snapshot-20260828 172148-N 2026-08-28 17-18-25+02-00.dx');
});

/* ---------------- repaired container round-trips ---------------- */

test('repaired olax: snapshot-only run becomes a native regular run', async () => {
  reset();
  await app.parseOlax(fxOnly.buffer, 'snap-only.olax');
  const u8 = await repairedU8(fxOnly, 'snap-only.olax');
  const names = [...app.parseZip(u8).files.keys()].sort();
  assert.ok(names.includes('snap-only.rslt%5cRun_Test.dx'), 'promoted dx: ' + names.join(' | '));
  assert.ok(names.includes('snap-only.rslt%5cRun_Test.rx'), 'promoted rx');
  assert.ok(!names.some((n) => n.toLowerCase().includes('snapshot-')), 'no snapshot- names remain');

  // OPC wrapper: parts + consistent relationships
  assert.ok(names.includes('[Content_Types].xml') && names.includes('_rels/.rels'), 'OPC wrapper present');
  const targets = await relsTargets(u8);
  assert.ok(targets.includes('/snap-only.rslt%5cRun_Test.dx'), 'rels references promoted dx');
  assert.ok(targets.includes('/snap-only.rslt%5cRun_Test.rx'), 'rels references promoted rx');
  assert.ok(!targets.some((t) => /snapshot-/i.test(t)), 'no snapshot- rels targets');
  assert.ok(/Extension="acaml"/.test(await contentTypes(u8)), 'content types cover acaml');

  reset();
  await app.parseOlax(u8.buffer, 'repaired.olax', { repairSnapshots: false });
  assert.equal(app.allTraces().length, 2, 'repaired olax parses natively (repair OFF)');
  assert.equal(app.allResults().peaks.length, 1);
});

test('repaired olax: partial snapshot duplicates are removed', async () => {
  reset();
  await app.parseOlax(fxDup.buffer, 'snap-dup.olax');
  const u8 = await repairedU8(fxDup, 'snap-dup.olax');
  const names = [...app.parseZip(u8).files.keys()];
  assert.ok(names.includes('snap-dup.rslt%5cRun_Test.dx'));
  assert.ok(!names.some((n) => n.toLowerCase().includes('snapshot-')));
  const targets = await relsTargets(u8);
  assert.ok(!targets.some((t) => /snapshot-/i.test(t)), 'dropped parts leave no rels target');

  reset();
  await app.parseOlax(u8.buffer, 'repaired.olax', { repairSnapshots: false });
  assert.equal(app.allTraces().length, 2);
  assert.equal(app.allResults().peaks.length, 1);
});

test('repaired olax: snapshot .rx is promoted next to the regular .dx', async () => {
  reset();
  await app.parseOlax(fxRxOnly.buffer, 'snap-rx.olax');
  const u8 = await repairedU8(fxRxOnly, 'snap-rx.olax');
  const names = [...app.parseZip(u8).files.keys()].sort();
  assert.deepEqual(names.filter((n) => /run_test\.(dx|rx)$/i.test(n)),
    ['snap-rx.rslt%5cRun_Test.dx', 'snap-rx.rslt%5cRun_Test.rx']);
  const targets = await relsTargets(u8);
  assert.ok(targets.includes('/snap-rx.rslt%5cRun_Test.rx'), 'rels references promoted rx');

  reset();
  await app.parseOlax(u8.buffer, 'repaired.olax', { repairSnapshots: false });
  assert.equal(app.allTraces().length, 2);
  assert.equal(app.allResults().peaks.length, 1, 'results now native (no repair needed)');
});

test('CM zip: grouped .rslt with a snapshot-only result set round-trips', async () => {
  const mkDx = makeZip([
    { name: 'injection.acmd', data: enc(acmdInjection(10, 0, 1, 6000, 5, 3000, 'Test')) },
    { name: `${TRACE1}.CH`, data: new Uint8Array(10 * 8) },
    { name: `${TRACE2}.CH`, data: new Uint8Array(5 * 8) },
    { name: '[Content_Types].xml', data: enc('<Types/>') },
  ]);
  const mkRx = makeZip([
    { name: '[Content_Types].xml', data: enc('<Types/>') },
    { name: 'Base/InjectionACAML', data: enc(rxInjectionACAML()) },
  ]);
  const buf = makeZip([
    { name: 'OK.rslt/Run.dx', data: mkDx },
    { name: 'OK.rslt/Run.rx', data: mkRx },
    { name: 'OK.rslt/Run.acaml', data: enc(acamlRegistry()) },
    { name: 'BROKEN.rslt/snapshot-20260828 172148-Run.dx', data: mkDx },
    { name: 'BROKEN.rslt/snapshot-20260828 172148-Run.rx', data: mkRx },
    { name: 'BROKEN.rslt/Run.acaml', data: enc(acamlRegistry()) },
  ]);

  reset();
  await app.parseOlax(buf.buffer, 'cm.zip');
  assert.equal(app.store.files.length, 2, 'both result sets parsed');
  assert.equal(app.allTraces().length, 4, 'BROKEN recovered during parse');
  assert.equal(app.allResults().peaks.length, 2);

  const c = containerOf('cm.zip');
  assert.equal(c.olax, false);
  assert.equal(c.plan.promote.map((p) => p.to).sort().join('|'), 'BROKEN.rslt/Run.dx|BROKEN.rslt/Run.rx');

  // CM zip -> TWO .olax archives (one per result set), both named after their folder
  const outs = await app.buildRepairedOlax(buf.buffer, 'cm.zip');
  assert.equal(outs.map(o => o.name).sort().join('|'), 'BROKEN.olax|OK.olax');
  assert.ok(outs.every(o => /\.olax$/i.test(o.name)), 'always .olax, even for .zip input');

  let traces = 0, peaks = 0, files = 0;
  for (const o of outs) {
    const u8 = blobToU8(o.blob);
    const names = [...app.parseZip(u8).files.keys()];
    assert.ok(!names.some((n) => /snapshot-/i.test(n)), o.name + ': no snapshot- names');
    assert.ok(names.some((n) => /\.rslt%5crun\.(dx|rx)$/i.test(n)), o.name + ': %5c-encoded .rslt parts');
    const targets = await relsTargets(u8);
    assert.ok(!targets.some((t) => /snapshot-/i.test(t)), o.name + ': no snapshot- rels targets');
    reset();
    await app.parseOlax(u8.buffer, o.name, { repairSnapshots: false });
    files += app.store.files.length;
    traces += app.allTraces().length;
    peaks += app.allResults().peaks.length;
  }
  assert.equal(files, 2);
  assert.equal(traces, 4, 'repaired olax files parse natively (repair OFF)');
  assert.equal(peaks, 2);
});

/* ---------------- OPC wrapper maintenance (.olax in -> .olax out) ---------------- */

test('repaired olax from OPC input: wrapper carried over, .rels rewritten, names verbatim', async () => {
  const fxOpc = buildOlax({ snapshot: 'duplicate', opc: true });
  reset();
  await app.parseOlax(fxOpc.buffer, 'opc-dup.olax');
  const c = containerOf('opc-dup.olax');

  const outs = await app.buildRepairedOlax(fxOpc.buffer, 'opc-dup.olax');
  assert.equal(outs.length, 1);
  assert.equal(outs[0].name, 'opc-dup.repaired.olax');
  const u8 = blobToU8(outs[0].blob);
  const names = [...app.parseZip(u8).files.keys()].sort();

  // original part names kept VERBATIM (real OPC encoding, not re-synthesized)
  assert.ok(names.includes('Run_Test.dx'), 'verbatim OPC part name');
  assert.ok(names.includes('Run_Test.rx'));
  assert.ok(!names.some((n) => /snapshot-/i.test(n)));

  // [Content_Types].xml byte-identical; .rels rewritten
  const ct = await contentTypes(u8);
  const origZip = app.parseZip(new Uint8Array(fxOpc.buffer));
  const origCt = new TextDecoder().decode(await app.readZipFile(origZip, '[Content_Types].xml'));
  assert.equal(ct, origCt, '[Content_Types].xml carried over byte-identical');

  const targets = await relsTargets(u8);
  // 3 targets = dx, rx, acaml. [Content_Types].xml is the content-types
  // stream, not a part, so it correctly has no relationship (same as real .olax).
  assert.equal(targets.length, 3, 'rels: one target per shipped part');
  assert.ok(targets.includes('/Run_Test.dx') && targets.includes('/Run_Test.rx') && targets.includes('/Run.acaml'));
  assert.ok(!targets.some((t) => /snapshot-/i.test(t)), 'dropped snapshot parts removed from rels');

  reset();
  await app.parseOlax(u8.buffer, 'repaired.olax', { repairSnapshots: false });
  assert.equal(app.allTraces().length, 2);
  assert.equal(app.allResults().peaks.length, 1);
  void c;
});
