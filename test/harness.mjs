// Test harness: loads the SHIPPED index.html, extracts the application <script>,
// and evaluates it inside a Node VM context with browser-ish shims so the real
// artifact (not a copy) is what the tests exercise.
//
// Shims:
//   - DOMParser: @xmldom/xmldom (wrapped to add querySelector, which xmldom lacks)
//   - XLSX:      real SheetJS (same version embedded in index.html)
//   - inflateRawOrDeflate: overridden to use node:zlib (browser would use DecompressionStream)
//   - document/URL/Blob:   permissive stubs so top-level UI wiring doesn't crash

import fs from 'node:fs';
import vm from 'node:vm';
import zlib from 'node:zlib';
import { createRequire } from 'node:module';
import { DOMParser as _DP } from '@xmldom/xmldom';

const require = createRequire(import.meta.url);
export const XLSX = require('xlsx/dist/xlsx.full.min.js');

const html = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const m = html.match(/<script>([\s\S]*?)<\/script>/);
if (!m) throw new Error('Could not find application <script> block in index.html');
const APP_CODE = m[1] + [
  // Expose top-level `let`/`const` bindings (which don't become global properties
  // the way `var`/`function` do) so tests can reach into the evaluated script.
  ';globalThis.store = store;',
  ';globalThis.PEAK_HEADER = PEAK_HEADER; globalThis.COMPOUND_HEADER = COMPOUND_HEADER; globalThis.CALIB_HEADER = CALIB_HEADER; globalThis.INJ_HEADER = INJ_HEADER;',
  // Worker machinery — the worker tests compose the REAL worker source from these.
  ';globalThis.parseZip = parseZip; globalThis.groupByRslt = groupByRslt; globalThis.getFileSlice = getFileSlice; globalThis.buildWorkerSource = buildWorkerSource; globalThis.buildWorkerMessage = buildWorkerMessage; globalThis.parseContainerParallel = parseContainerParallel; globalThis.WORKER_FNS = WORKER_FNS;',
].join('\n');

// xmldom has no querySelector; the app uses doc.querySelector("parsererror").
class DOMParser extends _DP {
  parseFromString(s, t) {
    const d = super.parseFromString(s, t);
    d.querySelector = (sel) => d.getElementsByTagName(sel)[0] || null;
    return d;
  }
}

// A permissive element stub: any property set is swallowed; any method is a noop;
// createElement/querySelector return more stubs.
function stubEl() {
  return new Proxy({}, {
    get(_t, p) {
      if (p === 'addEventListener' || p === 'appendChild' || p === 'append' ||
          p === 'remove' || p === 'click' || p === 'setAttribute') return () => {};
      if (p === 'classList') return { add() {}, remove() {} };
      if (p === 'querySelectorAll') return () => [];
      if (p === 'querySelector') return () => null;
      if (p === 'createElement') return () => stubEl();
      if (p === 'body') return stubEl();
      return undefined;
    },
    set() { return true; },
  });
}

const documentStub = new Proxy({}, {
  get(_t, p) {
    if (p === 'getElementById' || p === 'createElement') return () => stubEl();
    if (p === 'body') return stubEl();
    if (p === 'querySelector') return () => null;
    return undefined;
  },
  set() { return true; },
});

export function loadApp() {
  const ctx = {
    document: documentStub,
    DOMParser,
    XLSX,
    TextEncoder, TextDecoder,
    console,
    Math, Date, Number, Array, Object, String, JSON, Map, Set,
    Uint8Array, Float64Array, Float32Array, DataView, ArrayBuffer,
    Promise, Error, RegExp, Boolean, parseInt, parseFloat, isFinite, isNaN,
    setTimeout, clearTimeout,
  };
  ctx.Blob = class Blob { constructor(parts, opts) { this.parts = parts; this.type = opts && opts.type; } };
  ctx.URL = { createObjectURL: () => 'blob:x', revokeObjectURL() {} };
  ctx.alert = () => {}; // browser dialog; noop under test
  ctx.globalThis = ctx;

  vm.createContext(ctx);
  vm.runInContext(APP_CODE, ctx);

  // Browser would use DecompressionStream; use zlib instead.
  ctx.inflateRawOrDeflate = async (u8) => {
    try { return zlib.inflateRawSync(u8); }
    catch { return zlib.inflateSync(u8); }
  };

  // Capture anything the app tries to download.
  ctx.captured = null;
  ctx.downloadBlob = (blob, name) => { ctx.captured = { blob, name }; };

  return ctx;
}

// Reassemble a captured Blob's parts into a single Uint8Array.
export function blobToU8(blob) {
  const parts = blob.parts || [];
  const chunks = [];
  for (const p of parts) {
    if (p instanceof ArrayBuffer) chunks.push(new Uint8Array(p));
    else if (ArrayBuffer.isView(p)) chunks.push(new Uint8Array(p.buffer, p.byteOffset, p.byteLength));
    else if (Array.isArray(p)) chunks.push(Uint8Array.from(p));
    else chunks.push(new TextEncoder().encode(String(p)));
  }
  let total = 0;
  for (const c of chunks) total += c.length;
  const out = new Uint8Array(total);
  let o = 0;
  for (const c of chunks) { out.set(c, o); o += c.length; }
  return out;
}
