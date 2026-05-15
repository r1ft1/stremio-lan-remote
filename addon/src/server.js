import express from 'express';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import sdk from 'stremio-addon-sdk';
const { getRouter } = sdk;
import { addonInterface } from './index.js';
import {
  encodePlayerLoad,
  encodePlayerPausedChanged,
  encodePlayerVideoParamsChanged,
  encodeStreamingServerGetStatistics,
} from './dispatchEncoder.js';
import { resolveBestStream } from './resolver.js';
import { config } from './config.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PLACEHOLDER = readFileSync(resolve(__dirname, '../assets/casting.mp4'));
const CONTROL_TINY = readFileSync(resolve(__dirname, '../assets/tiny.mp4'));
const DOWNLOAD_ICON = readFileSync(resolve(__dirname, '../assets/download.png'));

function controllerHtml(title, metaDeepLink) {
  const escapeHtml = (s) =>
    String(s || '').replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' })[c]);
  const safeTitle = escapeHtml(title || 'Stream');
  const safeDeepLink = escapeHtml(metaDeepLink || '');
  return /* eslint-disable */ `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="theme-color" content="#0f0f12">
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
  <div class="row">
    <button data-action="vol-down">🔉 Vol −</button>
    <button data-action="vol-up">🔊 Vol +</button>
  </div>
  <div class="volume-bar">
    <span class="volume-label">Volume</span>
    <div class="volume-track"><div class="volume-fill" id="vol-fill"></div></div>
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
  <div class="row one">
    <button data-action="fullscreen" id="btn-fs">⛶ Fullscreen</button>
  </div>
  <div class="row one"><a class="pick-link" href="${safeDeepLink}">↻ Pick a different stream</a></div>
  <div class="row one"><button class="danger" data-action="stop">⏹ Stop Deck playback</button></div>
  <div class="status" id="status"></div>
</main>
<script>
  const status = document.getElementById('status');
  const seek = document.getElementById('seek');
  const tPos = document.getElementById('t-pos');
  const tDur = document.getElementById('t-dur');
  const aidSel = document.getElementById('aid');
  const sidSel = document.getElementById('sid');
  const buffer = document.getElementById('buffer');
  const bufferPct = document.getElementById('buffer-pct');
  const volFill = document.getElementById('vol-fill');
  const volNum = document.getElementById('vol-num');
  const btnFs = document.getElementById('btn-fs');
  let seeking = false;
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
      try {
        const r = await fetch('/control?action=' + encodeURIComponent(action), { method: 'POST' });
        if (!r.ok) flash('Failed: ' + r.status, 'err');
        else if (action === 'stop') {
          setTimeout(() => { window.location.href = 'stremio:///'; }, 200);
        }
      } catch (e) { flash('Network error', 'err'); }
    });
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
  });
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
        rebuildSelect(sidSel, list.filter(t => t.type === 'sub'), true);
      }
      if (s.aid != null && s.aid !== false) aidSel.value = String(s.aid);
      if (s.sid != null && s.sid !== false) sidSel.value = String(s.sid);
      const vol = Math.max(0, Math.min(150, Number(s.volume) || 0));
      volFill.style.width = Math.min(100, (vol / 100) * 100) + '%';
      volNum.textContent = Math.round(vol) + '%';
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

export function createServer({
  resolver = ({ type, id }) =>
    resolveBestStream({ type, id, upstreamUrl: config.streamResolverUrl }),
  fetch: fetchFn = fetch,
  shellHost = config.shellHost,
} = {}) {
  const app = express();
  app.use(getRouter(addonInterface));

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
      await fetchFn(`http://${shellHost}/download`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: sourceUrl, filename, meta_id }),
      }).catch(() => {});
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

  app.post('/set_track', async (req, res) => {
    try {
      const kind = String(req.body?.kind || '');
      const id = String(req.body?.id ?? '');
      if (!['aid', 'sid', 'vid'].includes(kind)) return res.status(400).end();
      const r = await fetchFn(`http://${shellHost}/set_track`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ kind, id }),
      });
      res.status(r.ok ? 200 : r.status).end();
    } catch (e) { res.status(502).end(); }
  });

  app.get('/state', async (_req, res) => {
    try {
      const r = await fetchFn(`http://${shellHost}/state`);
      if (!r.ok) return res.status(r.status).end();
      const j = await r.json();
      res.json(j);
    } catch (e) { res.status(502).end(); }
  });

  app.get('/downloads', async (_req, res) => {
    try {
      const r = await fetchFn(`http://${shellHost}/downloads`);
      if (!r.ok) return res.status(r.status).end();
      const j = await r.json();
      res.json(j);
    } catch (e) { res.status(502).end(); }
  });

  app.get('/cast_local', async (req, res) => {
    try {
      const streamToken = req.query.stream;
      if (!streamToken) return res.status(400).send('missing stream');
      const stream = JSON.parse(Buffer.from(streamToken, 'base64url').toString('utf8'));
      if (!stream.url) return res.status(400).send('stream has no url');
      await fetchFn(`http://${shellHost}/play_url`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: stream.url }),
      });
      const title = String(req.query.name || stream.name || 'Local file');
      res.set('Content-Type', 'text/html; charset=utf-8');
      res.send(controllerHtml(title, 'stremio:///'));
    } catch (e) {
      res.status(502).send(e.message);
    }
  });

  app.get('/cancel_download', async (req, res) => {
    try {
      const filename = String(req.query.filename || '');
      if (!filename) return res.status(400).send('missing filename');
      await fetchFn(`http://${shellHost}/cancel_download`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filename }),
      }).catch(() => {});
      res.set('Content-Type', 'video/mp4');
      res.send(CONTROL_TINY);
    } catch (e) {
      res.status(502).send(e.message);
    }
  });

  app.get('/delete_download', async (req, res) => {
    try {
      const filename = String(req.query.filename || '');
      if (!filename) return res.status(400).send('missing filename');
      await fetchFn(`http://${shellHost}/delete_download`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filename }),
      }).catch(() => {});
      res.set('Content-Type', 'video/mp4');
      res.send(CONTROL_TINY);
    } catch (e) {
      res.status(502).send(e.message);
    }
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
      await fetchFn(`http://${shellHost}/download`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: sourceUrl, filename, meta_id }),
      }).catch(() => {});
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
      const dl = await fetchFn(`http://${shellHost}/downloads`).then((r) => r.json()).catch(() => []);
      const entry = (Array.isArray(dl) ? dl : []).find((d) => d.filename === filename);
      if (!entry || !entry.source_url) {
        return res.status(404).send('no resumable source URL');
      }
      await fetchFn(`http://${shellHost}/download`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: entry.source_url, filename, meta_id: entry.meta_id || '' }),
      }).catch(() => {});
      res.set('Content-Type', 'video/mp4');
      res.send(CONTROL_TINY);
    } catch (e) {
      res.status(502).send(e.message);
    }
  });

  app.post('/download', async (req, res) => {
    try {
      const url = String(req.body?.url || '');
      const filename = String(req.body?.filename || '');
      if (!url || !filename) return res.status(400).end();
      const r = await fetchFn(`http://${shellHost}/download`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url, filename }),
      });
      res.status(r.ok ? 200 : r.status).end();
    } catch (e) { res.status(502).end(); }
  });

  app.get('/control', async (req, res) => {
    if (!CONTROL_MAP[req.query.action]) return res.status(400).send('invalid action');
    await dispatchControl(req.query.action);
    res.set('Content-Type', 'video/mp4');
    res.send(CONTROL_TINY);
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

      if (!dryRun) {
        if (stream.infoHash) {
          if (!isValidInfoHash(stream.infoHash)) {
            return res.status(400).send(`invalid infoHash: ${stream.infoHash}`);
          }
          const streamUrl = `http://127.0.0.1:11470/${stream.infoHash}/${stream.fileIdx ?? 0}`;
          await fetchFn(`http://${shellHost}/play_url`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ url: streamUrl }),
          }).catch(() => {});
        } else if (stream.url) {
          await fetchFn(`http://${shellHost}/play_url`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ url: stream.url }),
          }).catch(() => {});
        }
      }

      if (req.query.placeholder === '1') {
        res.set('Content-Type', 'video/mp4');
        return res.send(PLACEHOLDER);
      }
      const title = stream?.title?.split('\n')[0] || stream?.name?.replace(/\n/g, ' ') || 'Stream';
      const metaDeepLink = isSeries
        ? `stremio:///detail/series/${id}/${videoId}`
        : `stremio:///detail/movie/${id}`;
      res.set('Content-Type', 'text/html; charset=utf-8');
      res.send(controllerHtml(title, metaDeepLink));
    } catch (e) {
      res.status(502).send(e.message);
    }
  });

  return app;
}
