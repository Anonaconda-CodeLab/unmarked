// Copyright (C) 2026 Anonaconda Code Lab · SPDX-License-Identifier: GPL-3.0-or-later
// Tests for src/clean.js on real files (tests/fixtures, made with ExifTool, Pillow, reportlab and pikepdf).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import zlib from 'node:zlib';
// both files are plain browser scripts (the page inlines them): run them as scripts, as the browser does
const load = f => vm.runInThisContext(readFileSync(new URL(f, import.meta.url), 'utf8'), { filename: f });
load('../src/vendor/pdf-lib.min.js');
load('../src/clean.js');
const C = globalThis.UnmarkedClean, PDFLib = globalThis.PDFLib;
const fx = name => new Uint8Array(readFileSync(new URL('./fixtures/' + name, import.meta.url)));
const ids = r => r.findings.map(f => f.id);
const has = (bytes, s) => Buffer.from(bytes).includes(Buffer.from(s));
const base = { pdfLib: PDFLib };
const ALL = { pdfLib: PDFLib, removeAttachments: true, removeScripts: true, removeComments: true };

test('detects file types', () => {
  assert.equal(C.detect(fx('photo-full.jpg')).type, 'jpeg');
  assert.equal(C.detect(fx('image.png')).type, 'png');
  assert.equal(C.detect(fx('image.webp')).type, 'webp');
  assert.equal(C.detect(fx('doc.pdf')).type, 'pdf');
  const heic = new Uint8Array(32); heic.set([0, 0, 0, 24], 0); heic.set(Buffer.from('ftypheic'), 4);
  assert.deepEqual([C.detect(heic).type, C.detect(heic).supported], ['heic', false]);
  assert.equal(C.detect(new Uint8Array([1, 2, 3])).supported, false);
});

test('JPEG: finds location, names, serials, thumbnail, XMP, IPTC and comment', async () => {
  const r = await C.inspect(fx('photo-full.jpg'), base);
  for (const id of ['gps', 'artist', 'owner', 'serial', 'thumb', 'place', 'make', 'model', 'software', 'datetaken', 'tz', 'uniqueid', 'comment', 'copyright', 'orientation'])
    assert.ok(ids(r).includes(id), 'missing ' + id);
  const gps = r.findings.find(f => f.id === 'gps');
  assert.match(gps.value, /^51\.50072, -0\.12462/);
  assert.equal(gps.risk, 'high');
  assert.equal(r.findings.filter(f => f.id === 'artist').length, 1, 'duplicates from EXIF, XMP and IPTC are merged');
  assert.ok(r.findings[0].risk === 'high', 'most revealing first');
});

test('JPEG: cleaned copy keeps the picture byte for byte and only the rotation', async () => {
  const src = fx('photo-full.jpg'), out = (await C.clean(src, base)).bytes;
  const r = await C.inspect(out, base);
  assert.deepEqual(ids(r), ['orientation']);
  for (const s of ['Jane', 'Pixel', 'SN1234', 'London', 'holiday', 'Snapseed', 'http://ns.adobe.com']) assert.ok(!has(out, s), 'still contains ' + s);
  // the compressed picture (from the quantisation tables to the end) is unchanged
  const from = b => { const s = C._internal.jpegSegments(b).segs.find(x => x.m === 0xdb); return Buffer.from(b.subarray(s.s)); };
  assert.ok(from(src).equals(from(out)));
  assert.ok(out.length < src.length);
});

test('JPEG: motion photo clip after the picture is removed', async () => {
  const r = await C.inspect(fx('motion.jpg'), base);
  assert.ok(ids(r).includes('trailing'));
  assert.match(r.findings.find(f => f.id === 'trailing').label, /video/i);
  const out = (await C.clean(fx('motion.jpg'), base)).bytes;
  assert.ok(!has(out, 'ftypmp4'));
  assert.equal(out[out.length - 2], 0xff); assert.equal(out[out.length - 1], 0xd9);
});

test('JPEG: a plain sRGB profile is removed, nothing found in a plain file', async () => {
  const r = await C.inspect(fx('icc.jpg'), base);
  assert.ok(C.isRemoved(r.findings.find(f => f.id === 'icc'), {}));
  const out = (await C.clean(fx('icc.jpg'), base)).bytes;
  assert.deepEqual(ids(await C.inspect(out, base)), []);
  assert.ok(!has(out, 'ICC_PROFILE'));
  const plain = fx('plain.jpg');
  assert.equal((await C.inspect(plain, base)).findings.length, 0);
  assert.ok(Buffer.from((await C.clean(plain, base)).bytes).equals(Buffer.from(plain)));
});

// colour profiles (fixtures from make-icc.py; tests/fixtures/check-colours.sh checks with Pillow/lcms that colours convert identically)
const REVEALING = ['Example Display', 'SN-998877', 'APPL', 'EXDC', 'P3X1', 'exmp'];
const profileOf = {   // the profile bytes inside a file, whatever the format
  jpeg: b => { const s = C._internal.jpegSegments(b).segs.filter(x => x.m === 0xe2 && has(b.subarray(x.d, x.d + 12), 'ICC_PROFILE')); return s.length ? Buffer.concat(s.sort((x, y) => b[x.d + 12] - b[y.d + 12]).map(x => Buffer.from(b.subarray(x.d + 14, x.e)))) : null; },
  webp: b => { const c = C._internal.webpChunks(b).chunks.find(x => x.type === 'ICCP'); return c ? Buffer.from(b.subarray(c.d, c.d + c.n)) : null; },
  png: b => { const c = C._internal.pngChunks(b).chunks.find(x => x.type === 'iCCP'); if (!c) return null; const d = Buffer.from(b.subarray(c.d, c.d + c.n)); return zlib.inflateSync(d.subarray(d.indexOf(0) + 2)); }
};
for (const [file, type] of [['p3.jpg', 'jpeg'], ['p3.png', 'png'], ['p3.webp', 'webp']]) {
  test(`${type.toUpperCase()}: another profile is kept, its revealing fields blanked`, async () => {
    const src = fx(file), r = await C.inspect(src, base);
    assert.deepEqual(r.findings.map(f => [f.id, C.isRemoved(f, {})]).sort(), [['icc', false], ['iccdetails', true]]);
    assert.equal(r.findings.find(f => f.id === 'icc').value, 'Display P3');
    assert.match(r.findings.find(f => f.id === 'iccdetails').value, /made 2026-10-24 07:59.*APPL.*Example Display Co.*SN-998877.*calibration/);
    const out = (await C.clean(src, base)).bytes, again = await C.inspect(out, base);
    assert.deepEqual(ids(again), ['icc'], 'nothing left to remove, so no "still inside" warning');
    const before = profileOf[type](src), after = profileOf[type](out);
    assert.equal(after.length, before.length, 'same length');
    for (const s of REVEALING) assert.ok(!after.includes(Buffer.from(s)) && !after.includes(Buffer.from(s, 'utf16le').swap16()), 'still contains ' + s);
    assert.ok(after.subarray(24, 36).equals(Buffer.alloc(12)), 'creation date blanked');
    assert.ok(after.subarray(84, 100).equals(Buffer.alloc(16)), 'profile ID cleared');
    assert.ok(after.subarray(128).length && after.includes(Buffer.from('rXYZ')), 'colour tags still there');
    // everything outside the blanked fields is unchanged
    const diff = []; for (let i = 0; i < before.length; i++) if (before[i] !== after[i]) diff.push(i);
    assert.ok(diff.every(i => (i >= 4 && i < 8) || (i >= 24 && i < 36) || (i >= 40 && i < 44) || (i >= 48 && i < 56) || (i >= 80 && i < 100) || i >= 128));
    if (type === 'webp') assert.equal(out[C._internal.webpChunks(out).chunks[0].d] & 0x20, 0x20, 'ICC flag still set');
    if (type === 'jpeg') assert.equal(C._internal.jpegSegments(out).segs.filter(x => x.m === 0xe2).length, 3, 'still in three parts');
    // cleaning again changes nothing more
    assert.ok(Buffer.from((await C.clean(out, base)).bytes).equals(Buffer.from(out)));
  });
}

test('PNG and WebP: a plain sRGB profile is removed; a bare sRGB chunk is not listed', async () => {
  for (const file of ['srgb.png', 'srgb.webp']) {
    const r = await C.inspect(fx(file), base);
    assert.deepEqual(r.findings.map(f => [f.id, f.value, C.isRemoved(f, {})]), [['icc', 'sRGB built-in', true]]);
    const out = (await C.clean(fx(file), base)).bytes;
    assert.deepEqual(ids(await C.inspect(out, base)), []);
    assert.ok(!has(out, 'iCCP') && !has(out, 'ICCP') && !has(out, 'sRGB built-in'));
  }
  const png = (await C.clean(fx('srgb.png'), base)).bytes;
  const s = C._internal.pngChunks(png).chunks.find(c => c.type === 'sRGB');
  assert.ok(s && s.n === 1, 'replaced by a one-byte sRGB chunk, so a gAMA or cHRM chunk could not change the colours');
  const webp = (await C.clean(fx('srgb.webp'), base)).bytes;
  assert.equal(webp[C._internal.webpChunks(webp).chunks[0].d] & 0x20, 0, 'ICC flag cleared');
  assert.equal(new DataView(webp.buffer, webp.byteOffset).getUint32(4, true), webp.length - 8, 'RIFF size');
  assert.deepEqual((await C.inspect(fx('srgb-chunk.png'), base)).findings, []);
  assert.ok(Buffer.from((await C.clean(fx('srgb-chunk.png'), base)).bytes).equals(Buffer.from(fx('srgb-chunk.png'))));
});

test('JPEG: a profile split into parts that do not fit together is removed', async () => {
  const b = fx('p3.jpg').slice(), s = C._internal.jpegSegments(b).segs.find(x => x.m === 0xe2);
  b[s.d + 12] = 9;   // part number out of range
  const r = await C.inspect(b, base);
  assert.deepEqual(r.findings.map(f => [f.id, f.value, C.isRemoved(f, {})]), [['icc', 'damaged', true]]);
  assert.ok(!has((await C.clean(b, base)).bytes, 'ICC_PROFILE'));
});

test('options: keep the date taken and the copyright notice', async () => {
  const out = (await C.clean(fx('photo-full.jpg'), { ...base, keepDate: true, keepCopyright: true })).bytes;
  const r = await C.inspect(out, base);
  assert.deepEqual(ids(r).sort(), ['copyright', 'datetaken', 'orientation']);
  assert.equal(r.findings.find(f => f.id === 'datetaken').value, '2026-10-24 14:35:12');
  assert.ok(!has(out, '+07:00'), 'time zone is not kept');
  assert.equal(C.isRemoved({ keep: 'date' }, { keepDate: true }), false);
  assert.equal(C.isRemoved({ keep: 'date' }, {}), true);
  assert.equal(C.isRemoved({ keep: 'always' }, {}), false);
  assert.equal(C.isRemoved({ option: 'attachments' }, { removeAttachments: false }), false);
});

test('PNG: text, XMP and eXIf removed; picture chunks unchanged', async () => {
  const src = fx('image.png'), r = await C.inspect(src, base);
  for (const id of ['gps', 'artist', 'software', 'comment']) assert.ok(ids(r).includes(id), 'missing ' + id);
  const out = (await C.clean(src, base)).bytes;
  assert.deepEqual(ids(await C.inspect(out, base)), []);
  const idat = b => Buffer.concat(C._internal.pngChunks(b).chunks.filter(c => c.type === 'IDAT').map(c => Buffer.from(b.subarray(c.s, c.e))));
  assert.ok(idat(src).equals(idat(out)));
  const kept = (await C.clean(src, { ...base, keepCopyright: true, keepDate: true })).bytes;
  assert.deepEqual(ids(await C.inspect(kept, base)).sort(), ['copyright', 'datetaken']);
});

test('WebP: EXIF and XMP removed, flags fixed, picture unchanged', async () => {
  const src = fx('image.webp'), r = await C.inspect(src, base);
  for (const id of ['gps', 'artist', 'model']) assert.ok(ids(r).includes(id));
  const out = (await C.clean(src, base)).bytes;
  assert.deepEqual(ids(await C.inspect(out, base)), []);
  const { chunks } = C._internal.webpChunks(out);
  assert.equal(new DataView(out.buffer, out.byteOffset).getUint32(4, true), out.length - 8, 'RIFF size');
  const vp8x = chunks.find(c => c.type === 'VP8X'); if (vp8x) assert.equal(out[vp8x.d] & 0x0c, 0);
  const pic = b => Buffer.from(b.subarray(...(c => [c.s, c.e])(C._internal.webpChunks(b).chunks.find(c => /^VP8[ L]$/.test(c.type)))));
  assert.ok(pic(src).equals(pic(out)));
});

test('PDF: finds info, XMP, attachments, scripts, comment authors, photos and earlier versions', async () => {
  const r = await C.inspect(fx('doc-rev.pdf'), base);
  for (const id of ['revisions', 'artist', 'creator', 'software', 'docid', 'pieceinfo', 'attachments', 'comments', 'commentauthors', 'scripts', 'photos'])
    assert.ok(ids(r).includes(id), 'missing ' + id);
  assert.deepEqual(r.options, { attachments: true, scripts: true, comments: true });
  assert.match(r.findings.find(f => f.id === 'artist').value, /Second Author/);
  assert.match(r.findings.find(f => f.id === 'artist').value, /Jane Example/);
  assert.match(r.findings.find(f => f.id === 'photos').value, /2 photos.*2 with a location/);
});

test('PDF: cleaned copy has one version, no info, and the chosen extras removed', async () => {
  const out = (await C.clean(fx('doc-rev.pdf'), ALL)).bytes;
  assert.equal(C._internal.countRevisions(out), 1);
  assert.deepEqual(ids(await C.inspect(out, base)), []);
  for (const s of ['Jane', 'Second Author', 'Bob Reviewer', 'bank-details', '12345678', 'app.alert', 'Microsoft Word', 'pikepdf', 'secret'])
    assert.ok(!has(out, s), 'still contains ' + s);
  const doc = await PDFLib.PDFDocument.load(out, { updateMetadata: false });
  assert.equal(doc.getPageCount(), 2);
  assert.equal(doc.context.trailerInfo.Info, undefined);
  const annots = doc.getPages()[0].node.lookup(PDFLib.PDFName.of('Annots'));
  assert.equal(annots.size(), 1, 'the link stays');
  assert.equal(String(annots.lookup(0).lookup(PDFLib.PDFName.of('Subtype'))), '/Link');
});

test('PDF: attachments, scripts and comments stay when not chosen', async () => {
  const out = (await C.clean(fx('doc.pdf'), base)).bytes;
  const r = await C.inspect(out, base);
  assert.deepEqual(ids(r).sort(), ['attachments', 'commentauthors', 'comments', 'scripts']);
  assert.ok(!r.findings.some(f => C.isRemoved(f, { removeAttachments: false, removeScripts: false, removeComments: false })));
});

test('file names that give things away', () => {
  assert.equal(C.nameFindings('IMG_20261024_143512.jpg')[0].id, 'filename-date');
  assert.match(C.nameFindings('PXL_20260101_101010123.jpg')[0].value, /date and time/);
  assert.equal(C.nameFindings('Screenshot_note.png')[0].id, 'filename-device');
  assert.deepEqual(C.nameFindings('holiday.jpg'), []);
  assert.equal(C.plainName(3, 'jpg'), 'image-03.jpg');
  assert.equal(C.plainName(12, 'pdf'), 'document-12.pdf');
});

test('zip: stored files, fixed dates, duplicate names renamed', () => {
  const z = C.zip([{ name: 'a.jpg', bytes: new Uint8Array([1, 2, 3]) }, { name: 'a.jpg', bytes: new Uint8Array([4]) }, { name: 'ünï/cø:de.pdf', bytes: new Uint8Array(0) }]);
  const v = new DataView(z.buffer), names = [];
  let p = v.getUint32(z.length - 6, true);   // central directory offset
  for (let i = 0; i < 3; i++) {
    assert.equal(v.getUint32(p, true), 0x02014b50);
    assert.equal(v.getUint16(p + 14, true), 0x21, 'date 1980-01-01');
    const n = v.getUint16(p + 28, true); names.push(new TextDecoder().decode(z.subarray(p + 46, p + 46 + n)));
    const local = v.getUint32(p + 42, true), size = v.getUint32(p + 20, true), crc = v.getUint32(p + 16, true);
    const ln = v.getUint16(local + 26, true), data = z.subarray(local + 30 + ln, local + 30 + ln + size);
    assert.equal(C._internal.crc32(data), crc);
    p += 46 + n;
  }
  assert.deepEqual(names, ['a.jpg', 'a (2).jpg', 'ünï_cø_de.pdf']);
});

test('damaged and hostile files never crash inspection', async () => {
  const files = ['photo-full.jpg', 'motion.jpg', 'image.png', 'image.webp', 'doc.pdf', 'icc.jpg', 'p3.jpg', 'p3.png', 'p3.webp'];
  let seed = 7; const rnd = n => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) % n;
  for (const f of files) {
    const src = fx(f);
    for (let k = 0; k < 25; k++) {
      let b = src.slice(0, 8 + rnd(src.length));   // cut short
      if (k % 2) for (let j = 0; j < 20; j++) b[rnd(b.length)] = rnd(256);   // and scrambled
      const r = await C.inspect(b, base);   // must resolve, never throw
      assert.ok(Array.isArray(r.findings));
      try { const c = await C.clean(b, ALL); assert.ok(c.bytes instanceof Uint8Array); } catch (e) { assert.ok(e instanceof Error); }
    }
  }
});
