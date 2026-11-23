import { Engine } from './audio.js';

const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];

async function api(url, body, method) {
  const opt = body === undefined ? {} : { method: method || 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
  const res = await fetch(url, opt);
  if (!res.ok) throw new Error((await res.text()).replace(/<[^>]+>/g, ' ').trim().slice(0, 200) || res.statusText);
  return res.json();
}

// ------------------------------------------------------------------ model

const METERS = { '4/4': { beats: 4, spb: 4 }, '3/4': { beats: 3, spb: 4 }, '6/8': { beats: 6, spb: 2 } };
const SWING = { straight: [0, 0.25, 0.5, 0.75], swing8: [0, 1 / 3, 2 / 3, 5 / 6], shuffle16: [0, 1 / 3, 0.5, 5 / 6] };
const ROWS = [
  { p: 49, name: 'Crash', color: '#9ec5ff' },
  { p: 51, name: 'Ride', color: '#9ec5ff', part: 'ride' },
  { p: 46, name: 'Open hat', color: '#5fd4c8', part: 'hat' },
  { p: 42, name: 'Closed hat', color: '#5fd4c8', part: 'hat' },
  { p: 54, name: 'Tambourine', color: '#9be36d', part: 'shaker' },
  { p: 82, name: 'Shaker', color: '#9be36d', part: 'shaker' },
  { p: 50, name: 'High tom', color: '#c78bff' },
  { p: 47, name: 'Mid tom', color: '#c78bff' },
  { p: 43, name: 'Floor tom', color: '#c78bff' },
  { p: 37, name: 'Side stick', color: '#ffd166', part: 'snare' },
  { p: 38, name: 'Snare', color: '#ffd166', part: 'snare' },
  { p: 36, name: 'Kick', color: '#ff7a59', part: 'kick' },
];
const ROW_OF = Object.fromEntries(ROWS.map((r, i) => [r.p, i]));
const COLORS = ['#4ea8ff', '#ff7a59', '#62d38b', '#c78bff', '#ffd166', '#ff6fae'];

const S = {
  song: null, ready: false, sections: [], sel: null,
  view: { a: 0, b: 1 }, peaks: {}, beats: [], feels: {}, undo: [],
  layers: [], layer: null, row: 42, prefs: { rim: false, shaker: false, tamb: false },
};
// Layers are reductions of the one full groove: each is just the set of drum rows it keeps.
const inLayer = (p) => S.layer === null || !S.layers[S.layer] || S.layers[S.layer].rows.includes(p);
function saveConfig() { api('/api/config', { layers: S.layers, prefs: S.prefs }, 'PUT').catch(() => {}); }
const engine = new Engine();
const mix = { song: { on: true, v: 0.8 }, drums: { on: false, v: 0.9 }, midi: { on: true, v: 0.9 }, click: { on: false, v: 0.6 } };

const sel = () => S.sections.find((x) => x.id === S.sel) || null;
const meterOf = (g) => METERS[g.meter];
const beatLen = (g) => 60 / g.bpm;
const barLen = (g) => meterOf(g).beats * beatLen(g);
const gridLen = (g) => g.bars * barLen(g);
const totalSlots = (g) => g.bars * meterOf(g).beats * meterOf(g).spb;
const noteKey = (n) => n.s + ':' + n.p;

function slotPts(g) {
  const m = meterOf(g);
  return m.spb === 4 ? SWING[g.swing] || SWING.straight : [0, 0.5];
}
function slotBeat(g, s) {
  const spb = meterOf(g).spb;
  return Math.floor(s / spb) + slotPts(g)[s % spb];
}
function slotAt(g, t) {
  const pos = (t - g.t0) / beatLen(g);
  const whole = Math.floor(pos);
  const frac = pos - whole;
  const pts = slotPts(g);
  let j = 0;
  for (let i = 0; i < pts.length; i++) if (frac >= pts[i]) j = i;
  return whole * meterOf(g).spb + j;
}
function syncSpan(sec) {
  if (sec.grid) { sec.start = sec.grid.t0; sec.end = sec.grid.t0 + gridLen(sec.grid); }
}

// Where a note really sounds, in beats from the loop start, and how hard.
function sounding(sec, n) {
  const g = sec.grid, f = sec.feel;
  let beat = slotBeat(g, n.s), vel = n.v;
  if (f.mode === 'played') beat += (n.o || 0) * f.timing;
  else if (f.mode === 'ni' && f.pick) {
    const part = ROWS[ROW_OF[n.p]]?.part;
    const m = meterOf(g);
    const e = part && f.pick.parts[part] && f.pick.parts[part][n.s % (m.beats * m.spb)];
    if (e) { beat += e[0] * f.timing; vel = Math.round(n.v + (e[1] - n.v) * f.vel); }
  }
  return { beat, vel: Math.max(1, Math.min(127, vel)) };
}

// ------------------------------------------------------------------ helpers

let toastTimer;
function toast(msg, err) {
  const el = $('#toast');
  el.textContent = msg; el.hidden = false; el.classList.toggle('err', !!err);
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, err ? 6000 : 3500);
}
const fmtTime = (t) => `${Math.floor(t / 60)}:${(t % 60).toFixed(1).padStart(4, '0')}`;
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

function fit(cv) {
  const r = cv.getBoundingClientRect(), d = window.devicePixelRatio || 1;
  const w = Math.round(r.width * d), h = Math.round(r.height * d);
  if (cv.width !== w || cv.height !== h) { cv.width = w; cv.height = h; }
  const g = cv.getContext('2d');
  g.setTransform(d, 0, 0, d, 0, 0);
  return [g, r.width, r.height];
}

function makePeaks(buf) {
  const B = 64, m = Math.floor(buf.length / B);
  const min = new Float32Array(m), max = new Float32Array(m);
  const c0 = buf.getChannelData(0), c1 = buf.numberOfChannels > 1 ? buf.getChannelData(1) : c0;
  let peak = 0.001;
  for (let i = 0; i < m; i++) {
    let lo = 1, hi = -1;
    const o = i * B;
    for (let j = 0; j < B; j++) { const v = (c0[o + j] + c1[o + j]) * 0.5; if (v < lo) lo = v; if (v > hi) hi = v; }
    min[i] = lo; max[i] = hi;
    if (hi > peak) peak = hi; if (-lo > peak) peak = -lo;
  }
  return { min, max, rate: buf.sampleRate / B, peak };
}

function drawWave(g, pk, x0, w, y0, h, ta, tb, color, localGain) {
  const n = pk.min.length;
  let peak = pk.peak;
  if (localGain) {
    peak = 0.001;
    const a = clamp(Math.floor(ta * pk.rate), 0, n), b = clamp(Math.ceil(tb * pk.rate), 0, n);
    for (let i = a; i < b; i++) { if (pk.max[i] > peak) peak = pk.max[i]; if (-pk.min[i] > peak) peak = -pk.min[i]; }
  }
  const mid = y0 + h / 2, sc = (h / 2) * 0.94 / peak;
  g.fillStyle = color;
  for (let x = 0; x < w; x++) {
    const a = Math.floor((ta + ((tb - ta) * x) / w) * pk.rate);
    const b = Math.max(a + 1, Math.floor((ta + ((tb - ta) * (x + 1)) / w) * pk.rate));
    if (b <= 0 || a >= n) continue;
    let lo = 1, hi = -1;
    for (let i = Math.max(0, a); i < Math.min(b, n); i++) { if (pk.min[i] < lo) lo = pk.min[i]; if (pk.max[i] > hi) hi = pk.max[i]; }
    const y1 = mid - hi * sc, y2 = mid - lo * sc;
    g.fillRect(x0 + x, y1, 1, Math.max(1, y2 - y1));
  }
}

// ------------------------------------------------------------------ saving, undo

let saveTimer;
function save() {
  if (!S.song) return;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    api(`/api/song/${S.song.id}/project`, { sections: S.sections, sel: S.sel }, 'PUT').catch(() => {});
  }, 500);
}
function pushUndo(sec) {
  S.undo.push({ id: sec.id, snap: JSON.stringify({ grid: sec.grid, notes: sec.notes, removed: sec.removed, ghosts: sec.ghosts, start: sec.start, end: sec.end, map: sec.map || {}, tamb24: !!sec.tamb24 }) });
  if (S.undo.length > 100) S.undo.shift();
}
function undo() {
  const last = S.undo.pop();
  if (!last) return;
  const sec = S.sections.find((x) => x.id === last.id);
  if (!sec) return;
  Object.assign(sec, JSON.parse(last.snap));
  afterGridChange(sec, false);
}

// ------------------------------------------------------------------ loading

async function openSong(promise) {
  try {
    engine.stop();
    setStatus('busy', 'Loading…');
    const meta = await promise;
    S.song = meta; S.ready = false; S.beats = []; S.peaks = {}; S.undo = [];
    S.sections = (meta.project && meta.project.sections) || [];
    S.sel = (meta.project && meta.project.sel) || (S.sections[0] && S.sections[0].id) || null;
    S.view = { a: 0, b: meta.duration };
    engine.cursor = 0;
    engine.setBuffer('song', null); engine.setBuffer('drums', null);
    $('#songName').textContent = meta.name;
    document.title = meta.name + ' · Groove Workbench';
    $('#empty').hidden = true; $('#work').hidden = false;
    renderAll();
    loadLibrary();
    const buf = await engine.decode(await (await fetch(`/api/song/${meta.id}/song.wav`)).arrayBuffer());
    if (S.song.id !== meta.id) return;
    engine.setBuffer('song', buf);
    S.peaks.song = makePeaks(buf);
    drawOverview();
    pollStatus(meta.id);
  } catch (e) {
    setStatus('err', 'Could not load');
    toast('Could not load that file: ' + e.message, true);
  }
}

function setStatus(kind, text) {
  const el = $('#status');
  el.hidden = false; el.className = 'pill ' + kind; el.textContent = text;
}

async function pollStatus(id) {
  while (S.song && S.song.id === id) {
    let st;
    try { st = await api(`/api/song/${id}/status`); } catch (e) { st = { stage: 'error', error: e.message }; }
    if (!S.song || S.song.id !== id) return;
    if (st.stage === 'ready') {
      S.beats = st.beats || [];
      const buf = await engine.decode(await (await fetch(`/api/song/${id}/drums.wav`)).arrayBuffer());
      if (S.song.id !== id) return;
      engine.setBuffer('drums', buf);
      S.peaks.drums = makePeaks(buf);
      S.ready = true;
      setStatus('ok', 'Drums separated');
      renderAll();
      return;
    }
    if (st.stage === 'error') { setStatus('err', 'Drum separation failed'); toast(st.error || 'Drum separation failed', true); return; }
    setStatus('busy', `Separating drums… ${Math.round(st.elapsed)}s`);
    await new Promise((r) => setTimeout(r, 700));
  }
}

async function loadLibrary(dir) {
  try {
    const data = await api('/api/library' + (dir ? '?dir=' + encodeURIComponent(dir) : ''));
    $('#libDir').value = data.dir;
    const list = $('#libList');
    list.innerHTML = '';
    if (data.error) { list.innerHTML = `<div class="lib-err"></div>`; list.firstChild.textContent = data.error; return; }
    if (!data.songs.length) { list.innerHTML = '<div class="lib-foot">No audio files in this folder.</div>'; return; }
    for (const song of data.songs) {
      const el = document.createElement('div');
      el.className = 'lib-item' + (S.song && S.song.path === song.path ? ' cur' : '');
      el.title = song.name;
      const n = document.createElement('span'); n.className = 'n'; n.textContent = song.name;
      el.append(n);
      if (song.exported) { const d = document.createElement('span'); d.className = 'd'; d.textContent = `✓ ${song.exported}`; d.title = `${song.exported} MIDI file(s) exported`; el.append(d); }
      el.onclick = () => openSong(api('/api/open', { path: song.path }));
      list.append(el);
    }
  } catch (e) { /* server not reachable */ }
}

function uploadFile(file) {
  const form = new FormData();
  form.append('file', file);
  openSong(fetch('/api/upload', { method: 'POST', body: form }).then((r) => { if (!r.ok) throw new Error('upload failed'); return r.json(); }));
}

// ------------------------------------------------------------------ sections

function addSection(start, end) {
  const used = new Set(S.sections.map((x) => x.color));
  const names = ['Verse', 'Chorus', 'Bridge', 'Intro', 'Outro'];
  const taken = new Set(S.sections.map((x) => x.name));
  const sec = {
    id: Math.random().toString(36).slice(2, 9),
    name: names.find((n) => !taken.has(n)) || `Part ${S.sections.length + 1}`,
    color: COLORS.find((c) => !used.has(c)) || COLORS[S.sections.length % COLORS.length],
    start, end, grid: null, notes: [], ghosts: [], removed: [],
    sens: { kick: 0.5, snare: 0.5, hat: 0.5 },
    map: { 38: S.prefs.rim ? 37 : 38, 42: S.prefs.shaker ? 82 : 42 },
    feel: { mode: 'quant', pick: null, timing: 1, vel: 0 },
    exported: null,
  };
  S.sections.push(sec);
  S.sections.sort((a, b) => a.start - b.start);
  S.sel = sec.id;
  return sec;
}

function removeSection(sec) {
  if (sec.grid && !confirm(`Delete "${sec.name}" and its notes?`)) return;
  if (engine.mode === 'loop') engine.stop();
  S.sections = S.sections.filter((x) => x !== sec);
  if (S.sel === sec.id) S.sel = S.sections[0] ? S.sections[0].id : null;
  renderAll(); save();
}

function select(id) {
  if (S.sel === id) return;
  if (engine.mode === 'loop') engine.stop();
  S.sel = id;
  renderAll(); save();
}

function mergeNotes(sec, auto, ghosts) {
  // The detector hears snare and hat; the section decides which drum plays them.
  const mp = sec.map || {};
  auto = auto.map((n) => ({ ...n, p: mp[n.p] || n.p }));
  ghosts = ghosts.map((n) => ({ ...n, p: mp[n.p] || n.p }));
  const total = totalSlots(sec.grid);
  const user = sec.notes.filter((n) => n.u && n.s < total);
  const taken = new Set(user.map(noteKey));
  const gone = new Set(sec.removed);
  sec.notes = [...user, ...auto.filter((n) => !taken.has(noteKey(n)) && !gone.has(noteKey(n)))];
  sec.ghosts = ghosts.filter((n) => !taken.has(noteKey(n)));
}

async function extract(sec, opts = {}) {
  if (!S.ready) { toast('Still separating the drums. Give it a few seconds.'); return; }
  if (sec.grid) pushUndo(sec);
  try {
    $('#extractBig').disabled = true;
    const res = await api(`/api/song/${S.song.id}/extract`, {
      start: sec.start, end: sec.end, sens: sec.sens,
      meter: opts.meter || (sec.grid && sec.grid.meter) || '4/4',
      bars: opts.bars || null,
    });
    sec.grid = res.grid; sec.removed = []; sec.notes = [];
    syncSpan(sec);
    sec.ref = [sec.start, sec.end];
    sec.tamb24 = !!S.prefs.tamb;
    mergeNotes(sec, res.notes, res.ghosts);
    autoTamb(sec);
    sec.exported = null;
    await suggestFeel(sec);
    renderAll(); save(); restartLoop();
    if (!res.notes.length) toast('No clear drum hits in this section. Try a part where the kit is playing, or raise the sensitivity.');
  } catch (e) { toast('Extract failed: ' + e.message, true); }
  $('#extractBig').disabled = false;
}

// The bars the loudness reference was measured on. It stays put while the grid is slid or
// nudged, so the same hits are re-snapped; it only moves when the section itself moves.
function refFor(sec) {
  const g = sec.grid, len = gridLen(g), r = sec.ref;
  if (!r || Math.abs(r[0] - g.t0) > beatLen(g) || Math.abs((r[1] - r[0]) / len - 1) > 0.05) sec.ref = [g.t0, g.t0 + len];
  return sec.ref;
}

// Play the detected snare as a rim click, or the hats as a shaker: move the whole row.
function setVoice(source, target) {
  const sec = sel();
  if (!sec || !sec.grid) return;
  sec.map = sec.map || {};
  const from = sec.map[source] || source;
  if (from === target) return;
  pushUndo(sec);
  const have = new Set(sec.notes.filter((n) => n.p === target).map((n) => n.s));
  sec.notes = sec.notes.filter((n) => !(n.p === from && have.has(n.s)));
  for (const n of sec.notes) if (n.p === from) n.p = target;
  for (const n of sec.ghosts || []) if (n.p === from) n.p = target;
  sec.removed = sec.removed.map((k) => (k.endsWith(':' + from) ? k.split(':')[0] + ':' + target : k));
  sec.map[source] = target;
  if (source === 38) S.prefs.rim = target === 37;
  if (source === 42) S.prefs.shaker = target === 82;
  saveConfig();
  sec.exported = null;
  renderEditor(); renderSections(); save();
}

// New sections get a tambourine on the backbeat. It follows bar and tempo changes until
// the tambourine row is edited by hand.
function autoTamb(sec) {
  if (!sec.tamb24 || !sec.grid) return;
  const m = meterOf(sec.grid), total = totalSlots(sec.grid);
  sec.notes = sec.notes.filter((n) => n.p !== 54);
  for (let s = 0; s < total; s += m.spb) {
    const beat = (s / m.spb) % m.beats;
    if (m.beats === 6 ? beat === 3 : beat % 2 === 1) sec.notes.push({ s, p: 54, v: 92, o: 0, u: 1 });
  }
}

// Write a steady pattern into the selected row (the tambourine, say).
function fillRow(kind) {
  const sec = sel();
  if (!sec || !sec.grid) return;
  pushUndo(sec);
  const p = S.row, m = meterOf(sec.grid), total = totalSlots(sec.grid);
  if (p === 54) sec.tamb24 = false;
  for (const n of sec.notes) if (n.p === p && !n.u) sec.removed.push(noteKey(n));
  sec.notes = sec.notes.filter((n) => n.p !== p);
  if (kind !== 'clear') {
    for (let s = 0; s < total; s++) {
      const sub = s % m.spb, beat = Math.floor(s / m.spb) % m.beats;
      let on = false, v = 92;
      if (kind === '4') on = sub === 0;
      else if (kind === '8') { on = (sub * 2) % m.spb === 0; v = sub === 0 ? 96 : 76; }
      else if (kind === '16') { on = true; v = sub === 0 ? 96 : sub * 2 === m.spb ? 82 : 68; }
      else if (kind === '24') on = sub === 0 && (m.beats === 6 ? beat === 3 : beat % 2 === 1);
      if (!on) continue;
      sec.removed = sec.removed.filter((k) => k !== s + ':' + p);
      sec.notes.push({ s, p, v, o: 0, u: 1 });
    }
  }
  sec.ghosts = (sec.ghosts || []).filter((gh) => gh.p !== p || kind === 'clear');
  sec.exported = null;
  renderEditor(); renderSections(); save();
}

function renderLayers() {
  const box = $('#layers');
  box.innerHTML = '';
  const add = (label, index, title) => {
    const b = document.createElement('button');
    b.textContent = label; b.title = title;
    b.classList.toggle('on', S.layer === index);
    b.onclick = () => { S.layer = index; renderLayers(); drawEditor(); };
    if (index !== null) b.ondblclick = () => openSettings();
    box.append(b);
  };
  S.layers.forEach((l, i) => add(`${i + 1} ${l.name}`, i, `Hear and see only this layer (key ${i + 1}). Double-click to edit layers.`));
  add('Full groove', null, 'Everything in the grid (key 0)');
  const plus = document.createElement('button');
  plus.textContent = '+'; plus.title = 'Add or edit layers';
  plus.onclick = () => openSettings(true);
  box.append(plus);
  $('#layerHint').textContent = !S.layers.length ? 'Optional: press + to add a stripped-down version of this groove, such as kick only.' : S.layer === null ? 'Pick a layer to hear that reduction.' : 'Click a row\'s colour tab to put that drum in or out of this layer.';
}

let qTimer, qSeq = 0;
function requantize(sec, now) {
  clearTimeout(qTimer);
  const run = async () => {
    const seq = ++qSeq;
    try {
      const res = await api(`/api/song/${S.song.id}/quantize`, { grid: sec.grid, sens: sec.sens, norm: refFor(sec) });
      if (seq !== qSeq || !sec.grid) return;
      mergeNotes(sec, res.notes, res.ghosts);
      drawEditor(); save();
    } catch (e) { /* keep the old notes */ }
  };
  if (now) run(); else qTimer = setTimeout(run, 70);
}

// Any change to tempo, start, bars, meter or swing lands here.
function afterGridChange(sec, quant = true) {
  syncSpan(sec);
  const total = totalSlots(sec.grid);
  sec.notes = sec.notes.filter((n) => n.s < total);
  autoTamb(sec);
  sec.exported = null;
  if (quant) requantize(sec);
  // A different swing grid needs a feel measured on that grid.
  if (sec.feel.pick && sec.feel.pick.swing !== sec.grid.swing) suggestFeel(sec).then(() => { if (sel() === sec) { fillFeelPicker(sec); drawEditor(); save(); } });
  renderSections(); syncToolbar(); drawOverview(); drawEditor(); restartLoop(); save();
}

function changeGrid(fn) {
  const sec = sel();
  if (!sec || !sec.grid) return;
  pushUndo(sec);
  fn(sec.grid, sec);
  sec.grid.t0 = Math.max(0, sec.grid.t0);
  afterGridChange(sec);
}

// ------------------------------------------------------------------ feel

async function loadFeels(sec) {
  const key = sec.grid.swing + '|' + Math.round(sec.grid.bpm / 4);
  if (!S.feels[key]) S.feels[key] = await api(`/api/feels?swing=${sec.grid.swing}&bpm=${sec.grid.bpm}`);
  return S.feels[key];
}
async function suggestFeel(sec) {
  try {
    const data = await loadFeels(sec);
    const g = sec.grid;
    const hats = new Set(sec.notes.filter((n) => [42, 46, 51, 82].includes(n.p)).map((n) => n.s % 16));
    const odd = [...hats].filter((s) => s % 2 === 1).length, ands = [...hats].filter((s) => s % 4 === 2).length;
    const density = !hats.size ? 'none' : odd >= 2 && odd >= ands ? 'sixteenth' : ands >= 2 ? 'eighth' : 'quarter';
    const band = g.bpm < 85 ? 'slow' : g.bpm < 120 ? 'mid' : g.bpm < 160 ? 'fast' : 'brisk';
    const same = data.templates.filter((t) => t.swing === g.swing);
    sec.feel.pick = same.find((t) => t.key === `${g.swing}|${density}|${band}`) || same.find((t) => t.key.startsWith(`${g.swing}|${density}|`)) || same.find((t) => t.key.endsWith('|' + band)) || same[0] || data.templates[0] || null;
  } catch (e) { /* feel data is optional */ }
}
async function fillFeelPicker(sec) {
  const pick = $('#feelPick');
  let data;
  try { data = await loadFeels(sec); } catch (e) { pick.innerHTML = '<option>Nothing learned yet. Use Learn in Settings.</option>'; return; }
  if (sel() !== sec) return;
  pick.innerHTML = '';
  const group = (label, items) => {
    if (!items.length) return;
    const og = document.createElement('optgroup'); og.label = label;
    for (const it of items) { const o = document.createElement('option'); o.value = it.id; o.textContent = it.label; og.append(o); }
    pick.append(og);
  };
  const match = data.templates.filter((t) => t.swing === sec.grid.swing);
  group('Averaged feel, matching this grid', match);
  group('Single grooves from your library near this tempo', data.grooves);
  group('Averaged feel, other grids', data.templates.filter((t) => t.swing !== sec.grid.swing));
  pick._items = [...data.templates, ...data.grooves];
  if (!pick._items.length) pick.innerHTML = '<option>Nothing learned yet. Use Learn in Settings.</option>';
  if (sec.feel.pick && pick._items.some((i) => i.id === sec.feel.pick.id)) pick.value = sec.feel.pick.id;
  else if (sec.feel.pick) { const o = document.createElement('option'); o.value = sec.feel.pick.id; o.textContent = sec.feel.pick.label; pick.prepend(o); pick.value = o.value; }
}

// ------------------------------------------------------------------ playback

function loopSpec(sec) {
  const g = sec.grid;
  if (!g) return { start: sec.start, len: Math.max(0.2, sec.end - sec.start), notes: () => [], beats: () => [] };
  const b = beatLen(g);
  return {
    start: g.t0, len: gridLen(g),
    notes: () => sec.notes.filter((n) => inLayer(n.p)).map((n) => { const s = sounding(sec, n); return { sec: s.beat * b, p: n.p, v: s.vel }; }),
    beats: () => { const out = [], m = meterOf(g); for (let i = 0; i < g.bars * m.beats; i++) out.push({ sec: i * b, accent: i % m.beats === 0 }); return out; },
  };
}
function playLoop() {
  const sec = sel();
  if (!sec || !engine.buffers.song) return;
  engine.playLoop(loopSpec(sec));
  syncTransport(); tickFrame();
}
function restartLoop() { if (engine.mode === 'loop') playLoop(); }
function playSong() {
  if (!engine.buffers.song) return;
  engine.playSong(clamp(engine.cursor, 0, S.song.duration - 0.05));
  syncTransport(); tickFrame();
}
function toggle(kind) {
  if (engine.mode) { const was = engine.mode; engine.stop(); if (was === kind) return; }
  if (kind === 'loop') playLoop(); else playSong();
}
function syncTransport() {
  $('#loopBtn').textContent = engine.mode === 'loop' ? '■ Stop' : '▶ Loop';
  $('#playSong').textContent = engine.mode === 'song' ? '■ Stop' : '▶ Song';
}
engine.onstop = () => { syncTransport(); drawTops(); };

function applyMix() {
  for (const [name, m] of Object.entries(mix)) {
    engine.setGain(name, m.on ? m.v : 0);
    const btn = document.querySelector(`[data-mute="${name}"]`);
    if (btn) btn.classList.toggle('on', m.on);
    const sl = document.querySelector(`[data-gain="${name}"]`);
    if (sl) sl.value = m.v;
  }
  try { localStorage.setItem('gw-mix', JSON.stringify(mix)); } catch (e) { /* private window */ }
}

let raf = 0;
function tickFrame() {
  cancelAnimationFrame(raf);
  const step = () => {
    drawTops();
    if (engine.mode) raf = requestAnimationFrame(step);
  };
  step();
}

// ------------------------------------------------------------------ overview

const OV = { drag: null, hover: null };
const ovX = (t, w) => ((t - S.view.a) / (S.view.b - S.view.a)) * w;
const ovT = (x, w) => S.view.a + (x / w) * (S.view.b - S.view.a);

function setView(a, b) {
  const dur = S.song.duration, span = clamp(b - a, 0.5, dur);
  a = clamp(a, 0, dur - span);
  S.view = { a, b: a + span };
  drawOverview();
}

function drawOverview() {
  if (!S.song) return;
  const [g, w, h] = fit($('#ov'));
  g.clearRect(0, 0, w, h);
  g.fillStyle = '#14171c'; g.fillRect(0, 0, w, h);
  const { a, b } = S.view;
  const cur = sel();
  // Bar lines of the selected section's grid, carried across the song.
  if (cur && cur.grid) {
    const bar = barLen(cur.grid), px = (bar / (b - a)) * w;
    if (px >= 5) {
      const k0 = Math.ceil((a - cur.grid.t0) / bar), k1 = Math.floor((b - cur.grid.t0) / bar);
      g.fillStyle = 'rgba(255,255,255,0.07)';
      for (let k = k0; k <= k1; k++) g.fillRect(Math.round(ovX(cur.grid.t0 + k * bar, w)), 0, 1, h);
    }
  } else if (S.beats.length && (w / (b - a)) * 0.5 > 5) {
    g.fillStyle = 'rgba(255,255,255,0.06)';
    for (const t of S.beats) if (t >= a && t <= b) g.fillRect(Math.round(ovX(t, w)), h - 10, 1, 10);
  }
  if (S.peaks.song) drawWave(g, S.peaks.song, 0, w, 18, h - 22, a, b, '#5b6676');
  else { g.fillStyle = '#8d95a3'; g.fillText('Loading audio…', 12, h / 2); }
  // Time ruler.
  const stepOpts = [1, 2, 5, 10, 15, 30, 60, 120];
  const step = stepOpts.find((s) => (s / (b - a)) * w >= 60) || 300;
  g.font = '10px -apple-system, sans-serif'; g.textBaseline = 'top';
  for (let t = Math.ceil(a / step) * step; t <= b; t += step) {
    const x = ovX(t, w);
    g.fillStyle = 'rgba(255,255,255,0.12)'; g.fillRect(x, 0, 1, 5);
    g.fillStyle = '#6f7887'; g.fillText(`${Math.floor(t / 60)}:${String(Math.round(t % 60)).padStart(2, '0')}`, x + 3, 2);
  }
  for (const sec of S.sections) {
    const x1 = ovX(sec.start, w), x2 = ovX(sec.end, w);
    if (x2 < 0 || x1 > w) continue;
    const on = sec.id === S.sel;
    g.fillStyle = sec.color + (on ? '40' : '22'); g.fillRect(x1, 16, x2 - x1, h - 16);
    if (sec.grid && (barLen(sec.grid) / (b - a)) * w > 12) {
      g.fillStyle = sec.color + '88';
      for (let k = 1; k < sec.grid.bars; k++) g.fillRect(Math.round(ovX(sec.grid.t0 + k * barLen(sec.grid), w)), 16, 1, h - 16);
    }
    g.fillStyle = sec.color; g.fillRect(x1, 16, on ? 3 : 2, h - 16); g.fillRect(x2 - (on ? 3 : 2), 16, on ? 3 : 2, h - 16);
    if (on) for (const x of [x1, x2]) { g.beginPath(); g.roundRect(x - 5, h / 2 - 3, 10, 26, 3); g.fill(); g.fillStyle = '#14171c'; g.fillRect(x - 1.5, h / 2 + 3, 1, 14); g.fillRect(x + 0.5, h / 2 + 3, 1, 14); g.fillStyle = sec.color; }
    const label = sec.name + (sec.grid ? ` · ${sec.grid.bars} bar${sec.grid.bars > 1 ? 's' : ''}` : '');
    g.font = '600 11px -apple-system, sans-serif';
    const tw = g.measureText(label).width + 12;
    g.fillStyle = sec.color; g.beginPath(); g.roundRect(Math.max(0, x1), 16, tw, 17, [0, 0, 5, 0]); g.fill();
    g.fillStyle = '#10131a'; g.textBaseline = 'middle'; g.fillText(label, Math.max(0, x1) + 6, 25); g.textBaseline = 'top';
  }
  if (OV.drag && OV.drag.kind === 'new' && OV.drag.moved) {
    const x1 = ovX(Math.min(OV.drag.t0, OV.drag.t1), w), x2 = ovX(Math.max(OV.drag.t0, OV.drag.t1), w);
    g.fillStyle = 'rgba(245,165,36,0.25)'; g.fillRect(x1, 16, x2 - x1, h - 16);
  }
  drawTops();
}

function ovHit(x, w) {
  const order = [...S.sections].sort((p, q) => (q.id === S.sel) - (p.id === S.sel));
  for (const sec of order) {
    const x1 = ovX(sec.start, w), x2 = ovX(sec.end, w);
    if (Math.abs(x - x1) <= 6) return { kind: 'left', sec };
    if (Math.abs(x - x2) <= 6) return { kind: 'right', sec };
  }
  for (const sec of order) if (x > ovX(sec.start, w) && x < ovX(sec.end, w)) return { kind: 'move', sec };
  return { kind: 'new' };
}

function snapBeat(t, w, free) {
  if (free || !S.beats.length) return t;
  let best = t, d = (10 / w) * (S.view.b - S.view.a);
  for (const b of S.beats) { const e = Math.abs(b - t); if (e < d) { d = e; best = b; } }
  return best;
}

function bindOverview() {
  const cv = $('#ov');
  cv.addEventListener('pointerdown', (e) => {
    if (!S.song) return;
    const r = cv.getBoundingClientRect(), x = e.clientX - r.left;
    const hit = ovHit(x, r.width);
    const t = ovT(x, r.width);
    OV.drag = { ...hit, x0: x, t0: t, t1: t, moved: false, orig: hit.sec ? { start: hit.sec.start, end: hit.sec.end, grid: hit.sec.grid && { ...hit.sec.grid } } : null };
    cv.setPointerCapture(e.pointerId);
  });
  cv.addEventListener('pointermove', (e) => {
    const r = cv.getBoundingClientRect(), x = e.clientX - r.left, w = r.width;
    const d = OV.drag;
    if (!d) { const hit = ovHit(x, w); cv.style.cursor = hit.kind === 'left' || hit.kind === 'right' ? 'ew-resize' : hit.kind === 'move' ? 'grab' : 'crosshair'; return; }
    if (!d.moved && Math.abs(x - d.x0) < 4) return;
    if (!d.moved) {
      d.moved = true;
      if (d.sec) { if (S.sel !== d.sec.id) { if (engine.mode === 'loop') engine.stop(); S.sel = d.sec.id; renderSections(); renderEditor(); } if (d.sec.grid) pushUndo(d.sec); }
    }
    const t = ovT(x, w), dt = t - d.t0, sec = d.sec, o = d.orig;
    d.t1 = t;
    if (d.kind === 'new') { drawOverview(); return; }
    if (sec.grid) {
      const g = sec.grid, bar = barLen(o.grid), beat = beatLen(o.grid);
      if (d.kind === 'move') g.t0 = Math.max(0, o.grid.t0 + (e.altKey ? dt : Math.round(dt / beat) * beat));
      if (d.kind === 'right') g.bars = clamp(Math.round((t - g.t0) / bar), 1, 16);
      if (d.kind === 'left') { const k = clamp(Math.round(dt / bar), -16 + o.grid.bars, o.grid.bars - 1); g.t0 = o.grid.t0 + k * bar; g.bars = o.grid.bars - k; if (g.t0 < 0) { g.t0 = o.grid.t0; g.bars = o.grid.bars; } }
      syncSpan(sec); requantize(sec);
      renderSections(); syncToolbar(); drawEditor();
    } else {
      const len = o.end - o.start;
      if (d.kind === 'move') { sec.start = clamp(o.start + dt, 0, S.song.duration - len); sec.end = sec.start + len; }
      if (d.kind === 'left') sec.start = clamp(snapBeat(t, w, e.altKey), 0, sec.end - 0.5);
      if (d.kind === 'right') sec.end = clamp(snapBeat(t, w, e.altKey), sec.start + 0.5, S.song.duration);
      renderSections();
    }
    drawOverview();
  });
  const up = (e) => {
    const d = OV.drag;
    if (!d) return;
    OV.drag = null;
    const r = cv.getBoundingClientRect();
    if (!d.moved) {
      if (d.sec && S.sel !== d.sec.id) select(d.sec.id);
      const was = engine.mode;
      if (was) engine.stop();
      engine.cursor = clamp(d.t0, 0, S.song.duration);
      if (was === 'song') playSong();
      drawTops();
      return;
    }
    if (d.kind === 'new') {
      const a = clamp(snapBeat(Math.min(d.t0, d.t1), r.width, e.altKey), 0, S.song.duration);
      const b = clamp(snapBeat(Math.max(d.t0, d.t1), r.width, e.altKey), 0, S.song.duration);
      if (b - a >= 0.5) { if (engine.mode === 'loop') engine.stop(); addSection(a, b); }
      renderAll(); save();
      return;
    }
    if (d.sec.grid) afterGridChange(d.sec); else { S.sections.sort((p, q) => p.start - q.start); renderAll(); save(); restartLoop(); }
  };
  cv.addEventListener('pointerup', up);
  cv.addEventListener('pointercancel', up);
  cv.addEventListener('dblclick', () => { const sec = sel(); if (sec) playLoop(); });
  cv.addEventListener('wheel', (e) => {
    if (!S.song) return;
    e.preventDefault();
    const r = cv.getBoundingClientRect(), span = S.view.b - S.view.a;
    if (e.ctrlKey || e.metaKey) {
      const at = ovT(e.clientX - r.left, r.width), k = Math.exp(e.deltaY * 0.01);
      const ns = clamp(span * k, 1, S.song.duration);
      setView(at - ((at - S.view.a) / span) * ns, at - ((at - S.view.a) / span) * ns + ns);
    } else {
      const dx = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.shiftKey ? e.deltaY : 0;
      if (dx) setView(S.view.a + (dx / r.width) * span, S.view.b + (dx / r.width) * span);
      else window.scrollBy(0, e.deltaY);
    }
  }, { passive: false });
  const zoom = (k) => { const mid = (S.view.a + S.view.b) / 2, span = (S.view.b - S.view.a) * k; setView(mid - span / 2, mid + span / 2); };
  $('#zoomIn').onclick = () => zoom(0.5);
  $('#zoomOut').onclick = () => zoom(2);
  $('#zoomFit').onclick = () => setView(0, S.song.duration);
  $('#zoomSel').onclick = () => { const sec = sel(); if (sec) { const pad = (sec.end - sec.start) * 0.75; setView(sec.start - pad, sec.end + pad); } };
}

// ------------------------------------------------------------------ section list

function renderSections() {
  const list = $('#secList');
  const focus = document.activeElement && document.activeElement.dataset && document.activeElement.dataset.sec;
  list.innerHTML = '';
  $('#secHint').textContent = S.sections.length ? '' : 'None yet. Drag across the part of the song you want, for example four bars of the chorus.';
  $('#exportAll').disabled = !S.sections.some((x) => x.grid);
  for (const sec of S.sections) {
    const el = document.createElement('div');
    el.className = 'sec' + (sec.id === S.sel ? ' cur' : '');
    el.style.borderLeftColor = sec.color;
    const name = document.createElement('input');
    name.type = 'text'; name.value = sec.name; name.setAttribute('list', 'names'); name.dataset.sec = sec.id; name.setAttribute('aria-label', 'Section name');
    name.oninput = () => { sec.name = name.value; sec.exported = null; drawOverview(); save(); };
    name.onfocus = () => select(sec.id);
    const meta = document.createElement('span'); meta.className = 'meta';
    meta.textContent = sec.grid
      ? `${sec.grid.bars} bar${sec.grid.bars > 1 ? 's' : ''} · ${sec.grid.bpm.toFixed(1)} bpm · ${fmtTime(sec.start)}`
      : `${fmtTime(sec.start)} – ${fmtTime(sec.end)} · not extracted`;
    el.append(name, meta);
    if (sec.exported) { const d = document.createElement('span'); d.className = 'done'; d.textContent = '✓ exported'; d.title = sec.exported; el.append(d); }
    const x = document.createElement('button'); x.className = 'x'; x.textContent = '✕'; x.title = 'Delete section';
    x.onclick = (e) => { e.stopPropagation(); removeSection(sec); };
    el.append(x);
    el.onclick = (e) => { if (e.target !== name && e.target !== x) select(sec.id); };
    list.append(el);
  }
  if (focus) { const again = list.querySelector(`[data-sec="${focus}"]`); if (again) again.focus(); }
}

// ------------------------------------------------------------------ editor

const ED = { gutter: 92, ruler: 22, wave: 92, row: 24, drag: null, hover: null };
const CORE = new Set([49, 51, 46, 42, 37, 38, 36]);
// Rows on screen: the usual kit pieces plus anything this section uses, or every drum.
function rowsFor(sec) {
  if (S.allRows) return ROWS;
  const used = new Set(sec.notes.map((n) => n.p));
  const show = new Set([...CORE, ...used, S.row]);
  for (const l of S.layers) for (const p of l.rows) show.add(p);
  // With the backbeat on the rim, an empty snare row is only clutter.
  if (sec.map && sec.map[38] === 37 && !used.has(38) && S.row !== 38) show.delete(38);
  return ROWS.filter((r) => show.has(r.p));
}
const edHeight = (sec) => ED.ruler + ED.wave + rowsFor(sec).length * ED.row + 2;

function edGeom(sec, w) {
  const g = sec.grid, pad = beatLen(g) * 0.5;
  const a = g.t0 - pad, b = g.t0 + gridLen(g) + pad;
  const pw = w - ED.gutter;
  return { a, b, x: (t) => ED.gutter + ((t - a) / (b - a)) * pw, t: (x) => a + ((x - ED.gutter) / pw) * (b - a), pps: pw / (b - a) };
}

function renderEditor() {
  const sec = sel();
  $('#editor').hidden = !sec;
  if (!sec) return;
  $('#needExtract').hidden = !!sec.grid;
  $('#edBody').hidden = !sec.grid;
  if (!sec.grid) {
    $('#extractBig').disabled = !S.ready;
    $('#extractBig').textContent = S.ready ? `Extract drums for "${sec.name}"` : 'Separating drums…';
    return;
  }
  $('#ed').style.height = edHeight(sec) + 'px';
  $('#moreRows').textContent = S.allRows ? 'Fewer drums' : 'More drums';
  syncToolbar();
  renderLayers();
  fillFeelPicker(sec);
  drawEditor();
}

function syncToolbar() {
  const sec = sel();
  if (!sec || !sec.grid) return;
  const g = sec.grid;
  if (document.activeElement !== $('#bpm')) $('#bpm').value = g.bpm.toFixed(2);
  $$('#bars button').forEach((b) => b.classList.toggle('on', +b.dataset.b === g.bars));
  $('#meter').value = g.meter;
  $('#swing').value = g.swing; $('#swing').disabled = meterOf(g).spb !== 4;
  $('#sKick').value = sec.sens.kick; $('#sSnare').value = sec.sens.snare; $('#sHat').value = sec.sens.hat;
  $$('#feelMode button').forEach((b) => b.classList.toggle('on', b.dataset.m === sec.feel.mode));
  $('#feelPick').disabled = sec.feel.mode !== 'ni';
  $('#fTiming').disabled = sec.feel.mode === 'quant'; $('#fVel').disabled = sec.feel.mode !== 'ni';
  $('#fTiming').value = sec.feel.timing; $('#fVel').value = sec.feel.vel;
  $('#fTimingV').textContent = Math.round(sec.feel.timing * 100) + '%';
  $('#fVelWrap').classList.toggle('off', sec.feel.mode !== 'ni');
  $('#undo').disabled = !S.undo.length;
  const mp = sec.map || {};
  $$('#backbeat button').forEach((b) => b.classList.toggle('on', +b.dataset.p === (mp[38] || 38)));
  $$('#hatsAs button').forEach((b) => b.classList.toggle('on', +b.dataset.p === (mp[42] || 42)));
  $('#rowName').textContent = ROWS[ROW_OF[S.row]].name;
}

function drawEditor() {
  const sec = sel();
  if (!sec || !sec.grid) return;
  const [c, w, h] = fit($('#ed'));
  const g = sec.grid, G = edGeom(sec, w), m = meterOf(g), beat = beatLen(g), total = totalSlots(g);
  const top = ED.ruler, rowsY = ED.ruler + ED.wave;
  const rows = rowsFor(sec), rowOf = Object.fromEntries(rows.map((r, i) => [r.p, i]));
  if (Math.abs(h - edHeight(sec)) > 1) { $('#ed').style.height = edHeight(sec) + 'px'; return drawEditor(); }
  c.clearRect(0, 0, w, h);
  c.fillStyle = '#14171c'; c.fillRect(0, 0, w, h);
  c.fillStyle = '#191c22'; c.fillRect(ED.gutter, top, w - ED.gutter, ED.wave);
  // Rows.
  rows.forEach((row, i) => {
    const y = rowsY + i * ED.row;
    c.fillStyle = i % 2 ? '#181b21' : '#1c2027'; c.fillRect(ED.gutter, y, w - ED.gutter, ED.row);
  });
  // Shade alternate beats so the eye can count.
  for (let bi = 0; bi < g.bars * m.beats; bi++) {
    if (bi % 2 === 0) continue;
    c.fillStyle = 'rgba(255,255,255,0.025)';
    c.fillRect(G.x(g.t0 + bi * beat), rowsY, G.x(g.t0 + (bi + 1) * beat) - G.x(g.t0 + bi * beat), rows.length * ED.row);
  }
  // Drum stem (or the song until the stem is in).
  const pk = S.peaks.drums || S.peaks.song;
  if (pk) drawWave(c, pk, ED.gutter, w - ED.gutter, top + 2, ED.wave - 4, G.a, G.b, S.peaks.drums ? '#b9c2cf' : '#5b6676', true);
  // Grid lines through the waveform and the rows: the same lines, the same clock.
  for (let s = 0; s <= total; s++) {
    const x = Math.round(G.x(g.t0 + slotBeat(g, s) * beat)) + 0.5;
    const isBar = s % (m.beats * m.spb) === 0, isBeat = s % m.spb === 0;
    c.strokeStyle = isBar ? 'rgba(245,165,36,0.85)' : isBeat ? 'rgba(255,255,255,0.28)' : 'rgba(255,255,255,0.09)';
    c.lineWidth = isBar ? 1.5 : 1;
    c.beginPath(); c.moveTo(x, isBar ? 0 : top); c.lineTo(x, h); c.stroke();
  }
  // Outside the loop.
  c.fillStyle = 'rgba(10,12,15,0.62)';
  c.fillRect(ED.gutter, top, G.x(g.t0) - ED.gutter, h - top);
  c.fillRect(G.x(g.t0 + gridLen(g)), top, w - G.x(g.t0 + gridLen(g)), h - top);
  // Ruler.
  c.font = '600 11px -apple-system, sans-serif'; c.textBaseline = 'middle';
  for (let bi = 0; bi < g.bars * m.beats; bi++) {
    const x = G.x(g.t0 + bi * beat), isBar = bi % m.beats === 0;
    c.fillStyle = isBar ? '#f5a524' : '#6f7887';
    c.fillText(isBar ? `${bi / m.beats + 1}` : `${(bi % m.beats) + 1}`, x + 4, ED.ruler / 2);
  }
  // Ghosts: hits the detector heard but did not keep.
  const slotW = (beat / m.spb) * G.pps;
  for (const gh of sec.ghosts || []) {
    const i = rowOf[gh.p];
    if (i === undefined || gh.s >= total) continue;
    const x = G.x(g.t0 + slotBeat(g, gh.s) * beat), y = rowsY + i * ED.row + ED.row / 2;
    c.strokeStyle = rows[i].color + '77'; c.lineWidth = 1;
    c.beginPath(); c.arc(x + 5, y, 2.5, 0, Math.PI * 2); c.stroke();
  }
  // Notes, at the time they will actually sound.
  const nw = clamp(slotW * 0.72, 5, 26);
  for (const n of sec.notes) {
    const i = rowOf[n.p];
    if (i === undefined) continue;
    const s = sounding(sec, n);
    const x = G.x(g.t0 + s.beat * beat), y = rowsY + i * ED.row + 3, hh = ED.row - 6;
    c.globalAlpha = inLayer(n.p) ? 1 : 0.16;
    c.fillStyle = rows[i].color + '38';
    c.beginPath(); c.roundRect(x, y, nw, hh, 3); c.fill();
    const fill = Math.max(3, hh * (s.vel / 127));
    c.fillStyle = rows[i].color;
    c.beginPath(); c.roundRect(x, y + hh - fill, nw, fill, 3); c.fill();
    c.fillRect(x, y, 1.5, hh);
  }
  c.globalAlpha = 1;
  const d = ED.drag;
  if (d && d.kind === 'vel' && d.moved) {
    c.fillStyle = '#fff'; c.font = '600 11px -apple-system, sans-serif';
    c.fillText(`vel ${d.note.v}`, G.x(g.t0 + slotBeat(g, d.note.s) * beat) + nw + 5, rowsY + rowOf[d.note.p] * ED.row + ED.row / 2);
  }
  // Gutter.
  c.fillStyle = '#1a1d23'; c.fillRect(0, 0, ED.gutter, h);
  c.fillStyle = 'rgba(255,255,255,0.08)'; c.fillRect(ED.gutter - 1, 0, 1, h);
  c.font = '11px -apple-system, sans-serif';
  c.fillStyle = '#8d95a3'; c.fillText(S.peaks.drums ? 'Drum stem' : 'Song', 10, top + ED.wave / 2);
  rows.forEach((row, i) => {
    const y = rowsY + i * ED.row + ED.row / 2;
    const within = inLayer(row.p);
    if (row.p === S.row) { c.fillStyle = 'rgba(255,255,255,0.07)'; c.fillRect(0, y - ED.row / 2, ED.gutter - 1, ED.row); }
    if (within) { c.fillStyle = row.color; c.fillRect(6, y - 6, 8, 12); }
    else { c.strokeStyle = row.color + '99'; c.lineWidth = 1; c.strokeRect(6.5, y - 5.5, 7, 11); }
    c.fillStyle = !within ? '#4f5661' : sec.notes.some((n) => n.p === row.p) ? '#e7e9ee' : '#737c8a';
    c.fillText(row.name, 20, y);
  });
  drawTops();
}

function bindEditor() {
  const cv = $('#ed');
  const locate = (e) => {
    const sec = sel(), r = cv.getBoundingClientRect(), x = e.clientX - r.left, y = e.clientY - r.top;
    const G = sec && sec.grid ? edGeom(sec, r.width) : { t: () => 0 }, rowsY = ED.ruler + ED.wave;
    const row = y >= rowsY ? Math.floor((y - rowsY) / ED.row) : -1;
    return { sec, x, y, G, row: sec.grid && row >= 0 ? rowsFor(sec)[row] : null, zone: x < ED.gutter ? 'gutter' : y < ED.ruler ? 'ruler' : y < rowsY ? 'wave' : 'rows', t: G.t(x) };
  };
  cv.addEventListener('pointerdown', (e) => {
    const L = locate(e), sec = L.sec;
    if (!sec || !sec.grid) return;
    engine.ctx.resume();
    cv.setPointerCapture(e.pointerId);
    if (L.zone === 'gutter') {
      if (!L.row) return;
      if (L.x < 18 && S.layer !== null && S.layers[S.layer]) {
        const rows = S.layers[S.layer].rows, at = rows.indexOf(L.row.p);
        if (at >= 0) rows.splice(at, 1); else rows.push(L.row.p);
        saveConfig();
      } else { S.row = L.row.p; engine.hit(L.row.p, 105); }
      syncToolbar(); drawEditor();
      return;
    }
    if (L.zone === 'wave' || L.zone === 'ruler') { pushUndo(sec); ED.drag = { kind: 'slide', x0: L.x, t0: sec.grid.t0, pps: L.G.pps, moved: false }; return; }
    const row = L.row;
    if (!row) return;
    const s = slotAt(sec.grid, L.t);
    if (s < 0 || s >= totalSlots(sec.grid)) return;
    const note = sec.notes.find((n) => n.s === s && n.p === row.p);
    pushUndo(sec);
    if (row.p === 54) sec.tamb24 = false;
    if (note) { ED.drag = { kind: 'vel', note, y0: L.y, v0: note.v, moved: false }; return; }
    const key = s + ':' + row.p;
    sec.removed = sec.removed.filter((k) => k !== key);
    const ghost = (sec.ghosts || []).find((gh) => gh.s === s && gh.p === row.p);
    const fresh = { s, p: row.p, v: ghost ? 80 : 100, o: 0, u: 1 };
    sec.notes.push(fresh);
    sec.ghosts = (sec.ghosts || []).filter((gh) => gh !== ghost);
    engine.hit(row.p, fresh.v);
    ED.drag = { kind: 'vel', note: fresh, y0: L.y, v0: fresh.v, moved: false, fresh: true };
    sec.exported = null;
    drawEditor(); renderSections(); save();
  });
  cv.addEventListener('pointermove', (e) => {
    const d = ED.drag, sec = sel();
    if (!sec || !sec.grid) return;
    const L = locate(e);
    if (!d) { cv.style.cursor = L.zone === 'wave' || L.zone === 'ruler' ? 'ew-resize' : L.zone === 'rows' ? 'pointer' : 'default'; return; }
    if (d.kind === 'slide') {
      if (!d.moved && Math.abs(L.x - d.x0) < 2) return;
      d.moved = true;
      // Audio follows the pointer: dragging right moves the audio later, so the grid starts earlier in the song.
      sec.grid.t0 = Math.max(0, d.t0 - (L.x - d.x0) / d.pps);
      syncSpan(sec); requantize(sec); drawEditor(); drawOverview();
    }
    if (d.kind === 'vel') {
      if (!d.moved && Math.abs(L.y - d.y0) < 4) return;
      d.moved = true;
      d.note.v = clamp(Math.round(d.v0 - (L.y - d.y0) * 1.2), 1, 127);
      d.note.u = 1;
      drawEditor();
    }
  });
  const up = () => {
    const d = ED.drag, sec = sel();
    ED.drag = null;
    if (!d || !sec) return;
    if (d.kind === 'slide') { if (d.moved) afterGridChange(sec); else S.undo.pop(); return; }
    if (d.kind === 'vel') {
      if (d.moved) engine.hit(d.note.p, d.note.v);
      else if (!d.fresh) {
        sec.notes = sec.notes.filter((n) => n !== d.note);
        if (!d.note.u) sec.removed.push(noteKey(d.note));
      }
      sec.exported = null;
      drawEditor(); renderSections(); syncToolbar(); save();
    }
  };
  cv.addEventListener('pointerup', up);
  cv.addEventListener('pointercancel', up);
}

// Playheads live on their own layer so the waveforms are not redrawn every frame.
function drawTops() {
  if (!S.song) return;
  const pos = engine.position();
  $('#clock').textContent = fmtTime(pos);
  {
    const [g, w, h] = fit($('#ovTop'));
    g.clearRect(0, 0, w, h);
    if (engine.mode === 'song' && (pos > S.view.b || pos < S.view.a)) { const span = S.view.b - S.view.a; setView(pos - span * 0.05, pos + span * 0.95); return; }
    const x = ovX(pos, w);
    g.fillStyle = '#fff'; g.fillRect(Math.round(x), 0, 1.5, h);
    g.beginPath(); g.moveTo(x - 5, 0); g.lineTo(x + 6, 0); g.lineTo(x + 0.5, 7); g.fill();
  }
  const sec = sel();
  if (sec && sec.grid && !$('#edBody').hidden) {
    const [g, w, h] = fit($('#edTop'));
    g.clearRect(0, 0, w, h);
    const G = edGeom(sec, w);
    if (pos >= G.a && pos <= G.b && (engine.mode || pos > 0)) { g.fillStyle = '#fff'; g.fillRect(Math.round(G.x(pos)), 0, 1.5, h); }
  }
}

// ------------------------------------------------------------------ export

function exportBody(sec, label, rows) {
  const notes = sec.notes.filter((n) => !rows || rows.includes(n.p)).map((n) => { const x = sounding(sec, n); return { beat: x.beat, p: n.p, v: x.vel }; });
  return { label, grid: sec.grid, notes };
}
// One file per layer plus the full groove, all cut from the same notes.
async function exportSection(sec, quiet) {
  if (!sec.grid) return 0;
  const sets = S.layers.map((l, i) => ({ label: `${sec.name} - ${i + 1} ${l.name}`, rows: l.rows }));
  // With no layers set up there is just the one groove, under the section's own name.
  sets.push({ label: S.layers.length ? `${sec.name} - ${S.layers.length + 1} Full` : sec.name, rows: null });
  let count = 0, last = null;
  const empty = [];
  for (const set of sets) {
    const body = exportBody(sec, set.label, set.rows);
    if (!body.notes.length) { empty.push(set.label); continue; }
    last = await api(`/api/song/${S.song.id}/export`, body);
    count++;
  }
  if (last) sec.exported = last.rel.split('/').slice(0, -1).join('/') + '/';
  if (!quiet) toast(`Saved ${count} file${count === 1 ? '' : 's'} for "${sec.name}" to ${sec.exported || 'exports'}` + (empty.length ? ` (${empty.length} empty layer${empty.length === 1 ? '' : 's'} skipped)` : ''));
  renderSections(); save(); loadLibrary();
  return count;
}

// ------------------------------------------------------------------ wiring

function renderAll() { renderSections(); renderEditor(); drawOverview(); }

function bindToolbar() {
  $('#loopBtn').onclick = () => toggle('loop');
  $('#playSong').onclick = () => toggle('song');
  $('#extractBig').onclick = () => { const sec = sel(); if (sec) extract(sec); };
  $('#redetect').onclick = () => { const sec = sel(); if (sec && (!sec.notes.some((n) => n.u) && !sec.removed.length || confirm('Read the drums again? Your edits to this section will be replaced.'))) extract(sec); };
  $('#undo').onclick = undo;
  $$('#backbeat button').forEach((b) => { b.onclick = () => setVoice(38, +b.dataset.p); });
  $$('#hatsAs button').forEach((b) => { b.onclick = () => setVoice(42, +b.dataset.p); });
  $$('#fill button').forEach((b) => { b.onclick = () => fillRow(b.dataset.k); });
  $('#moreRows').onclick = () => { S.allRows = !S.allRows; renderEditor(); };
  $('#bpm').onchange = (e) => { const v = parseFloat(e.target.value); if (v >= 30 && v <= 400) changeGrid((g) => { g.bpm = v; }); };
  $('#half').onclick = () => changeGrid((g) => { g.bpm /= 2; g.bars = Math.max(1, Math.round(g.bars / 2)); if (g.swing === 'swing8') g.swing = 'shuffle16'; });
  $('#dbl').onclick = () => changeGrid((g) => { g.bpm *= 2; g.bars = Math.min(16, g.bars * 2); if (g.swing === 'shuffle16') g.swing = 'swing8'; });
  $$('#bars button').forEach((b) => { b.onclick = () => changeGrid((g) => { g.bars = +b.dataset.b; }); });
  $('#meter').onchange = (e) => { const sec = sel(); if (sec) extract(sec, { meter: e.target.value }); };
  $('#swing').onchange = (e) => changeGrid((g) => { g.swing = e.target.value; });
  $('#dbL').onclick = () => changeGrid((g) => { g.t0 -= beatLen(g); });
  $('#dbR').onclick = () => changeGrid((g) => { g.t0 += beatLen(g); });
  $('#ngL').onclick = (e) => changeGrid((g) => { g.t0 -= e.shiftKey ? 0.01 : 0.002; });
  $('#ngR').onclick = (e) => changeGrid((g) => { g.t0 += e.shiftKey ? 0.01 : 0.002; });
  for (const [id, key] of [['#sKick', 'kick'], ['#sSnare', 'snare'], ['#sHat', 'hat']]) {
    $(id).oninput = (e) => { const sec = sel(); if (!sec) return; sec.sens[key] = +e.target.value; sec.exported = null; requantize(sec); };
  }
  $$('#feelMode button').forEach((b) => { b.onclick = () => { const sec = sel(); if (!sec) return; sec.feel.mode = b.dataset.m; sec.exported = null; syncToolbar(); drawEditor(); renderSections(); save(); }; });
  $('#feelPick').onchange = (e) => { const sec = sel(); const it = (e.target._items || []).find((i) => i.id === e.target.value); if (sec && it) { sec.feel.pick = it; sec.exported = null; drawEditor(); renderSections(); save(); } };
  $('#fTiming').oninput = (e) => { const sec = sel(); if (!sec) return; sec.feel.timing = +e.target.value; sec.exported = null; syncToolbar(); drawEditor(); save(); };
  $('#fVel').oninput = (e) => { const sec = sel(); if (!sec) return; sec.feel.vel = +e.target.value; sec.exported = null; syncToolbar(); drawEditor(); save(); };
  $('#exportBtn').onclick = () => { const sec = sel(); if (sec) exportSection(sec).catch((e) => toast('Export failed: ' + e.message, true)); };
  $('#exportAll').onclick = async () => {
    try {
      let n = 0;
      for (const sec of S.sections) n += await exportSection(sec, true);
      toast(`Saved ${n} file${n === 1 ? '' : 's'} to exports/${S.song.name}/`);
    } catch (e) { toast('Export failed: ' + e.message, true); }
  };
  $$('[data-mute]').forEach((b) => { b.onclick = (e) => { e.preventDefault(); mix[b.dataset.mute].on = !mix[b.dataset.mute].on; applyMix(); }; });
  $$('[data-gain]').forEach((sl) => { sl.oninput = () => { mix[sl.dataset.gain].v = +sl.value; applyMix(); }; });
  $('#libLoad').onclick = async (e) => {
    const btn = e.currentTarget;
    btn.disabled = true;
    try {
      const r = await api('/api/pick-folder', { start: $('#libDir').value.trim() });
      if (r.error) toast(r.error, true);
      else if (r.dir) await loadLibrary(r.dir);
    } catch (err) { toast(err.message, true); }
    btn.disabled = false;
  };
  $('#libDir').onkeydown = (e) => { if (e.key === 'Enter') loadLibrary($('#libDir').value.trim()); };
  $('#pickBtn').onclick = () => $('#filePick').click();
  $('#filePick').onchange = (e) => { if (e.target.files[0]) uploadFile(e.target.files[0]); };
}

function bindGlobal() {
  let depth = 0;
  window.addEventListener('dragenter', (e) => { if (e.dataTransfer && [...e.dataTransfer.types].includes('Files')) { depth++; $('#dropVeil').hidden = false; } });
  window.addEventListener('dragleave', () => { depth = Math.max(0, depth - 1); if (!depth) $('#dropVeil').hidden = true; });
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', (e) => {
    e.preventDefault(); depth = 0; $('#dropVeil').hidden = true;
    const file = e.dataTransfer && e.dataTransfer.files[0];
    if (file) uploadFile(file);
  });
  window.addEventListener('keydown', (e) => {
    const tag = e.target.tagName;
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z' && tag !== 'INPUT') { e.preventDefault(); undo(); return; }
    if (tag === 'INPUT' && e.target.type !== 'range' || tag === 'SELECT' || e.metaKey || e.ctrlKey) return;
    const k = e.key.toLowerCase();
    if (e.code === 'Space') { e.preventDefault(); toggle(e.shiftKey || !sel() ? 'song' : 'loop'); }
    else if (k === 's') { mix.song.on = !mix.song.on; applyMix(); }
    else if (k === 'd') { mix.drums.on = !mix.drums.on; applyMix(); }
    else if (k === 'm') { mix.midi.on = !mix.midi.on; applyMix(); }
    else if (k === 'c') { mix.click.on = !mix.click.on; applyMix(); }
    else if (k === 'e') { const sec = sel(); if (sec && !sec.grid) extract(sec); }
    else if (/^[0-9]$/.test(k) && sel() && sel().grid) { const i = +k - 1; if (k === '0') S.layer = null; else if (S.layers[i]) S.layer = i; else return; renderLayers(); drawEditor(); }
    else if (e.key === 'Escape') engine.stop();
  });
  let rz;
  window.addEventListener('resize', () => { clearTimeout(rz); rz = setTimeout(() => { drawOverview(); drawEditor(); }, 60); });
}

try { Object.assign(mix, JSON.parse(localStorage.getItem('gw-mix') || '{}')); } catch (e) { /* defaults */ }
window.GW = { S, engine };
// ------------------------------------------------------------------ settings

const SET = { layers: [], prefs: {} };
const PATH_KEYS = ['songs_dir', 'kit_dir', 'exports_dir', 'feel_dir'];

function showStatus(status) {
  for (const key of PATH_KEYS) {
    const el = $('#st_' + key), text = status[key] || '';
    el.textContent = text;
    el.className = 'st' + (/does not exist|No drum folders|No songs/.test(text) ? ' bad' : '');
  }
}

function drawSetLayers() {
  const box = $('#setLayers');
  box.innerHTML = '';
  SET.layers.forEach((layer, i) => {
    const row = document.createElement('div'); row.className = 'lay';
    const num = document.createElement('span'); num.className = 'num'; num.textContent = i + 1;
    const name = document.createElement('input'); name.type = 'text'; name.value = layer.name; name.setAttribute('aria-label', `Layer ${i + 1} name`);
    name.oninput = () => { layer.name = name.value; };
    const chips = document.createElement('span'); chips.className = 'chips';
    for (const r of ROWS) {
      // The backbeat and the hats are each one choice above, so each is one chip here that covers both drums.
      if (r.p === 37 || r.p === 82) continue;
      const group = r.p === 38 ? [38, 37] : r.p === 42 ? [42, 82] : [r.p];
      const label = r.p === 38 ? (SET.prefs.rim ? 'Rim click' : 'Snare') : r.p === 42 ? (SET.prefs.shaker ? 'Shaker' : 'Closed hat') : r.name;
      const chip = document.createElement('button'); chip.type = 'button'; chip.className = 'chip'; chip.textContent = label;
      const paint = () => { const on = group.some((p) => layer.rows.includes(p)); chip.classList.toggle('on', on); chip.style.background = on ? r.color : ''; chip.setAttribute('aria-pressed', on); };
      chip.onclick = () => { const on = group.some((p) => layer.rows.includes(p)); layer.rows = layer.rows.filter((p) => !group.includes(p)); if (!on) layer.rows.push(...group); paint(); };
      paint(); chips.append(chip);
    }
    const btn = (label, title, fn, off) => { const b = document.createElement('button'); b.type = 'button'; b.className = 'mv'; b.textContent = label; b.title = title; b.disabled = !!off; b.onclick = () => { fn(); drawSetLayers(); }; return b; };
    row.append(num, name, chips,
      btn('↑', 'Move up', () => { SET.layers.splice(i - 1, 0, SET.layers.splice(i, 1)[0]); }, i === 0),
      btn('↓', 'Move down', () => { SET.layers.splice(i + 1, 0, SET.layers.splice(i, 1)[0]); }, i === SET.layers.length - 1),
      btn('✕', 'Delete layer', () => { SET.layers.splice(i, 1); }));
    box.append(row);
  });
}

function paintSetPrefs() {
  $$('#setBackbeat button').forEach((b) => b.classList.toggle('on', (b.dataset.v === '1') === !!SET.prefs.rim));
  $$('#setHats button').forEach((b) => b.classList.toggle('on', (b.dataset.v === '1') === !!SET.prefs.shaker));
  $('#setTamb').checked = !!SET.prefs.tamb;
}

async function openSettings(addLayer) {
  try {
    const data = await api('/api/settings');
    for (const key of PATH_KEYS) { $('#set_' + key).value = data.paths[key]; $('#set_' + key).placeholder = 'Default: ' + data.placeholders[key]; }
    showStatus(data.status);
  } catch (e) { toast('Could not read settings: ' + e.message, true); return; }
  SET.layers = JSON.parse(JSON.stringify(S.layers));
  SET.prefs = { ...S.prefs };
  if (addLayer) SET.layers.push({ name: 'New layer', rows: S.layer !== null && S.layers[S.layer] ? [...S.layers[S.layer].rows] : [36] });
  $('#setErr').textContent = '';
  paintSetPrefs(); drawSetLayers();
  $('#settings').showModal();
  if (addLayer) { const inputs = $$('#setLayers input[type=text]'); const last = inputs[inputs.length - 1]; if (last) { last.focus(); last.select(); } }
}

async function saveSettings() {
  const paths = Object.fromEntries(PATH_KEYS.map((k) => [k, $('#set_' + k).value.trim()]));
  const layers = SET.layers.filter((l) => l.name.trim()).map((l) => ({ name: l.name.trim(), rows: l.rows }));
  try {
    const res = await fetch('/api/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ paths }) });
    const out = await res.json();
    if (!res.ok) { $('#setErr').textContent = out.error || 'Could not save.'; return; }
    await api('/api/config', { layers, prefs: SET.prefs }, 'PUT');
  } catch (e) { $('#setErr').textContent = e.message; return; }
  S.layers = layers; S.layer = null; Object.assign(S.prefs, SET.prefs); S.feels = {};
  $('#settings').close();
  loadKit(); loadLibrary();
  if (sel()) renderEditor();
  toast('Settings saved');
}

function bindSettings() {
  $('#settingsBtn').onclick = () => openSettings();
  $('#setCancel').onclick = () => $('#settings').close();
  $('#setSave').onclick = saveSettings;
  $('#setAddLayer').onclick = () => { SET.layers.push({ name: 'New layer', rows: [36] }); drawSetLayers(); };
  $$('#setBackbeat button').forEach((b) => { b.onclick = () => { SET.prefs.rim = b.dataset.v === '1'; paintSetPrefs(); drawSetLayers(); }; });
  $$('#setHats button').forEach((b) => { b.onclick = () => { SET.prefs.shaker = b.dataset.v === '1'; paintSetPrefs(); drawSetLayers(); }; });
  $('#setTamb').onchange = (e) => { SET.prefs.tamb = e.target.checked; };
  const titles = { songs_dir: 'Choose your song folder', kit_dir: 'Choose your drum kit folder', exports_dir: 'Choose where MIDI files are saved', feel_dir: 'Choose where learned feel is kept', learn: 'Choose a folder of MIDI grooves' };
  $$('[data-browse]').forEach((b) => {
    b.onclick = async () => {
      const input = b.dataset.browse === 'learn' ? $('#learnDir') : $('#set_' + b.dataset.browse);
      b.disabled = true;
      try {
        const r = await api('/api/pick-folder', { start: input.value.trim(), title: titles[b.dataset.browse] });
        if (r.error) $('#setErr').textContent = r.error; else if (r.dir) input.value = r.dir;
      } catch (e) { $('#setErr').textContent = e.message; }
      b.disabled = false;
    };
  });
  $('#learnBtn').onclick = async () => {
    const st = $('#st_learn'), btn = $('#learnBtn');
    const folder = $('#learnDir').value.trim();
    if (!folder) { st.textContent = 'Choose the folder that holds your MIDI grooves first.'; st.className = 'st bad'; return; }
    btn.disabled = true; st.className = 'st'; st.textContent = 'Learning… a large library can take a minute.';
    try {
      const res = await fetch('/api/learn', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ folder }) });
      const out = await res.json();
      if (!res.ok) { st.textContent = out.error || 'Learning failed.'; st.className = 'st bad'; }
      else { st.textContent = 'Done. ' + out.status.feel_dir + '.'; st.className = 'st good'; showStatus(out.status); S.feels = {}; }
    } catch (e) { st.textContent = e.message; st.className = 'st bad'; }
    btn.disabled = false;
  };
}
bindSettings();

api('/api/config').then((cfg) => {
  if (Array.isArray(cfg.layers) && cfg.layers.length) S.layers = cfg.layers;
  Object.assign(S.prefs, cfg.prefs || {});
  if (S.prefs.tamb) S.row = 54;
  if (sel()) renderEditor();
}).catch(() => {});
// Play the MIDI with the BeatBuddy kit's own samples where the kit has them.
async function loadKit() {
  try {
    const kit = await api('/api/kit');
    engine.samples = {};
    for (const [pitch, files] of Object.entries(kit.drums)) {
      const bufs = await Promise.all(files.map(async (f) => engine.decode(await (await fetch('/api/kit/file?f=' + encodeURIComponent(f))).arrayBuffer())));
      engine.setSamples(+pitch, bufs);
    }
  } catch (e) { toast('Could not load the drum kit samples: ' + e.message, true); }
}
loadKit();
bindOverview(); bindEditor(); bindToolbar(); bindGlobal(); applyMix(); loadLibrary();
