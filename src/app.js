/* Copyright (C) 2026 Anonaconda Code Lab · SPDX-License-Identifier: GPL-3.0-or-later
   ---------- Unmarked app ----------
   Pick files -> each is checked (clean.js) and its hidden data listed -> "Remove hidden data" makes clean copies,
   checks each copy again, and offers them to save or share. Originals are never changed. Nothing leaves the device. */
(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const C = window.UnmarkedClean, PDF = window.PDFLib;
  const MAX_BYTES = 300 * 1024 * 1024, MAX_FILES = 300;
  const state = { files: [], phase: 'pick', seq: 0, busy: false };
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const size = n => n < 1024 ? n + ' bytes' : n < 1048576 ? Math.round(n / 1024) + ' KB' : (n / 1048576).toFixed(1) + ' MB';
  const plural = (n, one, many) => `${n} ${n === 1 ? one : (many || one + 's')}`;
  const RISK = { high: 2, medium: 1, low: 0 };

  // ---------- options (remembered on this device) ----------
  const OPT_KEY = 'unmarked.options';
  const opts = () => ({ keepDate: $('optDate').checked, keepCopyright: $('optCopyright').checked, plainNames: $('optNames').checked });
  try { const o = JSON.parse(localStorage.getItem(OPT_KEY) || '{}'); $('optDate').checked = !!o.keepDate; $('optCopyright').checked = !!o.keepCopyright; $('optNames').checked = !!o.plainNames; } catch (e) { /* storage off: defaults */ }
  for (const id of ['optDate', 'optCopyright', 'optNames']) $(id).addEventListener('change', () => {
    try { localStorage.setItem(OPT_KEY, JSON.stringify(opts())); } catch (e) {}
    state.files.forEach(render); updateActions();
  });
  const cleanOpts = f => Object.assign({ pdfLib: PDF, removeAttachments: f.pdf.attachments, removeScripts: f.pdf.scripts, removeComments: f.pdf.comments }, opts());
  const removed = (x, f) => /^filename/.test(x.id) ? opts().plainNames : C.isRemoved(x, cleanOpts(f));
  const allFindings = f => f.insp ? f.insp.findings.concat(f.nameF || []) : [];

  // ---------- screens ----------
  function show(id) {
    for (const s of document.querySelectorAll('main > section')) s.hidden = s.id !== id;
    document.body.dataset.screen = id;
    window.scrollTo(0, 0);
  }
  $('btnAbout').onclick = () => show('scrAbout');
  $('btnHome').onclick = () => show('scrHome');
  $('btnAboutBack').onclick = () => show('scrHome');
  $('btnHelp').onclick = () => show('scrHelp');
  $('btnHelp2').onclick = () => show('scrHelp');
  $('btnHelpBack').onclick = () => show('scrAbout');
  window.unmarkedBack = () => {   // Android Back button: go back inside the app; on the home screen, let Android handle it
    const scr = document.body.dataset.screen || 'scrHome';
    if (scr === 'scrHome') return false;
    show(scr === 'scrHelp' ? 'scrAbout' : 'scrHome');
    return true;
  };
  let toastTimer = 0;
  function toast(msg) {
    let t = document.querySelector('.toast');
    if (!t) { t = document.createElement('div'); t.className = 'toast'; t.setAttribute('role', 'status'); document.body.appendChild(t); }
    t.textContent = msg; t.hidden = false;
    clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.hidden = true; }, 4000);
  }

  // ---------- adding files ----------
  async function addFiles(list) {
    list = Array.from(list || []);
    if (!list.length) return;
    if (state.phase === 'done') reset();
    if (state.phase === 'cleaning') return toast('Please wait until cleaning has finished.');
    let skipped = 0;
    for (const it of list) {
      if (state.files.length >= MAX_FILES) { skipped++; continue; }
      // an item is a File; { file, handle } from the browser's file picker; or { name, bytes, source } from the Android app.
      // handle / source say which folder the file came from, so its clean copy can be saved back there.
      const item = it instanceof Blob ? it : it.file || it;
      const name = item.name || it.name || 'file', bytesIn = item instanceof Blob ? null : it.bytes;
      const sz = bytesIn ? bytesIn.length : item.size;
      if (sz > MAX_BYTES) { toast(`${name} is too large (over ${size(MAX_BYTES)}).`); continue; }
      const f = { id: ++state.seq, name, size: sz, bytes: null, det: null, insp: null, nameF: C.nameFindings(name), pdf: { attachments: true, scripts: true, comments: true }, out: null, url: null, li: null, error: '',
        handle: it.handle || null, source: it.source || '' };
      state.files.push(f);
      render(f);
      try {
        f.bytes = bytesIn || new Uint8Array(await item.arrayBuffer());
        f.size = f.bytes.length;
        f.det = C.detect(f.bytes);
        if (f.det.supported && f.det.type !== 'pdf') f.url = URL.createObjectURL(new Blob([f.bytes], { type: f.det.mime }));
        render(f); updateActions();
        f.insp = await C.inspect(f.bytes, { pdfLib: PDF });
        if (f.insp.error) f.error = f.insp.error;
      } catch (e) {
        f.error = 'This file could not be opened. (' + (e && e.message || e) + ')';
      }
      if (state.files.includes(f)) { render(f); updateActions(); }
    }
    if (skipped) toast(`${plural(skipped, 'file')} not added: ${MAX_FILES} at a time is the limit.`);
    updateActions();
  }
  $('fileInput').addEventListener('change', e => { addFiles(e.target.files); e.target.value = ''; });
  // Where possible, files are opened with the system's own picker instead of the upload box: the upload box hides which
  // folder a file came from, the system picker doesn't, so the clean copy can be saved back next to the original.
  const OPEN_TYPES = [{ description: 'Photos and PDFs', accept: { 'image/jpeg': ['.jpg', '.jpeg'], 'image/png': ['.png'], 'image/webp': ['.webp'], 'application/pdf': ['.pdf'], 'image/heic': ['.heic', '.heif'] } }];
  $('fileInput').addEventListener('click', async e => {
    if (NATIVE) {
      e.preventDefault();
      try { const got = await UnmarkedNative.pickFiles(); if (got.length) await addFiles(got); }
      catch (err) { toast('Could not open the files: ' + (err && err.message || err)); }
    } else if (typeof window.showOpenFilePicker === 'function') {
      e.preventDefault();
      let hs;
      try { hs = await window.showOpenFilePicker({ multiple: true, id: 'unmarked-files', types: OPEN_TYPES }); }
      catch (err) { if (!err || err.name !== 'AbortError') toast('Could not open the files: ' + (err && err.message || err)); return; }
      addFiles(await Promise.all(hs.map(async h => ({ file: await h.getFile(), handle: h }))));
    }
  });
  const drop = $('drop');
  document.addEventListener('dragover', e => { if (e.dataTransfer && Array.from(e.dataTransfer.types || []).includes('Files')) { e.preventDefault(); drop.classList.add('over'); } });
  document.addEventListener('dragleave', e => { if (!e.relatedTarget) drop.classList.remove('over'); });
  document.addEventListener('drop', async e => {
    if (!e.dataTransfer || !e.dataTransfer.files.length) return;
    e.preventDefault(); drop.classList.remove('over'); show('scrHome');
    const files = Array.from(e.dataTransfer.files);
    // dropped files carry a handle too in Chromium browsers (it must be asked for before the drop event ends)
    const items = Array.from(e.dataTransfer.items || []).filter(i => i.kind === 'file');
    const hp = items.length === files.length && typeof items[0].getAsFileSystemHandle === 'function' ? items.map(i => i.getAsFileSystemHandle().catch(() => null)) : null;
    const handles = hp ? await Promise.all(hp) : [];
    addFiles(files.map((file, i) => ({ file, handle: handles[i] && handles[i].kind === 'file' ? handles[i] : null })));
  });

  function removeFile(f) {
    if (state.phase === 'cleaning') return;
    if (f.url) URL.revokeObjectURL(f.url);
    if (f.li) f.li.remove();
    state.files = state.files.filter(x => x !== f);
    if (!state.files.length) reset(); else updateActions();
  }
  function reset() {
    for (const f of state.files) { if (f.url) URL.revokeObjectURL(f.url); }
    state.files = []; state.phase = 'pick';
    $('files').textContent = '';
    updateActions();
  }
  $('btnRestart').onclick = () => { reset(); window.scrollTo(0, 0); };

  // ---------- one file's card ----------
  const PDF_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"><path d="M6 3h8l5 5v13H6z"/><path d="M14 3v5h5"/><path d="M9 13h6M9 16.5h6" stroke-linecap="round"/></svg>';
  const FILE_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"><path d="M6 3h8l5 5v13H6z"/><path d="M14 3v5h5"/></svg>';
  const OPT_LABEL = { attachments: 'Remove attached files', scripts: 'Remove scripts', comments: 'Remove comments and markup' };
  const OPT_NOTE = { attachments: 'Files stored inside the PDF.', scripts: 'Code that runs when the PDF is opened. Rarely needed.', comments: 'Notes, highlights and drawings, and who made them. Links and form fields stay.' };

  function render(f) {
    if (!f.li) {
      f.li = $('tplFile').content.firstElementChild.cloneNode(true);
      f.li.querySelector('.file-remove').onclick = () => removeFile(f);
      $('files').appendChild(f.li);
    }
    const li = f.li, q = s => li.querySelector(s);
    q('.file-name').textContent = (f.out && f.out.name !== f.name) ? f.out.name : f.name;
    q('.file-name').title = f.name;
    q('.file-sub').textContent = [f.det ? f.det.label : 'Reading…', f.size != null ? size(f.size) : '', f.out && f.out.name !== f.name ? 'was ' + f.name : ''].filter(Boolean).join(' · ');
    const thumb = q('.thumb');
    const wantImg = f.url ? 'img' : f.det && f.det.type === 'pdf' ? 'pdf' : 'file';
    if (thumb.dataset.kind !== wantImg) {
      thumb.dataset.kind = wantImg;
      thumb.innerHTML = wantImg === 'img' ? `<img alt="" src="${f.url}">` : wantImg === 'pdf' ? PDF_ICON : FILE_ICON;
    }
    q('.file-remove').hidden = state.phase !== 'pick';
    // status
    const st = q('.file-status');
    const list = allFindings(f), gone = list.filter(x => removed(x, f));
    if (!f.det || (!f.insp && !f.error)) st.innerHTML = '<span class="chip busy"><i></i>Checking…</span>';
    else if (f.error) st.innerHTML = `<span class="chip"><i></i>Can't clean this file</span><p>${esc(f.error)}</p>`;
    else if (f.cleanError) st.innerHTML = `<span class="chip high"><i></i>Not cleaned</span><p>${esc(f.cleanError)}</p>`;
    else if (f.out) {
      const left = f.out.leftover, kept = f.out.kept.filter(x => x.keep !== 'always' || /orientation|icc/.test(x.id));
      st.innerHTML = `<span class="chip ok"><i></i>Cleaned</span>`
        + `<p>${f.out.removedCount ? `Removed ${plural(f.out.removedCount, 'item')}. ` : 'Nothing needed removing. '}${size(f.size)} → ${size(f.out.bytes.length)}.</p>`
        + (left.length ? `<p class="warn">Still inside: ${esc(left.map(x => x.label).join(', '))}. Please report this file type to us.</p>` : '<p>Checked again: nothing else found.</p>')
        + (kept.length ? `<p>Kept: ${esc([...new Set(kept.map(x => x.label))].join(', '))}.</p>` : '');
    } else if (state.phase === 'cleaning') st.innerHTML = '<span class="chip busy"><i></i>Cleaning…</span>';
    else if (!gone.length) st.innerHTML = '<span class="chip ok"><i></i>No hidden data found</span>' + (list.length ? `<p>Kept: ${esc([...new Set(list.map(x => x.label))].join(', '))}.</p>` : '<p>A clean copy will still be made, so you can be sure.</p>');
    else {
      const top = gone.slice().sort((a, b) => RISK[b.risk] - RISK[a.risk]);
      const worst = top[0].risk, names = [...new Set(top.map(x => x.label))];
      st.innerHTML = `<span class="chip ${worst}"><i></i>${plural(gone.length, 'item')} to remove</span><p>${esc(names.slice(0, 3).join(', '))}${names.length > 3 ? ` and ${names.length - 3} more` : ''}</p>`
        + (f.insp.warning ? `<p class="warn">${esc(f.insp.warning)}</p>` : '');
    }
    // PDF choices
    const po = q('.pdf-opts');
    const choices = f.insp && f.insp.options ? Object.keys(OPT_LABEL).filter(k => f.insp.options[k]) : [];
    po.hidden = !choices.length || !!f.out || state.phase === 'done';
    if (!po.hidden && po.dataset.built !== '1') {
      po.dataset.built = '1';
      po.innerHTML = '<span class="lbl">This PDF also contains</span>' + choices.map(k => `<label class="check"><input type="checkbox" data-k="${k}"${f.pdf[k] ? ' checked' : ''}><span><b>${OPT_LABEL[k]}</b><small>${OPT_NOTE[k]}</small></span></label>`).join('');
      for (const cb of po.querySelectorAll('input')) cb.onchange = () => { f.pdf[cb.dataset.k] = cb.checked; render(f); updateActions(); };
    }
    for (const cb of po.querySelectorAll('input')) cb.disabled = state.phase !== 'pick';
    // findings
    const det = q('.findings');
    det.hidden = !list.length;
    if (list.length) {
      const open = det.open;
      const sum = f.out ? `What was found (${list.length})` : `What's inside (${list.length})`;
      const groups = [['high', 'Most revealing'], ['medium', 'Revealing'], ['low', 'Technical']];
      let html = '';
      for (const [r, title] of groups) {
        const items = list.filter(x => x.risk === r); if (!items.length) continue;
        html += `<li class="grp">${title}</li>` + items.map(x => {
          const rm = removed(x, f);
          return `<li class="${r}${rm ? '' : ' kept'}"><i></i><b>${esc(x.label)}</b><span class="tag${rm ? '' : ' kept'}">${rm ? (f.out ? 'Removed' : 'Remove') : 'Keep'}</span>${x.value ? `<span class="val">${esc(x.value)}</span>` : ''}${x.note ? `<span class="note">${esc(x.note)}</span>` : ''}</li>`;
        }).join('');
      }
      q('.findings summary').textContent = sum;
      q('.findings ul').innerHTML = html;
      det.open = open;
    }
    // per-file save/share once cleaned (when there is more than one file; one file uses the main buttons)
    const acts = q('.file-acts');
    acts.hidden = !(f.out && state.files.filter(x => x.out).length > 1);
    if (!acts.hidden && acts.dataset.built !== '1') {
      acts.dataset.built = '1';
      acts.innerHTML = `<button class="btn small" data-a="save">Save</button>${canShare() ? '<button class="btn small" data-a="share">Share</button>' : ''}`;
      acts.querySelector('[data-a="save"]').onclick = () => saveFiles([f]);
      const sh = acts.querySelector('[data-a="share"]'); if (sh) sh.onclick = () => shareFiles([f]);
    }
  }

  // ---------- main buttons ----------
  function updateActions() {
    const any = state.files.length > 0, ready = state.files.filter(f => f.insp && !f.error);
    const checking = state.files.some(f => !f.error && !f.insp);
    $('intro').hidden = any;
    drop.classList.toggle('compact', any);
    $('dropMain').textContent = any ? 'Add more files' : 'Choose photos or PDFs';
    drop.hidden = state.phase === 'cleaning';
    $('optCard').hidden = !any || state.phase === 'done';
    for (const id of ['optDate', 'optCopyright', 'optNames']) $(id).disabled = state.phase !== 'pick';
    $('actions').hidden = !any || state.phase === 'done';
    $('doneActions').hidden = state.phase !== 'done';
    const btn = $('btnClean');
    btn.disabled = state.phase !== 'pick' || !ready.length || checking;
    $('btnCleanLbl').textContent = state.phase === 'cleaning' ? 'Cleaning…' : ready.length > 1 ? `Remove hidden data from ${ready.length} files` : 'Remove hidden data';
    const bad = state.files.filter(f => f.error).length, withData = ready.filter(f => allFindings(f).some(x => removed(x, f))).length;
    $('cleanHint').textContent = checking ? 'Checking files…' : !any ? '' : [
      ready.length ? `${plural(withData, 'file')} with hidden data` : '',
      bad ? `${plural(bad, 'file')} can't be cleaned and will be skipped` : ''
    ].filter(Boolean).join(' · ') + (ready.length ? '. Your originals stay unchanged.' : '');
    if (state.phase === 'done') {
      const done = state.files.filter(f => f.out);
      $('doneTitle').textContent = done.length ? `${plural(done.length, 'clean copy', 'clean copies')} ready` : 'Nothing was cleaned';
      $('doneSub').textContent = done.length ? 'Save or share them below. The originals on your device are unchanged.' : 'None of the files could be cleaned.';
      $('btnSaveAll').hidden = !done.length;
      $('btnSaveAll').textContent = done.length > 1 ? 'Save all (.zip)' : 'Save';
      $('btnShareAll').hidden = !done.length || !canShare();
      $('btnShareAll').textContent = done.length > 1 ? 'Share all' : 'Share';
      $('saveHint').textContent = done.length > 1 ? 'Each file also has its own Save button above.' : '';
    }
  }

  // ---------- cleaning ----------
  $('btnClean').onclick = async () => {
    const todo = state.files.filter(f => f.insp && !f.error);
    if (!todo.length || state.phase !== 'pick') return;
    state.phase = 'cleaning';
    state.files.forEach(render); updateActions();
    const o = opts(), count = { image: 0, document: 0 }, used = new Set();
    for (const f of todo) {
      try {
        const co = cleanOpts(f);
        const r = await C.clean(f.bytes, co);
        const check = await C.inspect(r.bytes, { pdfLib: PDF });
        const leftover = check.error ? [{ label: 'the copy could not be checked' }] : check.findings.filter(x => C.isRemoved(x, co));
        const kept = check.error ? [] : check.findings.filter(x => !C.isRemoved(x, co));
        const ext = f.det.ext;
        let name;
        if (o.plainNames) { const k = ext === 'pdf' ? 'document' : 'image'; name = C.plainName(++count[k], ext); }
        else name = /\.[A-Za-z0-9]{2,5}$/.test(f.name) ? f.name : `${f.name}.${ext}`;
        let n = name, k = 2; while (used.has(n.toLowerCase())) { n = name.replace(/(\.[^.]+)?$/, m => ` (${k})${m}`); k++; }
        used.add(n.toLowerCase());
        f.out = { bytes: r.bytes, name: n, mime: f.det.mime, leftover, kept, removedCount: allFindings(f).filter(x => removed(x, f)).length };
      } catch (e) {
        f.cleanError = 'Cleaning failed: ' + (e && e.message || e);
      }
      render(f);
      await new Promise(r => setTimeout(r, 0));   // let the page update between files
    }
    state.phase = 'done';
    state.files.forEach(render); updateActions();
    $('doneActions').scrollIntoView({ behavior: 'smooth', block: 'center' });
  };

  // ---------- saving and sharing ----------
  const outFiles = list => list.filter(f => f.out).map(f => ({ name: f.out.name, bytes: f.out.bytes, mime: f.out.mime }));
  function download(name, bytes, mime) {
    const url = URL.createObjectURL(new Blob([bytes], { type: mime }));
    const a = document.createElement('a'); a.href = url; a.download = name; a.rel = 'noopener';
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  }
  async function saveFiles(list) {
    const files = outFiles(list); if (!files.length) return;
    const from = list.find(f => f.out && (f.handle || f.source)) || {};   // the original's folder (the first file's, for a zip)
    const one = files.length === 1;
    let name = one ? files[0].name : 'unmarked-files.zip';
    // saving next to the original under the same name would offer to replace it: suggest "photo-unmarked.jpg" instead
    const orig = one ? list.find(f => f.out && f.out.name === files[0].name) : null;
    if (orig && (orig.handle || orig.source) && name.toLowerCase() === orig.name.toLowerCase()) name = name.replace(/(\.[^.]+)?$/, m => '-unmarked' + m);
    const bytes = one ? files[0].bytes : C.zip(files), mime = one ? files[0].mime : 'application/zip';
    try {
      if (NATIVE) { const r = await UnmarkedNative.saveFile(name, bytes, mime, from.source); if (r.saved) toast('Saved.'); }
      else if (typeof window.showSaveFilePicker === 'function') {
        // desktop Chromium browsers: a "save as" dialog that reopens the folder used last time (remembered by the id)
        const ext = (/\.[A-Za-z0-9]{1,5}$/.exec(name) || [''])[0].toLowerCase();
        let h;
        const where = from.handle ? { startIn: from.handle } : { id: 'unmarked-save' };   // the original's folder, else the last one used
        try { h = await window.showSaveFilePicker(Object.assign({ suggestedName: name, types: ext ? [{ description: 'Clean copy', accept: { [mime]: [ext] } }] : undefined }, where)); }
        catch (e) { if (e && e.name === 'AbortError') return; download(name, bytes, mime); return; }   // dialog refused (e.g. blocked by the browser): plain download
        const w = await h.createWritable(); await w.write(bytes); await w.close();
        toast('Saved.');
      } else download(name, bytes, mime);   // other browsers save to their usual download folder
    } catch (e) { if (!e || e.name !== 'AbortError') toast('Could not save: ' + (e && e.message || e)); }
  }
  const webShareOk = () => { try { return !!(navigator.canShare && navigator.canShare({ files: [new File([new Uint8Array(1)], 'x.jpg', { type: 'image/jpeg' })] })); } catch (e) { return false; } };
  const canShare = () => NATIVE || webShareOk();
  async function shareFiles(list) {
    const files = outFiles(list); if (!files.length) return;
    try {
      if (NATIVE) await UnmarkedNative.share(files);
      else await navigator.share({ files: files.map(f => new File([f.bytes], f.name, { type: f.mime })) });
    } catch (e) { if (!e || e.name !== 'AbortError') toast('Could not share: ' + (e && e.message || e)); }
  }
  $('btnSaveAll').onclick = () => saveFiles(state.files);
  $('btnShareAll').onclick = () => shareFiles(state.files);

  // ---------- files shared to the Android app ----------
  if (NATIVE) {
    let taking = false;
    const take = async () => {
      if (taking) return; taking = true;
      try { const got = await UnmarkedNative.takeShared(); if (got.length) { show('scrHome'); await addFiles(got); } }
      catch (e) { toast('Could not open the shared files: ' + (e && e.message || e)); }
      finally { taking = false; }
    };
    UnmarkedNative.onShared(take);
    take();
  }

  show('scrHome');
  updateActions();
})();
