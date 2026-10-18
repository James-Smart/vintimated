// Vintimated — no user-visible surface may carry upstream's identity.
// Copyright (C) 2026 Vintimated contributors
//
// This program is free software: you can redistribute it and/or modify it
// under the terms of the GNU General Public License as published by the Free
// Software Foundation, either version 3 of the License, or (at your option)
// any later version.
//
// This program is distributed in the hope that it will be useful, but WITHOUT
// ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or
// FITNESS FOR A PARTICULAR PURPOSE. See the GNU General Public License for
// more details.
//
// You should have received a copy of the GNU General Public License along
// with this program. If not, see <https://www.gnu.org/licenses/>.

// The rebrand renamed every display string but deliberately left upstream's
// external identifiers (welcome/uninstall URLs, store ids, footer links) in
// place until the fork had a home of its own. It has one now — these tests
// pin the home so no install-time or runtime surface can send a seller back
// to Bumpline. Comments and GPL provenance lines naming upstream are fine and
// are stripped before the source checks; only shipped values matter.

const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');

const ROOT = join(__dirname, '..');
const HOME = 'https://github.com/James-Smart/vintimated';

const read = name => readFileSync(join(ROOT, name), 'utf8');
const codeOf = name =>
  read(name)
    .split('\n')
    .filter(line => !line.trim().startsWith('//'))
    .join('\n');

test('background.js: install and uninstall pages point at the Vintimated home, not upstream', () => {
  const code = codeOf('background.js');
  assert.doesNotMatch(code, /bumpline/i);
  assert.doesNotMatch(code, /giampy/i);
  assert.doesNotMatch(code, /\/welcome\//);
  assert.doesNotMatch(code, /\/goodbye\//);
  assert.match(code, /const SITE = 'https:\/\/github\.com\/James-Smart\/vintimated';/);
  assert.match(code, /ext\.tabs\.create\(\{ url: SITE/);
  assert.match(code, /setUninstallURL\(SITE \+ '\/issues'\)/);
});

test('popup.html: footer links point at the Vintimated repo, not upstream', () => {
  const html = read('popup.html');
  assert.doesNotMatch(html, /bumpline/i);
  assert.doesNotMatch(html, /giampy/i);
  assert.match(html, new RegExp(`href="${HOME.replace(/[/.]/g, '\\$&')}#readme"`));
  assert.match(html, new RegExp(`href="${HOME.replace(/[/.]/g, '\\$&')}/issues"`));
});

test('store.js: no upstream store ids remain in shipped values', () => {
  const code = codeOf('store.js');
  assert.doesNotMatch(code, /bumpline/i);
  assert.doesNotMatch(code, /giampy/i);
  assert.match(code, /const CHROME_STORE_ID = '';/);
  assert.match(code, /const FIREFOX_ADDON_ID = '';/);
});

function loadStore(browserKind) {
  delete require.cache[require.resolve('../store.js')];
  const stub = { runtime: { getURL: () => (browserKind === 'firefox' ? 'moz-extension://x/' : 'chrome-extension://x/') } };
  if (browserKind === 'firefox') globalThis.browser = stub;
  else globalThis.chrome = stub;
  return require('../store.js');
}

test('store.js: review link is hidden when the fork has no store listing (both browsers)', () => {
  assert.equal(loadStore('chrome').reviewUrl(), null);
  assert.equal(loadStore('firefox').reviewUrl(), null);
  delete globalThis.browser;
  delete globalThis.chrome;
});

test('icons/logo.svg: labels say Vintimated', () => {
  const svg = read('icons/logo.svg');
  assert.doesNotMatch(svg, /bumpline/i);
  assert.match(svg, /aria-label="Vintimated"/);
  assert.match(svg, /<title>Vintimated<\/title>/);
});

test('strings and locales carry no upstream brand in user-visible values', () => {
  assert.doesNotMatch(codeOf('strings.js').replace(/\/\*[\s\S]*?\*\//g, ''), /bumpline/i);
  for (const lang of ['en', 'fr', 'it']) {
    assert.doesNotMatch(read(`_locales/${lang}/messages.json`), /bumpline/i);
  }
});
