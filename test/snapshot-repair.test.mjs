// Snapshot-repair tests: a result set "left open" in snapshot mode keeps acquired
// measurements only as "snapshot-<ts>-<name>.dx/.rx" (partial captures). With
// repair on (default) those measurements must be recovered when the completed
// counterpart is missing; snapshot duplicates of existing runs must be ignored;
// processed results may come from a snapshot .rx when the regular .rx is absent.

import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { loadApp } from './harness.mjs';
import { buildOlax, makeZip, enc, acmdInjection, acamlRegistry, TRACE1, TRACE2 } from './fixtures/build-olax.mjs';

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
  app.activeTab = 'traces';
  app.captured = null;
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
