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

/* ---------------- ACAML manifest repair (.acaml/.mfx + MD5 checksum) --------- */

// Reference vector for the checksum algorithm: canonical re-serialization of
// the <Doc> subtree (UTF-8, no declaration, no inter-element whitespace,
// CDATA preserved, newlines raw in text / entitized in attributes), then MD5.
test('acaml checksum: reference vector (CDATA, entities, multi-line text)', async () => {
  const vec = `<?xml version="1.0" encoding="utf-8"?>
<ACAML xmlns:xsd="http://www.w3.org/2001/XMLSchema" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" schemaversion="2.1.30.999" xmlns="urn:schemas-agilent-com:acaml21">
  <Checksum Algorithm="MD5">
    <Value>E4J7Oyth3ym0hQsyaVJNAw==</Value>
  </Checksum>
  <Doc>
    <DocID>synthetic-vector</DocID>
    <DocInfo>
      <Description>A &amp; B &lt;test&gt; with &gt; chars</Description>
      <MultiLine>line1
line2
line3</MultiLine>
    </DocInfo>
    <Injections>
      <InjectionMetaData xmlns:xsd="http://www.w3.org/2001/XMLSchema" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns="">
        <Path><![CDATA[snapshot-20260828 215532-280826-18F-01 2026-08-28 21-24-55+02-00-r005.dx]]></Path>
        <TypedValue xsi:type="xsd:string">x</TypedValue>
      </InjectionMetaData>
    </Injections>
    <Empty />
    <Paired></Paired>
  </Doc>
</ACAML>`;
  const got = app.md5Base64(app.encodeUTF8(app.acamlCanonicalDoc(vec)));
  assert.equal(got, 'E4J7Oyth3ym0hQsyaVJNAw==');
});

test('repairAcamlManifest: rewrites snapshot paths, recomputes checksum, keeps BOM', async () => {
  const mk = (bom, value) => {
    const body = `<ACAML xmlns="urn:schemas-agilent-com:acaml21" schemaversion="2.1.30.999">
<Checksum Algorithm="MD5"><Value>${value}</Value></Checksum>
 <Doc><Content><Injections>
  <InjectionMetaData><Path>snapshot-20260710 084732-Run_Test.dx</Path></InjectionMetaData>
 </Injections></Content></Doc>
</ACAML>`;
    return app.encodeUTF8(bom ? '\ufeff' + body : body);
  };
  const map = new Map([['snapshot-20260710 084732-Run_Test.dx', 'Run_Test.dx']]);

  const out = app.repairAcamlManifest(mk(true, 'placeholder=='), map);
  const text = new TextDecoder().decode(out);
  assert.ok(out[0] === 0xef && out[1] === 0xbb && out[2] === 0xbf, 'BOM preserved');
  assert.ok(!text.includes('snapshot-'), 'snapshot path retargeted');
  const m = /<Value>([^<]*)<\/Value>/.exec(text);
  assert.equal(m[1], app.md5Base64(app.encodeUTF8(app.acamlCanonicalDoc(text))), 'checksum matches recomputed canonical MD5');

  // unchanged input (no snapshot refs) -> original bytes
  const plain = mk(false, 'x');
  assert.equal(app.repairAcamlManifest(plain, new Map()), plain, 'no-op returns original bytes');
});

test('repairAcamlManifest: non-MD5 checksum left untouched', async () => {
  const body = app.encodeUTF8(`<ACAML xmlns="urn:schemas-agilent-com:acaml21"><Checksum Algorithm="SHA1"><Value>aa==</Value></Checksum>
 <Doc><Path>snapshot-20260710 084732-Run_Test.dx</Path></Doc></ACAML>`);
  const out = app.repairAcamlManifest(body, new Map([['snapshot-20260710 084732-Run_Test.dx', 'Run_Test.dx']]));
  assert.equal(out, body, 'unverifiable algorithm -> original bytes');
});

test('repaired olax: manifest snapshot refs retargeted with valid checksum (duplicate mode)', async () => {
  const fx = buildOlax({ snapshot: 'duplicate', withRx: true });
  reset();
  await app.parseOlax(fx.buffer, 'dup.olax');
  const outs = await app.buildRepairedOlax(fx.buffer, 'dup.olax');
  const zip = app.parseZip(blobToU8(outs[0].blob));
  const acamlName = [...zip.files.keys()].find((n) => /\.acaml$/i.test(n));
  const text = new TextDecoder().decode(await app.readZipFile(zip, acamlName));

  assert.ok(!/Path>[^<]*snapshot-/i.test(text), 'no snapshot Path refs left');
  assert.ok(text.includes('<Path>Run_Test.dx</Path>'), 'regular ref present');
  const m = /<Value>([^<]*)<\/Value>/.exec(text);
  assert.notEqual(m[1], 'placeholder==', 'checksum was recomputed');
  assert.equal(m[1], app.md5Base64(app.encodeUTF8(app.acamlCanonicalDoc(text))), 'checksum self-consistent');
});

test('repaired olax: snapshot-only manifest promoted (only mode)', async () => {
  const fx = buildOlax({ snapshot: 'only', withRx: true });
  reset();
  await app.parseOlax(fx.buffer, 'only.olax');
  const outs = await app.buildRepairedOlax(fx.buffer, 'only.olax');
  const zip = app.parseZip(blobToU8(outs[0].blob));
  const acamlName = [...zip.files.keys()].find((n) => /\.acaml$/i.test(n));
  const text = new TextDecoder().decode(await app.readZipFile(zip, acamlName));

  assert.ok(!/Path>[^<]*snapshot-/i.test(text), 'promoted: snapshot ref renamed to regular');
  assert.ok(text.includes('<Path>Run_Test.dx</Path>'));
});

/* --------- commit of acquired-but-uncommitted injections into .acaml ------- */

import { buildCommitOlax } from './fixtures/build-olax.mjs';

async function acamlOf(u8) {
  const z = app.parseZip(u8);
  const name = [...z.files.keys()].find((n) => /\.acaml$/i.test(n));
  const text = new TextDecoder().decode(await app.readZipFile(z, name));
  return { z, name, text };
}

test('repaired olax: uncommitted injections get committed to the manifest', async () => {
  const fx = buildCommitOlax();          // r001 committed, r002/r003 not
  reset();
  await app.parseOlax(fx.buffer, 'commit.olax');
  const u8 = await repairedU8(fx, 'commit.olax');
  const { z, text } = await acamlOf(u8);

  // All three injections are committed now, each with its own GUID used
  // consistently as MeasData@id, InjectionMeasData_ID ref and
  // InjectionMetaData@InjectionId.
  const imdNames = [...text.matchAll(/RawDataFileName="([^"]*)"/g)].map(m => m[1]);
  assert.deepEqual(imdNames,
    ['Run_Std-r001.dx', 'Run_Std-r002.dx', 'Run_Std-r003.dx']);
  const newGuids = [...text.matchAll(/<InjectionMetaData [^>]*>/g)]
    .map(m => m[0])
    .filter(b => /RawDataFileName="Run_Std-r00[23]\.dx"/.test(b))
    .map(b => (/InjectionId="([0-9a-f-]+)"/.exec(b) || [])[1]);
  assert.equal(newGuids.length, 2, 'two new injections committed');
  for (const g of newGuids) {
    assert.ok(new RegExp(`<MeasData id="${g}"`).test(text), 'MeasData row @ ' + g.slice(0, 8));
    assert.ok(new RegExp(`<InjectionMeasData_ID id="${g}"`).test(text), 'sample ref @ ' + g.slice(0, 8));
  }

  // New rows carry the facts from their own injection.acmd: trace IDs,
  // acquisition time (converted to UTC ms), replicate + order numbers.
  // They stay in the "acquired, not yet processed" state (no
  // ExternalResultPath); the originally committed r001 keeps its results.
  assert.equal((text.match(/<ExternalResultPath>/g) || []).length, 1,
    'only r001 has processed results');
  const g2 = newGuids[0];
  const blk2 = text.slice(text.indexOf(`<MeasData id="${g2}"`));
  assert.ok(blk2.includes(fx.runs[1].tA) && blk2.includes(fx.runs[1].tB),
    'r002 signal rows carry r002 trace GUIDs');
  assert.ok(text.includes('InjectionAcqDateTime="2026-07-10T09:00:00.500Z"'),
    'acq time converted to UTC ms form');
  const order2 = /<OrderNo val="(\d+)" \/>/.exec(blk2.slice(0, 4000));
  assert.equal(order2[1], '2', 'OrderNo follows the replicate number');
  assert.ok(/<ReplicateNumber val="2" \/>/.test(
    text.slice(text.indexOf('InjectionId="' + g2 + '"') - 900)), 'ReplicateNumber 2');

  // Manifest stays self-consistent: checksum covers the committed rows.
  const v = /<Value>([^<]*)<\/Value>/.exec(text)[1];
  assert.equal(v, app.md5Base64(app.encodeUTF8(app.acamlCanonicalDoc(text))),
    'checksum self-consistent after commit');

  // Fileset: the .dx files the session never registered are listed with
  // the MD5 of the bytes actually shipped.
  const mfxName = [...z.files.keys()].find((n) => /\.mfx$/i.test(n));
  const mfx = new TextDecoder().decode(await app.readZipFile(z, mfxName));
  for (const f of ['Run_Std-r002.dx', 'Run_Std-r003.dx']) {
    const e = new RegExp(`<File Path="${f}" IdentifierAlgorithm="MD5" Identifier="([0-9a-f]{32})"`).exec(mfx);
    assert.ok(e, 'mfx lists ' + f);
    const dxName = [...z.files.keys()].find(n => n.endsWith(f));
    const bytes = await app.readZipFile(z, dxName);
    assert.equal(e[1], app.md5Hex(bytes), 'mfx MD5 for ' + f);
  }
  const acamlId = /<File Path="Run\.acaml" IdentifierAlgorithm="MD5" Identifier="([0-9a-f]{32})"/.exec(mfx);
  assert.equal(acamlId[1], app.md5Hex(await app.readZipFile(z,
    [...z.files.keys()].find(n => /\.acaml$/i.test(n)))),
    'mfx tracks the repaired .acaml bytes');
});

test('healthy result set: nothing to commit, no output churn', async () => {
  const fx = buildCommitOlax({ healthy: true });   // all injections committed
  reset();
  await app.parseOlax(fx.buffer, 'healthy.olax');
  assert.equal(await app.olaxHasUncommittedDx(fx.buffer), false,
    'nothing to commit detected');
  const outs = await app.buildRepairedOlax(fx.buffer, 'healthy.olax');
  const { text } = await acamlOf(blobToU8(outs[0].blob));
  assert.equal((text.match(/<InjectionMetaData /g) || []).length, 3,
    'still exactly the three committed injections');
});

test('uncommitted-dx detection gates the repaired download', async () => {
  const fx = buildCommitOlax();
  reset();
  await app.parseOlax(fx.buffer, 'commit.olax');
  assert.equal(await app.olaxHasUncommittedDx(fx.buffer), true,
    'r002/r003 detected as uncommitted');
});
