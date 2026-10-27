/* Copyright (C) 2026 Anonaconda Code Lab · SPDX-License-Identifier: GPL-3.0-or-later
   ---------- Unmarked cleaning module ----------
   Finds and removes hidden data (metadata) in JPEG, PNG and WebP images and PDF documents.
   Self-contained: no DOM, no network, no dependencies except pdf-lib for PDFs, which the caller passes in
   (options.pdfLib). Works in browsers and in Node 18+, so other apps (and the tests) can reuse it unchanged.

   Images are cleaned losslessly: metadata blocks are cut out of the file and the picture data is copied byte for byte,
   so there is no recompression and no quality loss. Only harmless display data is kept: the rotation, and a colour
   profile other than plain sRGB, with its creation details blanked (see "ICC colour profiles" below).

   API (all on the global UnmarkedClean):
     detect(bytes)                         -> { type, label, ext, mime, supported, reason? }
     inspect(bytes, opts) (async)          -> { type, findings: [Finding], options: { attachments, scripts, comments }, error? }
     clean(bytes, opts) (async)            -> { bytes, type }
     nameFindings(fileName)                -> [Finding]   (things a file name gives away)
     plainName(index, ext)                 -> 'image-01.jpg' style names
     zip([{ name, bytes }])                -> Uint8Array (stored, fixed timestamps, UTF-8 names)
   opts: { pdfLib, keepDate, keepCopyright, removeAttachments, removeScripts, removeComments }
   Finding: { id, label, value, risk: 'high'|'medium'|'low', keep?: 'always'|'date'|'copyright', option?: 'attachments'|'scripts'|'comments', note? }
     keep 'always' = harmless display data that is never removed; 'date'/'copyright' = kept only if that option is on;
     option = PDF content removed only if that option is on; everything else is always removed. */
(function (root) {
  'use strict';

  // ---------- byte helpers ----------
  const u8 = b => b instanceof Uint8Array ? b : new Uint8Array(b);
  const be16 = (b, o) => (b[o] << 8) | b[o + 1];
  const be32 = (b, o) => ((b[o] << 24) >>> 0) + (b[o + 1] << 16) + (b[o + 2] << 8) + b[o + 3];
  const le16 = (b, o) => b[o] | (b[o + 1] << 8);
  const le32 = (b, o) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16)) + ((b[o + 3] << 24) >>> 0);
  const ascii = (b, o, n) => { let s = ''; for (let i = o; i < o + n && i < b.length; i++) s += String.fromCharCode(b[i]); return s; };
  const startsWith = (b, o, s) => { if (o + s.length > b.length) return false; for (let i = 0; i < s.length; i++) if (b[o + i] !== s.charCodeAt(i)) return false; return true; };
  const indexOf = (b, s, from = 0, to = b.length) => {
    const c0 = s.charCodeAt(0), n = s.length;
    outer: for (let i = from; i <= to - n; i++) { if (b[i] !== c0) continue; for (let k = 1; k < n; k++) if (b[i + k] !== s.charCodeAt(k)) continue outer; return i; }
    return -1;
  };
  const concat = parts => {
    let n = 0; for (const p of parts) n += p.length;
    const out = new Uint8Array(n); let o = 0;
    for (const p of parts) { out.set(p, o); o += p.length; }
    return out;
  };
  const enc = s => { const a = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) a[i] = s.charCodeAt(i) & 255; return a; };
  const utf8 = (b, fatal) => { try { return new TextDecoder('utf-8', { fatal: !!fatal }).decode(b); } catch (e) { return null; } };
  const latin1 = b => { let s = ''; for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]); return s; };
  const text = b => { const s = utf8(b, true); return s != null ? s : latin1(b); };
  const clip = (s, n = 120) => { s = String(s).replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s; };
  const kb = n => n < 1024 ? n + ' bytes' : n < 1048576 ? (n / 1024).toFixed(n < 10240 ? 1 : 0) + ' KB' : (n / 1048576).toFixed(1) + ' MB';
  // compressed data is unpacked up to a limit: a few kilobytes can unpack to gigabytes and freeze the page
  const UNPACK_LIMIT = 64 * 1024 * 1024;
  async function inflate(bytes, raw) {   // null when damaged or too big
    if (typeof DecompressionStream === 'undefined') return null;
    try {
      const reader = new Blob([bytes]).stream().pipeThrough(new DecompressionStream(raw ? 'deflate-raw' : 'deflate')).getReader();
      const parts = []; let n = 0;
      for (;;) {
        const { done, value } = await reader.read(); if (done) break;
        n += value.length;
        if (n > UNPACK_LIMIT) { reader.cancel().catch(() => {}); return null; }
        parts.push(value);
      }
      return concat(parts);
    } catch (e) { return null; }
  }
  async function deflate(bytes) {
    if (typeof CompressionStream === 'undefined') return null;
    try {
      const out = new Response(new Blob([bytes]).stream().pipeThrough(new CompressionStream('deflate')));
      return new Uint8Array(await out.arrayBuffer());
    } catch (e) { return null; }
  }
  const same = (a, b) => { if (a.length !== b.length) return false; for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false; return true; };

  // ---------- CRC-32 (PNG chunks, zip) ----------
  const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
  const crc32 = (b, c = 0xffffffff) => { for (let i = 0; i < b.length; i++) c = CRC[(c ^ b[i]) & 255] ^ (c >>> 8); return c; };
  const crcDone = c => (c ^ 0xffffffff) >>> 0;

  // ---------- findings ----------
  const F = (id, label, value, risk, extra) => Object.assign({ id, label, value: value == null ? '' : clip(value, 160), risk }, extra || {});
  const RISK = { low: 0, medium: 1, high: 2 };
  const LISTY = new Set(['software', 'artist', 'place', 'keywords', 'make', 'model', 'creator']);
  function merge(list) {   // one line per kind of finding, even when several metadata blocks hold the same thing
    const out = [];
    for (const f of list) {
      const prev = out.find(x => x.id === f.id);
      if (!prev) { out.push(Object.assign({}, f)); continue; }
      const sep = LISTY.has(f.id) ? /;\s*|,\s*/ : /;\s*/, vals = prev.value.split(sep).filter(Boolean);
      for (const v of (f.value || '').split(sep).filter(Boolean)) if (!vals.some(x => x.toLowerCase() === v.toLowerCase())) vals.push(v);
      prev.value = clip(vals.join(LISTY.has(f.id) ? ', ' : '; '), 160);
      if (RISK[f.risk] > RISK[prev.risk]) prev.risk = f.risk;
      if (!prev.note && f.note) prev.note = f.note;
    }
    return out.sort((a, b) => RISK[b.risk] - RISK[a.risk]);
  }
  function addOnce(list, f) { const prev = list.find(x => x.id === f.id); if (!prev) list.push(f); else if (f.value && !prev.value.includes(f.value)) prev.value = clip(prev.value ? prev.value + '; ' + f.value : f.value, 160); return list; }

  // ---------- TIFF / EXIF ----------
  const TYPE_SIZE = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 6: 1, 7: 1, 8: 2, 9: 4, 10: 8, 11: 4, 12: 8, 13: 4 };
  function parseTiff(b) {
    if (!b || b.length < 8) return null;
    const le = b[0] === 0x49 && b[1] === 0x49, beo = b[0] === 0x4d && b[1] === 0x4d;
    if (!le && !beo) return null;
    const r16 = o => o + 2 <= b.length ? (le ? le16(b, o) : be16(b, o)) : 0;
    const r32 = o => o + 4 <= b.length ? (le ? le32(b, o) : be32(b, o)) : 0;
    if (r16(2) !== 42) return null;
    const seen = new Set();
    function ifd(off) {
      const tags = new Map();
      if (!off || off + 2 > b.length || seen.has(off)) return { tags, next: 0 };
      seen.add(off);
      const n = Math.min(r16(off), 1000);
      for (let i = 0; i < n; i++) {
        const e = off + 2 + i * 12; if (e + 12 > b.length) break;
        const tag = r16(e), type = r16(e + 2), count = r32(e + 4), size = (TYPE_SIZE[type] || 1) * count;
        const at = size <= 4 ? e + 8 : r32(e + 8);
        if (at + Math.min(size, 1 << 24) > b.length) { tags.set(tag, { type, count, at: -1, size }); continue; }
        tags.set(tag, { type, count, at, size });
      }
      return { tags, next: r32(off + 2 + n * 12) };
    }
    const val = t => {   // decoded value: string for ASCII/UNDEFINED-text, number[] otherwise
      if (!t || t.at < 0) return null;
      const { type, count, at } = t;
      if (type === 2) return clip(text(b.subarray(at, at + count).filter(x => x)), 200);
      if (type === 1 || type === 7) return b.subarray(at, at + Math.min(count, 1 << 20));
      const out = [];
      for (let i = 0; i < Math.min(count, 64); i++) {
        if (type === 3 || type === 8) out.push(r16(at + i * 2));
        else if (type === 4 || type === 9 || type === 13) out.push(r32(at + i * 4));
        else if (type === 5 || type === 10) { const d = r32(at + i * 8 + 4); out.push(d ? r32(at + i * 8) / d : 0); }
      }
      return out;
    };
    const ifd0 = ifd(r32(4));
    const sub = tag => ifd0.tags.has(tag) ? ifd((val(ifd0.tags.get(tag)) || [])[0]) : { tags: new Map(), next: 0 };
    const exif = sub(0x8769), gps = sub(0x8825);
    const ifd1 = ifd(ifd0.next);
    return { le, ifd0: ifd0.tags, exif: exif.tags, gps: gps.tags, ifd1: ifd1.tags, val };
  }

  const xpText = v => v instanceof Uint8Array ? clip(new TextDecoder('utf-16le').decode(v).replace(/\u0000+$/, '')) : '';
  const ucText = v => {   // EXIF UserComment: 8-byte charset id then text
    if (!(v instanceof Uint8Array) || v.length <= 8) return '';
    const id = ascii(v, 0, 8), body = v.subarray(8);
    if (id.startsWith('UNICODE')) return clip(new TextDecoder(body[0] === 0 ? 'utf-16be' : 'utf-16le').decode(body).replace(/\u0000/g, ''));
    return clip(text(body).replace(/\u0000/g, ''));
  };
  const exifDate = s => typeof s === 'string' ? s.replace(/^(\d{4}):(\d{2}):(\d{2})/, '$1-$2-$3') : '';
  function gpsDecimal(v, ref) {
    if (!Array.isArray(v) || v.length < 3) return null;
    let d = v[0] + v[1] / 60 + v[2] / 3600;
    if (/^[SW]/i.test(ref || '')) d = -d;
    return isFinite(d) ? d : null;
  }

  const TAGS0 = {   // IFD0 (and IFD in PNG eXIf / WebP EXIF)
    0x010e: ['description', 'Image description', 'medium'], 0x010f: ['make', 'Camera or phone maker', 'medium'],
    0x0110: ['model', 'Camera or phone model', 'medium'], 0x0131: ['software', 'Software', 'medium'],
    0x0132: ['datemod', 'Date modified', 'medium'], 0x013b: ['artist', 'Author name', 'high'],
    0x013c: ['host', 'Computer name', 'high'], 0x8298: ['copyright', 'Copyright notice', 'low', { keep: 'copyright' }],
    0x9c9b: ['xptitle', 'Title', 'medium'], 0x9c9c: ['xpcomment', 'Comment', 'medium'], 0x9c9d: ['xpauthor', 'Author name', 'high'],
    0x9c9e: ['xpkeywords', 'Keywords', 'medium'], 0x9c9f: ['xpsubject', 'Subject', 'medium']
  };
  const TAGSX = {   // Exif sub-IFD
    0x9003: ['datetaken', 'Date and time taken', 'medium', { keep: 'date' }], 0x9004: ['datedigitized', 'Date digitised', 'medium'],
    0x9010: ['tz', 'Time zone', 'medium'], 0x9011: ['tz', 'Time zone', 'medium'], 0x9012: ['tz', 'Time zone', 'medium'],
    0xa430: ['owner', 'Camera owner name', 'high'], 0xa431: ['serial', 'Camera serial number', 'high'],
    0xa435: ['lensserial', 'Lens serial number', 'high'], 0xa433: ['lens', 'Lens', 'low'], 0xa434: ['lens', 'Lens', 'low'],
    0xa420: ['uniqueid', 'Unique image ID', 'medium'], 0x9286: ['usercomment', 'Comment', 'medium']
  };
  const SETTINGS = new Set([0x829a, 0x829d, 0x8822, 0x8827, 0x8832, 0x9201, 0x9202, 0x9203, 0x9204, 0x9205, 0x9206, 0x9207, 0x9208, 0x9209,
    0x920a, 0xa402, 0xa403, 0xa404, 0xa405, 0xa406, 0xa407, 0xa408, 0xa409, 0xa40a, 0xa40c, 0xa432, 0x9000, 0xa000, 0xa001, 0xa002, 0xa003, 0x9101, 0x9102, 0xa300, 0xa301, 0xa302, 0xa217, 0x9290, 0x9291, 0x9292]);
  const STRUCTURAL = new Set([0x8769, 0x8825, 0xa005, 0x0112, 0x011a, 0x011b, 0x0128, 0x0213, 0x0100, 0x0101, 0x0102, 0x0103, 0x0106, 0x0115, 0x011c, 0x0201, 0x0202]);

  // findings from a parsed TIFF structure; also returns the values worth keeping (orientation, date, copyright)
  function exifFindings(t, where) {
    const out = [], keep = {};
    if (!t) return { findings: out, keep };
    const v = tag => t.val(t.ifd0.get(tag));
    const vx = tag => t.val(t.exif.get(tag));
    let other = 0;
    for (const [tag, ent] of t.ifd0) {
      const d = TAGS0[tag];
      if (d) {
        let value = tag >= 0x9c9b && tag <= 0x9c9f ? xpText(t.val(ent)) : t.val(ent);
        if (value instanceof Uint8Array) value = text(value);
        if (Array.isArray(value)) value = value.join(' ');
        if (tag === 0x0132) value = exifDate(value);
        if (value === '' || value == null) continue;
        addOnce(out, F(d[0], d[1], value, d[2], d[3]));
      } else if (!STRUCTURAL.has(tag)) other++;
    }
    const o = (v(0x0112) || [])[0];
    if (o && o !== 1) { keep.orientation = o; out.push(F('orientation', 'Rotation', 'kept so the picture shows the right way up', 'low', { keep: 'always' })); }
    const cr = v(0x8298); if (typeof cr === 'string' && cr) keep.copyright = cr;
    for (const [tag, ent] of t.exif) {
      const d = TAGSX[tag];
      if (d) {
        let value = tag === 0x9286 ? ucText(t.val(ent)) : t.val(ent);
        if (value instanceof Uint8Array) value = text(value);
        if (Array.isArray(value)) value = value.map(x => +x.toFixed(2)).join('–');
        if (tag === 0x9003 || tag === 0x9004) value = exifDate(value);
        if (value === '' || value == null) continue;
        addOnce(out, F(d[0], d[1], value, d[2], d[3]));
      } else if (tag === 0x927c) addOnce(out, F('makernote', 'Manufacturer data', kb(ent.size) + ' of private data from the camera maker, which can include serial numbers', 'medium'));
      else if (SETTINGS.has(tag)) addOnce(out, F('settings', 'Camera settings', 'exposure, ISO, focal length and similar', 'low'));
      else if (!STRUCTURAL.has(tag)) other++;
    }
    const dt = vx(0x9003); if (typeof dt === 'string' && /^\d{4}:\d\d:\d\d \d\d:\d\d:\d\d/.test(dt)) keep.date = dt.slice(0, 19);
    if (t.gps.size) {
      const lat = gpsDecimal(t.val(t.gps.get(2)), t.val(t.gps.get(1))), lon = gpsDecimal(t.val(t.gps.get(4)), t.val(t.gps.get(3)));
      if (lat != null && lon != null && (lat || lon)) {
        const alt = (t.val(t.gps.get(6)) || [])[0];
        out.unshift(F('gps', 'Location', `${lat.toFixed(5)}, ${lon.toFixed(5)}${alt ? ` · ${Math.round(alt)} m altitude` : ''}`, 'high', { note: 'Shows where the photo was taken, often to within a few metres.' }));
      } else out.push(F('gpsmisc', 'GPS data', 'location fields (no position recorded)', 'medium'));
      if (t.gps.has(0x11)) addOnce(out, F('gpsdir', 'Direction faced', ((t.val(t.gps.get(0x11)) || [])[0] || 0).toFixed(0) + '°', 'medium'));
      if (t.gps.has(0x1d) || t.gps.has(7)) addOnce(out, F('gpstime', 'GPS time stamp', String(t.val(t.gps.get(0x1d)) || '').replace(/:/g, '-'), 'medium'));
    }
    if (t.ifd1.has(0x0201) || t.ifd1.has(0x0111)) out.push(F('thumb', 'Embedded thumbnail', 'a small copy of the original picture', 'high', { note: 'It can still show parts of the photo you cropped out or edited.' }));
    if (other) addOnce(out, F('exifother', 'Other camera data', other + ' more field' + (other > 1 ? 's' : ''), 'low'));
    if (where) out.forEach(f => { if (!f.where) f.where = where; });
    return { findings: out, keep };
  }

  // minimal EXIF (big-endian TIFF) holding only what the person chose to keep
  function buildExif(keep, opts) {
    const ifd0 = [], exif = [];
    if (keep.orientation && keep.orientation >= 2 && keep.orientation <= 8) ifd0.push({ tag: 0x0112, type: 3, count: 1, data: [0, keep.orientation] });
    if (opts.keepCopyright && keep.copyright) { const s = enc(keep.copyright.slice(0, 200) + '\u0000'); ifd0.push({ tag: 0x8298, type: 2, count: s.length, data: s }); }
    if (opts.keepDate && keep.date) { const s = enc(keep.date + '\u0000'); exif.push({ tag: 0x9003, type: 2, count: s.length, data: s }); }
    if (!ifd0.length && !exif.length) return null;
    if (exif.length) ifd0.push({ tag: 0x8769, type: 4, count: 1, data: null });
    ifd0.sort((a, b) => a.tag - b.tag);
    const size = list => 2 + list.length * 12 + 4 + list.reduce((n, e) => n + (e.data && e.data.length > 4 ? e.data.length + (e.data.length & 1) : 0), 0);
    const exifOff = 8 + size(ifd0), total = exifOff + (exif.length ? size(exif) : 0);
    const out = new Uint8Array(total), w16 = (o, v) => { out[o] = v >> 8; out[o + 1] = v & 255; }, w32 = (o, v) => { w16(o, v >>> 16); w16(o + 2, v & 0xffff); };
    out.set([0x4d, 0x4d, 0, 42, 0, 0, 0, 8]);
    const write = (list, off) => {
      w16(off, list.length);
      let dataAt = off + 2 + list.length * 12 + 4;
      list.forEach((e, i) => {
        const p = off + 2 + i * 12;
        w16(p, e.tag); w16(p + 2, e.type); w32(p + 4, e.count);
        if (!e.data) w32(p + 8, exifOff);
        else if (e.data.length <= 4) out.set(e.data, p + 8);
        else { w32(p + 8, dataAt); out.set(e.data, dataAt); dataAt += e.data.length + (e.data.length & 1); }
      });
      w32(off + 2 + list.length * 12, 0);
    };
    write(ifd0, 8);
    if (exif.length) write(exif, exifOff);
    return out;
  }

  // ---------- XMP (text) ----------
  // Every scan below goes forward once: patterns like <tag>...</tag> retried from each opener take quadratic time on a
  // file built with thousands of openers and no closer, which would freeze the page. Findings also read at most
  // XMP_SCAN of the text; cleaning removes XMP blocks whole, so this limits only the list.
  const XMP_SCAN = 1024 * 1024;
  function stripTags(s) {
    let out = '', i = 0;
    for (;;) {
      const lt = s.indexOf('<', i); if (lt < 0) return out + s.slice(i);
      out += s.slice(i, lt);
      const gt = s.indexOf('>', lt); if (gt < 0) return out;
      i = gt + 1;
    }
  }
  function attrValue(xml, name) {   // name="value" or name='value': the first one only
    const m = new RegExp(`\\b${name}\\s*=\\s*(["'])`).exec(xml); if (!m) return null;
    const start = m.index + m[0].length, end = xml.indexOf(m[1], start);
    return end < 0 ? null : xml.slice(start, end);
  }
  function elementText(xml, name) {   // what is inside the first <name ...>...</name>
    const m = new RegExp(`<${name}(?=[\\s/>])`).exec(xml); if (!m) return null;
    const gt = xml.indexOf('>', m.index); if (gt < 0 || xml[gt - 1] === '/') return null;
    const end = xml.indexOf(`</${name}>`, gt);
    return end < 0 ? null : xml.slice(gt + 1, end);
  }
  function listItems(s) {   // the <rdf:li> items of a list
    const out = [];
    for (let i = 0; ;) {
      const o = s.indexOf('<rdf:li', i); if (o < 0) break;
      const gt = s.indexOf('>', o); if (gt < 0) break;
      if (s[gt - 1] === '/') { i = gt + 1; continue; }
      const c = s.indexOf('</rdf:li>', gt); if (c < 0) break;
      out.push(s.slice(gt + 1, c)); i = c + 9;
    }
    return out;
  }
  function xmpFindings(full, where) {
    const out = [];
    if (!full) return out;
    const xml = full.length > XMP_SCAN ? full.slice(0, XMP_SCAN) : full;
    const one = name => {
      const a = attrValue(xml, name); if (a != null) return a;
      const e = elementText(xml, name); if (e == null) return '';
      const li = listItems(e);
      return li.length ? li.map(stripTags).filter(Boolean).join(', ') : stripTags(e);
    };
    const unxml = s => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&').trim();
    const add = (id, label, names, risk, extra) => {
      const vals = names.map(n => unxml(one(n))).filter(Boolean);
      if (vals.length) addOnce(out, F(id, label, [...new Set(vals)].join(', '), risk, extra));
    };
    const lat = one('exif:GPSLatitude'), lon = one('exif:GPSLongitude');
    if (lat && lon) out.push(F('gps', 'Location', `${lat}, ${lon}`, 'high', { note: 'Shows where the photo was taken, often to within a few metres.' }));
    add('artist', 'Author name', ['dc:creator', 'tiff:Artist', 'photoshop:AuthorsPosition', 'pdf:Author'], 'high');
    add('place', 'Place names', ['photoshop:City', 'photoshop:State', 'photoshop:Country', 'Iptc4xmpCore:Location', 'Iptc4xmpCore:CountryCode', 'Iptc4xmpExt:City', 'Iptc4xmpExt:Sublocation'], 'high');
    add('serial', 'Camera serial number', ['aux:SerialNumber', 'exifEX:BodySerialNumber', 'aux:LensSerialNumber', 'exifEX:LensSerialNumber'], 'high');
    add('owner', 'Camera owner name', ['aux:OwnerName', 'exifEX:CameraOwnerName'], 'high');
    add('contact', 'Contact details', ['Iptc4xmpCore:CiEmailWork', 'Iptc4xmpCore:CiTelWork', 'Iptc4xmpCore:CiAdrExtadr', 'Iptc4xmpCore:CiUrlWork'], 'high');
    add('model', 'Camera or phone model', ['tiff:Make', 'tiff:Model'], 'medium');
    add('software', 'Software', ['xmp:CreatorTool', 'pdf:Producer'], 'medium');
    add('datetaken', 'Dates', ['exif:DateTimeOriginal', 'photoshop:DateCreated', 'xmp:CreateDate', 'xmp:ModifyDate', 'xmp:MetadataDate'], 'medium');
    add('description', 'Title and description', ['dc:title', 'dc:description', 'photoshop:Headline'], 'medium');
    add('keywords', 'Keywords', ['dc:subject', 'pdf:Keywords'], 'medium');
    add('copyright', 'Copyright notice', ['dc:rights'], 'low');
    if (/xmpMM:(Document|Instance|OriginalDocument)ID/.test(xml)) out.push(F('docid', 'Document IDs', 'identifiers that can link this file to its originals and other copies', 'medium'));
    if (/xmpMM:History|stEvt:action/.test(xml)) out.push(F('history', 'Edit history', 'a log of the apps and edits used on this file', 'medium'));
    if (/photoshop:DocumentAncestors/.test(xml)) out.push(F('ancestors', 'Source file IDs', 'IDs of other files that were pasted into this one', 'medium'));
    if (/GCamera:Motion|Camera:MotionPhoto|GCamera:MicroVideo|Container:Directory/.test(xml)) out.push(F('motion', 'Motion photo', 'a short video clip stored with the photo', 'high', { note: 'The clip and its sound are removed too.' }));
    if (/GDepth:|GImage:|hdrgm:/.test(xml)) out.push(F('depth', 'Extra image layers', 'depth map or other hidden images', 'medium'));
    if (!out.length) out.push(F('xmp', 'XMP metadata', kb(full.length) + ' of extra data', 'low'));
    if (where) out.forEach(f => { f.where = where; });
    return out;
  }

  // ---------- IPTC (in JPEG APP13 Photoshop blocks) ----------
  const IPTC = { 80: ['artist', 'Author name', 'high'], 122: ['artist', 'Author name', 'high'], 85: ['artisttitle', 'Author job title', 'medium'],
    90: ['place', 'Place names', 'high'], 92: ['place', 'Place names', 'high'], 95: ['place', 'Place names', 'high'], 100: ['place', 'Place names', 'high'], 101: ['place', 'Place names', 'high'],
    116: ['copyright', 'Copyright notice', 'low'], 120: ['description', 'Title and description', 'medium'], 105: ['description', 'Title and description', 'medium'], 5: ['description', 'Title and description', 'medium'],
    25: ['keywords', 'Keywords', 'medium'], 55: ['datetaken', 'Dates', 'medium'], 110: ['credit', 'Credit', 'medium'], 115: ['credit', 'Credit', 'medium'], 118: ['contact', 'Contact details', 'high'] };
  function photoshopFindings(b, start, end) {
    const out = [];
    let p = start;
    while (p + 12 <= end && startsWith(b, p, '8BIM')) {
      const id = be16(b, p + 4), nameLen = b[p + 6], nameEnd = p + 6 + 1 + nameLen + ((1 + nameLen) & 1);
      const size = be32(b, nameEnd), data = nameEnd + 4, next = data + size + (size & 1);
      if (next > end + 1) break;
      if (id === 0x0404) {
        let q = data;
        while (q + 5 <= data + size && b[q] === 0x1c) {
          const rec = b[q + 1], ds = b[q + 2], n = be16(b, q + 3); const v = b.subarray(q + 5, q + 5 + n);
          if (rec === 2 && IPTC[ds]) { const d = IPTC[ds]; addOnce(out, F(d[0], d[1], text(v), d[2])); }
          q += 5 + n;
        }
      } else if (id === 0x040c || id === 0x0409) addOnce(out, F('thumb', 'Embedded thumbnail', 'a small copy of the original picture', 'high', { note: 'It can still show parts of the photo you cropped out or edited.' }));
      else if (id === 0x0424) addOnce(out, xmpFindings(text(b.subarray(data, data + size)))[0] || F('xmp', 'XMP metadata', '', 'low'));
      else addOnce(out, F('photoshop', 'Photoshop data', 'editing information from Photoshop or similar apps', 'low'));
      p = next;
    }
    if (!out.length) out.push(F('photoshop', 'Photoshop data', 'editing information from Photoshop or similar apps', 'low'));
    return out;
  }

  // ---------- ICC colour profiles ----------
  // A plain sRGB profile is removed: viewers assume sRGB when a picture has no profile, so the colours stay the same.
  // Any other profile (Display P3, Adobe RGB…) is kept so colours look right, but its revealing fields are blanked:
  // when it was made (lcms and Pillow stamp the moment the file was saved), the app, platform, maker and model codes,
  // the profile ID (a checksum of the original), the copyright text and any device or calibration notes.
  // None of these take part in colour conversion, and the profile keeps its length.
  const SRGB_D50 = { rXYZ: [0.4361, 0.2225, 0.0139], gXYZ: [0.3851, 0.7169, 0.0971], bXYZ: [0.1431, 0.0606, 0.7141] };
  const s15 = (p, o) => ((p[o] << 24) | (p[o + 1] << 16) | (p[o + 2] << 8) | p[o + 3]) / 65536;
  function iccTags(p) {
    const tags = new Map(), n = Math.min(be32(p, 128), 200);
    for (let i = 0; i < n; i++) {
      const e = 132 + i * 12; if (e + 12 > p.length) break;
      const o = be32(p, e + 4), len = be32(p, e + 8);
      if (o >= 128 && len >= 8 && o + len <= p.length && !tags.has(ascii(p, e, 4))) tags.set(ascii(p, e, 4), { o, n: len, type: ascii(p, o, 4) });
    }
    return tags;
  }
  function iccText(p, t) {   // text of a 'desc' (v2), 'text' or 'mluc' (v4) tag
    if (!t) return '';
    const o = t.o, end = t.o + t.n, strip = s => clip(s.replace(/\u0000[\s\S]*$/, ''), 120);
    if (t.type === 'text') return strip(latin1(p.subarray(o + 8, end)));
    if (t.type === 'desc' && t.n >= 12) return strip(latin1(p.subarray(o + 12, Math.min(end, o + 12 + be32(p, o + 8)))));
    if (t.type === 'mluc' && t.n >= 16) {
      const count = Math.min(be32(p, o + 8), 100), size = be32(p, o + 12); let best = '';
      for (let i = 0; i < count && size >= 12; i++) {
        const r = o + 16 + i * size; if (r + 12 > end) break;
        const len = be32(p, r + 4), at = o + be32(p, r + 8); if (at + len > end) continue;
        const s = strip(new TextDecoder('utf-16be').decode(p.subarray(at, at + (len & ~1))));
        if (s && (!best || ascii(p, r, 4) === 'enUS')) best = s;
      }
      return best;
    }
    return '';
  }
  function blankText(p, t) {   // empties a text tag in place, keeping its length and structure
    const o = t.o, end = t.o + t.n;
    if (t.type === 'text') p.fill(0, o + 8, end);
    else if (t.type === 'desc') p.fill(0, Math.min(end, o + 12), end);
    else if (t.type === 'mluc' && t.n >= 16) {
      const count = Math.min(be32(p, o + 8), 100), size = be32(p, o + 12);
      for (let i = 0; i < count && size >= 12; i++) { const r = o + 16 + i * size; if (r + 12 > end) break; p.fill(0, r + 4, r + 8); }
      p.fill(0, Math.min(end, o + 16 + count * size), end);
    }
  }
  // what to do with a profile: { kind: 'srgb' | 'other' | 'bad', name, details: [what is revealing], bytes: blanked copy }
  function iccPlan(p) {
    if (!p || p.length < 132 || !startsWith(p, 36, 'acsp') || be32(p, 0) > p.length) return { kind: 'bad', name: '', details: [] };
    const tags = iccTags(p), name = iccText(p, tags.get('desc'));
    const xyz = sig => { const t = tags.get(sig); return t && t.type === 'XYZ ' && t.n >= 20 ? [s15(p, t.o + 8), s15(p, t.o + 12), s15(p, t.o + 16)] : null; };
    const isSrgb = ascii(p, 16, 4) === 'RGB ' && /srgb/i.test(name)
      && Object.keys(SRGB_D50).every(sig => { const v = xyz(sig); return v && v.every((x, i) => Math.abs(x - SRGB_D50[sig][i]) < 0.0015); });
    if (isSrgb) return { kind: 'srgb', name, details: [], intent: p[67] & 3 };
    const q = p.slice(), details = [], zero = (a, b) => q.fill(0, a, b), nonzero = (a, b) => p.subarray(a, b).some(x => x);
    if (nonzero(24, 36)) {
      const d = i => String(be16(p, 24 + i * 2)).padStart(2, '0');
      details.push(`made ${d(0)}-${d(1)}-${d(2)} ${d(3)}:${d(4)}`); zero(24, 36);
    }
    const codes = [];
    for (const at of [4, 40, 48, 52, 80]) if (nonzero(at, at + 4)) { const c = clip(latin1(p.subarray(at, at + 4)).replace(/[^\x20-\x7e]/g, ''), 8); if (c && !codes.includes(c)) codes.push(c); zero(at, at + 4); }
    if (codes.length) details.push('app and device codes ' + codes.join(', '));
    for (const sig of ['cprt', 'dmnd', 'dmdd']) {
      const t = tags.get(sig); if (!t) continue;
      const s = iccText(p, t); if (s) details.push(s);
      if (s || nonzero(t.o + 8, t.o + t.n)) blankText(q, t);
    }
    const calt = tags.get('calt'); if (calt && calt.type === 'dtim' && calt.n >= 20 && nonzero(calt.o + 8, calt.o + 20)) { details.push('calibration date'); zero(calt.o + 8, calt.o + 20); }
    const changed = !same(p, q);
    if (changed) zero(84, 100);   // the profile ID is a checksum of the original: it would no longer match
    return { kind: 'other', name, details, changed, bytes: q };
  }
  function iccFindings(plan, out) {
    if (!plan) return out;
    if (plan.kind === 'bad') addOnce(out, F('icc', 'Colour profile', 'damaged', 'low', { note: 'Viewers ignore a damaged colour profile, so it is removed.' }));
    else if (plan.kind === 'srgb') addOnce(out, F('icc', 'Colour profile', plan.name, 'low', { note: 'Standard sRGB, which viewers assume anyway, so the colours stay the same.' }));
    else {
      addOnce(out, F('icc', 'Colour profile', plan.name, 'low', { keep: 'always', note: 'Kept so colours look right.' }));
      if (plan.changed) addOnce(out, F('iccdetails', 'Colour profile details', plan.details.join('; ') || 'creation details', 'low', { note: 'When and with what the profile was made. Blanked; the colours are not affected.' }));
    }
    return out;
  }

  // ---------- JPEG ----------
  function jpegSegments(b) {
    if (!(b[0] === 0xff && b[1] === 0xd8)) throw new Error('Not a JPEG file');
    const segs = []; let p = 2, end = -1;
    while (p < b.length) {
      if (b[p] !== 0xff) break;
      while (b[p + 1] === 0xff) p++;   // fill bytes
      const m = b[p + 1];
      if (m === 0xd9) { end = p + 2; break; }
      if ((m >= 0xd0 && m <= 0xd7) || m === 0x01) { segs.push({ m, s: p, e: p + 2, d: p + 2 }); p += 2; continue; }
      if (p + 4 > b.length) break;
      const len = be16(b, p + 2); let e = p + 2 + len;
      if (len < 2 || e > b.length) break;
      if (m === 0xda) {   // start of scan: the compressed picture runs until the next real marker
        let i = e;
        while (i < b.length - 1) {
          if (b[i] === 0xff) { const n = b[i + 1]; if (n === 0 || (n >= 0xd0 && n <= 0xd7) || n === 0xff) { i += n === 0xff ? 1 : 2; continue; } break; }
          i++;
        }
        e = Math.min(i, b.length);
      }
      segs.push({ m, s: p, e, d: p + 4 });
      p = e;
    }
    return { segs, end, trailing: end > 0 ? b.length - end : 0, truncated: end < 0 };
  }
  const appId = (b, s) => {
    const d = s.d, m = s.m;
    if (m === 0xe0) return startsWith(b, d, 'JFIF\0') ? 'jfif' : startsWith(b, d, 'JFXX\0') ? 'jfxx' : 'app0';
    if (m === 0xe1) return startsWith(b, d, 'Exif\0') ? 'exif' : startsWith(b, d, 'http://ns.adobe.com/xap/1.0/\0') ? 'xmp' : startsWith(b, d, 'http://ns.adobe.com/xmp/extension/\0') ? 'xmpext' : 'app1';
    if (m === 0xe2) return startsWith(b, d, 'ICC_PROFILE\0') ? 'icc' : startsWith(b, d, 'MPF\0') ? 'mpf' : startsWith(b, d, 'FPXR\0') ? 'fpxr' : 'app2';
    if (m === 0xed) return startsWith(b, d, 'Photoshop 3.0\0') ? 'photoshop' : 'app13';
    if (m === 0xee) return startsWith(b, d, 'Adobe') ? 'adobe' : 'app14';
    if (m >= 0xf0 && m <= 0xfd) return 'jpgn';   // reserved markers: no picture data in an ordinary JPEG (JPEG-LS is handled below)
    if (m === 0xeb) return 'jumbf';
    if (m === 0xfe) return 'com';
    if (m >= 0xe0 && m <= 0xef) return 'app' + (m - 0xe0);
    return null;
  }
  // JPEG-LS uses two of the reserved markers (FFF7 frame, FFF8 parameters) for the picture itself
  const isJpegLs = segs => segs.some(s => s.m === 0xf7);
  const ADOBE_LEN = 12;
  // JFIF header: 'JFIF\0', version, density units, X and Y density, then the thumbnail's width and height (0 = none)
  // and its pixels (3 bytes each). Only those first 14 bytes are needed; a clean copy says "no thumbnail".
  const JFIF_LEN = 14;   // 'Adobe', version, two flag words and the colour transform: anything after it is extra
  // a JPEG colour profile may be split over several APP2 segments, numbered 1..count
  function jpegIcc(b, segs) {
    const parts = segs.filter(s => appId(b, s) === 'icc');
    if (!parts.length) return null;
    const ordered = parts.length === 1 ? parts : parts.slice().sort((x, y) => b[x.d + 12] - b[y.d + 12]);
    const ok = ordered.every((s, i) => s.e >= s.d + 14 && (parts.length === 1 || (b[s.d + 12] === i + 1 && b[s.d + 13] === parts.length)));
    return { parts, ordered, plan: ok ? iccPlan(concat(ordered.map(s => b.subarray(s.d + 14, s.e)))) : { kind: 'bad', name: '', details: [] } };
  }
  function jpegIccSegments(b, icc) {   // the blanked profile, back in segments of the same sizes
    let at = 0;
    return icc.ordered.map(s => { const seg = b.slice(s.s, s.e), n = s.e - s.d - 14; seg.set(icc.plan.bytes.subarray(at, at + n), s.d - s.s + 14); at += n; return seg; });
  }
  function inspectJpeg(b, where) {
    const { segs, trailing, truncated } = jpegSegments(b);
    let out = [], keep = {};
    for (const s of segs) {
      const id = appId(b, s); if (!id) continue;
      if (id === 'exif') { const r = exifFindings(parseTiff(b.subarray(s.d + 6, s.e)), where); out = out.concat(r.findings); keep = Object.assign(keep, r.keep); }
      else if (id === 'xmp') out = out.concat(xmpFindings(text(b.subarray(s.d + 29, s.e)), where));
      else if (id === 'xmpext') addOnce(out, F('xmp', 'XMP metadata', 'extended block', 'low'));
      else if (id === 'photoshop') out = out.concat(photoshopFindings(b, s.d + 14, s.e));
      else if (id === 'icc') continue;   // handled below, once all its parts are known
      else if (id === 'mpf') addOnce(out, F('mpf', 'Extra embedded images', 'previews, depth maps or other hidden pictures', 'medium'));
      else if (id === 'jumbf') addOnce(out, F('c2pa', 'Content Credentials', 'a signed record of where the image came from and how it was edited', 'medium'));
      else if (id === 'com') addOnce(out, F('comment', 'Comment', text(b.subarray(s.d, s.e)), 'medium'));
      else if (id === 'adobe') { if (s.e - s.d > ADOBE_LEN) addOnce(out, F('appdata', 'Other app data', 'extra data added to the Adobe colour block', 'low')); }
      else if (id === 'jpgn') { if (!(isJpegLs(segs) && (s.m === 0xf7 || s.m === 0xf8))) addOnce(out, F('appdata', 'Other app data', 'data in reserved JPEG markers', 'low')); }
      else if (id === 'jfif') {
        const tw = b[s.d + 12] || 0, th = b[s.d + 13] || 0;
        if (s.e - s.d >= JFIF_LEN && tw * th) addOnce(out, F('thumb', 'Embedded thumbnail', 'a small copy of the original picture', 'high', { note: 'It can still show parts of the photo you cropped out or edited.' }));
        else if (s.e - s.d > JFIF_LEN) addOnce(out, F('appdata', 'Other app data', 'extra data added to the JFIF header', 'low'));
      }
      else if (id === 'jfxx') addOnce(out, F('thumb', 'Embedded thumbnail', 'a small copy of the original picture', 'high', { note: 'It can still show parts of the photo you cropped out or edited.' }));
      else addOnce(out, F('appdata', 'Other app data', 'private data added by a camera or app', 'low'));
    }
    const icc = jpegIcc(b, segs); if (icc) iccFindings(icc.plan, out);
    if (trailing > 16) {
      const tail = b.subarray(b.length - trailing);
      const video = indexOf(tail, 'ftyp') >= 0 && indexOf(tail, 'ftyp') < 64 || indexOf(tail, 'ftypmp4') >= 0 || indexOf(tail, 'ftypisom') >= 0;
      addOnce(out, F('trailing', video ? 'Hidden video' : 'Hidden data after the picture', video ? `a ${kb(trailing)} video clip (motion photo) attached to the file` : kb(trailing) + ' of extra data stored after the image', 'high'));
    }
    return { findings: out, keep, truncated };
  }
  function cleanJpeg(b, opts, keepIn) {
    const { segs, end } = jpegSegments(b);
    const keep = keepIn || inspectJpeg(b).keep;
    const icc = jpegIcc(b, segs);
    const exif = buildExif(keep, opts || {});
    const parts = [b.subarray(0, 2)];
    let inserted = false;
    const addExif = () => { if (!inserted && exif) { const head = new Uint8Array(10); const n = exif.length + 8; head.set([0xff, 0xe1, n >> 8, n & 255, 0x45, 0x78, 0x69, 0x66, 0, 0]); parts.push(head, exif); } inserted = true; };
    for (const s of segs) {
      const id = appId(b, s);
      if (id === 'jfif') {
        if (s.e - s.d < JFIF_LEN) parts.push(b.subarray(s.s, s.e));   // too short to hold anything extra: as it is
        else { const h = b.slice(s.d - 4, s.d + JFIF_LEN); h[2] = 0; h[3] = JFIF_LEN + 2; h[16] = 0; h[17] = 0; parts.push(h); }
        continue;
      }
      if (!inserted && id !== 'jfif') addExif();
      if (id === 'icc') { if (icc.plan.kind === 'other' && s === icc.parts[0]) parts.push(...jpegIccSegments(b, icc)); }
      else if (id === 'adobe') parts.push(s.e - s.d > ADOBE_LEN ? concat([new Uint8Array([0xff, 0xee, 0, ADOBE_LEN + 2]), b.subarray(s.d, s.d + ADOBE_LEN)]) : b.subarray(s.s, s.e));
      else if (id === 'jpgn') { if (isJpegLs(segs) && (s.m === 0xf7 || s.m === 0xf8)) parts.push(b.subarray(s.s, s.e)); }
      else if (id === null) parts.push(b.subarray(s.s, s.e));
    }
    addExif();
    parts.push(end > 0 ? b.subarray(end - 2, end) : new Uint8Array([0xff, 0xd9]));
    return concat(parts);
  }

  // ---------- PNG ----------
  const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  const PNG_KEEP = new Set(['tRNS', 'gAMA', 'cHRM', 'sRGB', 'iCCP', 'sBIT', 'bKGD', 'pHYs', 'hIST', 'acTL', 'fcTL', 'fdAT', 'cICP', 'mDCv', 'cLLI', 'mDCV', 'cLLi']);
  const PNG_CRITICAL = new Set(['IHDR', 'PLTE', 'IDAT', 'IEND']);   // any other chunk with a capital first letter is unknown: viewers refuse it
  function pngChunks(b) {
    for (let i = 0; i < 8; i++) if (b[i] !== PNG_SIG[i]) throw new Error('Not a PNG file');
    const out = []; let p = 8;
    while (p + 12 <= b.length) {
      const len = be32(b, p), type = ascii(b, p + 4, 4), e = p + 12 + len;
      if (e > b.length) break;
      out.push({ type, s: p, d: p + 8, n: len, e });
      p = e;
      if (type === 'IEND') break;
    }
    return { chunks: out, trailing: b.length - p };
  }
  const PNG_TEXT = { Author: ['artist', 'Author name', 'high'], Artist: ['artist', 'Author name', 'high'], Make: ['make', 'Camera or phone maker', 'medium'], Model: ['model', 'Camera or phone model', 'medium'], Comment: ['comment', 'Comment', 'medium'], Copyright: ['copyright', 'Copyright notice', 'low', { keep: 'copyright' }],
    'Creation Time': ['datetaken', 'Date created', 'medium', { keep: 'date' }], Description: ['description', 'Title and description', 'medium'], Title: ['description', 'Title and description', 'medium'],
    Software: ['software', 'Software', 'medium'], Source: ['model', 'Camera or phone model', 'medium'], Disclaimer: ['other', 'Other text', 'low'], Warning: ['other', 'Other text', 'low'] };
  async function pngTexts(b, chunks) {
    const out = [];
    for (const c of chunks) {
      if (c.type !== 'tEXt' && c.type !== 'zTXt' && c.type !== 'iTXt') continue;
      const d = b.subarray(c.d, c.d + c.n), z = d.indexOf(0); if (z < 0) continue;
      const key = latin1(d.subarray(0, z));
      let val = null;
      if (c.type === 'tEXt') val = latin1(d.subarray(z + 1));
      else if (c.type === 'zTXt') { const r = await inflate(d.subarray(z + 2)); val = r ? latin1(r) : null; }
      else {
        const comp = d[z + 1]; let q = z + 3;
        const l1 = d.indexOf(0, q); const l2 = l1 < 0 ? -1 : d.indexOf(0, l1 + 1); if (l2 < 0) continue;
        const body = d.subarray(l2 + 1);
        if (comp) { const r = await inflate(body); val = r ? utf8(r) : null; } else val = utf8(body);
      }
      out.push({ key, val, type: c.type });
    }
    return out;
  }
  const hexProfile = s => {   // ImageMagick "Raw profile type exif": "\nexif\n   1234\n4578696600..."
    const m = /^\s*\S+\s+\d+\s/.exec(s || ''); if (!m) return null;   // the header, then the hex checked separately (one pass)
    const hex = s.slice(m[0].length).replace(/\s+/g, ''); if (!/^[0-9a-fA-F]*$/.test(hex)) return null;
    const a = new Uint8Array(hex.length >> 1);
    for (let i = 0; i < a.length; i++) a[i] = parseInt(hex.substr(i * 2, 2), 16);
    return a;
  };
  // iCCP: profile name, 0, compression method 0, zlib data. null when this browser can't decompress (left as it is)
  async function pngIcc(b, c) {
    const d = b.subarray(c.d, c.d + c.n), z = d.indexOf(0), bad = { name: null, plan: { kind: 'bad', name: '', details: [] } };
    if (z < 1 || z > 79 || d[z + 1] !== 0) return bad;
    if (typeof DecompressionStream === 'undefined') return null;
    const raw = await inflate(d.subarray(z + 2));
    return raw ? { name: d.subarray(0, z), plan: iccPlan(raw) } : bad;
  }
  async function inspectPng(b) {
    const { chunks, trailing } = pngChunks(b);
    let out = [], keep = {};
    const texts = await pngTexts(b, chunks);
    for (const t of texts) {
      if (t.key === 'XML:com.adobe.xmp') { out = out.concat(xmpFindings(t.val || '')); continue; }
      if (/^Raw profile type (exif|APP1)$/i.test(t.key)) {
        let raw = hexProfile(t.val); if (raw && startsWith(raw, 0, 'Exif\0')) raw = raw.subarray(6);
        const r = exifFindings(parseTiff(raw)); out = out.concat(r.findings.length ? r.findings : [F('exif', 'Camera data', 'stored as text', 'medium')]); keep = Object.assign({}, r.keep, keep);
        continue;
      }
      if (/^Raw profile type (xmp)$/i.test(t.key)) { const raw = hexProfile(t.val); out = out.concat(xmpFindings(raw ? text(raw) : '')); continue; }
      if (/^Raw profile type/i.test(t.key)) { addOnce(out, F('appdata', 'Other app data', t.key.replace(/^Raw profile type /i, '') + ' profile', 'low')); continue; }
      if (/^exif:GPS(Latitude|Longitude)$/i.test(t.key)) { addOnce(out, F('gps', 'Location', t.val || '', 'high', { note: 'Shows where the photo was taken, often to within a few metres.' })); continue; }
      if (/^(date|exif):/i.test(t.key) && /date|time/i.test(t.key)) { addOnce(out, F('datemod', 'Dates', t.val || '', 'medium')); continue; }
      if (/^exif:/i.test(t.key)) { addOnce(out, F('exiftext', 'Camera data', 'stored as text by an editing app', 'medium')); continue; }
      const d = PNG_TEXT[t.key];
      if (d) { addOnce(out, F(d[0], d[1], t.val == null ? '(compressed)' : t.val, d[2], d[3])); if (t.key === 'Copyright' && t.val) keep.pngCopyright = t.val; if (t.key === 'Creation Time' && t.val) keep.pngDate = t.val; }
      else addOnce(out, F('text:' + t.key, 'Text: ' + clip(t.key, 40), t.val == null ? '(compressed)' : t.val, 'medium'));
    }
    for (const c of chunks) {
      if (c.type === 'eXIf') { const r = exifFindings(parseTiff(b.subarray(c.d, c.d + c.n))); out = out.concat(r.findings); keep = Object.assign(keep, r.keep); }
      else if (c.type === 'tIME') { const d = b.subarray(c.d); addOnce(out, F('timemod', 'Date modified', `${be16(d, 0)}-${String(d[2]).padStart(2, '0')}-${String(d[3]).padStart(2, '0')} ${String(d[4]).padStart(2, '0')}:${String(d[5]).padStart(2, '0')}`, 'medium')); }
      else if (c.type === 'iCCP') { const icc = await pngIcc(b, c); if (icc) iccFindings(icc.plan, out); else addOnce(out, F('icc', 'Colour profile', '', 'low', { keep: 'always', note: 'Kept so colours look right.' })); }
      else if (c.type === 'caBX') addOnce(out, F('c2pa', 'Content Credentials', 'a signed record of where the image came from and how it was edited', 'medium'));
      else if (c.type === 'sPLT') addOnce(out, F('appdata', 'Other app data', 'a suggested palette, which carries a name', 'low'));
      else if (!PNG_CRITICAL.has(c.type) && !PNG_KEEP.has(c.type) && !/^(tEXt|zTXt|iTXt)$/.test(c.type)) addOnce(out, F('appdata', 'Other app data', 'private data added by an app (' + clip(c.type.replace(/[^\x20-\x7e]/g, '?'), 8) + ')', 'low'));
    }
    if (trailing > 16) addOnce(out, F('trailing', 'Hidden data after the picture', kb(trailing) + ' of extra data stored after the image', 'high'));
    return { findings: out, keep };
  }
  function pngChunk(type, data) {
    const out = new Uint8Array(12 + data.length), t = enc(type);
    out[0] = data.length >>> 24; out[1] = (data.length >> 16) & 255; out[2] = (data.length >> 8) & 255; out[3] = data.length & 255;
    out.set(t, 4); out.set(data, 8);
    const c = crcDone(crc32(data, crc32(t)));
    out[8 + data.length] = c >>> 24; out[9 + data.length] = (c >> 16) & 255; out[10 + data.length] = (c >> 8) & 255; out[11 + data.length] = c & 255;
    return out;
  }
  async function cleanPng(b, opts) {
    const { chunks } = pngChunks(b);
    const { keep } = await inspectPng(b);
    const exif = buildExif(keep, opts);
    const extra = [];
    if (exif) extra.push(pngChunk('eXIf', exif));
    if (opts.keepCopyright && keep.pngCopyright && !(exif && keep.copyright)) extra.push(pngChunk('tEXt', concat([enc('Copyright\0'), enc(keep.pngCopyright.slice(0, 200))])));
    if (opts.keepDate && keep.pngDate && !(exif && keep.date)) extra.push(pngChunk('tEXt', concat([enc('Creation Time\0'), enc(keep.pngDate.slice(0, 64))])));
    const parts = [b.subarray(0, 8)], hasSrgb = chunks.some(c => c.type === 'sRGB' || c.type === 'cICP');
    for (const c of chunks) {
      const critical = PNG_CRITICAL.has(c.type);
      if (c.type === 'iCCP') {
        const icc = await pngIcc(b, c), plan = icc && icc.plan;
        if (!plan || (plan.kind === 'other' && !plan.changed)) parts.push(b.subarray(c.s, c.e));
        else if (plan.kind === 'srgb' && !hasSrgb) parts.push(pngChunk('sRGB', new Uint8Array([plan.intent])));   // says "sRGB" in one byte, so any gAMA or cHRM chunk stays ignored
        else if (plan.kind === 'other') { const z = await deflate(plan.bytes); parts.push(z ? pngChunk('iCCP', concat([icc.name, new Uint8Array(2), z])) : b.subarray(c.s, c.e)); }
      } else if (critical || PNG_KEEP.has(c.type)) parts.push(b.subarray(c.s, c.e));
      if (c.type === 'IHDR') parts.push(...extra);
    }
    return concat(parts);
  }

  // ---------- WebP ----------
  function webpChunks(b) {
    if (!(startsWith(b, 0, 'RIFF') && startsWith(b, 8, 'WEBP'))) throw new Error('Not a WebP file');
    const out = []; let p = 12; const end = Math.min(b.length, 8 + le32(b, 4));
    while (p + 8 <= end) {
      const type = ascii(b, p, 4), n = le32(b, p + 4), e = p + 8 + n + (n & 1);
      if (p + 8 + n > b.length) break;
      out.push({ type, s: p, d: p + 8, n, e: Math.min(e, b.length) });
      p = e;
    }
    return { chunks: out, trailing: b.length - Math.min(p, b.length) };
  }
  function inspectWebp(b) {
    const { chunks, trailing } = webpChunks(b);
    let out = [], keep = {};
    for (const c of chunks) {
      if (c.type === 'EXIF') {
        let t = b.subarray(c.d, c.d + c.n); if (startsWith(t, 0, 'Exif\0')) t = t.subarray(6);
        const r = exifFindings(parseTiff(t)); out = out.concat(r.findings); keep = Object.assign(keep, r.keep);
      } else if (c.type === 'XMP ') out = out.concat(xmpFindings(text(b.subarray(c.d, c.d + c.n))));
      else if (c.type === 'ICCP') iccFindings(iccPlan(b.subarray(c.d, c.d + c.n)), out);
      else if (!['VP8X', 'VP8 ', 'VP8L', 'ALPH', 'ANIM', 'ANMF'].includes(c.type)) addOnce(out, F('appdata', 'Other app data', 'private data added by an app', 'low'));
    }
    if (trailing > 16) addOnce(out, F('trailing', 'Hidden data after the picture', kb(trailing) + ' of extra data stored after the image', 'high'));
    return { findings: out, keep };
  }
  function cleanWebp(b, opts) {
    const { chunks } = webpChunks(b);
    const { keep } = inspectWebp(b);
    const hasX = chunks.length && chunks[0].type === 'VP8X';
    const exif = hasX ? buildExif(keep, opts) : null;   // a simple WebP has no room for metadata: nothing to keep
    const iccChunk = hasX && chunks.find(c => c.type === 'ICCP'), plan = iccChunk ? iccPlan(b.subarray(iccChunk.d, iccChunk.d + iccChunk.n)) : null;
    const keepIcc = plan && plan.kind === 'other';
    const parts = [];
    for (const c of chunks) {
      if (c.type === 'VP8X') {
        const x = b.slice(c.s, c.e);
        x[8] = (x[8] & ~0x2c) | (exif ? 0x08 : 0) | (keepIcc ? 0x20 : 0);   // clear the EXIF and XMP flags (set EXIF again if we add one); ICC only if kept
        parts.push(x);
      } else if (c.type === 'ICCP') {
        if (c === iccChunk && keepIcc) { const x = b.slice(c.s, c.e); x.set(plan.bytes, 8); parts.push(x); }
      } else if (['VP8 ', 'VP8L', 'ALPH', 'ANIM', 'ANMF'].includes(c.type)) parts.push(b.subarray(c.s, c.e));
    }
    if (exif) { const h = new Uint8Array(8); h.set(enc('EXIF')); h[4] = exif.length & 255; h[5] = (exif.length >> 8) & 255; h[6] = (exif.length >> 16) & 255; h[7] = exif.length >>> 24; parts.push(h, exif); if (exif.length & 1) parts.push(new Uint8Array(1)); }
    const body = concat(parts), head = new Uint8Array(12), n = body.length + 4;
    head.set(enc('RIFF')); head[4] = n & 255; head[5] = (n >> 8) & 255; head[6] = (n >> 16) & 255; head[7] = n >>> 24; head.set(enc('WEBP'), 8);
    return concat([head, body]);
  }

  // ---------- PDF (needs pdf-lib) ----------
  const pdfDate = s => { const m = /^D?:?(\d{4})(\d\d)?(\d\d)?(\d\d)?(\d\d)?(\d\d)?/.exec(s || ''); return m ? `${m[1]}-${m[2] || '01'}-${m[3] || '01'}${m[4] ? ` ${m[4]}:${m[5] || '00'}` : ''}` : s; };
  const INFO = { Author: ['artist', 'Author name', 'high'], Creator: ['creator', 'App that created it', 'medium'], Producer: ['software', 'Software', 'medium'],
    Title: ['description', 'Title', 'medium'], Subject: ['subject', 'Subject', 'medium'], Keywords: ['keywords', 'Keywords', 'medium'],
    CreationDate: ['datecreated', 'Date created', 'medium'], ModDate: ['datemod', 'Date modified', 'medium'] };
  function countRevisions(b) {
    let n = 0, p = 0; while ((p = indexOf(b, '%%EOF', p)) >= 0) { n++; p += 5; }
    const head = latin1(b.subarray(0, Math.min(2048, b.length)));
    if (/\/Linearized/.test(head) && n > 1) n--;   // a "fast web view" PDF has two end markers for one version
    return Math.max(n, 1);
  }
  function pdfKit(lib) {
    const N = s => lib.PDFName.of(s);
    const isDict = o => o instanceof lib.PDFDict, isArr = o => o instanceof lib.PDFArray, isStream = o => o instanceof lib.PDFStream, isRef = o => o instanceof lib.PDFRef;
    const str = o => { try { return o instanceof lib.PDFString || o instanceof lib.PDFHexString ? o.decodeText() : o instanceof lib.PDFName ? o.decodeText() : o == null ? '' : String(o); } catch (e) { return ''; } };
    return { N, isDict, isArr, isStream, isRef, str };
  }
  async function loadPdf(b, lib) {
    if (!lib) throw new Error('PDF support is not available');
    try { return await lib.PDFDocument.load(b, { updateMetadata: false, ignoreEncryption: false, throwOnInvalidObject: false }); }
    catch (e) { if (/encrypt/i.test(e && (e.name + ' ' + e.message))) { const x = new Error('This PDF is password-protected or encrypted. Unmarked can’t clean encrypted PDFs yet.'); x.code = 'encrypted'; throw x; } throw e; }
  }
  // walks every object reachable from the document (each object once); fn(value, parentDict, key)
  function walk(doc, lib, fn) {
    const K = pdfKit(lib), ctx = doc.context, seen = new Set();
    const visit = (o, parent, key) => {
      if (K.isRef(o)) { if (seen.has(o)) return; seen.add(o); const t = ctx.lookup(o); if (t) visit(t, parent, key); return; }
      if (fn(o, parent, key) === false) return;
      if (K.isStream(o)) visit(o.dict, null, null);
      else if (K.isDict(o)) for (const [k, v] of o.entries()) visit(v, o, k.asString());
      else if (K.isArr(o)) for (const v of o.asArray()) visit(v, null, null);
    };
    visit(ctx.trailerInfo.Root);
    return seen;
  }
  function nameTreeNames(dict, lib, ctx, out = [], depth = 0) {
    const K = pdfKit(lib); if (!K.isDict(dict) || depth > 20) return out;
    const names = dict.lookup(K.N('Names'));
    if (K.isArr(names)) for (let i = 0; i < names.size(); i += 2) out.push(K.str(names.lookup(i)));
    const kids = dict.lookup(K.N('Kids'));
    if (K.isArr(kids)) for (let i = 0; i < kids.size(); i++) nameTreeNames(kids.lookup(i), lib, ctx, out, depth + 1);
    return out;
  }
  const MARKUP_KEEP = new Set(['/Link', '/Widget']);
  // a stream's decoded bytes, or null when it is damaged or would unpack past the limit
  function pdfDecode(o, lib) {
    try {
      if (!(o instanceof lib.PDFRawStream)) return o.getContents();
      const out = lib.decodePDFRawStream(o).getBytes(UNPACK_LIMIT + 1);
      return out.length > UNPACK_LIMIT ? null : out;
    } catch (e) { return null; }
  }
  const hostOf = s => { const m = /^[a-z][\w+.-]*:\/\/(?:[^@/?#]*@)?([^/?#:]+)/i.exec(s || ''); return clip(m ? m[1] : s || 'another file', 60); };
  // digital signatures: the field's value, and signature dictionaries anywhere (/Type /Sig or /DocTimeStamp)
  const isSigDict = (o, K) => K.isDict(o) && (o.lookup(K.N('Type')) === K.N('Sig') || o.lookup(K.N('Type')) === K.N('DocTimeStamp'));
  const isSigField = (o, K) => K.isDict(o) && o.lookup(K.N('FT')) === K.N('Sig');
  // actions that run code or send the form somewhere
  const SCRIPT_ACTIONS = ['JavaScript', 'Launch', 'SubmitForm', 'ImportData'];
  // XFA: an XML form layer (mostly in government and tax forms) that Adobe Reader runs, scripts included
  function xfaInfo(doc, K, lib) {
    const af = doc.catalog.lookup(K.N('AcroForm'));
    if (!K.isDict(af) || !af.has(K.N('XFA'))) return null;
    const x = af.lookup(K.N('XFA')), ctx = doc.context;
    const streams = K.isArr(x) ? x.asArray().map(v => ctx.lookup(v)).filter(K.isStream) : K.isStream(x) ? [x] : [];
    const xml = streams.map(s => { const r = pdfDecode(s, lib); return r ? latin1(r) : '<script>'; }).join('\n');   // unreadable: assume the worst
    const fields = af.lookup(K.N('Fields')), needs = doc.catalog.lookup(K.N('NeedsRendering'));
    const submits = [], low = xml.toLowerCase();   // not capped: removing XFA depends on what is found here
    for (let i = 0, n = 0; n < 200; n++) {   // each <submit ...> tag once, looking only inside the tag
      const o = low.indexOf('<submit', i); if (o < 0) break;
      const gt = low.indexOf('>', o), tag = xml.slice(o, Math.min(gt < 0 ? xml.length : gt, o + 500));
      const m = /\btarget\s*=\s*["']([^"']+)/i.exec(tag); if (m) submits.push(hostOf(m[1]));
      i = o + 7;
    }
    return { af, scripts: /<script\b/i.test(xml), submits, dynamic: !(K.isArr(fields) && fields.size()) || String(needs) === 'true' };
  }
  // a photo placed in the PDF: the JPEG data, after undoing any text encoding (ASCII85, hex, Flate) wrapped around it
  function pdfJpeg(o, K, lib) {
    if (!(o instanceof lib.PDFRawStream) || o.dict.lookup(K.N('Subtype')) !== K.N('Image')) return null;
    const f = o.dict.lookup(K.N('Filter'));
    const list = K.isArr(f) ? f.asArray().map(x => o.dict.context.lookup(x)) : f ? [f] : [];
    if (!list.length || list[list.length - 1] !== K.N('DCTDecode')) return null;
    if (list.length === 1) return o.getContents();
    const d = o.dict.clone(o.dict.context);
    d.set(K.N('Filter'), o.dict.context.obj(list.slice(0, -1)));
    const p = o.dict.lookup(K.N('DecodeParms'));
    if (K.isArr(p)) d.set(K.N('DecodeParms'), o.dict.context.obj(p.asArray().slice(0, -1))); else d.delete(K.N('DecodeParms'));
    const out = pdfDecode(lib.PDFRawStream.of(d, o.getContents()), lib);
    if (!out) throw new Error('too big or damaged');
    return out;
  }
  async function inspectPdf(b, lib) {
    const out = [], options = { attachments: false, scripts: false, comments: false };
    const revisions = countRevisions(b);
    if (revisions > 1) out.push(F('revisions', 'Earlier saved versions', `${revisions - 1} earlier version${revisions > 2 ? 's' : ''} of the document`, 'high', { note: 'Edits are often added to the end of a PDF. The earlier versions, including text you deleted, can still be inside the file.' }));
    const doc = await loadPdf(b, lib), K = pdfKit(lib), ctx = doc.context;
    const info = ctx.lookup(ctx.trailerInfo.Info);
    if (K.isDict(info)) for (const [k, v] of info.entries()) {
      const key = k.decodeText(), val = K.str(ctx.lookup(v)); if (!val || key === 'Trapped') continue;
      const d = INFO[key];
      if (d) addOnce(out, F(d[0], d[1], /Date$/.test(key) ? pdfDate(val) : val, d[2]));
      else addOnce(out, F('custom:' + key, 'Custom field: ' + clip(key, 40), val, 'medium'));
    }
    if (ctx.trailerInfo.ID) out.push(F('docid', 'Document IDs', 'identifiers that can link this file to its originals and other copies', 'medium'));
    const cat = doc.catalog;
    let xmpCount = 0, thumbs = 0, piece = 0, js = 0, annCount = 0, authors = new Set(), photos = 0, photoGps = 0, fields = 0, layers = 0;
    const sigs = new Set(), submits = new Set(); let imports = 0;
    const seen = walk(doc, lib, (o, parent, key) => {
      if (key === '/Metadata' && K.isStream(o)) xmpCount++;
      if (key === '/Thumb') thumbs++;
      if (key === '/PieceInfo') piece++;
      if ((key === '/S' && o === K.N('JavaScript')) || key === '/JS') js++;
      if (isSigDict(o, K)) sigs.add(o);
      if (isSigField(o, K)) { const v = o.lookup(K.N('V')); if (K.isDict(v)) sigs.add(v); }
      if (K.isDict(o)) {
        const s = o.lookup(K.N('S'));
        if (s === K.N('SubmitForm')) { const t = o.lookup(K.N('F')); submits.add(hostOf(K.isDict(t) ? K.str(t.lookup(K.N('UF')) || t.lookup(K.N('F'))) : K.str(t))); }
        if (s === K.N('ImportData')) imports++;
      }
      return true;
    });
    // digital signatures
    if (sigs.size || cat.has(K.N('DSS'))) {
      const who = [...sigs].map(d => [K.str(d.lookup(K.N('Name'))), d.has(K.N('M')) ? pdfDate(K.str(d.lookup(K.N('M')))) : '', K.str(d.lookup(K.N('Location'))), K.str(d.lookup(K.N('ContactInfo'))), K.str(d.lookup(K.N('Reason')))].filter(Boolean).join(', ')).filter(Boolean);
      out.push(F('signature', sigs.size > 1 ? 'Digital signatures' : 'Digital signature', who.join('; ') || (sigs.size ? 'the signer’s certificate, with their name' : 'certificates kept to check a signature'), 'high',
        { note: 'The digital signature is removed: any change to a signed PDF makes its signature invalid anyway.' }));
    }
    // XFA forms
    const xfa = xfaInfo(doc, K, lib);
    if (xfa && (xfa.scripts || xfa.submits.length)) {
      if (xfa.dynamic) out.push(F('xfa', 'XFA form scripts', `code in a form built entirely with XFA${xfa.submits.length ? `, which can send the form to ${[...new Set(xfa.submits)].join(', ')}` : ''}`, 'medium',
        { keep: 'always', note: 'Kept: this form is built entirely from XFA, so without it the pages would be blank. Only Adobe Reader runs it; most other PDF readers ignore it.' }));
      else { if (xfa.scripts) js++; xfa.submits.forEach(h => submits.add(h)); }
    }
    // article threads and web capture keep their own details
    const threads = cat.lookup(K.N('Threads')), tinfo = [];
    if (K.isArr(threads)) for (let i = 0; i < threads.size(); i++) {
      const t = threads.lookup(i), inf = K.isDict(t) ? t.lookup(K.N('I')) : null;
      if (K.isDict(inf)) for (const [, v] of inf.entries()) { const x = K.str(ctx.lookup(v)); if (x) tinfo.push(x); }
    }
    if (tinfo.length) out.push(F('threads', 'Article thread details', [...new Set(tinfo)].join('; '), 'medium', { note: 'Article threads (for reading columns in order) can carry their own author and title.' }));
    // XMP of the document itself (details), other XMP blocks are only counted
    const meta = cat.lookup(K.N('Metadata'));
    if (K.isStream(meta)) {
      let raw = null;
      raw = pdfDecode(meta, lib);
      out.push(...xmpFindings(raw ? text(raw) : '').filter(f => !out.some(x => x.id === f.id && x.value === f.value)));
      xmpCount--;
    }
    if (xmpCount > 0) out.push(F('xmp', 'XMP metadata', `${xmpCount} more block${xmpCount > 1 ? 's' : ''} inside images, fonts or pages`, 'low'));
    if (thumbs) out.push(F('thumb', 'Page thumbnails', `${thumbs} small preview picture${thumbs > 1 ? 's' : ''} of pages`, 'low'));
    if (piece) out.push(F('pieceinfo', 'Private editing data', 'data left by the app that made it (for example Illustrator or Word)', 'medium'));
    // attachments
    const names = cat.lookup(K.N('Names'));
    const files = K.isDict(names) ? nameTreeNames(names.lookup(K.N('EmbeddedFiles')), lib, ctx) : [];
    let fileAnnots = 0;
    for (const page of doc.getPages()) {
      const annots = page.node.lookup(K.N('Annots'));
      if (!K.isArr(annots)) continue;
      for (let i = 0; i < annots.size(); i++) {
        const a = annots.lookup(i); if (!K.isDict(a)) continue;
        const st = String(a.lookup(K.N('Subtype')) || '');
        if (st === '/FileAttachment') fileAnnots++;
        if (st === '/Widget') { fields++; continue; }
        if (MARKUP_KEEP.has(st) || st === '/Popup') continue;
        annCount++;
        const t = K.str(a.lookup(K.N('T'))); if (t) authors.add(clip(t, 40));
      }
    }
    if (files.length || fileAnnots) { options.attachments = true; out.push(F('attachments', 'Attached files', files.length ? files.map(n => clip(n, 40)).join(', ') : `${fileAnnots} attached file${fileAnnots > 1 ? 's' : ''}`, 'high', { option: 'attachments', note: 'Files stored inside the PDF. They can hold their own hidden data.' })); }
    if (annCount) { options.comments = true; out.push(F('comments', 'Comments and markup', `${annCount} note${annCount > 1 ? 's' : ''}, highlight${annCount > 1 ? 's' : ''} or drawing${annCount > 1 ? 's' : ''}`, 'medium', { option: 'comments' })); }
    if (authors.size) out.push(F('commentauthors', 'Comment authors', [...authors].join(', '), 'high', { option: 'comments' }));
    if (cat.has(K.N('SpiderInfo')) || (K.isDict(names) && (names.has(K.N('URLS')) || names.has(K.N('IDS'))))) out.push(F('webcapture', 'Web capture data', 'the addresses of the web pages this PDF was made from', 'medium'));
    const doesWhat = [];
    if (js || (K.isDict(names) && names.has(K.N('JavaScript')))) doesWhat.push('JavaScript that runs when the PDF is opened or used');
    if (submits.size) doesWhat.push(`a button that sends the form to ${[...submits].join(', ')}`);
    if (imports) doesWhat.push('a button that loads data from another file');
    if (doesWhat.length) { options.scripts = true; out.push(F('scripts', 'Scripts', doesWhat.join('; '), submits.size ? 'high' : 'medium', { option: 'scripts' })); }
    const af = cat.lookup(K.N('AcroForm')); if (K.isDict(af)) { const fl = af.lookup(K.N('Fields')); if (K.isArr(fl)) fields = Math.max(fields, fl.size()); }
    if (fields) out.push(F('forms', 'Form fields', `${fields} field${fields > 1 ? 's' : ''} and any answers in them (kept)`, 'low', { keep: 'always' }));
    const ocp = cat.lookup(K.N('OCProperties')); if (K.isDict(ocp)) { const ocg = ocp.lookup(K.N('OCGs')); layers = K.isArr(ocg) ? ocg.size() : 0; }
    if (layers) out.push(F('layers', 'Layers', `${layers} layer${layers > 1 ? 's' : ''} (kept; some may be hidden from view, so check them in a PDF reader)`, 'low', { keep: 'always' }));
    // photos placed in the PDF still carry their own camera data
    for (const ref of seen) {
      const o = ctx.lookup(ref);
      try {
        const jpg = pdfJpeg(o, K, lib); if (!jpg) continue;
        const r = inspectJpeg(jpg);
        const real = r.findings.filter(f => f.keep !== 'always' && !/^icc/.test(f.id));
        if (real.length) { photos++; if (real.some(f => f.id === 'gps')) photoGps++; }
      } catch (e) { /* not a readable JPEG: leave it */ }
    }
    if (photos) out.push(F('photos', 'Photos with camera data', `${photos} photo${photos > 1 ? 's' : ''} inside the PDF still carr${photos > 1 ? 'y' : 'ies'} camera data${photoGps ? `, ${photoGps} with a location` : ''}`, photoGps ? 'high' : 'medium'));
    return { findings: out, options };
  }
  async function cleanPdf(b, lib, opts) {
    const doc = await loadPdf(b, lib), K = pdfKit(lib), ctx = doc.context;
    ctx.trailerInfo.Info = undefined;
    ctx.trailerInfo.ID = undefined;
    const cat = doc.catalog;
    const ALWAYS = ['Metadata', 'PieceInfo', 'LastModified', 'Thumb'];
    // per-page annotations first, so removed ones are not walked below
    if (opts.removeComments || opts.removeAttachments || opts.removeScripts) {
      for (const page of doc.getPages()) {
        const annots = page.node.lookup(K.N('Annots')); if (!K.isArr(annots)) continue;
        const keep = [];
        for (let i = 0; i < annots.size(); i++) {
          const raw = annots.get(i), a = annots.lookup(i), st = K.isDict(a) ? String(a.lookup(K.N('Subtype')) || '') : '';
          if (opts.removeAttachments && st === '/FileAttachment') continue;
          if (opts.removeComments && !MARKUP_KEEP.has(st)) continue;
          keep.push(raw);
        }
        if (keep.length) page.node.set(K.N('Annots'), ctx.obj(keep)); else page.node.delete(K.N('Annots'));
      }
    }
    const names = cat.lookup(K.N('Names'));
    if (K.isDict(names)) {
      if (opts.removeAttachments) names.delete(K.N('EmbeddedFiles'));
      if (opts.removeScripts) names.delete(K.N('JavaScript'));
    }
    if (opts.removeAttachments) cat.delete(K.N('AF'));
    // digital signatures: the change made by cleaning would make them invalid anyway
    cat.delete(K.N('DSS')); cat.delete(K.N('Perms'));
    const af = cat.lookup(K.N('AcroForm'));
    if (K.isDict(af)) af.delete(K.N('SigFlags'));
    // XFA scripts: without XFA, Adobe Reader uses the ordinary form fields (an XFA-only form is kept, and listed)
    const xfa = xfaInfo(doc, K, lib);
    if (opts.removeScripts && xfa && !xfa.dynamic && (xfa.scripts || xfa.submits.length)) { xfa.af.delete(K.N('XFA')); cat.delete(K.N('NeedsRendering')); }
    // article threads' own details, and web capture data
    const threads = cat.lookup(K.N('Threads'));
    if (K.isArr(threads)) for (let i = 0; i < threads.size(); i++) { const t = threads.lookup(i); if (K.isDict(t)) t.delete(K.N('I')); }
    cat.delete(K.N('SpiderInfo'));
    if (K.isDict(names)) { names.delete(K.N('URLS')); names.delete(K.N('IDS')); }
    const isScriptAction = a => { const d = ctx.lookup(a); return K.isDict(d) && (SCRIPT_ACTIONS.some(n => d.lookup(K.N('S')) === K.N(n)) || d.has(K.N('JS'))); };
    walk(doc, lib, (o, parent, key) => {
      if (isSigDict(o, K) && K.isDict(parent) && key) { parent.delete(K.N(key.slice(1))); return false; }
      if (!K.isDict(o)) return true;
      for (const k of ALWAYS) if (o.has(K.N(k))) o.delete(K.N(k));
      if (isSigField(o, K)) {   // an empty signature field stays; its value and its picture (often the signer's name) go
        o.delete(K.N('V')); o.delete(K.N('AP'));
        const kids = o.lookup(K.N('Kids')); if (K.isArr(kids)) for (let i = 0; i < kids.size(); i++) { const w = kids.lookup(i); if (K.isDict(w)) w.delete(K.N('AP')); }
      }
      if (opts.removeScripts) {
        o.delete(K.N('AA'));
        for (const k of ['OpenAction', 'A']) { const v = o.get(K.N(k)); if (v && isScriptAction(v)) o.delete(K.N(k)); }
        if (o.has(K.N('Next'))) {
          const v = o.get(K.N('Next')), list = ctx.lookup(v);
          if (K.isArr(list)) { const keep = list.asArray().filter(a => !isScriptAction(a)); if (keep.length) o.set(K.N('Next'), ctx.obj(keep)); else o.delete(K.N('Next')); }
          else if (isScriptAction(v)) o.delete(K.N('Next'));
        }
      }
      if (opts.removeAttachments && o.lookup(K.N('Type')) === K.N('Filespec')) { o.delete(K.N('EF')); o.delete(K.N('RF')); }
      return true;
    });
    // camera data inside placed photos (lossless, same as for JPEG files)
    const reach = walk(doc, lib, () => true);
    for (const ref of reach) {
      const o = ctx.lookup(ref);
      try {
        const before = pdfJpeg(o, K, lib); if (!before) continue;
        const after = cleanJpeg(before, {}, {});   // PDF readers ignore the rotation tag, so nothing is kept
        if (o.getContents() === before && same(after, before)) continue;
        const d = o.dict.clone(ctx);
        d.set(K.N('Filter'), K.N('DCTDecode'));
        const p = o.dict.lookup(K.N('DecodeParms'));
        if (K.isArr(p) && p.size()) { const last = p.lookup(p.size() - 1); if (K.isDict(last)) d.set(K.N('DecodeParms'), last); else d.delete(K.N('DecodeParms')); } else if (!K.isDict(p)) d.delete(K.N('DecodeParms'));
        ctx.assign(ref, lib.PDFRawStream.of(d, after));
      } catch (e) { /* leave it */ }
    }
    // drop everything no longer reachable: the old document info, earlier versions, removed attachments and scripts
    for (const [ref] of ctx.enumerateIndirectObjects()) if (!reach.has(ref)) ctx.delete(ref);
    const out = await doc.save({ useObjectStreams: true, addDefaultPage: false, updateFieldAppearances: false });
    return out;
  }

  // ---------- detection ----------
  function detect(bytes) {
    const b = u8(bytes);
    const r = (type, label, ext, mime, supported, reason) => ({ type, label, ext, mime, supported, reason });
    if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return r('jpeg', 'JPEG image', 'jpg', 'image/jpeg', true);
    if (b.length >= 8 && PNG_SIG.every((x, i) => b[i] === x)) return r('png', 'PNG image', 'png', 'image/png', true);
    if (b.length >= 12 && startsWith(b, 0, 'RIFF') && startsWith(b, 8, 'WEBP')) return r('webp', 'WebP image', 'webp', 'image/webp', true);
    if (indexOf(b, '%PDF-', 0, Math.min(b.length, 1024)) >= 0) return r('pdf', 'PDF document', 'pdf', 'application/pdf', true);
    if (b.length >= 12 && startsWith(b, 4, 'ftyp')) {
      const brand = ascii(b, 8, 4);
      if (/^(heic|heix|hevc|hevx|heim|heis|mif1|msf1)$/.test(brand)) return r('heic', 'HEIC image', 'heic', 'image/heic', false, 'HEIC photos aren’t supported yet. Most phones can save or share photos as JPEG instead (on Android: camera settings, or “Share” → “Convert to JPEG”).');
      if (/^avi[fs]$/.test(brand)) return r('avif', 'AVIF image', 'avif', 'image/avif', false, 'AVIF images aren’t supported yet.');
      return r('video', 'Video', 'mp4', 'video/mp4', false, 'Videos aren’t supported.');
    }
    if (startsWith(b, 0, 'GIF8')) return r('gif', 'GIF image', 'gif', 'image/gif', false, 'GIF images aren’t supported yet.');
    if (startsWith(b, 0, 'II*\0') || startsWith(b, 0, 'MM\0*')) return r('tiff', 'TIFF or RAW image', 'tif', 'image/tiff', false, 'TIFF and camera RAW files aren’t supported. Export the photo as JPEG first.');
    return r('unknown', 'Unknown file', '', 'application/octet-stream', false, 'Unmarked handles JPEG, PNG and WebP images and PDF documents.');
  }

  async function inspect(bytes, opts = {}) {
    const b = u8(bytes), d = detect(b);
    if (!d.supported) return { type: d.type, findings: [], options: {}, error: d.reason };
    try {
      if (d.type === 'jpeg') { const r = inspectJpeg(b); return { type: d.type, findings: merge(r.findings), options: {}, warning: r.truncated ? 'This JPEG seems to be cut short; the visible part is kept as it is.' : undefined }; }
      if (d.type === 'png') return { type: d.type, findings: merge((await inspectPng(b)).findings), options: {} };
      if (d.type === 'webp') return { type: d.type, findings: merge(inspectWebp(b).findings), options: {} };
      const r = await inspectPdf(b, opts.pdfLib);
      return { type: d.type, findings: merge(r.findings), options: r.options };
    } catch (e) {
      return { type: d.type, findings: [], options: {}, error: e && e.code === 'encrypted' ? e.message : 'This file could not be read. It may be damaged. (' + clip(e && e.message || e, 80) + ')' };
    }
  }

  async function clean(bytes, opts = {}) {
    const b = u8(bytes), d = detect(b);
    if (!d.supported) throw new Error(d.reason);
    const o = { keepDate: !!opts.keepDate, keepCopyright: !!opts.keepCopyright, removeAttachments: !!opts.removeAttachments, removeScripts: !!opts.removeScripts, removeComments: !!opts.removeComments };
    let out;
    if (d.type === 'jpeg') out = cleanJpeg(b, o);
    else if (d.type === 'png') out = await cleanPng(b, o);
    else if (d.type === 'webp') out = cleanWebp(b, o);
    else out = await cleanPdf(b, opts.pdfLib, o);
    return { bytes: out, type: d.type };
  }

  // whether a finding is removed with these options
  function isRemoved(f, opts = {}) {
    if (f.keep === 'always') return false;
    if (f.keep === 'date') return !opts.keepDate;
    if (f.keep === 'copyright') return !opts.keepCopyright;
    if (f.option === 'attachments') return !!opts.removeAttachments;
    if (f.option === 'scripts') return !!opts.removeScripts;
    if (f.option === 'comments') return !!opts.removeComments;
    return true;
  }

  // ---------- file names ----------
  function nameFindings(name) {
    const out = [], base = String(name || '').replace(/\.[^.]+$/, '');
    const dt = /(?:19|20)\d{2}[-_.]?(?:0[1-9]|1[0-2])[-_.]?(?:0[1-9]|[12]\d|3[01])(?:[-_ T.]?(?:[01]\d|2[0-3])[-_.:]?[0-5]\d(?:[-_.:]?[0-5]\d)?)?/.exec(base);
    if (dt) out.push(F('filename-date', 'File name', `“${clip(base, 60)}” contains a date${dt[0].length > 10 ? ' and time' : ''}`, 'medium', { note: 'Turn on “Give files plain names” to replace it.' }));
    else if (/^(IMG|PXL|DSC|DSCN|DSCF|DCIM|MVIMG|Screenshot|Scan|WhatsApp|signal|PANO|VID|GOPR)[\s_-]/i.test(base)) out.push(F('filename-device', 'File name', `“${clip(base, 60)}” shows which phone, camera or app made it`, 'low', { note: 'Turn on “Give files plain names” to replace it.' }));
    return out;
  }
  const plainName = (i, ext) => `${ext === 'pdf' ? 'document' : 'image'}-${String(i).padStart(2, '0')}.${ext}`;

  // ---------- zip (no compression; fixed 1980-01-01 timestamps so the archive reveals nothing) ----------
  function zip(entries) {
    const local = [], central = []; let offset = 0;
    const used = new Set();
    for (const e of entries) {
      let name = String(e.name || 'file').replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_');
      if (used.has(name.toLowerCase())) { const m = /^(.*?)(\.[^.]*)?$/.exec(name); let k = 2; while (used.has(`${m[1]} (${k})${m[2] || ''}`.toLowerCase())) k++; name = `${m[1]} (${k})${m[2] || ''}`; }
      used.add(name.toLowerCase());
      const nm = new TextEncoder().encode(name), data = u8(e.bytes), crc = crcDone(crc32(data));
      const h = new Uint8Array(30 + nm.length), v = new DataView(h.buffer);
      v.setUint32(0, 0x04034b50, true); v.setUint16(4, 20, true); v.setUint16(6, 0x0800, true); v.setUint16(8, 0, true);
      v.setUint16(10, 0, true); v.setUint16(12, 0x21, true); v.setUint32(14, crc, true); v.setUint32(18, data.length, true); v.setUint32(22, data.length, true);
      v.setUint16(26, nm.length, true); v.setUint16(28, 0, true); h.set(nm, 30);
      const c = new Uint8Array(46 + nm.length), w = new DataView(c.buffer);
      w.setUint32(0, 0x02014b50, true); w.setUint16(4, 20, true); w.setUint16(6, 20, true); w.setUint16(8, 0x0800, true); w.setUint16(10, 0, true);
      w.setUint16(12, 0, true); w.setUint16(14, 0x21, true); w.setUint32(16, crc, true); w.setUint32(20, data.length, true); w.setUint32(24, data.length, true);
      w.setUint16(28, nm.length, true); w.setUint32(42, offset, true); c.set(nm, 46);
      local.push(h, data); central.push(c); offset += h.length + data.length;
    }
    const cd = concat(central), end = new Uint8Array(22), x = new DataView(end.buffer);
    x.setUint32(0, 0x06054b50, true); x.setUint16(8, entries.length, true); x.setUint16(10, entries.length, true); x.setUint32(12, cd.length, true); x.setUint32(16, offset, true);
    return concat([...local, cd, end]);
  }

  const api = { detect, inspect, clean, isRemoved, nameFindings, plainName, zip, version: 1,
    _internal: { parseTiff, buildExif, jpegSegments, pngChunks, webpChunks, countRevisions, crc32: b => crcDone(crc32(u8(b))) } };
  root.UnmarkedClean = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
