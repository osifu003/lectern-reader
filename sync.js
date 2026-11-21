// Library sync through the reader's own Google Drive (the hidden app data folder only).
// Pure planning and merging live here so they can be tested without a browser; app.js drives it.
(function (root) {
  'use strict';

  const STATE = 'state.json';
  const PREFS = 'prefs.json';
  const LIB = 'library.json'; // book folders and chapter order (shelf.js); older app versions never read or write it
  // Voice and reading settings that follow the reader to every device (skip: the Skip text choices); display settings stay per device.
  const PREF_KEYS = ['gkey', 'gengine', 'glang', 'gstyle', 'voiceURI', 'rate', 'skip'];
  const TOMB_DAYS = 180;
  const bookName = id => 'book-' + id + '.json';
  const bookVersion = b => b.updated || b.added || 0;

  // Newest position wins per book; deletions (tombstones) win over positions and are kept for TOMB_DAYS.
  function mergeState(local, remote, now) {
    now = now || Date.now();
    const lp = local.positions || {}, rp = remote.positions || {};
    const tombs = {};
    for (const src of [remote.tombs || {}, local.tombs || {}]) {
      for (const id in src) if (now - src[id] < TOMB_DAYS * 864e5) tombs[id] = Math.max(tombs[id] || 0, src[id]);
    }
    const positions = {};
    for (const id of new Set([...Object.keys(lp), ...Object.keys(rp)])) {
      if (tombs[id]) continue;
      const l = lp[id], r = rp[id];
      positions[id] = !l ? r : !r ? l : ((r.t || 0) > (l.t || 0) ? r : l);
    }
    const same = (a, b) => JSON.stringify(sortKeys(a)) === JSON.stringify(sortKeys(b));
    return {
      positions, tombs,
      remoteChanged: !same(positions, rp) || !same(tombs, remote.tombs || {}),
      localChanged: !same(positions, lp),
      pulled: Object.keys(positions).filter(id => rp[id] && positions[id] === rp[id] && !same(rp[id], lp[id] || null))
    };
  }
  function sortKeys(o) {
    if (!o || typeof o !== 'object') return o;
    const out = {}; Object.keys(o).sort().forEach(k => { out[k] = sortKeys(o[k]); }); return out;
  }

  // Settings: each field carries the time it was last changed by hand ({v, t}); the newest change wins, field by field.
  // On a tie a set value beats an empty one, otherwise nothing moves (so automatic adjustments never ping-pong).
  // skip: fields this device keeps to itself (neither sent nor taken). Fields this version does not know are kept on Drive.
  function mergePrefs(local, remote, skip) {
    local = local || {}; remote = remote || {};
    const no = new Set(skip || []), empty = x => !x || x.v === '' || x.v == null;
    const prefs = {}, pulled = {};
    let remoteChanged = false;
    for (const k of new Set([...Object.keys(local), ...Object.keys(remote)])) {
      const l = local[k], r = remote[k];
      if (no.has(k) || !l) { if (r) prefs[k] = r; continue; }
      if (!r) { prefs[k] = l; remoteChanged = true; continue; }
      const lt = +l.t || 0, rt = +r.t || 0;
      const take = rt > lt || (rt === lt && empty(l) && !empty(r));
      const give = lt > rt || (rt === lt && empty(r) && !empty(l));
      if (take) { prefs[k] = r; if (!sameVal(l.v, r.v) || lt !== rt) pulled[k] = { v: r.v, t: rt }; }
      else if (give) { prefs[k] = l; remoteChanged = true; }
      else prefs[k] = r;
    }
    return { prefs, pulled, remoteChanged };
  }
  const sameVal = (a, b) => JSON.stringify(a) === JSON.stringify(b);

  // Book folders and chapter placement: each folder and each item's entry carries the time it was changed ({..., t});
  // the newest wins, entry by entry. Entries of removed books go with them; a folder taken apart is remembered
  // (gone) for TOMB_DAYS so it isn't put back together.
  function mergeLib(local, remote, tombs, now) {
    now = now || Date.now(); tombs = tombs || {};
    const lib = { folders: {}, items: {} };
    let remoteChanged = false, localChanged = false;
    const key = o => JSON.stringify(sortKeys(o));
    for (const kind of ['folders', 'items']) {
      const L = (local && local[kind]) || {}, R = (remote && remote[kind]) || {};
      for (const id of new Set([...Object.keys(L), ...Object.keys(R)])) {
        const l = L[id], r = R[id];
        const lt = l ? +l.t || 0 : -1, rt = r ? +r.t || 0 : -1;
        const w = lt > rt ? l : rt > lt ? r : (key(l) >= key(r) ? l : r);
        const drop = !w || (kind === 'items' && tombs[id]) || (kind === 'folders' && w.gone && now - (+w.t || 0) > TOMB_DAYS * 864e5);
        if (drop) { if (r) remoteChanged = true; if (l) localChanged = true; continue; }
        lib[kind][id] = w;
        if (!r || key(w) !== key(r)) remoteChanged = true;
        if (!l || key(w) !== key(l)) localChanged = true;
      }
    }
    return { lib, remoteChanged, localChanged };
  }

  // Decide what moves where. local: [{id, v, synced}]; remote: [{fileId, id, v, modified}]; tombs: merged tombstones {id: time}.
  function planSync(local, remote, tombs) {
    const plan = { upload: [], download: [], deleteLocal: [], deleteRemote: [], untomb: [] };
    const byId = new Map();
    for (const r of remote) { // the same book uploaded twice: keep the newest copy
      const had = byId.get(r.id);
      if (!had) { byId.set(r.id, r); continue; }
      const keep = (r.v > had.v || (r.v === had.v && (r.modified || '') > (had.modified || ''))) ? r : had;
      plan.deleteRemote.push((keep === r ? had : r).fileId);
      byId.set(r.id, keep);
    }
    const localIds = new Set();
    for (const l of local) {
      localIds.add(l.id);
      const r = byId.get(l.id), t = tombs[l.id];
      if (t) {
        if (l.v <= t) { plan.deleteLocal.push(l.id); if (r) plan.deleteRemote.push(r.fileId); continue; }
        plan.untomb.push(l.id); // changed here after it was removed elsewhere: keep the newer edit
      }
      if (!r) { plan.upload.push({ id: l.id }); continue; }
      if (r.v > l.v) plan.download.push(r);
      else if (!l.synced || r.v < l.v) plan.upload.push({ id: l.id, fileId: r.fileId });
    }
    for (const [id, r] of byId) {
      if (localIds.has(id)) continue;
      if (tombs[id]) plan.deleteRemote.push(r.fileId); else plan.download.push(r);
    }
    return plan;
  }

  // Minimal Drive v3 client for the appDataFolder. getToken() returns a bearer token; fetchImpl defaults to fetch.
  function createDrive(getToken, fetchImpl) {
    const F = fetchImpl || ((...a) => fetch(...a));
    const API = 'https://www.googleapis.com/drive/v3', UP = 'https://www.googleapis.com/upload/drive/v3';
    async function call(url, opts = {}) {
      const token = getToken();
      if (!token) throw Object.assign(new Error('Sign in to Google to sync.'), { code: 'auth' });
      let r;
      try { r = await F(url, Object.assign({}, opts, { headers: Object.assign({ Authorization: 'Bearer ' + token }, opts.headers || {}) })); }
      catch { throw Object.assign(new Error('No connection to Google Drive.'), { code: 'offline' }); }
      if (r.status === 401) throw Object.assign(new Error('Google sign-in has expired.'), { code: 'auth' });
      if (!r.ok && r.status !== 204) {
        let msg = '';
        try { const j = await r.json(); msg = (j.error && (j.error.message || (j.error.errors && j.error.errors[0] && j.error.errors[0].reason))) || ''; } catch {}
        const code = r.status === 404 ? 'missing' : r.status === 403 && /storage|quota/i.test(msg) ? 'full' : 'http';
        throw Object.assign(new Error(code === 'full' ? 'Your Google Drive is full, so the library could not be saved there.' : 'Google Drive answered with an error' + (msg ? ': ' + msg : ` (${r.status}).`)), { code, status: r.status });
      }
      return r;
    }
    async function list() {
      const files = []; let page = '';
      do {
        const q = new URLSearchParams({ spaces: 'appDataFolder', pageSize: '1000', fields: 'nextPageToken,files(id,name,modifiedTime,appProperties)' });
        if (page) q.set('pageToken', page);
        const j = await (await call(API + '/files?' + q)).json();
        files.push(...(j.files || [])); page = j.nextPageToken || '';
      } while (page);
      return files;
    }
    async function read(fileId) { return (await call(API + '/files/' + encodeURIComponent(fileId) + '?alt=media')).json(); }
    async function write(fileId, name, data, props) { // create when fileId is empty, otherwise replace the content
      const body = typeof data === 'string' ? data : JSON.stringify(data);
      const meta = fileId ? { appProperties: props || {} } : { name, parents: ['appDataFolder'], appProperties: props || {} };
      const path = fileId ? '/files/' + encodeURIComponent(fileId) : '/files';
      const method = fileId ? 'PATCH' : 'POST';
      const size = new Blob([body]).size;
      if (size < 4.5 * 1024 * 1024) {
        const b = 'lectern' + Math.random().toString(36).slice(2);
        const multipart = `--${b}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(meta)}\r\n--${b}\r\nContent-Type: application/json\r\n\r\n${body}\r\n--${b}--`;
        return (await call(UP + path + '?uploadType=multipart&fields=id,modifiedTime,appProperties', { method, headers: { 'Content-Type': 'multipart/related; boundary=' + b }, body: multipart })).json();
      }
      const start = await call(UP + path + '?uploadType=resumable&fields=id,modifiedTime,appProperties', { method, headers: { 'Content-Type': 'application/json; charset=UTF-8', 'X-Upload-Content-Type': 'application/json' }, body: JSON.stringify(meta) });
      const loc = start.headers.get('Location');
      if (!loc) throw Object.assign(new Error('Google Drive did not accept the upload.'), { code: 'http' });
      return (await call(loc, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body })).json();
    }
    async function remove(fileId) { try { await call(API + '/files/' + encodeURIComponent(fileId), { method: 'DELETE' }); } catch (e) { if (e.code !== 'missing') throw e; } }
    async function about() { return (await call(API + '/about?fields=user(emailAddress,displayName)')).json(); }
    return { list, read, write, remove, about };
  }

  // One full pass: list Drive, merge positions and deletions, move books both ways.
  // store: { books(), positions(), tombs(), putBook(b), dropBook(id), markSynced(id, v), setPositions(p, tombs), clearTombs(ids),
  //         prefs() -> { values: {k: {v, t}}, skip: [k] }, setPrefs({k: {v, t}}), lib() -> { folders, items }, setLib(lib) }
  //         (prefs, setPrefs, lib and setLib optional)
  async function runSync(drive, store, now) {
    const files = await drive.list();
    const stateFile = files.find(f => f.name === STATE);
    const remoteState = stateFile ? await drive.read(stateFile.id).catch(e => { if (e.code === 'missing') return {}; throw e; }) : {};
    const localTombs = store.tombs();
    const merged = mergeState({ positions: store.positions(), tombs: localTombs }, remoteState || {}, now);
    const remoteBooks = files.filter(f => /^book-.+\.json$/.test(f.name) && f.appProperties && f.appProperties.lid)
      .map(f => ({ fileId: f.id, id: f.appProperties.lid, v: +f.appProperties.v || 0, modified: f.modifiedTime }));
    const local = store.books();
    const plan = planSync(local.map(b => ({ id: b.id, v: bookVersion(b), synced: !!b.synced })), remoteBooks, merged.tombs);
    for (const id of plan.untomb) delete merged.tombs[id];
    const result = { uploaded: 0, downloaded: 0, removed: 0, pulled: merged.pulled, downloadedIds: [] };

    for (const id of plan.deleteLocal) { await store.dropBook(id); result.removed++; }
    for (const fileId of plan.deleteRemote) await drive.remove(fileId);
    for (const r of plan.download) {
      const b = await drive.read(r.fileId);
      if (!b || !b.id || !Array.isArray(b.chapters)) continue;
      b.updated = r.v || bookVersion(b); b.synced = true;
      await store.putBook(b); result.downloaded++; result.downloadedIds.push(b.id);
    }
    for (const u of plan.upload) {
      const b = local.find(x => x.id === u.id); if (!b) continue;
      const v = bookVersion(b) || Date.now();
      const copy = Object.assign({}, b, { updated: v }); delete copy.synced;
      await drive.write(u.fileId || '', bookName(b.id), copy, { lid: b.id, v: String(v) });
      await store.markSynced(b.id, v); result.uploaded++;
    }
    const untombed = plan.untomb.length > 0;
    if (merged.remoteChanged || untombed || !stateFile) {
      await drive.write(stateFile ? stateFile.id : '', STATE, { lectern: 2, positions: merged.positions, tombs: merged.tombs }, { kind: 'state' });
    }
    if (merged.localChanged) store.setPositions(merged.positions, merged.tombs);
    store.clearTombs(Object.keys(localTombs));

    if (store.prefs) { // voice settings and the Google key, in their own file so older app versions never overwrite them
      const pf = files.find(f => f.name === PREFS);
      const remote = pf ? await drive.read(pf.id).catch(e => { if (e.code === 'missing') return {}; throw e; }) : {};
      const lp = store.prefs();
      const m = mergePrefs(lp.values, (remote && remote.prefs) || {}, lp.skip);
      if (m.remoteChanged || !pf) await drive.write(pf ? pf.id : '', PREFS, { lectern: 1, prefs: m.prefs }, { kind: 'prefs' });
      result.prefs = Object.keys(m.pulled);
      if (result.prefs.length) await store.setPrefs(m.pulled);
    }

    if (store.lib) { // book folders and chapter order, in their own file so older app versions never overwrite them
      const lf = files.find(f => f.name === LIB);
      const remote = lf ? await drive.read(lf.id).catch(e => { if (e.code === 'missing') return {}; throw e; }) : {};
      const m = mergeLib(store.lib(), (remote && remote.lib) || {}, merged.tombs, now);
      if (m.remoteChanged || !lf) await drive.write(lf ? lf.id : '', LIB, { lectern: 1, lib: m.lib }, { kind: 'lib' });
      result.lib = m.localChanged;
      if (m.localChanged) await store.setLib(m.lib);
    }
    return result;
  }

  const api = { mergeState, mergePrefs, mergeLib, planSync, createDrive, runSync, bookVersion, STATE, PREFS, LIB, PREF_KEYS };
  if (typeof module === 'object' && module.exports) module.exports = api; else root.LecternSync = api;
})(typeof self !== 'undefined' ? self : this);
