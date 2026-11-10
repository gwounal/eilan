'use strict';
// Vignettes des fichiers vidéo pour le rapport : une image par fichier, extraite avec ffmpeg
// (paquet ffmpeg-static s'il est installé, sinon ffmpeg du système). Sans ffmpeg : pas de vignettes, le rapport reste inchangé.
const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

let cached;
function findFfmpeg() {
  if (cached !== undefined) return cached;
  const cands = [];
  try {
    const p = require('ffmpeg-static');
    if (p) cands.push(String(p).replace('app.asar' + path.sep, 'app.asar.unpacked' + path.sep));
  } catch { /* paquet absent */ }
  cands.push('ffmpeg', '/opt/homebrew/bin/ffmpeg', '/usr/local/bin/ffmpeg', '/usr/bin/ffmpeg');
  cached = null;
  for (const c of cands) {
    try {
      const r = spawnSync(c, ['-version'], { timeout: 5000 });
      if (r.status === 0) { cached = c; break; }
    } catch { /* suivant */ }
  }
  return cached;
}

function extract(bin, file, out, seek) {
  return new Promise((resolve) => {
    const args = ['-v', 'error', '-y', '-ss', String(seek), '-i', file, '-an', '-sn',
      '-vf', 'thumbnail=48,scale=320:-2', '-frames:v', '1', '-q:v', '4', out];
    const p = spawn(bin, args, { stdio: 'ignore' });
    const timer = setTimeout(() => p.kill('SIGKILL'), 20000);
    p.on('error', () => { clearTimeout(timer); resolve(false); });
    p.on('close', (code) => { clearTimeout(timer); resolve(code === 0 && fs.existsSync(out) && fs.statSync(out).size > 0); });
  });
}

// ---------- Analyse d'un média : codec, résolution, cadence (images/s) ou fréquence d'échantillonnage ----------
const PRORES = { Proxy: 'ProRes 422 Proxy', LT: 'ProRes 422 LT', Standard: 'ProRes 422', HQ: 'ProRes 422 HQ', '4444': 'ProRes 4444', '4444 XQ': 'ProRes 4444 XQ' };
const CODECS = {
  h264: 'H.264', hevc: 'H.265 (HEVC)', mpeg2video: 'MPEG-2', mpeg4: 'MPEG-4', mjpeg: 'Motion JPEG', dnxhd: 'DNxHD/DNxHR', vp9: 'VP9', av1: 'AV1',
  aac: 'AAC', mp3: 'MP3', flac: 'FLAC', opus: 'Opus', vorbis: 'Vorbis', alac: 'ALAC', wmav2: 'WMA'
};
function codecLabel(codec, profile, audio) {
  if (codec === 'prores') return PRORES[profile] || 'ProRes';
  if (codec === 'dnxhd' && profile) return `DNxHD/DNxHR ${profile}`;
  const pcm = /^pcm_([sfu])(\d+)(?:le|be)?$/.exec(codec);
  if (pcm) return pcm[1] === 'f' ? `PCM ${pcm[2]} bits (flottant)` : `PCM ${pcm[2]} bits`;
  return CODECS[codec] || codec.toUpperCase();
}
// ffmpeg arrondit les cadences (23,98) : on les ramène aux valeurs usuelles (23,976 ; 29,97 ; 59,94…)
const RATES = [23.976, 24, 25, 29.97, 30, 47.952, 48, 50, 59.94, 60, 100, 119.88, 120];
const nominalFps = (n) => { const r = RATES.find((x) => Math.abs(x - n) < 0.03); return r || n; };
function parseProbe(text) {
  const info = {};
  const v = /Stream #[^\n]*?: Video: (\w+)(?: \(([^)]*)\))?([^\n]*)/.exec(text);
  if (v) {
    const res = /, (\d{2,5})x(\d{2,5})[ ,\[]/.exec(v[3] + ' ');
    const fps = /(\d+(?:\.\d+)?) fps/.exec(v[3]) || /(\d+(?:\.\d+)?) tbr/.exec(v[3]);
    info.video = { codec: v[1], label: codecLabel(v[1], v[2]), width: res ? +res[1] : 0, height: res ? +res[2] : 0, fps: fps ? nominalFps(parseFloat(fps[1])) : 0 };
  }
  const au = /Stream #[^\n]*?: Audio: (\w+)(?: \(([^)]*)\))?([^\n]*)/.exec(text);
  if (au) {
    const hz = /(\d+) Hz/.exec(au[3]);
    info.audio = { codec: au[1], label: codecLabel(au[1], au[2], true), hz: hz ? +hz[1] : 0 };
  }
  return info.video || info.audio ? info : null;
}
function probe(bin, file) {
  return new Promise((resolve) => {
    let err = '';
    const p = spawn(bin, ['-hide_banner', '-i', file], { stdio: ['ignore', 'ignore', 'pipe'] });
    const timer = setTimeout(() => p.kill('SIGKILL'), 15000);
    p.stderr.on('data', (d) => { if (err.length < 200000) err += d; });
    p.on('error', () => { clearTimeout(timer); resolve(null); });
    p.on('close', () => { clearTimeout(timer); resolve(parseProbe(err)); });   // ffmpeg -i sans sortie se termine en erreur : normal
  });
}

// items : [{ key, file, thumb }] -> Map key -> { info, thumb } (les échecs sont simplement absents)
async function analyzeMedia(items, { concurrency = 3 } = {}) {
  const out = new Map();
  const bin = findFfmpeg();
  if (!bin || !items.length) return out;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eilan-thumbs-'));
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      const it = items[i];
      const rec = {};
      rec.info = await probe(bin, it.file);
      if (it.thumb) {
        const jpg = path.join(dir, `${i + 1}.jpg`);
        let ok = await extract(bin, it.file, jpg, 1);
        if (!ok) ok = await extract(bin, it.file, jpg, 0);   // clip de moins d'une seconde
        if (ok) { try { rec.thumb = fs.readFileSync(jpg); } catch { /* ignoré */ } }
      }
      if (rec.info || rec.thumb) out.set(it.key, rec);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  fs.rmSync(dir, { recursive: true, force: true });
  return out;
}

module.exports = { analyzeMedia, parseProbe, findFfmpeg };
