// Builds an ARBITRARY, PII-free synthetic .olax for automated testing.
// Mirrors the structure of a real OpenLab CDS export:
//   <root>.acaml            -> signal registry (acaml21)
//   <run>_<sample>.dx        -> ZIP: injection.acmd (acmd20) + <traceId>.CH (Float64LE)
//   <run>_<sample>.rx        -> ZIP: Base/InjectionACAML (acaml21) with peak/compound/calibration
// All zips use DEFLATE (method 8) so the app's inflate path is exercised.
//
// Output values (RT, area, amount, coeffs, ...) are FIXED constants asserted by the tests,
// so this file is the single source of truth for expected test values.

import zlib from 'node:zlib';

/* ---------- minimal ZIP writer (STORE + DEFLATE) ---------- */

const CRC = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[i] = c >>> 0;
  }
  return t;
})();

function crc32(u8) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < u8.length; i++) c = CRC[(c ^ u8[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

const u16 = (n) => [n & 255, (n >>> 8) & 255];
const u32 = (n) => [n & 255, (n >>> 8) & 255, (n >>> 16) & 255, (n >>> 24) & 255];

export function makeZip(entries) {
  const enc = new TextEncoder();
  const parts = [], central = [];
  let offset = 0;

  for (const e of entries) {
    const nameBytes = enc.encode(e.name);
    const data = e.data;
    const comp = zlib.deflateRawSync(data);   // raw DEFLATE -> app reads via "deflate-raw"
    const method = 8;
    const crc = crc32(data);

    const lfh = [
      ...u32(0x04034b50), ...u16(20), ...u16(0), ...u16(method),
      ...u16(0), ...u16(0),
      ...u32(crc), ...u32(comp.length), ...u32(data.length),
      ...u16(nameBytes.length), ...u16(0),
    ];
    parts.push(new Uint8Array(lfh), nameBytes, comp);

    const cdh = [
      ...u32(0x02014b50), ...u16(20), ...u16(20), ...u16(0), ...u16(method),
      ...u16(0), ...u16(0),
      ...u32(crc), ...u32(comp.length), ...u32(data.length),
      ...u16(nameBytes.length), ...u16(0), ...u16(0),
      ...u16(0), ...u16(0), ...u32(0), ...u32(offset),
    ];
    central.push(new Uint8Array(cdh), nameBytes);

    offset += lfh.length + nameBytes.length + comp.length;
  }

  const cdStart = offset;
  for (const c of central) { parts.push(c); offset += c.length; }
  const cdSize = offset - cdStart;

  const eocd = [
    ...u32(0x06054b50), ...u16(0), ...u16(0),
    ...u16(entries.length), ...u16(entries.length),
    ...u32(cdSize), ...u32(cdStart), ...u16(0),
  ];
  parts.push(new Uint8Array(eocd));

  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

export const enc = (s) => new TextEncoder().encode(s);

/* ---------- known, fixed test constants ---------- */

export const SIG1   = '11111111-1111-4111-8111-111111111111'; // detector signal GUID
export const TRACE1 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1'; // gaussian trace
export const TRACE2 = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2'; // all-zero trace
export const CALIB  = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'; // calibration curve

export const PEAK = {
  rt: 5.0, type: 'NormalPeak', area: 1234.5, areaUnit: 'mAU·s',
  areaPct: 98.5, height: 100, heightUnit: 'mAU', begin: 4.8, end: 5.2,
  baselineCode: 'BB', sn: 500, plates: 10000, resolution: 2.5,
  purity: 'true', baselineModel: 'Linear',
};
export const COMPOUND = {
  name: 'ANALYTE', type: 'Expected', amount: 10, amountUnit: 'µg/ml',
  conc: 10, concUnit: 'µg/ml', area: 1234.5, height: 100,
  expRT: 5.0, expSignal: 'SIM1', quantType: 'Area',
};
export const CALIBRATION = {
  compound: 'ANALYTE', type: 'Linear', formula: 'y = ax + b',
  origin: 'Include', weight: 'None', r: 0.999, residual: 1.5,
  a: 10, b: 0.5, c: 0,
  level: 1, levelAmount: 1, levelUnit: 'µg/ml',
  avgResponse: 10.5, avgResponseAbs: 10.5, relResidualPct: 0.1,
};

/* ---------- XML builders ---------- */

export function acamlRegistry() {
  return `<?xml version="1.0" encoding="utf-8"?>
<ACAML xmlns="urn:schemas-agilent-com:acaml21" schemaversion="2.1.30.999">
 <Doc><Content><Resources>
  <Signal id="${SIG1}"><Name>SIM1</Name><ChannelName>A</ChannelName><Description>SIM1,Simulated detector 1</Description></Signal>
 </Resources></Content></Doc>
</ACAML>`;
}

export function acmdInjection(N1, min1, max1, tEnd1, N2, tEnd2, sampleName) {
  return `<?xml version="1.0" encoding="utf-8"?>
<Injection xmlns="urn:schemas-agilent-com:acmd20">${sampleName ? `\n  <SampleName>${sampleName}</SampleName>` : ''}
  <Signal>
    <TraceId>${TRACE1}</TraceId>
    <DeviceName>SIMDEV</DeviceName>
    <ChannelName>SIM1A</ChannelName>
    <Description>SIM1A,Wavelength=220 nm</Description>
    <Units>mAU</Units>
    <Encoding>Numeric/Float64/Signal179</Encoding>
    <NumberOfValues>${N1}</NumberOfValues>
    <TimeStart>0</TimeStart>
    <TimeEnd>${tEnd1}</TimeEnd>
    <Minimum>${min1}</Minimum>
    <Maximum>${max1}</Maximum>
    <Slope>1</Slope>
  </Signal>
  <Signal>
    <TraceId>${TRACE2}</TraceId>
    <DeviceName>SIMDEV</DeviceName>
    <ChannelName>SIM1Z</ChannelName>
    <Description>SIM1Z,Zero baseline</Description>
    <Units>mAU</Units>
    <Encoding>Numeric/Float64/Signal179</Encoding>
    <NumberOfValues>${N2}</NumberOfValues>
    <TimeStart>0</TimeStart>
    <TimeEnd>${tEnd2}</TimeEnd>
    <Minimum>0</Minimum>
    <Maximum>0</Maximum>
    <Slope>1</Slope>
  </Signal>
</Injection>`;
}

export function rxInjectionACAML() {
  return `<?xml version="1.0" encoding="utf-8"?>
<ACAML xmlns="urn:schemas-agilent-com:acaml21" schemaversion="2.1.30.999">
 <Doc>
  <Content>
   <Resources>
    <CalibrationCurve id="${CALIB}">
      <CorrCoefficient val="${CALIBRATION.r}"/>
      <Origin>${CALIBRATION.origin}</Origin>
      <Type>${CALIBRATION.type}</Type>
      <Formula>${CALIBRATION.formula}</Formula>
      <Coefficients><A val="${CALIBRATION.a}"/><B val="${CALIBRATION.b}"/><C val="${CALIBRATION.c}"/></Coefficients>
      <WeightType>${CALIBRATION.weight}</WeightType>
      <Residual val="${CALIBRATION.residual}"/>
      <CalibrationLevel>
        <Level val="${CALIBRATION.level}"/>
        <Amount val="${CALIBRATION.levelAmount}" unit="${CALIBRATION.levelUnit}"/>
        <AverageResponse val="${CALIBRATION.avgResponse}"/>
        <AverageResponseAbs val="${CALIBRATION.avgResponseAbs}"/>
        <RelativeResidualPercent val="${CALIBRATION.relResidualPct}"/>
      </CalibrationLevel>
    </CalibrationCurve>
   </Resources>
   <Injections>
    <Result>
     <Info>
      <LastModifiedBy><Username>TEST_USER</Username></LastModifiedBy>
      <CreatedDate>2025-01-01T00:00:00Z</CreatedDate>
      <LastModifiedDate>2025-01-01T00:00:00Z</LastModifiedDate>
     </Info>
     <DAParam>
      <OrderNo>42</OrderNo>
      <CalibrationStandard><Identifier>STD_A</Identifier><Amount val="1" unit="µg/ml"/></CalibrationStandard>
      <CalibrationStandard><Identifier>STD_B</Identifier><Amount val="2" unit="µg/ml"/></CalibrationStandard>
      <SampleBracketingType>None</SampleBracketingType>
     </DAParam>
     <SignalResult>
      <Signal_ID id="${SIG1}" ver="0"/>
      <Peak>
        <RetentionTime val="${PEAK.rt}" unit="min"/>
        <Type>${PEAK.type}</Type>
        <Area val="${PEAK.area}" unit="${PEAK.areaUnit}"/>
        <AreaPercent val="${PEAK.areaPct}"/>
        <Height val="${PEAK.height}" unit="${PEAK.heightUnit}"/>
        <BeginTime val="${PEAK.begin}" unit="min"/>
        <EndTime val="${PEAK.end}" unit="min"/>
        <BaselineCode>${PEAK.baselineCode}</BaselineCode>
        <TheoreticalPlates_EP val="${PEAK.plates}"/>
        <Resolution_EP val="${PEAK.resolution}"/>
        <SignalToNoise val="${PEAK.sn}"/>
        <PurityPassed>${PEAK.purity}</PurityPassed>
        <BaselineModel>${PEAK.baselineModel}</BaselineModel>
      </Peak>
     </SignalResult>
     <InjectionCompound>
      <CompoundName>${COMPOUND.name}</CompoundName>
      <Type>${COMPOUND.type}</Type>
      <Identification><Qualified><Peaks><Peak_ID id="pk1" calibPeakRole="Main"/></Peaks></Qualified></Identification>
      <Amount val="${COMPOUND.amount}" unit="${COMPOUND.amountUnit}"/>
      <Concentration val="${COMPOUND.conc}" unit="${COMPOUND.concUnit}"/>
      <Area val="${COMPOUND.area}"/>
      <Height val="${COMPOUND.height}"/>
      <ExpectedRetTime val="${COMPOUND.expRT}" unit="min"/>
      <ExpectedSignal>${COMPOUND.expSignal}</ExpectedSignal>
      <CalibrationCurve_ID id="${CALIB}"/>
      <QuantitationType>${COMPOUND.quantType}</QuantitationType>
      <IsInternalStandard>false</IsInternalStandard>
      <IsTimeRef>false</IsTimeRef>
     </InjectionCompound>
     <Integrator>Integrator</Integrator>
     <NoiseType>RMS</NoiseType>
     <CalibrationCurveChanged>false</CalibrationCurveChanged>
     <ReprocessingRequired>false</ReprocessingRequired>
     <ProcessingStatus>
      <ProcessingStatusItem><Category>Integrate</Category><TransformationState>Done</TransformationState><Message>ok</Message></ProcessingStatusItem>
     </ProcessingStatus>
    </Result>
   </Injections>
  </Content>
 </Doc>
</ACAML>`;
}

/* ---------- public builder ---------- */

export function buildOlax({ withRx = true, snapshot = 'none' } = {}) {
  // Trace 1: a clean Gaussian peak + small baseline (exercises bestFloatSegment)
  const N1 = 1000, tStart1 = 0, tEnd1 = 600000; // ms -> 10 min run
  const dt1 = (tEnd1 - tStart1) / N1;
  const amp = 1.0, baseline = 0.05, sigma = 20000, t0 = 300000;
  const g = new Float64Array(N1);
  let min1 = Infinity, max1 = -Infinity;
  for (let i = 0; i < N1; i++) {
    const t = tStart1 + i * dt1;
    g[i] = baseline + amp * Math.exp(-((t - t0) ** 2) / (2 * sigma * sigma));
    if (g[i] < min1) min1 = g[i];
    if (g[i] > max1) max1 = g[i];
  }

  // Trace 2: all zeros (exercises findAllZeroSegment)
  const N2 = 500, tEnd2 = N2 * 600;
  const z = new Float64Array(N2);

  // .dx (inner zip)
  const dxEntries = [
    { name: 'injection.acmd', data: enc(acmdInjection(N1, min1, max1, tEnd1, N2, tEnd2)) },
    { name: `${TRACE1}.CH`, data: new Uint8Array(g.buffer) },
    { name: `${TRACE2}.CH`, data: new Uint8Array(z.buffer) },
    { name: '[Content_Types].xml', data: enc('<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>') },
  ];
  const dxZip = makeZip(dxEntries);
  const dxName = 'Run_Test.dx';

  const olaxEntries = [
    { name: dxName, data: dxZip },
    { name: 'Run.acaml', data: enc(acamlRegistry()) },
  ];

  // Snapshot variants ("snapshot mode left unclosed"):

  //   none      – as before.

  //   only      – the run exists ONLY as snapshot-<ts>-Run_Test.dx/.rx (the

  //               completed counterpart was never written).

  //   duplicate – regular Run_Test.dx/.rx PLUS a snapshot-… copy (snapshot is a

  //               partial duplicate that must be ignored).

  //   rxOnly    – regular Run_Test.dx but the processed results exist only as

  //               snapshot-…-Run_Test.rx.

  const rxEntries = [
    {
      name: '[Content_Types].xml',
      data: enc('<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/Base/InjectionACAML" ContentType="text/xml"/></Types>'),
    },
    { name: 'Base/InjectionACAML', data: enc(rxInjectionACAML()) },
    { name: 'Base/AuditTrail', data: enc('audit') },
  ];
  const rxZip = makeZip(rxEntries);
  const snapDxName = 'snapshot-20260710 084732-Run_Test.dx';
  const snapRxName = 'snapshot-20260710 084732-Run_Test.rx';

  if (snapshot === 'only') {
    olaxEntries.length = 0; // drop the regular run; keep only the manifest
    olaxEntries.push(
      { name: snapDxName, data: dxZip },
      { name: 'Run.acaml', data: enc(acamlRegistry()) },
      { name: snapRxName, data: rxZip },
    );
  } else if (snapshot === 'duplicate') {
    if (withRx) olaxEntries.push({ name: dxName.replace(/\.dx$/, '.rx'), data: rxZip });
    olaxEntries.push({ name: snapDxName, data: dxZip });
    olaxEntries.push({ name: snapRxName, data: rxZip });
  } else if (snapshot === 'rxOnly') {
    olaxEntries.push({ name: snapRxName, data: rxZip });
  } else if (withRx) {
    olaxEntries.push({ name: dxName.replace(/\.dx$/, '.rx'), data: rxZip });
  }

  return {
    buffer: makeZip(olaxEntries),
    expected: {
      sample: 'Test',
      signalName: 'SIM1',
      N1, tStart1, tEnd1, dt1,
      gaussian: Array.from(g),
      min1, max1,
      N2,
      withRx, snapshot,
      peak: withRx ? PEAK : null,
      compound: withRx ? COMPOUND : null,
      calibration: withRx ? CALIBRATION : null,
    },
  };
}
