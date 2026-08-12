// Builds PII-free synthetic OpenLab "Content Manager" export zips for tests.
// Mirrors the real structure of 2026.zip (verified locally): a plain zip whose
// `.rslt` folders — sometimes nested several levels deep — each contain the same
// file set as a single .olax (.dx/.rx/.acaml/.amx/…). Also builds an OPC-style
// single-.olax (percent-encoded "%5c" separator) to exercise that path.
import {
  makeZip, enc, acamlRegistry, acmdInjection, rxInjectionACAML,
  TRACE1, PEAK, COMPOUND, CALIBRATION,
} from './build-olax.mjs';

// --- a synthetic .amx acquisition-method package ---------------------------------
// The app classifies HPLC vs GC from the DeviceMethodSettings/ driver-module NAMES
// (central directory only). HPLC -> AgilentPump/Vwd… ; GC -> a single "GC<#>" module.
export function amxZip(type) {
  const drivers = type === 'GC'
    ? ['GC1%0']
    : ['AgilentPumpDriver0', 'AgilentVwdDriver0', 'AgilentSamplerDriver0'];
  const entries = [
    { name: '[Content_Types].xml', data: enc('<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>') },
    { name: 'Agilent/MethodType', data: enc('Acquisition') },
    ...drivers.flatMap((d) => [
      { name: `DeviceMethodSettings/${d}`, data: enc('<method/>') },
      { name: `DeviceMethodSettings/${d}.chk`, data: enc('chk') },
    ]),
  ];
  return makeZip(entries);
}

// --- one .rslt folder: a single Gaussian-trace measurement with a known peak ------
function gaussianTrace() {
  const N = 800, tEnd = 480000, dt = tEnd / N;
  const amp = 1.0, baseline = 0.05, sigma = 16000, t0 = 240000;
  const g = new Float64Array(N);
  let min = Infinity, max = -Infinity;
  for (let i = 0; i < N; i++) {
    const t = i * dt;
    g[i] = baseline + amp * Math.exp(-((t - t0) ** 2) / (2 * sigma * sigma));
    if (g[i] < min) min = g[i];
    if (g[i] > max) max = g[i];
  }
  return { N, tEnd, min, max, buf: new Uint8Array(g.buffer) };
}

function rsltFiles({ instrLabel, type, sample, dxBase }) {
  const { N, tEnd, min, max, buf } = gaussianTrace();
  const dxZip = makeZip([
    { name: 'injection.acmd', data: enc(acmdInjection(N, min, max, tEnd, 0, 0, sample)) },
    { name: `${TRACE1}.CH`, data: buf },
    { name: '[Content_Types].xml', data: enc('<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>') },
  ]);
  const rxZip = makeZip([
    { name: '[Content_Types].xml', data: enc('<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/Base/InjectionACAML" ContentType="text/xml"/></Types>') },
    { name: 'Base/InjectionACAML', data: enc(rxInjectionACAML()) },
    { name: 'Base/AuditTrail', data: enc('audit') },
  ]);
  return [
    { name: `${instrLabel} FDG.amx`, data: amxZip(type) },
    { name: `${instrLabel}.acaml`, data: enc(acamlRegistry()) },
    { name: `${dxBase}.dx`, data: dxZip },
    { name: `${dxBase}.rx`, data: rxZip },
  ];
}

// --- the three fixtures ----------------------------------------------------------

// A CM export with two .rslt folders at DIFFERENT depths, one HPLC and one GC.
export function buildResultsZip() {
  const hplc = rsltFiles({ instrLabel: 'HPLC01', type: 'HPLC', sample: 'Blank', dxBase: '2025-01-01 10-00-00+02-00' });
  const gc = rsltFiles({ instrLabel: 'GC02', type: 'GC', sample: 'Std-A', dxBase: '2025-01-02 11-00-00+02-00' });

  const entries = [];
  const push = (prefix, files) => { for (const f of files) entries.push({ name: `${prefix}/${f.name}`, data: f.data }); };
  push('proj/2025/Instr HPLC-01 2025-01-01.SST.rslt', hplc);                 // depth 2 above .rslt
  push('proj/2025/Q4/deep/Instr GC-02 2025-01-02.NR.rslt', gc);              // depth 4 above .rslt (nested)

  return {
    buffer: makeZip(entries),
    expected: {
      groups: 2,
      hplc: { type: 'HPLC', instrument: 'HPLC01', sample: 'Blank', peak: PEAK, compound: COMPOUND, calibration: CALIBRATION },
      gc: { type: 'GC', instrument: 'GC02', sample: 'Std-A', peak: PEAK, compound: COMPOUND, calibration: CALIBRATION },
    },
  };
}

// A standalone .olax OPC package (percent-encoded "%5c" in-package separator) —
// one .rslt folder — to prove the same grouper handles OPC too.
export function buildOlaxOpc() {
  const files = rsltFiles({ instrLabel: 'HPLC03', type: 'HPLC', sample: 'SST', dxBase: '2025-03-03 09-00-00+02-00' });
  const entries = files.map((f) => ({ name: `RPBe-HPLC-03 2025-03-03+09-00-00%2b02-00_.rslt%5c${f.name}`, data: f.data }));
  return { buffer: makeZip(entries), expected: { groups: 1, type: 'HPLC', instrument: 'HPLC03', sample: 'SST' } };
}

// A .rslt with a .dx but NO .rx (and no .acaml) — traces only, empty results.
export function buildNoRxZip() {
  const { N, tEnd, buf } = gaussianTrace();
  const dxZip = makeZip([
    { name: 'injection.acmd', data: enc(acmdInjection(N, 0, 1, tEnd, 0, 0, 'NoRx')) },
    { name: `${TRACE1}.CH`, data: buf },
    { name: '[Content_Types].xml', data: enc('<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>') },
  ]);
  return {
    buffer: makeZip([
      { name: 'p/Instr HPLC-05 2025-05-05.X.rslt/HPLC05 FDG.amx', data: amxZip('HPLC') },
      { name: 'p/Instr HPLC-05 2025-05-05.X.rslt/2025-05-05 08-00-00+02-00.dx', data: dxZip },
      // deliberately no .rx
    ]),
  };
}
