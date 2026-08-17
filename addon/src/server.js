import express from 'express';
import { readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import sdk from 'stremio-addon-sdk';
const { getRouter } = sdk;
import { addonInterface, cinemetaResolveByMetaId } from './index.js';
import {
  encodePlayerLoad,
  encodePlayerPausedChanged,
  encodePlayerVideoParamsChanged,
  encodeStreamingServerGetStatistics,
} from './dispatchEncoder.js';
import { resolveBestStream, resolveAllStreams, summarizeStreams } from './resolver.js';
import { config } from './config.js';
import { startDownload, cancelDownload, deleteDownload, getDownloads } from './downloader.js';
import { addSub, removeSub } from './subscriptions.js';
import { fetchSub, parseMetaId, NoSubtitlesError } from './subtitleFetch.js';
import { cinemetaSearch, cinemetaPopular, cinemetaEpisodes } from './discover.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// --- Recently-played history (cast log) -------------------------------------
// The addon records each successful cast so the PWA home can show a "Recently
// played" row. Stored as a small JSON list, newest first, deduped by base id.
const HISTORY_FILE = resolve(homedir(), '.config/stremio-lan-remote/history.json');
function readHistory() {
  try {
    const h = JSON.parse(readFileSync(HISTORY_FILE, 'utf8'));
    return Array.isArray(h) ? h : [];
  } catch {
    return [];
  }
}
function recordHistory({ id, title, type }) {
  const baseId = String(id || '').split(':')[0];
  if (!baseId) return;
  try {
    const hist = readHistory().filter((h) => h.id !== baseId);
    hist.unshift({ id: baseId, title: title || baseId, type: type || 'movie', ts: Date.now() });
    writeFileSync(HISTORY_FILE, JSON.stringify(hist.slice(0, 20)));
  } catch {
    /* best-effort; never block a cast on history I/O */
  }
}
const PLACEHOLDER = readFileSync(resolve(__dirname, '../assets/casting.mp4'));
const CONTROL_TINY = readFileSync(resolve(__dirname, '../assets/tiny.mp4'));
const DOWNLOAD_ICON = readFileSync(resolve(__dirname, '../assets/download.png'));
const ICONS = {
  '/icons/icon-180.png': readFileSync(resolve(__dirname, '../assets/icon-180.png')),
  '/icons/icon-192.png': readFileSync(resolve(__dirname, '../assets/icon-192.png')),
  '/icons/icon-512.png': readFileSync(resolve(__dirname, '../assets/icon-512.png')),
};

// Shared <head> bits that make /app + the controller installable + standalone on iOS.
const PWA_HEAD = `
<link rel="manifest" href="/manifest.webmanifest">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<meta name="apple-mobile-web-app-title" content="Deck">
<link rel="apple-touch-icon" href="/icons/icon-180.png">`;

const MANIFEST = {
  name: 'Deck Remote',
  short_name: 'Deck',
  start_url: '/app',
  scope: '/',
  display: 'standalone',
  background_color: '#0f0f12',
  theme_color: '#0f0f12',
  icons: [
    { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any maskable' },
    { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any maskable' },
  ],
};

function controllerHtml(title, metaDeepLink, metaId = null, contentType = null) {
  const escapeHtml = (s) =>
    String(s || '').replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' })[c]);
  const safeTitle = escapeHtml(title || 'Stream');
  const safeDeepLink = escapeHtml(metaDeepLink || '');
  const metaIdJson = JSON.stringify(metaId || null);
  const contentTypeJson = JSON.stringify(contentType || null);
  // In the PWA flow, "pick a different stream" / stop should stay inside the app
  // (reopen the picker / go to search), not bounce to the official Stremio app.
  let pickHref = '/app';
  if (metaId) {
    pickHref = contentType === 'series'
      ? `/app?episodes=${encodeURIComponent(metaId.split(':')[0])}&name=${encodeURIComponent(title || '')}`
      : `/app?pick=${encodeURIComponent(metaId)}&type=movie&name=${encodeURIComponent(title || '')}`;
  }
  return /* eslint-disable */ `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="theme-color" content="#0f0f12">${PWA_HEAD}
<title>Deck Remote</title>
<style>
  *{box-sizing:border-box}
  html,body{margin:0;padding:0;background:#0f0f12;color:#eaeaf2;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;min-height:100vh}
  body{display:flex;flex-direction:column;padding:env(safe-area-inset-top) 16px env(safe-area-inset-bottom);max-width:480px;margin:0 auto}
  header{padding:20px 4px 12px}
  h1{font-size:14px;font-weight:500;color:#9a9aae;margin:0 0 4px;text-transform:uppercase;letter-spacing:.08em}
  .title{font-size:18px;font-weight:600;line-height:1.3;word-break:break-word}
  main{flex:1;display:flex;flex-direction:column;gap:12px;padding:8px 0 24px}
  .row{display:grid;grid-template-columns:1fr 1fr;gap:12px}
  .row.one{grid-template-columns:1fr}
  button{appearance:none;border:0;background:#1c1c22;color:#eaeaf2;font-size:17px;font-weight:600;padding:22px 12px;border-radius:14px;cursor:pointer;-webkit-tap-highlight-color:transparent;transition:background .12s,transform .08s;font-family:inherit}
  button:active{background:#2a2a33;transform:scale(.97)}
  button.primary{background:#3e3aed}
  button.primary:active{background:#5450ff}
  button.danger{background:#a02020}
  button.danger:active{background:#c83030}
  .status{min-height:20px;text-align:center;color:#9a9aae;font-size:13px;padding:8px 0}
  .status.ok{color:#52d987}
  .status.err{color:#e26e6e}
  .timebar{display:flex;flex-direction:column;gap:6px;background:#1c1c22;padding:14px 16px;border-radius:14px}
  .times{display:flex;justify-content:space-between;font-size:13px;color:#9a9aae;font-variant-numeric:tabular-nums}
  input[type=range]{width:100%;-webkit-appearance:none;appearance:none;background:transparent;height:30px}
  input[type=range]::-webkit-slider-runnable-track{height:6px;background:#2e2e3a;border-radius:3px}
  input[type=range]::-moz-range-track{height:6px;background:#2e2e3a;border-radius:3px}
  input[type=range]::-webkit-slider-thumb{-webkit-appearance:none;width:22px;height:22px;border-radius:50%;background:#eaeaf2;margin-top:-8px;border:0}
  input[type=range]::-moz-range-thumb{width:22px;height:22px;border-radius:50%;background:#eaeaf2;border:0}
  .picker{display:flex;flex-direction:column;gap:6px;background:#1c1c22;padding:14px 16px;border-radius:14px}
  .picker label{font-size:13px;color:#9a9aae;text-transform:uppercase;letter-spacing:.08em}
  select{appearance:none;background:#0f0f12;color:#eaeaf2;border:1px solid #2e2e3a;border-radius:8px;padding:12px;font-size:15px;font-family:inherit}
  .buffer{display:none;align-items:center;gap:10px;background:#1c1c22;padding:12px 16px;border-radius:12px;font-size:14px;color:#eaeaf2}
  .buffer.on{display:flex}
  .spinner{width:18px;height:18px;border-radius:50%;border:2px solid #3e3aed;border-top-color:transparent;animation:spin 0.8s linear infinite}
  .buffer .pct{margin-left:auto;color:#9a9aae;font-variant-numeric:tabular-nums}
  @keyframes spin{to{transform:rotate(360deg)}}
  .volume-bar{display:flex;align-items:center;gap:10px;background:#1c1c22;padding:10px 14px;border-radius:12px}
  .volume-bar input[type=range]{flex:1;min-width:0;width:auto;height:30px}
  .volume-label{font-size:12px;color:#9a9aae;text-transform:uppercase;letter-spacing:.08em;flex-shrink:0}
  .volume-track{flex:1;height:6px;background:#2e2e3a;border-radius:3px;overflow:hidden}
  .volume-fill{height:100%;background:#3e3aed;width:0%;transition:width .15s}
  .volume-num{font-size:13px;color:#9a9aae;font-variant-numeric:tabular-nums;min-width:40px;text-align:right}
  .pick-link{display:block;text-align:center;background:#1c1c22;color:#eaeaf2;font-size:15px;font-weight:600;padding:18px 12px;border-radius:14px;text-decoration:none}
  .pick-link:active{background:#2a2a33}
  button.active{background:#3e3aed}
  .download-status{background:#1c1c22;border-radius:12px;padding:10px 14px;font-size:13px;color:#9a9aae;display:flex;align-items:center;gap:10px}
  .download-status[hidden]{display:none}
  .download-status .name{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .download-status .pct{font-variant-numeric:tabular-nums}
</style>
</head>
<body>
<header>
  <h1>Casting to Deck</h1>
  <div class="title">${safeTitle}</div>
</header>
<main>
  <div class="buffer" id="buffer">
    <div class="spinner"></div>
    <span>Buffering…</span>
    <span class="pct" id="buffer-pct"></span>
  </div>
  <div class="timebar">
    <input type="range" id="seek" min="0" max="1000" value="0">
    <div class="times"><span id="t-pos">0:00</span><span id="t-dur">--:--</span></div>
  </div>
  <div class="row one"><button class="primary" data-action="toggle">⏯ Pause / Play</button></div>
  <div class="row">
    <button data-action="seek-back">⏪ -10s</button>
    <button data-action="seek-fwd">+10s ⏩</button>
  </div>
  <div class="volume-bar">
    <span class="volume-label">🔊</span>
    <input type="range" id="vol-slider" min="0" max="200" value="100">
    <span class="volume-num" id="vol-num">—</span>
  </div>
  <div class="picker">
    <label for="aid">Audio</label>
    <select id="aid"></select>
  </div>
  <div class="picker">
    <label for="sid">Subtitles</label>
    <select id="sid"></select>
  </div>
  <div class="picker">
    <label for="sid2">Secondary subtitles</label>
    <select id="sid2"></select>
  </div>
  <div class="row one"><button id="btn-getsubs" style="display:none">⬇ Get English subtitles</button></div>
  <div class="row one"><button id="btn-getsubs-ja" style="display:none">⬇ Get Japanese subtitles (dual)</button></div>
  <div class="row one">
    <button data-action="fullscreen" id="btn-fs">⛶ Fullscreen</button>
  </div>
  <div class="row one"><a class="pick-link" href="${pickHref}">↻ Pick a different stream</a></div>
  <div class="row one"><button class="danger" data-action="stop">⏹ Stop Deck playback</button></div>
  <div class="row">
    <button data-action="quit" data-confirm="Exit Stremio on the Deck?">⏏ Exit Stremio</button>
  </div>
  <div class="status" id="status"></div>
</main>
<script>
  const META_ID = ${metaIdJson};
  const CONTENT_TYPE = ${contentTypeJson};
  const EN_RE = /english|\\beng\\b|\\ben\\b|\\.en\\.srt$/i;
  const JA_RE = /japanese|\\bjpn\\b|\\bjpa\\b|\\bja\\b|\\.ja\\.srt$/i;
  const status = document.getElementById('status');
  const getSubsBtn = document.getElementById('btn-getsubs');
  const getSubsBtnJa = document.getElementById('btn-getsubs-ja');
  const seek = document.getElementById('seek');
  const tPos = document.getElementById('t-pos');
  const tDur = document.getElementById('t-dur');
  const aidSel = document.getElementById('aid');
  const sidSel = document.getElementById('sid');
  const sid2Sel = document.getElementById('sid2');
  const buffer = document.getElementById('buffer');
  const bufferPct = document.getElementById('buffer-pct');
  const volSlider = document.getElementById('vol-slider');
  const volNum = document.getElementById('vol-num');
  const btnFs = document.getElementById('btn-fs');
  let seeking = false;
  let volSeeking = false;
  let lastSig = '';
  let lastTimePos = -1;
  let lastTimeAt = 0;
  function fmt(t) {
    if (!isFinite(t) || t < 0) return '--:--';
    const s = Math.floor(t % 60).toString().padStart(2,'0');
    const m = Math.floor(t / 60) % 60;
    const h = Math.floor(t / 3600);
    return h > 0 ? h + ':' + m.toString().padStart(2,'0') + ':' + s : m + ':' + s;
  }
  function flash(text, kind) {
    status.textContent = text;
    status.className = 'status ' + (kind || '');
    clearTimeout(window.__t);
    window.__t = setTimeout(() => { status.textContent = ''; status.className = 'status'; }, 1500);
  }
  document.querySelectorAll('button[data-action]').forEach((b) => {
    b.addEventListener('click', async () => {
      const action = b.dataset.action;
      const confirmMsg = b.dataset.confirm;
      if (confirmMsg && !window.confirm(confirmMsg)) return;
      try {
        const r = await fetch('/control?action=' + encodeURIComponent(action), { method: 'POST' });
        if (!r.ok) flash('Failed: ' + r.status, 'err');
        else if (action === 'stop' || action === 'quit') {
          setTimeout(() => { window.location.href = '/app'; }, 200);
        }
      } catch (e) { flash('Network error', 'err'); }
    });
  });
  async function getSubs(btn, lang, secondary, label) {
    if (!META_ID) return;
    btn.disabled = true;
    flash('Fetching ' + label + ' subtitles…', '');
    try {
      const r = await fetch('/get_subtitles', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ id: META_ID, type: CONTENT_TYPE, lang: lang, secondary: secondary }) });
      const j = await r.json().catch(() => ({}));
      if (r.ok && j.ok) { flash(label + ' subtitles loaded', 'ok'); lastSig = ''; poll(); }
      else if (r.status === 404) { flash('No ' + label + ' subtitles found', 'err'); }
      else { flash('Failed: ' + (j.reason || r.status), 'err'); }
    } catch (e) { flash('Network error', 'err'); }
    btn.disabled = false;
  }
  getSubsBtn.addEventListener('click', () => getSubs(getSubsBtn, 'eng', false, 'English'));
  getSubsBtnJa.addEventListener('click', () => getSubs(getSubsBtnJa, 'jpn', true, 'Japanese'));
  volSlider.addEventListener('input', () => { volSeeking = true; volNum.textContent = volSlider.value + '%'; });
  volSlider.addEventListener('change', async () => {
    try {
      await fetch('/set_volume', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ volume: parseInt(volSlider.value, 10) }) });
    } catch (e) { flash('Network error', 'err'); }
    setTimeout(() => { volSeeking = false; }, 500);
  });
  seek.addEventListener('input', () => { seeking = true; });
  seek.addEventListener('change', async () => {
    const dur = parseFloat(tDur.dataset.dur || '0');
    if (dur > 0) {
      const target = (parseInt(seek.value, 10) / 1000) * dur;
      await fetch('/seek_abs', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ seconds: target }) });
    }
    setTimeout(() => { seeking = false; }, 500);
  });
  aidSel.addEventListener('change', async () => {
    await fetch('/set_track', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ kind:'aid', id: aidSel.value }) });
  });
  sidSel.addEventListener('change', async () => {
    await fetch('/set_track', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ kind:'sid', id: sidSel.value }) });
    rebuildSecondarySubs();
  });
  sid2Sel.addEventListener('change', async () => {
    await fetch('/set_track', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ kind:'secondary-sid', id: sid2Sel.value }) });
  });
  let lastSubTracks = [];
  function rebuildSecondarySubs() {
    const primary = sidSel.value;
    const filtered = lastSubTracks.filter((t) => String(t.id) !== String(primary));
    const prev = sid2Sel.value;
    rebuildSelect(sid2Sel, filtered, true);
    if (prev && prev !== 'no' && filtered.some((t) => String(t.id) === prev)) {
      sid2Sel.value = prev;
    } else if (prev && prev !== 'no') {
      sid2Sel.value = 'no';
      fetch('/set_track', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ kind:'secondary-sid', id: 'no' }) }).catch(() => {});
    }
  }
  function trackLabel(t) {
    const parts = [];
    if (t.lang) parts.push(t.lang);
    if (t.title) parts.push(t.title);
    if (t.codec) parts.push(t.codec);
    return parts.join(' · ') || ('Track ' + t.id);
  }
  function rebuildSelect(sel, items, offFirst) {
    while (sel.firstChild) sel.removeChild(sel.firstChild);
    if (offFirst) {
      const o = document.createElement('option');
      o.value = 'no'; o.textContent = 'Off';
      sel.appendChild(o);
    } else if (!items.length) {
      const o = document.createElement('option');
      o.value = ''; o.textContent = '—';
      sel.appendChild(o);
    }
    for (const t of items) {
      const o = document.createElement('option');
      o.value = String(t.id);
      o.textContent = trackLabel(t);
      sel.appendChild(o);
    }
  }
  function sig(list) { return list.map(t => t.type + ':' + t.id).join('|'); }
  async function poll() {
    try {
      const r = await fetch('/state');
      if (!r.ok) return;
      const s = await r.json();
      if (!seeking && s.duration > 0) {
        seek.value = String(Math.round((s.time_pos / s.duration) * 1000));
      }
      tPos.textContent = fmt(s.time_pos || 0);
      tDur.textContent = fmt(s.duration || 0);
      tDur.dataset.dur = String(s.duration || 0);
      const list = Array.isArray(s.track_list) ? s.track_list : [];
      const newSig = sig(list);
      if (newSig !== lastSig) {
        lastSig = newSig;
        rebuildSelect(aidSel, list.filter(t => t.type === 'audio'), false);
        lastSubTracks = list.filter(t => t.type === 'sub');
        rebuildSelect(sidSel, lastSubTracks, true);
        rebuildSecondarySubs();
      }
      const subMatch = (re) => list.some((t) => t.type === 'sub' &&
        (re.test(t.lang || '') || re.test(t.title || '') || re.test(t['external-filename'] || '')));
      const hasEng = subMatch(EN_RE);
      const hasJa = subMatch(JA_RE);
      getSubsBtn.style.display = (META_ID && !hasEng) ? '' : 'none';
      getSubsBtnJa.style.display = (META_ID && !hasJa) ? '' : 'none';
      if (s.aid != null && s.aid !== false) aidSel.value = String(s.aid);
      if (s.sid != null && s.sid !== false) {
        const before = sidSel.value;
        sidSel.value = String(s.sid);
        if (before !== sidSel.value) rebuildSecondarySubs();
      }
      if (s.secondary_sid != null && s.secondary_sid !== false) sid2Sel.value = String(s.secondary_sid);
      else if (s.secondary_sid === false) sid2Sel.value = 'no';
      const vol = Math.max(0, Math.min(200, Number(s.volume) || 0));
      if (!volSeeking) { volSlider.value = String(Math.round(vol)); volNum.textContent = Math.round(vol) + '%'; }
      if (s.fullscreen) btnFs.classList.add('active'); else btnFs.classList.remove('active');
      btnFs.textContent = s.fullscreen ? '⛶ Exit Fullscreen' : '⛶ Fullscreen';
      const now = Date.now();
      const tp = Number(s.time_pos) || 0;
      if (tp !== lastTimePos) { lastTimePos = tp; lastTimeAt = now; }
      const stalled = s.direct_mode && !s.paused && (now - lastTimeAt) > 1500;
      const isBuffering = !!s.buffering || stalled;
      if (isBuffering) {
        buffer.classList.add('on');
        const pct = Math.round(Number(s.buffer_pct) || 0);
        bufferPct.textContent = pct > 0 ? pct + '%' : '';
      } else {
        buffer.classList.remove('on');
        bufferPct.textContent = '';
      }
    } catch (e) {}
  }
  setInterval(poll, 1000);
  poll();
  window.addEventListener('pageshow', poll);
  window.addEventListener('visibilitychange', () => { if (!document.hidden) poll(); });
  window.addEventListener('focus', poll);
</script>
</body>
</html>`;
}

function discoverHtml() {
  return /* eslint-disable */ `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="theme-color" content="#0f0f12">${PWA_HEAD}
<title>Deck</title>
<style>
  *{box-sizing:border-box}
  html,body{margin:0;padding:0;background:#0f0f12;color:#eaeaf2;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;min-height:100vh}
  body{max-width:600px;margin:0 auto;padding:env(safe-area-inset-top) 14px env(safe-area-inset-bottom)}
  header{position:sticky;top:0;background:#0f0f12;padding:16px 2px 10px;z-index:5}
  h1{font-size:14px;font-weight:500;color:#9a9aae;margin:0 0 10px;text-transform:uppercase;letter-spacing:.08em}
  input{width:100%;font-size:17px;padding:14px 16px;border-radius:14px;border:0;background:#1c1c22;color:#eaeaf2;font-family:inherit;-webkit-appearance:none}
  input:focus{outline:2px solid #4da3ff}
  .sec{font-size:13px;color:#9a9aae;margin:18px 2px 8px;text-transform:uppercase;letter-spacing:.06em}
  .grid{display:grid;grid-template-columns:repeat(3,1fr);gap:10px}
  .card{position:relative;background:#1c1c22;border-radius:12px;overflow:hidden;cursor:pointer;-webkit-tap-highlight-color:transparent}
  .badge{position:absolute;top:6px;left:6px;background:rgba(0,0,0,.78);color:#4da3ff;font-size:10px;font-weight:700;padding:2px 6px;border-radius:6px;letter-spacing:.05em}
  .card:active{transform:scale(.97)}
  .card img{width:100%;aspect-ratio:2/3;object-fit:cover;display:block;background:#15151b}
  .card .nm{font-size:12px;padding:6px 7px 8px;line-height:1.25;color:#cfcfe0;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
  .eprow{display:flex;align-items:center;gap:12px;padding:14px 12px;background:#1c1c22;border-radius:12px;margin-bottom:8px;cursor:pointer}
  .eprow:active{background:#2a2a33}
  .eptag{font-size:13px;font-weight:700;color:#4da3ff;min-width:54px}
  .epnm{font-size:15px;color:#eaeaf2}
  .back{display:inline-block;background:#1c1c22;border-radius:12px;padding:12px 16px;font-size:15px;margin:4px 0 4px;cursor:pointer}
  .muted{color:#9a9aae;font-size:14px;padding:18px 4px}
</style>
</head>
<body>
<header>
  <h1>Deck — search &amp; cast</h1>
  <input id="q" type="search" placeholder="Search movies & shows…" autocomplete="off" autocapitalize="off">
</header>
<main id="content"></main>
<script>
  const content = document.getElementById('content');
  const q = document.getElementById('q');
  const POSTER_FALLBACK = '/icons/icon-192.png';
  function el(tag, cls){ const e = document.createElement(tag); if (cls) e.className = cls; return e; }
  function cast(url){ window.location.href = url; }

  function card(item){
    const c = el('div','card');
    const img = el('img');
    img.loading = 'lazy';
    img.src = item.poster || POSTER_FALLBACK;
    img.onerror = () => { img.src = POSTER_FALLBACK; };
    const nm = el('div','nm');
    nm.textContent = item.year ? (item.name + ' (' + item.year + ')') : item.name;
    c.appendChild(img); c.appendChild(nm);
    if (item.type === 'series'){ const b = el('div','badge'); b.textContent = 'TV'; c.appendChild(b); }
    c.onclick = () => pick(item);
    return c;
  }
  function grid(items){
    const g = el('div','grid');
    items.forEach((it) => g.appendChild(card(it)));
    return g;
  }
  function section(title, items){
    const frag = document.createDocumentFragment();
    const h = el('div','sec'); h.textContent = title; frag.appendChild(h);
    if (items.length) frag.appendChild(grid(items));
    else { const m = el('div','muted'); m.textContent = 'Nothing found.'; frag.appendChild(m); }
    return frag;
  }

  async function pick(item){
    if (item.type === 'series') return showEpisodes(item);
    showStreams(item.name, item.id, null, null, loadHome);
  }

  async function showStreams(titleText, baseId, season, episode, onBack){
    content.replaceChildren();
    const back = el('div','back'); back.textContent = '← Back'; back.onclick = onBack || loadHome;
    content.appendChild(back);
    const isSeries = season != null && episode != null;
    const h = el('div','sec');
    h.textContent = titleText + (isSeries ? '  ·  S' + season + 'E' + episode : '');
    content.appendChild(h);
    const loading = el('div','muted'); loading.textContent = 'Finding streams…'; content.appendChild(loading);
    try {
      let u = '/api/streams?id=' + encodeURIComponent(baseId) + '&type=' + (isSeries ? 'series' : 'movie');
      if (isSeries) u += '&season=' + season + '&episode=' + episode;
      const r = await fetch(u);
      const streams = r.ok ? await r.json() : [];
      loading.remove();
      if (!streams.length){ const m = el('div','muted'); m.textContent = 'No streams found.'; content.appendChild(m); return; }
      for (const s of streams){
        const row = el('div','eprow');
        const tag = el('div','eptag'); tag.textContent = s.quality || '—';
        const wrap = el('div'); wrap.style.flex = '1'; wrap.style.minWidth = '0';
        const nm = el('div','epnm'); nm.style.cssText = 'overflow:hidden;text-overflow:ellipsis;white-space:nowrap'; nm.textContent = s.label;
        wrap.appendChild(nm);
        const meta = [];
        if (s.seeders) meta.push('👤 ' + s.seeders);
        if (s.size) meta.push('💾 ' + s.size);
        if (meta.length){ const sub = el('div'); sub.style.cssText = 'font-size:12px;color:#9a9aae;margin-top:2px'; sub.textContent = meta.join('   '); wrap.appendChild(sub); }
        row.appendChild(tag); row.appendChild(wrap);
        let castUrl = '/cast?id=' + encodeURIComponent(baseId);
        if (isSeries) castUrl += '&season=' + season + '&episode=' + episode;
        castUrl += '&stream=' + encodeURIComponent(s.token);
        row.onclick = () => cast(castUrl);
        content.appendChild(row);
      }
    } catch (e){ loading.textContent = 'Couldn\\'t load streams.'; }
  }

  async function showEpisodes(series){
    content.replaceChildren();
    const back = el('div','back'); back.textContent = '← Back'; back.onclick = loadHome;
    content.appendChild(back);
    const title = el('div','sec'); title.textContent = series.name; content.appendChild(title);
    const loading = el('div','muted'); loading.textContent = 'Loading episodes…'; content.appendChild(loading);
    try {
      const r = await fetch('/api/meta?id=' + encodeURIComponent(series.id));
      const eps = r.ok ? await r.json() : [];
      loading.remove();
      if (!eps.length){ const m = el('div','muted'); m.textContent = 'No episodes found.'; content.appendChild(m); return; }
      let curSeason = null;
      for (const e of eps){
        if (e.season !== curSeason){ curSeason = e.season; const sh = el('div','sec'); sh.textContent = 'Season ' + e.season; content.appendChild(sh); }
        const row = el('div','eprow');
        const tag = el('div','eptag'); tag.textContent = 'S' + e.season + 'E' + e.episode;
        const nm = el('div','epnm'); nm.textContent = e.name;
        row.appendChild(tag); row.appendChild(nm);
        row.onclick = () => showStreams(series.name, series.id, e.season, e.episode, () => showEpisodes(series));
        content.appendChild(row);
      }
    } catch (err){ loading.textContent = 'Couldn\\'t load episodes.'; }
  }

  async function loadHome(){
    content.replaceChildren();
    const m = el('div','muted'); m.textContent = 'Loading…'; content.appendChild(m);
    const [hist, movies, series] = await Promise.all([
      fetch('/api/history').then((r)=>r.ok?r.json():[]).catch(()=>[]),
      fetch('/api/catalog/popular?type=movie').then((r)=>r.ok?r.json():[]).catch(()=>[]),
      fetch('/api/catalog/popular?type=series').then((r)=>r.ok?r.json():[]).catch(()=>[]),
    ]);
    content.replaceChildren();
    if (hist.length) content.appendChild(section('Recently played', hist));
    content.appendChild(section('Popular movies', movies.slice(0,9)));
    content.appendChild(section('Popular shows', series.slice(0,9)));
  }

  async function startView(){
    const p = new URLSearchParams(location.search);
    const epId = p.get('episodes');
    if (epId){ showEpisodes({ id: epId, name: p.get('name') || 'Episodes' }); return; }
    const pickId = p.get('pick');
    if (pickId){
      const type = p.get('type') || 'movie';
      const name = p.get('name') || 'Streams';
      if (type === 'series'){
        const bits = pickId.split(':');
        showStreams(name, bits[0], bits[1], bits[2], loadHome);
      } else {
        showStreams(name, pickId, null, null, loadHome);
      }
      return;
    }
    // Nothing specific requested: if the Deck is already playing something,
    // open the play/pause remote instead of the home screen (?home=1 forces home).
    if (p.get('home') !== '1'){
      try {
        const r = await fetch('/state');
        if (r.ok){ const s = await r.json(); if (s && s.now_title){ location.href = '/remote'; return; } }
      } catch (e) {}
    }
    loadHome();
  }

  let t = null;
  q.addEventListener('input', () => {
    clearTimeout(t);
    const term = q.value.trim();
    t = setTimeout(async () => {
      if (!term){ loadHome(); return; }
      content.replaceChildren();
      const m = el('div','muted'); m.textContent = 'Searching…'; content.appendChild(m);
      try {
        const r = await fetch('/api/search?q=' + encodeURIComponent(term));
        const list = r.ok ? await r.json() : [];
        content.replaceChildren();
        const shows = list.filter((x) => x.type === 'series');
        const movies = list.filter((x) => x.type !== 'series');
        if (!shows.length && !movies.length){ const z = el('div','muted'); z.textContent = 'No results.'; content.appendChild(z); }
        if (shows.length) content.appendChild(section('Shows', shows));
        if (movies.length) content.appendChild(section('Movies', movies));
      } catch (e){ content.replaceChildren(); const x = el('div','muted'); x.textContent = 'Search failed.'; content.appendChild(x); }
    }, 350);
  });

  startView();
</script>
</body>
</html>`;
}

export function createServer({
  resolver = ({ type, id }) =>
    resolveBestStream({ type, id, upstreamUrl: config.streamResolverUrl }),
  fetch: fetchFn = fetch,
  shellHost = config.shellHost,
  getSubtitles = fetchSub,
  deckToken = config.deckToken,
} = {}) {
  const app = express();
  app.use(getRouter(addonInterface));

  // --- Optional token auth for control/PWA routes --------------------------
  // Stremio protocol routes (handled by getRouter above) and the PWA shell
  // assets stay open; everything below this guard requires the token. First
  // request carries ?token=…; we set an httpOnly cookie so subsequent fetches +
  // navigations authenticate automatically. Disabled entirely if no token set.
  const AUTH_OPEN = ['/manifest.webmanifest', '/icons/'];
  const tokenEq = (a, b) => {
    if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
    let r = 0;
    for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
    return r === 0;
  };
  const cookieToken = (req) => {
    const m = (req.headers.cookie || '').match(/(?:^|;\s*)deck_token=([^;]+)/);
    return m ? decodeURIComponent(m[1]) : '';
  };
  app.use((req, res, next) => {
    if (!deckToken) return next(); // auth disabled
    if (AUTH_OPEN.some((p) => req.path === p || req.path.startsWith(p))) return next();
    if (req.query.token && tokenEq(String(req.query.token), deckToken)) {
      res.cookie('deck_token', deckToken, {
        httpOnly: true, sameSite: 'lax', path: '/', maxAge: 365 * 24 * 60 * 60 * 1000,
      });
      return next();
    }
    if (tokenEq(cookieToken(req), deckToken)) return next();
    return res.status(401).type('text/plain').send('unauthorized — open the app from your tokenized link (…/app?token=…)');
  });

  const CONTROL_MAP = {
    pause: { path: '/pause' },
    resume: { path: '/resume' },
    toggle: { path: '/toggle' },
    stop: { path: '/stop' },
    'seek-back': { path: '/seek', body: { seconds: -10 } },
    'seek-fwd': { path: '/seek', body: { seconds: 10 } },
    'vol-up': { path: '/volume', body: { delta: 5 } },
    'vol-down': { path: '/volume', body: { delta: -5 } },
    fullscreen: { path: '/fullscreen' },
    quit: { path: '/quit' },
  };

  async function dispatchControl(action) {
    const spec = CONTROL_MAP[action];
    if (!spec) return { ok: false, status: 400 };
    try {
      const opts = { method: 'POST' };
      if (spec.body) {
        opts.headers = { 'Content-Type': 'application/json' };
        opts.body = JSON.stringify(spec.body);
      }
      const r = await fetchFn(`http://${shellHost}${spec.path}`, opts);
      return { ok: r.ok, status: r.status };
    } catch (e) {
      return { ok: false, status: 502 };
    }
  }

  app.post('/control', async (req, res) => {
    const r = await dispatchControl(req.query.action);
    res.status(r.ok ? 200 : r.status).end();
  });

  app.use(express.json());

  // --- Deck PWA: search -> cast -> control --------------------------------
  // Bare URL → controller, so the Tailscale HTTPS link can be just the host.
  app.get('/', (_req, res) => res.redirect('/app'));

  app.get('/app', (_req, res) => {
    res.set('Content-Type', 'text/html; charset=utf-8');
    res.send(discoverHtml());
  });

  app.get('/manifest.webmanifest', (_req, res) => {
    res.set('Content-Type', 'application/manifest+json');
    res.json(MANIFEST);
  });

  app.get('/icons/:name', (req, res) => {
    const buf = ICONS[`/icons/${req.params.name}`];
    if (!buf) return res.status(404).end();
    res.set('Content-Type', 'image/png');
    res.set('Cache-Control', 'public, max-age=86400');
    res.send(buf);
  });

  app.get('/api/search', async (req, res) => {
    try {
      res.json(await cinemetaSearch(req.query.q, { fetch: fetchFn }));
    } catch (e) { res.status(502).json({ error: e.message }); }
  });

  app.get('/api/catalog/popular', async (req, res) => {
    const type = req.query.type === 'series' ? 'series' : 'movie';
    try {
      res.json(await cinemetaPopular(type, { fetch: fetchFn }));
    } catch (e) { res.status(502).json({ error: e.message }); }
  });

  // Recently-played rows for the PWA home, enriched with posters from Cinemeta.
  app.get('/api/history', async (_req, res) => {
    const hist = readHistory().slice(0, 9);
    const out = await Promise.all(hist.map(async (h) => {
      let poster = null;
      let name = h.title;
      try {
        const r = await fetchFn(`https://v3-cinemeta.strem.io/meta/${h.type}/${encodeURIComponent(h.id)}.json`);
        if (r.ok) {
          const d = await r.json();
          poster = d?.meta?.poster || null;
          if (d?.meta?.name) name = d.meta.name;
        }
      } catch { /* best-effort poster */ }
      return { id: h.id, name, type: h.type, poster };
    }));
    res.json(out);
  });

  app.get('/api/meta', async (req, res) => {
    if (!req.query.id) return res.status(400).json({ error: 'missing id' });
    try {
      res.json(await cinemetaEpisodes(req.query.id, { fetch: fetchFn }));
    } catch (e) { res.status(502).json({ error: e.message }); }
  });

  app.get('/api/streams', async (req, res) => {
    const { id, season, episode } = req.query;
    if (!id) return res.status(400).json({ error: 'missing id' });
    const type = req.query.type === 'series' ? 'series' : 'movie';
    const videoId = type === 'series' && season != null && episode != null
      ? `${id}:${season}:${episode}`
      : id;
    try {
      const streams = await resolveAllStreams({
        type, id: videoId, upstreamUrl: config.streamResolverUrl, fetch: fetchFn,
      });
      res.json(summarizeStreams(streams));
    } catch (e) { res.status(502).json({ error: e.message }); }
  });

  app.get('/test_fixture.mp4', (_req, res) => {
    res.set('Content-Type', 'video/mp4');
    res.send(PLACEHOLDER);
  });

  app.get('/noop', (_req, res) => {
    res.set('Content-Type', 'video/mp4');
    res.send(CONTROL_TINY);
  });

  app.get('/icons/download.png', (_req, res) => {
    res.set('Content-Type', 'image/png');
    res.set('Cache-Control', 'public, max-age=3600');
    res.send(DOWNLOAD_ICON);
  });

  app.get('/download_trigger_html', async (req, res) => {
    try {
      const { id, season, episode, stream: streamToken } = req.query;
      if (!streamToken) return res.status(400).send('missing stream');
      const stream = JSON.parse(Buffer.from(streamToken, 'base64url').toString('utf8'));
      if (!stream.infoHash) return res.status(400).send('stream has no infoHash');
      const sourceUrl = `http://127.0.0.1:11470/${stream.infoHash}/${stream.fileIdx ?? 0}`;
      let base = (stream.title?.split('\n')[0] || stream.name?.replace(/\n/g, ' ') || `${id}-${stream.infoHash}`)
        .replace(/[^\w\-. ]+/g, '_').slice(0, 160);
      if (season != null && episode != null) {
        const tag = `S${String(season).padStart(2, '0')}E${String(episode).padStart(2, '0')}`;
        if (!new RegExp(tag, 'i').test(base) && !new RegExp(`S0?${season}E0?${episode}`, 'i').test(base)) {
          base = `${base}.${tag}`;
        }
      }
      const filename = `${base}.mkv`;
      const meta_id = season != null && episode != null
        ? `${String(id || '').split(':')[0]}:${season}:${episode}`
        : String(id || '').split(':')[0];
      startDownload({ url: sourceUrl, filename, meta_id, dir: config.downloadDir });
      res.set('Content-Type', 'text/html; charset=utf-8');
      res.send(
        '<!doctype html><meta charset="utf-8">' +
        '<title>Download started</title>' +
        '<style>body{background:#0f0f12;color:#eaeaf2;font-family:-apple-system,sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;padding:0 20px;text-align:center}</style>' +
        '<div><p>📥 Download started on the Deck — returning to Stremio…</p></div>' +
        '<script>setTimeout(function(){location.href="stremio:///"},250)</script>'
      );
    } catch (e) {
      res.status(502).send(e.message);
    }
  });

  app.post('/seek_abs', async (req, res) => {
    try {
      const r = await fetchFn(`http://${shellHost}/seek_abs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ seconds: Number(req.body?.seconds) || 0 }),
      });
      res.status(r.ok ? 200 : r.status).end();
    } catch (e) { res.status(502).end(); }
  });

  // Absolute volume (0–200) for the controller's volume slider. The shell
  // already exposes /set_volume; this just proxies it.
  app.post('/set_volume', async (req, res) => {
    try {
      const vol = Math.max(0, Math.min(200, Number(req.body?.volume) || 0));
      const r = await fetchFn(`http://${shellHost}/set_volume`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ volume: vol }),
      });
      res.status(r.ok ? 200 : r.status).end();
    } catch (e) { res.status(502).end(); }
  });

  app.post('/set_track', async (req, res) => {
    try {
      const kind = String(req.body?.kind || '');
      const id = String(req.body?.id ?? '');
      if (!['aid', 'sid', 'vid', 'secondary-sid'].includes(kind)) return res.status(400).end();
      const r = await fetchFn(`http://${shellHost}/set_track`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ kind, id }),
      });
      res.status(r.ok ? 200 : r.status).end();
    } catch (e) { res.status(502).end(); }
  });

  app.post('/get_subtitles', async (req, res) => {
    const meta = parseMetaId(req.body?.id ?? req.query.id);
    if (!meta) return res.status(400).json({ ok: false, reason: 'no-id' });
    const lang = (req.body?.lang ?? req.query.lang) === 'jpn' ? 'jpn' : 'eng';
    const secondary = req.body?.secondary === true || req.query.secondary === '1';
    const post = (p, body) => fetchFn(`http://${shellHost}${p}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    const basename = (p) => String(p).split('/').pop();
    const getState = async () => {
      const r = await fetchFn(`http://${shellHost}/state`);
      return r.ok ? r.json() : null;
    };
    try {
      const path = await getSubtitles(meta, { fetch: fetchFn, lang });
      if (!secondary) {
        const r = await post('/sub_add', { url: path });
        if (!r.ok) return res.status(502).json({ ok: false, reason: 'player unreachable' });
        return res.json({ ok: true, path });
      }
      // Secondary (dual-subs): add it, move it to the secondary track, restore
      // the previous primary — so e.g. English stays on the bottom and Japanese
      // shows on top. Done via existing shell endpoints, no shell rebuild.
      const before = await getState();
      const prevSid = before?.sid;
      const ra = await post('/sub_add', { url: path });
      if (!ra.ok) return res.status(502).json({ ok: false, reason: 'player unreachable' });
      // small settle so the new track appears in the track list
      await new Promise((r) => setTimeout(r, 600));
      const after = await getState();
      const track = (after?.track_list || []).find(
        (t) => t.type === 'sub' && basename(String(t['external-filename'] || '')) === basename(path)
      );
      if (!track) return res.json({ ok: true, path, note: 'added as primary; secondary slot not set' });
      await post('/set_track', { kind: 'secondary-sid', id: String(track.id) });
      if (prevSid != null && prevSid !== false && prevSid !== 'no' && String(prevSid) !== String(track.id)) {
        await post('/set_track', { kind: 'sid', id: String(prevSid) });
      }
      return res.json({ ok: true, path, secondary: true, id: track.id });
    } catch (e) {
      if (e instanceof NoSubtitlesError) {
        return res.status(404).json({ ok: false, reason: e.message });
      }
      return res.status(502).json({ ok: false, reason: e.message });
    }
  });

  app.get('/state', async (_req, res) => {
    try {
      const r = await fetchFn(`http://${shellHost}/state`);
      if (!r.ok) return res.status(r.status).end();
      const j = await r.json();
      res.json(j);
    } catch (e) { res.status(502).end(); }
  });

  app.get('/downloads', (_req, res) => {
    res.json(getDownloads());
  });

  app.get('/cast_local', async (req, res) => {
    try {
      const streamToken = req.query.stream;
      if (!streamToken) return res.status(400).send('missing stream');
      const stream = JSON.parse(Buffer.from(streamToken, 'base64url').toString('utf8'));
      if (!stream.url) return res.status(400).send('stream has no url');
      const title = String(req.query.name || stream.name || 'Local file');
      await fetchFn(`http://${shellHost}/play_url`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: stream.url, title }),
      });
      res.set('Content-Type', 'text/html; charset=utf-8');
      res.send(controllerHtml(title, 'stremio:///'));
    } catch (e) {
      res.status(502).send(e.message);
    }
  });

  app.get('/cancel_download', (req, res) => {
    const filename = String(req.query.filename || '');
    if (!filename) return res.status(400).send('missing filename');
    cancelDownload(filename);
    res.set('Content-Type', 'video/mp4');
    res.send(CONTROL_TINY);
  });

  app.get('/delete_download', async (req, res) => {
    const filename = String(req.query.filename || '');
    if (!filename) return res.status(400).send('missing filename');
    await deleteDownload(filename);
    res.set('Content-Type', 'video/mp4');
    res.send(CONTROL_TINY);
  });

  app.get('/download_trigger', async (req, res) => {
    try {
      const { id, season, episode, stream: streamToken } = req.query;
      if (!streamToken) return res.status(400).send('missing stream');
      const stream = JSON.parse(Buffer.from(streamToken, 'base64url').toString('utf8'));
      if (!stream.infoHash) return res.status(400).send('stream has no infoHash');
      const sourceUrl = `http://127.0.0.1:11470/${stream.infoHash}/${stream.fileIdx ?? 0}`;
      let base = (stream.title?.split('\n')[0] || stream.name?.replace(/\n/g, ' ') || `${id}-${stream.infoHash}`)
        .replace(/[^\w\-. ]+/g, '_').slice(0, 160);
      if (season != null && episode != null) {
        const tag = `S${String(season).padStart(2, '0')}E${String(episode).padStart(2, '0')}`;
        if (!new RegExp(tag, 'i').test(base) && !new RegExp(`S0?${season}E0?${episode}`, 'i').test(base)) {
          base = `${base}.${tag}`;
        }
      }
      const filename = `${base}.mkv`;
      const meta_id = season != null && episode != null
        ? `${String(id || '').split(':')[0]}:${season}:${episode}`
        : String(id || '').split(':')[0];
      startDownload({ url: sourceUrl, filename, meta_id, dir: config.downloadDir });
      res.set('Content-Type', 'video/mp4');
      res.send(CONTROL_TINY);
    } catch (e) {
      res.status(502).send(e.message);
    }
  });

  app.get('/resume_download', async (req, res) => {
    try {
      const filename = String(req.query.filename || '');
      if (!filename) return res.status(400).send('missing filename');
      const dl = getDownloads();
      const entry = (Array.isArray(dl) ? dl : []).find((d) => d.filename === filename);
      if (!entry || !entry.source_url) {
        return res.status(404).send('no resumable source URL');
      }
      startDownload({ url: entry.source_url, filename, meta_id: entry.meta_id || '', dir: config.downloadDir });
      res.set('Content-Type', 'video/mp4');
      res.send(CONTROL_TINY);
    } catch (e) {
      res.status(502).send(e.message);
    }
  });

  app.post('/download', (req, res) => {
    const url = String(req.body?.url || '');
    const filename = String(req.body?.filename || '');
    const meta_id = String(req.body?.meta_id || '');
    if (!url || !filename) return res.status(400).end();
    const ok = startDownload({ url, filename, meta_id, dir: config.downloadDir });
    res.status(ok ? 202 : 409).end();
  });

  function bounceHtml(msg) {
    return '<!doctype html><meta charset="utf-8"><title>Subscriptions</title>' +
      '<style>body{background:#0f0f12;color:#eaeaf2;font-family:-apple-system,sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;padding:0 20px;text-align:center}</style>' +
      `<div><p>${msg}</p></div><script>setTimeout(function(){location.href="stremio:///"},400)</script>`;
  }

  app.get('/subscribe', async (req, res) => {
    const id = String(req.query.id || '').split(':')[0];
    if (!id) return res.status(400).send('missing id');
    await addSub(config.downloadDir, id, new Date().toISOString());
    res.set('Content-Type', 'text/html; charset=utf-8');
    res.send(bounceHtml('🔔 Subscribed — new 1080p episodes will auto-download.'));
  });

  app.get('/unsubscribe', async (req, res) => {
    const id = String(req.query.id || '').split(':')[0];
    if (!id) return res.status(400).send('missing id');
    await removeSub(config.downloadDir, id);
    res.set('Content-Type', 'text/html; charset=utf-8');
    res.send(bounceHtml('🔕 Unsubscribed.'));
  });

  app.get('/control', async (req, res) => {
    if (!CONTROL_MAP[req.query.action]) return res.status(400).send('invalid action');
    await dispatchControl(req.query.action);
    res.set('Content-Type', 'video/mp4');
    res.send(CONTROL_TINY);
  });

  app.get('/remote', async (_req, res) => {
    try {
      const stateResp = await fetchFn(`http://${shellHost}/state`).catch(() => null);
      let title = 'Deck Remote';
      if (stateResp && stateResp.ok) {
        const s = await stateResp.json().catch(() => null);
        if (s?.now_title) {
          title = s.now_title;
        } else if (s && Array.isArray(s.track_list)) {
          const v = s.track_list.find((t) => t && t.type === 'video' && t.selected);
          if (v && v['demux-w'] && v['demux-h']) {
            title = `Now playing — ${v['demux-w']}×${v['demux-h']}`;
          }
        }
      }
      res.set('Content-Type', 'text/html; charset=utf-8');
      res.send(controllerHtml(title, 'stremio:///'));
    } catch (e) {
      res.status(502).send(e.message);
    }
  });

  app.get('/cast', async (req, res) => {
    try {
      const { id, season, episode, stream: streamToken } = req.query;
      const isSeries = season != null;
      const type = isSeries ? 'series' : 'movie';
      const videoId = isSeries ? `${id}:${season}:${episode}` : id;

      const stream = streamToken
        ? JSON.parse(Buffer.from(streamToken, 'base64url').toString('utf8'))
        : await resolver({ type, id: videoId });
      const loadAction = encodePlayerLoad({ stream, metaId: id, videoId, type });
      const playerHash = loadAction.locationHash;

      const post = (body) =>
        fetchFn(`http://${shellHost}/dispatch`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });

      const isValidInfoHash0 = (h) => typeof h === 'string' && /^[0-9a-f]{40}$/i.test(h);
      const dryRun0 = req.query.dry_run === '1';
      if (!dryRun0 && stream.infoHash && !isValidInfoHash0(stream.infoHash)) {
        return res.status(400).send(`invalid infoHash: ${stream.infoHash}`);
      }
      if (!dryRun0) {
        const navRes = await post(loadAction);
        if (!navRes.ok) {
          return res.status(502).send('shell dispatch failed');
        }
      }

      const isValidInfoHash = (h) => typeof h === 'string' && /^[0-9a-f]{40}$/i.test(h);
      const dryRun = req.query.dry_run === '1';

      const filenameTitle = stream?.title?.split('\n')[0] || stream?.name?.replace(/\n/g, ' ') || 'Stream';
      let nowTitle = filenameTitle;
      try {
        const cm = await cinemetaResolveByMetaId(isSeries ? `${id}:${season}:${episode}` : id);
        if (cm?.name) nowTitle = cm.name;
      } catch (e) {}

      if (!dryRun) {
        if (stream.infoHash) {
          if (!isValidInfoHash(stream.infoHash)) {
            return res.status(400).send(`invalid infoHash: ${stream.infoHash}`);
          }
          const streamUrl = `http://127.0.0.1:11470/${stream.infoHash}/${stream.fileIdx ?? 0}`;
          await fetchFn(`http://${shellHost}/play_url`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ url: streamUrl, title: nowTitle }),
          }).catch(() => {});
        } else if (stream.url) {
          await fetchFn(`http://${shellHost}/play_url`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ url: stream.url, title: nowTitle }),
          }).catch(() => {});
        }
        recordHistory({ id, title: nowTitle, type });
      }

      if (req.query.placeholder === '1') {
        res.set('Content-Type', 'video/mp4');
        return res.send(PLACEHOLDER);
      }
      const title = filenameTitle;
      const metaDeepLink = isSeries
        ? `stremio:///detail/series/${id}/${videoId}`
        : `stremio:///detail/movie/${id}`;
      res.set('Content-Type', 'text/html; charset=utf-8');
      res.send(controllerHtml(title, metaDeepLink, videoId, type));
    } catch (e) {
      res.status(502).send(e.message);
    }
  });

  return app;
}
