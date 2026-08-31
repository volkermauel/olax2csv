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

export function acamlRegistry(paths = ['Run_Test.dx']) {
  const inj = paths.map(p => `  <InjectionMetaData><Path>${p}</Path></InjectionMetaData>`).join('\n');
  return `<?xml version="1.0" encoding="utf-8"?>
<ACAML xmlns="urn:schemas-agilent-com:acaml21" schemaversion="2.1.30.999">
<Checksum Algorithm="MD5"><Value>placeholder==</Value></Checksum>
 <Doc><Content><Resources>
  <Signal id="${SIG1}"><Name>SIM1</Name><ChannelName>A</ChannelName><Description>SIM1,Simulated detector 1</Description></Signal>
 </Resources>
 <Injections>
${inj}
 </Injections></Content></Doc>
</ACAML>`;
}

export function acmdInjection(N1, min1, max1, tEnd1, N2, tEnd2, sampleName,
  runDT = '2026-07-10T10:00:00.0000000+02:00', traceA = TRACE1, traceB = TRACE2) {
  return `<?xml version="1.0" encoding="utf-8"?>
<Injection xmlns="urn:schemas-agilent-com:acmd20">${sampleName ? `\n  <SampleName>${sampleName}</SampleName>` : ''}
  <RunDateTime>${runDT}</RunDateTime>
  <Signal>
    <TraceId>${traceA}</TraceId>
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
    <TraceId>${traceB}</TraceId>
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

export function buildOlax({ withRx = true, snapshot = 'none', opc = false, mfx = null } = {}) {
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
      { name: 'Run.acaml', data: enc(acamlRegistry([snapDxName])) },
      { name: snapRxName, data: rxZip },
    );
  } else if (snapshot === 'duplicate') {
    if (withRx) olaxEntries.push({ name: dxName.replace(/\.dx$/, '.rx'), data: rxZip });
    olaxEntries.push({ name: snapDxName, data: dxZip });
    olaxEntries.push({ name: snapRxName, data: rxZip });
    // Manifest written while both existed — references regular AND snapshot names.
    const reg = olaxEntries.find(e => e.name === 'Run.acaml');
    reg.data = enc(acamlRegistry([dxName, snapDxName]));
  } else if (snapshot === 'rxOnly') {
    olaxEntries.push({ name: snapRxName, data: rxZip });
    const reg = olaxEntries.find(e => e.name === 'Run.acaml');
    reg.data = enc(acamlRegistry([dxName, snapRxName]));
  } else if (withRx) {
    olaxEntries.push({ name: dxName.replace(/\.dx$/, '.rx'), data: rxZip });
  }

  // opc: wrap like a real OpenLab .olax (OPC [Content_Types].xml + _rels/.rels
  // referencing every part, snapshots included) so repairs must maintain them.
  if (opc) {
    const rels = '\ufeff<?xml version="1.0" encoding="utf-8"?>' +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      olaxEntries.map((e, i) =>
        `<Relationship Type="urn:schemas-agilent-com:OpenLabArchive" Target="/${e.name}" Id="R${(i + 1).toString(16).padStart(16, '0')}"/>`).join('') +
      '</Relationships>';
    const exts = new Set([...olaxEntries.map(e => e.name.split('.').pop().toLowerCase()), 'rels']);
    const ct = '\ufeff<?xml version="1.0" encoding="utf-8"?>' +
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
      [...exts].map(x => `<Default Extension="${x}" ContentType="${x === 'rels' ? 'application/vnd.openxmlformats-package.relationships+xml' : 'Agilent.OpenLab.Archive/ArchiveFile'}"/>`).join('') +
      '</Types>';
    olaxEntries.push({ name: '_rels/.rels', data: enc(rels) });
    olaxEntries.push({ name: '[Content_Types].xml', data: enc(ct) });
  }

  if (mfx) olaxEntries.push({ name: 'Run.mfx', data: enc(filesetManifest(mfx)) });

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

/* ---------- full-structure result-set manifest (commit scenarios) ---------- */

// Mirrors the .acaml OpenLab actually writes: DocInfo custom field
// "InjectionMetaDataItems" with <ArrayOfInjectionMetaData>, Content/Injections
// <MeasData> rows (one per injection, with Signal rows), and Content/Samples
// (setup + sample row linking its injections). Used to test committing
// .dx files that were acquired but never committed to the manifest.
export const SETUP1 = 'dddddddd-0000-4000-8000-0000000000aa';
export const METHOD1 = 'dddddddd-0000-4000-8000-0000000000bb';
export const CONTAINER1 = 'dddddddd-0000-4000-8000-0000000000cc';
export const SAMPLE_ROW = 'dddddddd-0000-4000-8000-0000000000dd';

const sigBlock = (dx, sigName, chan, desc, traceId, type) => `      <Signal id="${sigName}-s" ver="0">
        <ComplexCustomFields />
        <BinaryData>
          <DataItem>
            <Name>${dx}</Name>
            <OriginalFilePath>${dx}</OriginalFilePath>
            <Data><DataFileReference><Path>${dx}</Path></DataFileReference></Data>
          </DataItem>
        </BinaryData>
        <Name>${sigName}</Name>
        <Description>${desc}</Description>
        <Type>${type}</Type>
        <TraceID>${traceId}</TraceID>
        <UserGenerated>false</UserGenerated>
        <AutomationGenerated>false</AutomationGenerated>
        <DetectorName>SIMDEV</DetectorName>
        <DetectorInstance>1</DetectorInstance>
        <ChannelName>${chan}</ChannelName>
        <PeakDeletions />
        <InstrumentModule_ID id="${METHOD1}" />
      </Signal>`;

// rows: [{ dx, guid, repl, runDT (local ISO), utcDT (UTC ISO), rx }]
export function acamlManifest(rows) {
  const imd = rows.map(r => `          <InjectionMetaData AcqMethodName="FixtureMethod" DaMethodName="" ExpectedBarcode="" InjectionAcqDateTime="${r.utcDT}" InjectionId="${r.guid}" InjectorPosition="Front" InstrumentName="SIM-HPLC" LastModifiedDateTime="${r.utcDT}" BracketingType="Undefined" RawDataFileName="${r.dx}" SampleDescription="" SampleLabel="" SampleName="Std" SampleSetupId="${SETUP1}" SampleType="Sample" SequenceName="FixtureSeq" VialNumber="1">
              <LimsIds key="" />
              <Locked>false</Locked>
              <Dil>1;1</Dil>
              <Mult>1;1</Mult>
              <ReplicateNumber val="${r.repl}" />
              <SampleAmount val="0" unit="" />
              <SampleInjectionsCount val="3" />
              <SampleOrderNumber val="1" />
            </InjectionMetaData>`).join('\n');
  const md = rows.map(r => `        <MeasData id="${r.guid}" ver="0">
          <Info>
            <CreatedBy><Username>tester</Username></CreatedBy>
            <CreatedDate>${r.runDT}</CreatedDate>
            <LastModifiedBy><Username>tester</Username></LastModifiedBy>
            <LastModifiedDate>${r.runDT}</LastModifiedDate>
          </Info>
          <ComplexCustomFields />
          <BinaryData>
            <DataItem>
              <Name>${r.dx}</Name>
              <OriginalFilePath>/CMC/Results/Fixture.rslt</OriginalFilePath>
              <Data><DataFileReference><Path>${r.dx}</Path></DataFileReference></Data>
            </DataItem>
          </BinaryData>
          <AcqParam>
            <Method_ID id="${METHOD1}" ver="0" />
            <OrderNo val="${r.repl}" />
          </AcqParam>
${sigBlock(r.dx, 'SIM1A', 'A', 'SIM1A,Wavelength=220 nm', r.traceA, 'Chromatogram')}
${sigBlock(r.dx, 'SIM1Z', 'Z', 'SIM1Z,Zero baseline', r.traceB, 'InstrumentCurve')}
          <InjectionVolume val="20" unit="µL" />
          <DiagnosticData />
${r.rx ? `          <ExternalResultPath>${r.rx}</ExternalResultPath>\n` : ''}          <SampleContainerInfo_ID id="${CONTAINER1}" ver="0" />
          <SampleLocationIdentifier />
        </MeasData>`).join('\n');
  const refs = rows.map(r => `          <InjectionMeasData_ID id="${r.guid}" ver="0" />`).join('\n');
  return `<?xml version="1.0" encoding="utf-8"?>
<ACAML xmlns="urn:schemas-agilent-com:acaml21" schemaversion="2.1.30.999">
<Checksum Algorithm="MD5"><Value>placeholder==</Value></Checksum>
 <Doc>
  <DocInfo>
   <CustomField Name="CreatedByUserDisplayName"><TypedValue>tester</TypedValue></CustomField>
   <CustomField Name="InjectionMetaDataItems">
    <Xml>
      <ArrayOfInjectionMetaData>
${imd}
      </ArrayOfInjectionMetaData>
    </Xml>
   </CustomField>
  </DocInfo>
  <Content>
   <Method id="${METHOD1}" ver="0"><Info /><Name>FixtureMethod</Name></Method>
   <Samples>
    <Setup id="${SETUP1}" ver="0">
     <Info><CreatedBy><Username>tester</Username></CreatedBy><CreatedDate>2026-07-10T09:00:00.0000000+02:00</CreatedDate></Info>
     <IdentParam><Name>Std</Name><Description /><ProjectID>CMC</ProjectID><ExpectedBarcode /></IdentParam>
     <AcqParam><OrderNo val="1" /><VialNumber>1</VialNumber><NumberOfInjections val="3" /><InjectionVolume val="20" unit="µL" /></AcqParam>
    </Setup>
    <MeasData id="${SAMPLE_ROW}" ver="0">
      <AcqParam><VialNumber>1</VialNumber><NumberOfInjections val="3" /></AcqParam>
      <SampleSetup_ID id="${SETUP1}" ver="0" />
${refs}
      <DiagnosticData />
    </MeasData>
   </Samples>
   <Injections>
${md}
   </Injections>
  </Content>
 </Doc>
</ACAML>`;
}

// Minimal Fileset so the .mfx repair path (Identifier follow + File entries
// for unregistered .dx) can be tested.
export function filesetManifest(paths = []) {
  const files = paths.map(p => {
    const path = typeof p === 'string' ? p : p.path;
    const id = typeof p === 'string' || !p.md5
      ? '00000000000000000000000000000000' : p.md5;
    return `    <File Path="${path}" IdentifierAlgorithm="MD5" Identifier="${id}">
      <Property Name="appVersion" Value="ACQ-2026-0710-1000-00001" />
    </File>`;
  }).join('\n');
  return `<?xml version="1.0" encoding="utf-8"?>
<Fileset IdentifierAlgorithm="" Identifier="" xmlns="urn:schemas-agilent-com:Fileset">
  <Files>
    <File Path="Run.acaml" IdentifierAlgorithm="MD5" Identifier="00000000000000000000000000000000">
      <Property Name="appVersion" Value="ACQ-2026-0710-1000-00001" />
    </File>
${files}
  </Files>
</Fileset>`;
}

// A result set where only r001 was committed: r002/r003 .dx were acquired
// (with per-injection trace GUIDs and RunDateTime in their injection.acmd)
// but the session ended before the manifest was updated — the state an
// abandoned snapshot session leaves behind.
export function buildCommitOlax({ healthy = false } = {}) {
  const mkDx = (i, runDT) => {
    const tA = `eeeeeeee-0000-4000-8000-00000000000${i}a`;
    const tB = `eeeeeeee-0000-4000-8000-00000000000${i}b`;
    return {
      zip: makeZip([
        { name: 'injection.acmd', data: enc(acmdInjection(10, 0, 1, 6000, 5, 3000, 'Std', runDT, tA, tB)) },
        { name: `${tA}.CH`, data: new Float64Array(10) },
        { name: `${tB}.CH`, data: new Float64Array(5) },
        { name: '[Content_Types].xml', data: enc('<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>') },
      ]),
      tA, tB
    };
  };
  const runs = [
    { repl: 1, runDT: '2026-07-10T10:15:30.1234567+02:00', utcDT: '2026-07-10T08:15:30.123Z' },
    { repl: 2, runDT: '2026-07-10T11:00:00.5000000+02:00', utcDT: '2026-07-10T09:00:00.500Z' },
    { repl: 3, runDT: '2026-07-10T11:45:10.2500000+02:00', utcDT: '2026-07-10T09:45:10.250Z' },
  ].map((r, i) => ({ ...r, dx: `Run_Std-r00${i + 1}.dx`, ...mkDx(i + 1, r.runDT) }));
  const committed = healthy ? runs : [runs[0]];
  const guid = (i) => `abcdef0${i}-0000-4000-8000-00000000000${i}`;
  const rows = committed.map((r, i) => ({
    dx: r.dx, guid: guid(i + 1), repl: r.repl, runDT: r.runDT, utcDT: r.utcDT,
    traceA: r.tA, traceB: r.tB, rx: 'Run_Std-r001.rx'
  }));
  const entries = [
    ...runs.map(r => ({ name: r.dx, data: r.zip })),
    { name: 'Run_Std-r001.rx', data: makeZip([
      { name: '[Content_Types].xml', data: enc('<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>') },
      { name: 'Base/InjectionACAML', data: enc(rxInjectionACAML()) },
    ]) },
    { name: 'Run.acaml', data: enc(acamlManifest(rows)) },
    { name: 'Run.mfx', data: enc(filesetManifest(['Run_Std-r001.dx'])) },
  ];
  return { buffer: makeZip(entries).buffer, runs };
}
