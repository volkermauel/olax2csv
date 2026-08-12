// Regression guard for the embedded SheetJS library.
//
// History: the app shipped a corrupted xlsx.full.min.js blob (a bad edit had
// injected "/*XLSX_LIBRARY*/" placeholders and a stray "&", producing a
// SyntaxError). Because the test harness provides its OWN XLSX shim, the unit
// tests never exercised the real embedded blob — so downloadExcel() blew up in
// the browser with "XLSX is not defined" while every test stayed green. These
// tests extract the ACTUAL embedded blob and validate it directly.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

function embeddedSheetJSBlob() {
  // The SheetJS library is the LAST <script> block in index.html.
  const html = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  const open = html.lastIndexOf('<script>') + '<script>'.length;
  const close = html.lastIndexOf('</script>');
  assert.ok(open > 0 && close > open, 'could not locate the SheetJS <script> block');
  return html.slice(open, close).trim();
}

test('embedded SheetJS blob is syntactically valid (parses as a function body)', () => {
  const blob = embeddedSheetJSBlob();
  assert.ok(blob.length > 500_000, `blob looks too small (${blob.length} bytes)`);
  // Construct a function — throws SyntaxError on malformed JS.
  new Function(blob);
  // Guard against the specific corruption markers from the original broken embed.
  assert.equal(blob.includes('XLSX_LIBRARY'), false, 'blob contains corruption marker "XLSX_LIBRARY"');
});

test('embedded SheetJS exposes window.XLSX (version/utils/write) in a browser-like context', () => {
  const blob = embeddedSheetJSBlob();
  // Browser-like sandbox: window/self/global alias, but NO module/exports/define
  // (so the UMD wrapper takes the browser branch and sets window.XLSX).
  const sandbox = {};
  sandbox.window = sandbox;
  sandbox.self = sandbox;
  sandbox.global = sandbox;
  vm.runInNewContext(blob, sandbox);
  const X = sandbox.window.XLSX;
  assert.equal(typeof X, 'object', 'window.XLSX is not an object');
  assert.ok(X, 'window.XLSX is null/undefined');
  assert.equal(typeof X.version, 'string', 'XLSX.version missing');
  assert.equal(typeof X.utils, 'object', 'XLSX.utils missing');
  assert.equal(typeof X.write, 'function', 'XLSX.write missing');
  assert.equal(typeof X.utils.aoa_to_sheet, 'function', 'XLSX.utils.aoa_to_sheet missing');
  assert.equal(typeof X.utils.book_append_sheet, 'function', 'XLSX.utils.book_append_sheet missing');
});
