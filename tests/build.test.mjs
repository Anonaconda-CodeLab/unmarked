// Copyright (C) 2026 Anonaconda Code Lab · SPDX-License-Identifier: GPL-3.0-or-later
// Checks the built page (run after `node build.mjs`): no network, everything inlined, settings filled in.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
const dist = f => readFileSync(new URL('../dist/' + f, import.meta.url), 'utf8');
const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

test('page blocks all network access', () => {
  const html = dist('index.html');
  const csp = /http-equiv="Content-Security-Policy" content="([^"]+)"/.exec(html)[1];
  for (const d of ["default-src 'none'", "connect-src 'none'", "worker-src 'none'", "form-action 'none'", "frame-src 'none'"]) assert.ok(csp.includes(d), d);
  assert.ok(!csp.includes('unsafe-eval'));
  assert.ok(!/<script[^>]+src=/i.test(html), 'no external scripts');
  assert.ok(!/sourceMappingURL/.test(html), 'no source map reference');
});

test('page contains the app, pdf-lib and the manual, with placeholders filled', () => {
  const html = dist('index.html');
  assert.ok(html.includes('UnmarkedClean'));
  assert.ok(html.includes('PDFLib'));
  assert.ok(html.includes('What Unmarked can'));
  assert.ok(html.includes(`Version ${pkg.version}`));
  assert.ok(!/\{\{[A-Z_]+\}\}/.test(html), 'unfilled placeholder');
  const own = html.replace(/<script>\s*!function\(t,e\)[\s\S]*?<\/script>/, '');   // everything except pdf-lib
  assert.ok(own.length < html.length - 400000, 'pdf-lib block found');
  assert.ok(!/leadone|Lead One|Polar|\bECG\b/i.test(own), 'nothing left over from Lead One');
});

test('Android page and manifest', () => {
  const on = /androidPage:\s*true/.test(readFileSync(new URL('../build.mjs', import.meta.url), 'utf8'));
  const html = dist('index.html'), sitemap = dist('sitemap.xml');
  assert.ok(!/\[\[\/?android\]\]/.test(html), 'manual markers removed');
  if (on) {
    const a = dist('android.html');
    assert.ok(a.includes(`Unmarked-${pkg.version}.apk`));
    assert.ok(!/\{\{[A-Z_]+\}\}/.test(a));
    assert.ok(sitemap.includes('android.html'));
  } else {   // not announced yet: no install page, and the website says nothing about an Android app
    assert.ok(!existsSync(new URL('../dist/android.html', import.meta.url)));
    assert.ok(!sitemap.includes('android.html'));
    assert.ok(!/android\.html|Android app/.test(html.replace(/<script>\s*!function\(t,e\)[\s\S]*?<\/script>/, '').replace(/<script>[\s\S]*<\/script>/, '')), 'no Android app in the page text');
  }
  const m = JSON.parse(dist('manifest.webmanifest'));
  assert.equal(m.name, 'Unmarked');
  assert.ok(m.icons.some(i => i.purpose === 'maskable'));
});

test('Android app version matches package.json', () => {
  const g = readFileSync(new URL('../mobile/android/app/build.gradle', import.meta.url), 'utf8');
  const [maj, min, pat] = pkg.version.split('.').map(Number);
  assert.match(g, new RegExp(`versionName "${pkg.version.replace(/\./g, '\\.')}"`));
  assert.match(g, new RegExp(`versionCode ${maj * 10000 + min * 100 + pat}\\b`));
  const mp = JSON.parse(readFileSync(new URL('../mobile/package.json', import.meta.url), 'utf8'));
  assert.equal(mp.version, pkg.version);
  const man = readFileSync(new URL('../mobile/android/app/src/main/AndroidManifest.xml', import.meta.url), 'utf8');
  assert.match(man, /android\.permission\.INTERNET" tools:node="remove"/);
  assert.match(man, /android\.intent\.action\.SEND_MULTIPLE/);
});
