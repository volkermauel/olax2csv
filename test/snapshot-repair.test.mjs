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
  const c = containerOf(name);
  const blob = await app.buildRepairedContainer(fx.buffer, c.plan);
  return blobToU8(blob);
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

test('repaired container: snapshot-only run becomes a native regular run', async () => {
  reset();
  await app.parseOlax(fxOnly.buffer, 'snap-only.olax');
  const u8 = await repairedU8(fxOnly, 'snap-only.olax');
  const names = [...app.parseZip(u8).files.keys()].sort();
  assert.ok(names.includes('Run_Test.dx'));
  assert.ok(names.includes('Run_Test.rx'));
  assert.ok(!names.some((n) => n.toLowerCase().includes('snapshot-')), 'no snapshot- names remain');

  reset();
  await app.parseOlax(u8.buffer, 'repaired.olax', { repairSnapshots: false });
  assert.equal(app.allTraces().length, 2, 'repaired container parses natively (repair OFF)');
  assert.equal(app.allResults().peaks.length, 1);
});

test('repaired container: partial snapshot duplicates are removed', async () => {
  reset();
  await app.parseOlax(fxDup.buffer, 'snap-dup.olax');
  const u8 = await repairedU8(fxDup, 'snap-dup.olax');
  const names = [...app.parseZip(u8).files.keys()];
  assert.ok(names.includes('Run_Test.dx'));
  assert.ok(!names.some((n) => n.toLowerCase().includes('snapshot-')));

  reset();
  await app.parseOlax(u8.buffer, 'repaired.olax', { repairSnapshots: false });
  assert.equal(app.allTraces().length, 2);
  assert.equal(app.allResults().peaks.length, 1);
});

test('repaired container: snapshot .rx is promoted next to the regular .dx', async () => {
  reset();
  await app.parseOlax(fxRxOnly.buffer, 'snap-rx.olax');
  const u8 = await repairedU8(fxRxOnly, 'snap-rx.olax');
  const names = [...app.parseZip(u8).files.keys()].sort();
  assert.deepEqual(names.filter((n) => /run_test\.(dx|rx)$/i.test(n)), ['Run_Test.dx', 'Run_Test.rx']);

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
  const u8 = blobToU8(await app.buildRepairedContainer(buf.buffer, c.plan));

  reset();
  await app.parseOlax(u8.buffer, 'repaired-cm.zip', { repairSnapshots: false });
  assert.equal(app.store.files.length, 2);
  assert.equal(app.allTraces().length, 4, 'repaired CM zip parses natively (repair OFF)');
  assert.equal(app.allResults().peaks.length, 2);
});
