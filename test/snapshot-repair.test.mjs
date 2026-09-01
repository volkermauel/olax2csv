// Snapshot-repair tests: a result set "left open" in snapshot mode keeps acquired
// measurements only as "snapshot-<ts>-<name>.dx/.rx" (partial captures). With
// repair on (default) those measurements must be recovered when the completed
// counterpart is missing; snapshot duplicates of existing runs must be ignored;
// processed results may come from a snapshot .rx when the regular .rx is absent.

import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { loadApp, blobToU8 } from './harness.mjs';
import { buildOlax, makeZip, enc, filesetManifest, acmdInjection, acamlRegistry, rxInjectionACAML, TRACE1, TRACE2 } from './fixtures/build-olax.mjs';

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

async function repairedU8(fx, name, variant) {
  const outs = await app.buildRepairedOlax(fx.buffer, name, variant);
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
  assert.ok(names.includes('snap-only-repaired.rslt%5cRun_Test.dx'), 'promoted dx: ' + names.join(' | '));
  assert.ok(names.includes('snap-only-repaired.rslt%5cRun_Test.rx'), 'promoted rx');
  assert.ok(!names.some((n) => n.toLowerCase().includes('snapshot-')), 'no snapshot- names remain');

  // OPC wrapper: parts + consistent relationships
  assert.ok(names.includes('[Content_Types].xml') && names.includes('_rels/.rels'), 'OPC wrapper present');
  const targets = await relsTargets(u8);
  assert.ok(targets.includes('/snap-only-repaired.rslt%5cRun_Test.dx'), 'rels references promoted dx');
  assert.ok(targets.includes('/snap-only-repaired.rslt%5cRun_Test.rx'), 'rels references promoted rx');
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
  assert.ok(names.includes('snap-dup-repaired.rslt%5cRun_Test.dx'));
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
    ['snap-rx-repaired.rslt%5cRun_Test.dx', 'snap-rx-repaired.rslt%5cRun_Test.rx']);
  const targets = await relsTargets(u8);
  assert.ok(targets.includes('/snap-rx-repaired.rslt%5cRun_Test.rx'), 'rels references promoted rx');

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
  assert.equal(outs.map(o => o.name).sort().join('|'), 'BROKEN-repaired.olax|OK-repaired.olax');
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

test('repaired olax: mfx fileset matches the shipped parts exactly (drop + promote)', async () => {
  const fx = buildOlax({
    snapshot: 'duplicate',
    mfx: [
      'Run.acaml',
      'Run_Test.dx',
      'snapshot-20260710 084732-Run_Test.dx',   // partial copy — regular ships
      'snapshot-20260710 084732-Run_Test.rx',   // only copy of the results
    ],
  });
  reset();
  await app.parseOlax(fx.buffer, 'dup.olax');
  const u8 = await repairedU8(fx, 'dup.olax');
  const z = app.parseZip(u8);
  const mfxName = [...z.files.keys()].find(n => /\.mfx$/i.test(n));
  const mfx = new TextDecoder().decode(await app.readZipFile(z, mfxName));

  // One entry per shipped data file, none left over: the snapshot-duplicate
  // entries are gone (their runs ship as regular files), the snapshot .rx is
  // listed under its promoted regular name.
  assert.equal((mfx.match(/<File /g) || []).length, 3,
    'acaml + dx + rx, exactly one entry each');
  assert.equal(mfx.includes('snapshot-'), false, 'no snapshot paths remain');
  for (const f of ['Run.acaml', 'Run_Test.dx', 'Run_Test.rx']) {
    const e = new RegExp(`<File Path="${f}" IdentifierAlgorithm="MD5" Identifier="([0-9a-f]{32})"`).exec(mfx);
    assert.ok(e, 'mfx lists ' + f);
    const part = [...z.files.keys()].find(n => n.endsWith(f));
    assert.equal(e[1], app.md5Hex(await app.readZipFile(z, part)),
      'identifier = MD5 of shipped bytes for ' + f);
  }
});

test('repaired olax: mfx with correct identifiers stays byte-identical', async () => {
  // Healthy input whose mfx already matches the shipped bytes — the repair
  // must not touch it (identifiers, formatting and BOM preserved).
  const base = buildOlax({ withRx: true });
  const z0 = app.parseZip(new Uint8Array(base.buffer));
  const md5Of = async n => app.md5Hex(await app.readZipFile(z0, n));
  const entries = [];
  for (const [n] of z0.files) {
    if (n.endsWith('/')) continue;
    entries.push({ name: n, data: await app.readZipFile(z0, n) });
  }
  // filesetManifest() adds the Run.acaml entry itself.
  const mfxBytes = enc(filesetManifest([
    { path: 'Run_Test.dx', md5: await md5Of('Run_Test.dx') },
    { path: 'Run_Test.rx', md5: await md5Of('Run_Test.rx') },
  ]).replace(
    /<File Path="Run.acaml" IdentifierAlgorithm="MD5" Identifier="0{32}"/,
    `<File Path="Run.acaml" IdentifierAlgorithm="MD5" Identifier="${await md5Of('Run.acaml')}"`));
  const fx = { buffer: makeZip([...entries, { name: 'Run.mfx', data: mfxBytes }]).buffer };
  reset();
  await app.parseOlax(fx.buffer, 'healthy-mfx.olax');
  const u8 = await repairedU8(fx, 'healthy-mfx.olax');
  const z = app.parseZip(u8);
  const mfxName = [...z.files.keys()].find(n => /\.mfx$/i.test(n));
  const out = new TextDecoder().decode(await app.readZipFile(z, mfxName));
  // The result-set rename swaps <Description> in the .acaml (its checksum
  // covers the new name), so the fileset's .acaml identifier legitimately
  // tracks the new bytes — everything else must stay untouched.
  const acamlName = [...z.files.keys()].find(n => /\.acaml$/i.test(n));
  const expect = new TextDecoder().decode(mfxBytes).replace(
    /(<File Path="Run.acaml"[^>]*Identifier=")[0-9a-f]{32}(")/,
    `$1${app.md5Hex(await app.readZipFile(z, acamlName))}$2`);
  assert.equal(out, expect,
    'mfx unchanged except the .acaml identifier that tracks the renamed manifest');
});

test('repaired olax (commit repair): fileset mirrors the shipped parts',
  async () => {
  // Invariants an archive consumer validates: every <File> entry resolves to
  // a shipped part whose bytes hash to the entry's MD5 identifier, every
  // shipped data part has exactly one entry, and each entry carries the
  // appVersion property the native fileset writer always emits.
  const fx = buildCommitOlax();
  reset();
  await app.parseOlax(fx.buffer, 'commit.olax');
  const u8 = await repairedU8(fx, 'commit.olax');
  const z = app.parseZip(u8);
  const mfxName = [...z.files.keys()].find(n => /\.mfx$/i.test(n));
  const mfx = new TextDecoder().decode(await app.readZipFile(z, mfxName));

  const entryRe = /<File Path="([^"]*)" IdentifierAlgorithm="MD5" Identifier="([0-9a-f]{32})"([\s\S]*?)<\/File>/g;
  const seen = new Map();
  for (const e of mfx.matchAll(entryRe)) {
    assert.ok(!seen.has(e[1]), 'no duplicate Path entry: ' + e[1]);
    seen.set(e[1], e[2]);
    assert.match(e[3], /Property Name="appVersion" Value="[^"]+"/,
      'entry carries an appVersion property: ' + e[1]);
    const part = [...z.files.keys()].find(n => n.endsWith(e[1]));
    assert.ok(part, 'entry resolves to a shipped part: ' + e[1]);
    assert.equal(e[2], app.md5Hex(await app.readZipFile(z, part)),
      'identifier = MD5 of shipped bytes: ' + e[1]);
  }
  const dataParts = [...z.files.keys()].filter(n =>
    !n.endsWith('/') && !/\.mfx$/i.test(n) &&
    !['[Content_Types].xml', '_rels/.rels'].includes(n) &&
    !n.startsWith('package/')); // wrapper-class, like the parser's isWrapper
  assert.equal(seen.size, dataParts.length,
    'one entry per shipped data part (acaml, dx, rx)');
  for (const p of dataParts) {
    const base = p.split('%5c').pop().split('/').pop();
    assert.ok(seen.has(base), 'shipped part is listed: ' + p);
  }
});

test('repaired olax re-parsed lists every committed measurement', async () => {
  // The user-visible contract: after the repair the archive itself must
  // expose all acquired measurements, not only the ones the snapshot
  // session committed. Re-parse the repaired bytes through the app's own
  // pipeline and count distinct measurements.
  const fx = buildCommitOlax();
  reset();
  await app.parseOlax(fx.buffer, 'commit.olax');
  const u8 = await repairedU8(fx, 'commit.olax');

  reset();
  const z = app.parseZip(u8);
  await app.processResultSet(z, { containerName: 'commit-repaired.olax' }, {});
  const meas = new Set(app.store.files[0].traces.map(t => t.measIndex));
  assert.equal(meas.size, 3, 'all three injections are listed measurements');
  const byMeas = new Map(app.store.files[0].traces.map(t => [t.measIndex, t]));
  assert.equal(byMeas.size, 3);
  const stems = [...byMeas.values()].map(t => t.srcStem);
  assert.ok(stems.every(s => s), 'every measurement carries its source stem');
});

test('repaired olax carries non-manifest parts byte-identically', async () => {
  // Data files never change during a repair: .dx/.rx (and anything else
  // that is not the .acaml/.mfx manifest pair) must come out with the
  // exact input bytes, so every checksum recorded elsewhere stays valid.
  const fx = buildCommitOlax();
  const zin = app.parseZip(new Uint8Array(fx.buffer));
  reset();
  await app.parseOlax(fx.buffer, 'commit.olax');
  const u8 = await repairedU8(fx, 'commit.olax');
  const z = app.parseZip(u8);
  for (const [n] of zin.files) {
    if (n.endsWith('/') || /\.(acaml|mfx)$/i.test(n)) continue;
    const outName = [...z.files.keys()].find(x => x.endsWith(n));
    assert.ok(outName, 'part still shipped: ' + n);
    assert.equal(
      app.md5Hex(await app.readZipFile(z, outName)),
      app.md5Hex(await app.readZipFile(zin, n)),
      'bytes unchanged for ' + n);
  }
});

test('repaired wrapper carries native-shaped package core properties', async () => {
  // Native .olax exports ship a psmdcp core-properties part (category,
  // title, creator, created) plus a matching core-properties relationship
  // and content-type default. Repaired archives that synthesize the OPC
  // wrapper must mirror that shape.
  const fx = buildCommitOlax();
  reset();
  await app.parseOlax(fx.buffer, 'commit.olax');
  const u8 = await repairedU8(fx, 'commit.olax');
  const z = app.parseZip(u8);
  const core = [...z.files.keys()].find(n =>
    /^package\/services\/metadata\/core-properties\/[0-9a-f]{32}\.psmdcp$/.test(n));
  assert.ok(core, 'psmdcp part present with deterministic hex name');
  const ct = new TextDecoder().decode(await app.readZipFile(z, '[Content_Types].xml'));
  assert.match(ct, /Extension="psmdcp"/,
    'psmdcp content type declared');
  assert.match(ct, /application\/vnd\.openxmlformats-package\.core-properties\+xml/,
    'psmdcp gets the OPC core-properties content type');
  const rels = new TextDecoder().decode(await app.readZipFile(z, '_rels/.rels'));
  assert.ok(rels.includes('"/' + core + '"'),
    'core-properties relationship targets the part');
  const order = [...rels.matchAll(/Target="([^"]*)"/g)].map(m => m[1]);
  assert.equal(order[order.length - 1], '/' + core,
    'core-properties relationship comes last (native order)');
  const coreXml = new TextDecoder().decode(await app.readZipFile(z, core));
  assert.match(coreXml, /<category>Agilent OpenLab Archive File<\/category>/);
  assert.match(coreXml, /<dc:title>[^<]*\.rslt<\/dc:title>/);
  assert.match(coreXml, /<dc:creator>/, 'creator from the manifest DocInfo');
  assert.match(coreXml, /<dcterms:created xsi:type="dcterms:W3CDTF">/,
    'creation date from the manifest DocInfo');
});

test('variant nocommit: manifest keeps its original injection list', async () => {
  // Diagnostic variant for import bisection: everything repairs (renames,
  // checksums, fileset) but no <MeasData> rows are appended, so the
  // manifest lists exactly the injections the input committed.
  const fx = buildCommitOlax();
  const zin = app.parseZip(new Uint8Array(fx.buffer));
  const inAcaml = [...zin.files.keys()].find(n => /\.acaml$/i.test(n));
  const before = (new TextDecoder().decode(await app.readZipFile(zin, inAcaml))
    .match(/<MeasData /g) || []).length;
  reset();
  await app.parseOlax(fx.buffer, 'commit.olax');
  const outs = await app.buildRepairedOlax(fx.buffer, 'commit.olax', 'nocommit');
  assert.match(outs[0].name, /commit\.repaired-nocommit\.olax$/,
    'variant is visible in the download name');
  const z = app.parseZip(await blobToU8(outs[0].blob));
  const outAcaml = [...z.files.keys()].find(n => /\.acaml$/i.test(n));
  const after = (new TextDecoder().decode(await app.readZipFile(z, outAcaml))
    .match(/<MeasData /g) || []).length;
  assert.equal(after, before, 'no MeasData rows added');
});

test('variant origacaml: manifest ships byte-identically', async () => {
  const fx = buildCommitOlax();
  const zin = app.parseZip(new Uint8Array(fx.buffer));
  const inAcaml = [...zin.files.keys()].find(n => /\.acaml$/i.test(n));
  const inBytes = await app.readZipFile(zin, inAcaml);
  reset();
  await app.parseOlax(fx.buffer, 'commit.olax');
  const outs = await app.buildRepairedOlax(fx.buffer, 'commit.olax', 'origacaml');
  const z = app.parseZip(await blobToU8(outs[0].blob));
  const outAcaml = [...z.files.keys()].find(n => /\.acaml$/i.test(n));
  assert.equal(app.md5Hex(await app.readZipFile(z, outAcaml)),
    app.md5Hex(inBytes), 'acaml untouched');
});

test('variant freshid: new DocID under a valid checksum', async () => {
  // The <DocID> is the document identity a document backend keys on.
  // freshid must swap it BEFORE the checksum is recomputed, so the
  // checksum covers the new identity and the fileset identifier tracks
  // the new bytes.
  const fx = buildCommitOlax();
  const zin = app.parseZip(new Uint8Array(fx.buffer));
  const inAcaml = [...zin.files.keys()].find(n => /\.acaml$/i.test(n));
  const inDocId = /<DocID>([^<]*)<\/DocID>/.exec(
    new TextDecoder().decode(await app.readZipFile(zin, inAcaml)))[1];
  reset();
  await app.parseOlax(fx.buffer, 'commit.olax');
  const outs = await app.buildRepairedOlax(fx.buffer, 'commit.olax', 'freshid');
  const z = app.parseZip(await blobToU8(outs[0].blob));
  const outAcaml = [...z.files.keys()].find(n => /\.acaml$/i.test(n));
  const text = new TextDecoder().decode(await app.readZipFile(z, outAcaml));
  const outDocId = /<DocID>([^<]*)<\/DocID>/.exec(text)[1];
  assert.notEqual(outDocId, inDocId, 'identity is fresh');
  assert.match(outDocId, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    'identity stays a GUID');
  const canonical = app.acamlCanonicalDoc(text);
  assert.ok(canonical != null, 'document canonicalizes');
  assert.equal(/<Value>([^<]*)<\/Value>/.exec(text)[1],
    app.md5Base64(app.encodeUTF8(canonical)),
    'checksum covers the new identity');
  const mfxName = [...z.files.keys()].find(n => /\.mfx$/i.test(n));
  const mfx = new TextDecoder().decode(await app.readZipFile(z, mfxName));
  const acamlEntry = /\.acaml"/.exec(mfx);
  assert.ok(acamlEntry, 'fileset tracks the acaml');
  assert.ok(mfx.includes('Identifier="' +
    app.md5Hex(await app.readZipFile(z, outAcaml)) + '"'),
    'fileset acaml identifier = MD5 of the shipped bytes');
});

test('repaired result set carries its own name (no import collisions)', async () => {
  // Importing a repaired archive must never offer a rename/skip dialog
  // against the original result set: the .rslt folder, the manifest's
  // <Description> (the displayed name) and the core-properties title all
  // state the …-repaired name, and no part keeps the old folder prefix.
  const fx = buildCommitOlax();
  reset();
  await app.parseOlax(fx.buffer, 'commit.olax');
  const u8 = await repairedU8(fx, 'commit.olax');
  const z = app.parseZip(u8);
  const names = [...z.files.keys()];
  const folder = names.map(n => n.split('%5c')[0]).find(f => /\.rslt$/i.test(f));
  assert.equal(folder, 'commit-repaired.rslt', 'folder renamed');
  assert.ok(!names.some(n => n.startsWith('commit.rslt%5c')),
    'no part keeps the original folder prefix');
  const acamlN = names.find(n => /\.acaml$/i.test(n));
  const text = new TextDecoder().decode(await app.readZipFile(z, acamlN));
  assert.ok(text.includes('<Description>commit-repaired</Description>'),
    'manifest description states the repaired name');
  const core = names.find(n => n.endsWith('.psmdcp'));
  const coreXml = new TextDecoder().decode(await app.readZipFile(z, core));
  assert.match(coreXml, /<dc:title>commit-repaired\.rslt<\/dc:title>/,
    'core-properties title follows the folder');
});

test('agifile variant: acaml in the native writer byte shape', async () => {
  // BOM + LF line endings + tab-indented <Checksum> block, content and
  // checksum value untouched — the shape the native ACAML writer emits.
  const fx = buildOlax({ snapshot: 'duplicate', withRx: true });
  reset();
  await app.parseOlax(fx.buffer, 'agifile-src.olax');
  const outs = await app.buildRepairedOlax(fx.buffer, 'agifile-src.olax', 'agifile');
  const z = app.parseZip(blobToU8(outs[0].blob));
  const acamlN = [...z.files.keys()].find(n => /\.acaml$/i.test(n));
  const bytes = await app.readZipFile(z, acamlN);
  assert.ok(bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf,
    'UTF-8 BOM present');
  const text = new TextDecoder('utf-8', { ignoreBOM: true }).decode(bytes).slice(1);
  assert.ok(!text.includes('\r'), 'LF line endings only');
  const ck = /\n\t<Checksum Algorithm="MD5">\n\t\t(<Value>[^<]*<\/Value>)\n\t<\/Checksum>/.exec(text);
  assert.ok(ck, 'tab-indented checksum block');
  // checksum value still verifies against the canonical <Doc> preimage
  assert.equal(/<Value>([^<]*)<\/Value>/.exec(ck[1])[1],
    app.md5Base64(app.encodeUTF8(app.acamlCanonicalDoc(text))),
    'checksum self-consistent in writer form');
  // only the checksum block uses tabs (matches native writer output)
  assert.ok(!/^\t</m.test(text.replace(/\n\t<Checksum Algorithm="MD5">[\s\S]*?\n\t<\/Checksum>/, '')),
    'no other tab-indented elements');
});

test('repaired wrapper matches native .olax layout', async () => {
  // Native OPC part names percent-encode a literal "+" as "%2b", use "+"
  // for a space, and separate folder and file with "%5c" — while manifest
  // (.acaml) and fileset (.mfx) references keep the raw instrument names.
  // Wrapper parts (_rels/.rels, psmdcp, [Content_Types].xml) are stored
  // uncompressed and [Content_Types].xml is the LAST entry; data parts are
  // deflated when the runtime supports it.
  const { acmdInjection, enc, makeZip, TRACE1 } = await import('./fixtures/build-olax.mjs');
  const dxInner = makeZip([
    { name: 'injection.acmd', data: enc(acmdInjection(10, 0, 1, 6000, 5, 3000, 'Test')) },
    { name: `${TRACE1}.CH`, data: new Uint8Array(10 * 8) },
    { name: 'TRACE1.CH', data: new Uint8Array(10 * 8) },
  ]);
  const outer = makeZip([
    { name: 'spacey run.rslt/Run Test+1.acaml', data: enc(
      `<?xml version="1.0"?>\r\n<ACAML xmlns="urn:schemas-agilent-com:acaml21" schemaversion="2.1.30.999">\r\n  <Checksum Algorithm="MD5">\r\n    <Value>placeholder==</Value>\r\n  </Checksum>\r\n  <Doc><DocID>d</DocID><Description>spacey run</Description><CreatedByUser>u</CreatedByUser><CreationDate>2026-08-28T15:15:00+02:00</CreationDate><Content>\r\n    <MeasData>\r\n      <Injection>1</Injection>\r\n      <Path>Run Test+1.dx</Path>\r\n      <Signals>\r\n        <Signal><Name>TRACE1</Name></Signal>\r\n      </Signals>\r\n    </MeasData>\r\n  </Content></Doc>\r\n</ACAML>\r\n`.replaceAll('\r\n', '\n')) },
    { name: 'spacey run.rslt/Run Test+1.dx', data: dxInner },
  ]);
  reset();
  await app.parseOlax(outer.buffer, 'spacey.zip');
  const outs = await app.buildRepairedOlax(outer.buffer, 'spacey.zip');
  const u8 = blobToU8(outs[0].blob);
  const z = app.parseZip(u8);
  const names = [...z.files.keys()];

  // folder rename applies to the decoded folder; part names use native encoding
  assert.ok(names.includes('spacey+run-repaired.rslt%5cRun+Test%2b1.dx'),
    'space->"+", plus->"%2b": ' + names.join(' | '));
  assert.ok(!names.some(n => n.includes(' ')), 'no raw spaces in part names');
  const rels = new TextDecoder().decode(await app.readZipFile(z, '_rels/.rels'));
  assert.ok(rels.includes('"/spacey+run-repaired.rslt%5cRun+Test%2b1.dx"'),
    'rels targets use the native encoding');

  // manifest keeps RAW names
  const acamlN = names.find(n => /\.acaml$/i.test(n));
  const acaml = new TextDecoder().decode(await app.readZipFile(z, acamlN));
  assert.ok(acaml.includes('<Path>Run Test+1.dx</Path>'), 'acaml path stays raw');
  assert.ok(acaml.includes('<Description>spacey+run-repaired</Description>') ||
    acaml.includes('<Description>spacey run-repaired</Description>'),
    'description states the repaired name');

  // reparse round-trips through the decode
  reset();
  await app.parseOlax(u8.buffer, 'repaired.olax', { repairSnapshots: false });
  assert.ok(app.allTraces().length >= 1, 'reparse decodes part names');

  // compression + entry order parity (native layout)
  if (typeof CompressionStream !== 'undefined' && typeof Response === 'function') {
    const dxEntry = z.files.get('spacey+run-repaired.rslt%5cRun+Test%2b1.dx');
    assert.equal(dxEntry.method, 8, 'data parts deflated');
    for (const w of ['_rels/.rels', '[Content_Types].xml'])
      assert.equal(z.files.get(w).method, 0, w + ' stored');
  }
  const idx = names.indexOf('[Content_Types].xml');
  assert.equal(idx, names.length - 1, '[Content_Types].xml is the last entry');

  // relationship ids: R + 16 lowercase hex, like native exports
  const ids = [...rels.matchAll(/Id="(R[0-9a-f]+)"/g)].map(m => m[1]);
  assert.ok(ids.length >= 2);
  assert.ok(ids.every(id => /^R[0-9a-f]{16}$/.test(id)), 'native rel id form');
});
