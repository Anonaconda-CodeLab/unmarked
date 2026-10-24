/* Copyright (C) 2026 Anonaconda Code Lab · SPDX-License-Identifier: GPL-3.0-or-later
   ---------- Android app (Capacitor) ----------
   In the Android app the page runs inside Android's WebView, which can't download files or share them with other apps.
   This file supplies native stand-ins: saving (Android's "save as" screen), sharing (the share sheet), and receiving
   files shared to Unmarked from the gallery or a file manager. In a browser NATIVE is false and nothing here is used.
   Everything stays on the phone: the app has no internet permission. */
const NATIVE = !!(window.Capacitor && typeof window.Capacitor.isNativePlatform === 'function' && window.Capacitor.isNativePlatform());
const nativeCall = (plugin, method, opts) => window.Capacitor.nativePromise(plugin, method, opts || {});
const nativeOn = (plugin, event, cb) => window.Capacitor.addListener(plugin, event, cb);
const CHUNK = 384 * 1024;   // bytes per bridge call (sent as base64)
const toB64 = u => { let s = ''; for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000)); return btoa(s); };
const fromB64 = s => { const b = atob(s || ''), u = new Uint8Array(b.length); for (let i = 0; i < b.length; i++) u[i] = b.charCodeAt(i); return u; };
const UnmarkedNative = NATIVE ? {
  // pick the place first (name only: Android limits what a pending call may carry), then write in pieces
  async saveFile(name, bytes, mime) {
    const r = await nativeCall('Unmarked', 'pickSaveLocation', { name, mime: mime || 'application/octet-stream' });
    if (!r || !r.uri) return { saved: false };
    for (let i = 0; i === 0 || i < bytes.length; i += CHUNK)
      await nativeCall('Unmarked', 'writeChunk', { uri: r.uri, data: toB64(bytes.subarray(i, i + CHUNK)), first: i === 0, last: i + CHUNK >= bytes.length });
    return { saved: true };
  },
  // copy the files into the app's private share folder, then open Android's share sheet
  async share(files) {
    await nativeCall('Unmarked', 'shareBegin');
    for (const [k, f] of files.entries())
      for (let i = 0; i === 0 || i < f.bytes.length; i += CHUNK)
        await nativeCall('Unmarked', 'shareChunk', { index: k, name: f.name, data: toB64(f.bytes.subarray(i, i + CHUNK)), first: i === 0, last: i + CHUNK >= f.bytes.length });
    await nativeCall('Unmarked', 'shareSend', { count: files.length, mimes: files.map(f => f.mime || 'application/octet-stream') });
  },
  // files shared to Unmarked from another app ("Share → Unmarked")
  async takeShared() {
    const r = await nativeCall('Unmarked', 'getShared');
    const out = [];
    for (const it of (r && r.files) || []) {
      const parts = []; let offset = 0;
      for (;;) {
        const c = await nativeCall('Unmarked', 'readShared', { id: it.id, offset, length: CHUNK });
        const u = fromB64(c && c.data); parts.push(u); offset += u.length;
        if (!c || c.eof || !u.length) break;
      }
      const bytes = new Uint8Array(offset); let o = 0; for (const p of parts) { bytes.set(p, o); o += p.length; }
      out.push({ name: it.name || 'shared-file', bytes });
    }
    await nativeCall('Unmarked', 'clearShared').catch(() => {});
    return out;
  },
  onShared: cb => nativeOn('Unmarked', 'shared', cb),
  openUrl: url => nativeCall('Unmarked', 'openUrl', { url })
} : null;

if (NATIVE) (() => {
  document.documentElement.classList.add('native');   // shows Android-only buttons (Check for updates)
  // links to websites and email open in the phone's browser or mail app, never inside the app
  document.addEventListener('click', e => {
    const a = e.target && e.target.closest && e.target.closest('a[href]'); if (!a) return;
    const href = a.getAttribute('href') || '';
    if (/^(https:|mailto:)/i.test(href)) { e.preventDefault(); UnmarkedNative.openUrl(href).catch(() => {}); }
  }, true);
})();
