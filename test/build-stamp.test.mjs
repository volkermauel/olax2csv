// Build info badge: the repo ships clean __COMMIT__/__BUILT__ placeholders;
// the Pages deploy job substitutes them at publish time. Locally (or from a
// plain file:// open) the placeholder fails the SHA check and the badge
// stays hidden instead of showing wrong info.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { loadApp } from './harness.mjs';

test('BUILD ships as clean placeholders for deploy-time substitution', () => {
  const app = loadApp();
  assert.equal(app.BUILD.commit, '__COMMIT__');
  assert.equal(app.BUILD.built, '__BUILT__');
  // Deploy contract: each token appears exactly once in the shipped HTML.
  const html = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  assert.equal((html.match(/__COMMIT__/g) || []).length, 1);
  assert.equal((html.match(/__BUILT__/g) || []).length, 1);
  // The badge anchor exists next to the heading and starts hidden.
  assert.ok(/<h1>[^<]*<span id="buildInfo" class="buildInfo" hidden>/.test(html));
  // Placeholder must NOT look like a commit hash, or the guard would
  // unhide a bogus badge on a plain local open.
  assert.equal(/^[0-9a-f]{7,40}$/.test(app.BUILD.commit), false);
});
