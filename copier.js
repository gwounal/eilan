'use strict';
const fsp = require('fs').promises;
const path = require('path');
const crypto = require('crypto');

const CHUNK = 4 * 1024 * 1024;
const IGNORED = new Set([
  '.DS_Store', 'Thumbs.db', 'desktop.ini', '$RECYCLE.BIN', 'System Volume Information',
  '.Trashes', '.Spotlight-V100', '.fseventsd', '.TemporaryItems', 'lost+found'
]);
const VIDEO_EXT = new Set([
  '.mp4', '.mov', '.m4v', '.mxf', '.avi', '.mkv', '.mts', '.m2ts', '.mpg', '.mpeg',
  '.wmv', '.webm', '.r3d', '.braw', '.ari', '.crm', '.vob', '.ts'
]);
const AUDIO_EXT = new Set([
  '.wav', '.bwf', '.rf64', '.w64', '.aif', '.aiff', '.caf', '.sd2', '.flac', '.mp3', '.m4a', '.aac', '.ogg', '.opus', '.wma', '.mka'
]);
// « média » = vidéo ou son (l'indicateur interne reste nommé `video`)
const isRealVideo = (name) => VIDEO_EXT.has(path.extname(name).toLowerCase());
const isVideo = (name) => { const e = path.extname(name).toLowerCase(); return VIDEO_EXT.has(e) || AUDIO_EXT.has(e); };

// Pause : la copie attend, le temps de pause est décompté du débit et de la durée
async function waitIfPaused(ctl) {
  if (!ctl.paused) return;
  const start = Date.now();
  while (ctl.paused && !ctl.cancelled) await new Promise((r) => setTimeout(r, 150));
  ctl.pausedMs = (ctl.pausedMs || 0) + (Date.now() - start);
}

// ---------- Hash : xxHash64 ou MD5 ----------
let xxhashPromise = null;
function getXXH() {
  if (!xxhashPromise) {
    const mod = require('xxhash-wasm');
    xxhashPromise = (mod.default || mod)();
  }
  return xxhashPromise;
}

async function createHasher(algo) {
  if (algo === 'md5') {
    const h = crypto.createHash('md5');
    return { update: (b) => h.update(b), digest: () => h.digest('hex') };
  }
  const xxh = await getXXH();
  const h = xxh.create64();
  return {
    update: (b) => h.update(b),
    digest: () => BigInt(h.digest()).toString(16).padStart(16, '0')
  };
}

async function hashFile(file, algo, ctl, onBytes) {
  const hasher = await createHasher(algo);
  const fh = await fsp.open(file, 'r');
  try {
    const buf = Buffer.allocUnsafe(CHUNK);
    let pos = 0;
    for (;;) {
      if (ctl.cancelled) throw new Error('CANCELLED');
      await waitIfPaused(ctl);
      if (ctl.cancelled) throw new Error('CANCELLED');
      const { bytesRead } = await fh.read(buf, 0, CHUNK, pos);
      if (!bytesRead) break;
      hasher.update(buf.subarray(0, bytesRead));
      pos += bytesRead;
      onBytes(bytesRead);
    }
  } finally {
    await fh.close();
  }
  return hasher.digest();
}

// ---------- Scan du dossier source ----------
async function scan(root, onlyVideos = false) {
  const files = [];
  async function walk(dir, rel) {
    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch (e) {
      if (rel === '') throw e; // la racine doit être lisible, pas les sous-dossiers protégés
      return;
    }
    for (const e of entries) {
      if (IGNORED.has(e.name)) continue;
      const abs = path.join(dir, e.name);
      const r = path.join(rel, e.name);
      if (e.isDirectory()) {
        await walk(abs, r);
      } else if (e.isFile()) {
        const video = isVideo(e.name);
        if (onlyVideos && !video) continue;
        let st;
        try { st = await fsp.stat(abs); } catch { continue; }
        files.push({ abs, rel: r, size: st.size, mtime: st.mtime, video });
      }
    }
  }
  await walk(root, '');
  files.sort((a, b) => a.rel.localeCompare(b.rel));
  return files;
}

// ---------- Copie d'un fichier vers N destinations (une seule lecture) ----------
// Chaque destination a son propre fichier d'écriture : on écrit sous un nom temporaire (<nom>.eilan-part) ; le nom définitif
// n'est donné qu'une fois le fichier contrôlé (taille ou empreinte). Un fichier existant n'est donc remplacé qu'à ce moment-là,
// et une coupure ne laisse jamais un fichier tronqué sous son vrai nom.
const TMP = '.eilan-part';
const tmpName = (t) => t + TMP;
const RING = 6;   // blocs de 4 Mo en vol : une destination lente ne bloque les autres que passé ~24 Mo de retard

// Les destinations sont isolées : une erreur d'écriture retire seulement la destination concernée pour ce fichier.
// Renvoie un tableau {ok, error} par destination ; lève une erreur seulement si la source est illisible ou si tout a échoué.
async function copyFile(f, targets, hasher, ctl, onBytes) {
  const n = targets.length;
  const res = targets.map(() => ({ ok: true, error: null }));
  const outs = new Array(n).fill(null);
  const fail = (i, e) => { if (res[i].ok) res[i] = { ok: false, error: e && e.message ? e.message : String(e) }; };
  const src = await fsp.open(f.abs, 'r');
  const chain = targets.map(() => Promise.resolve());
  try {
    await Promise.all(targets.map(async (t, i) => {
      try {
        await fsp.mkdir(path.dirname(t), { recursive: true });
        outs[i] = await fsp.open(tmpName(t), 'w');
      } catch (e) { fail(i, e); }
    }));
    if (res.every((r) => !r.ok)) return res;
    const bufs = Array.from({ length: RING }, () => Buffer.allocUnsafe(CHUNK));
    const inflight = [];
    let pos = 0, k = 0;
    for (;;) {
      if (ctl.cancelled) throw new Error('CANCELLED');
      await waitIfPaused(ctl);
      if (ctl.cancelled) throw new Error('CANCELLED');
      if (k >= RING) await inflight[k - RING];          // le bloc k-RING doit être écrit partout avant de réutiliser son tampon
      const buf = bufs[k % RING];
      const { bytesRead: len } = await src.read(buf, 0, CHUNK, pos);
      if (!len) break;
      if (hasher) hasher.update(buf.subarray(0, len));
      const at = pos;
      const writes = [];
      for (let i = 0; i < n; i++) {
        if (!res[i].ok) continue;
        chain[i] = chain[i].then(async () => {
          if (!res[i].ok) return;
          try { await outs[i].write(buf, 0, len, at); } catch (e) { fail(i, e); }
        });
        writes.push(chain[i]);
      }
      inflight[k] = Promise.all(writes);
      pos += len; k++;
      onBytes(len);
      if (res.every((r) => !r.ok)) break;
    }
    await Promise.all(chain);
    await Promise.all(outs.map(async (o, i) => {
      if (!o || !res[i].ok) return;
      try { await o.sync(); } catch (e) { fail(i, e); }   // force l'écriture réelle sur le disque
    }));
  } finally {
    await Promise.allSettled(chain);
    await Promise.allSettled(outs.map((o) => o && o.close()));
    await src.close();
  }
  await Promise.all(targets.map((t, i) => (res[i].ok ? fsp.utimes(tmpName(t), f.mtime, f.mtime).catch(() => {}) : null)));
  return res;
}

// Donne le nom définitif (remplace un fichier existant) ; supprime le temporaire en cas d'échec de la copie
const finalize = (t) => fsp.rename(tmpName(t), t);
const dropTmp = (t) => fsp.rm(tmpName(t), { force: true }).catch(() => {});

// ---------- Boucle principale ----------
async function run({ source, destinations, subdir, verify, algo, onlyVideos }, ctl, emit) {
  const files = await scan(source, onlyVideos);
  const totalBytes = files.reduce((s, f) => s + f.size, 0);
  const work = totalBytes * (verify ? 1 + destinations.length : 1);
  const videosTotal = files.filter((f) => f.video).length;

  const t0 = Date.now();
  let done = 0, filesDone = 0, videosDone = 0, lastEmit = 0;
  let current = '', phase = 'copy';

  const tick = (force) => {
    const now = Date.now();
    if (!force && now - lastEmit < 150) return;
    lastEmit = now;
    const elapsed = (now - t0 - (ctl.pausedMs || 0)) / 1000;
    const speed = elapsed > 0 ? done / elapsed : 0;
    emit({
      percent: work > 0 ? Math.min(100, (done / work) * 100) : 100,
      phase, current, speed,
      etaSec: speed > 0 ? (work - done) / speed : null,
      filesDone, filesTotal: files.length,
      videosDone, videosTotal
    });
  };
  const onBytes = (n) => { done += n; tick(false); };

  // Phase 1 : copie de tous les fichiers (chaque fichier lu une fois, écrit sur toutes les destinations en parallèle)
  const recs = [];
  const cleanup = async () => {   // annulation : on ne laisse aucun fichier temporaire
    await Promise.all(recs.flatMap((r) => r.targets.map((t, i) => (r.final && r.final[i] ? null : dropTmp(t)))));
  };
  for (const f of files) {
    if (ctl.cancelled) break;
    current = f.rel;
    phase = 'copy';
    tick(true);

    const targets = destinations.map((d) => path.join(d, subdir, f.rel));
    const rec = {
      name: path.basename(f.rel), rel: f.rel, size: f.size, video: f.video,
      hash: null, dests: new Array(destinations.length).fill(null), ok: false, error: null, date: null,
      f, targets, copied: false, abs: f.abs, thumbable: isRealVideo(f.rel), final: new Array(destinations.length).fill(false)
    };
    recs.push(rec);
    try {
      const hasher = verify ? await createHasher(algo) : null;
      const res = await copyFile(f, targets, hasher, ctl, onBytes);
      rec.date = new Date().toISOString();
      // destinations dont l'écriture a échoué : résultat connu tout de suite, les autres continuent
      res.forEach((r, i) => { if (!r.ok) { rec.dests[i] = { dest: destinations[i], ok: false, error: r.error }; if (!rec.error) rec.error = r.error; dropTmp(targets[i]); } });
      rec.copied = res.some((r) => r.ok);
      if (rec.copied && verify) rec.hash = hasher.digest();
      if (!verify) {
        for (let i = 0; i < targets.length; i++) {
          if (!res[i].ok) continue;
          try {
            const st = await fsp.stat(tmpName(targets[i]));
            const ok = st.size === f.size;
            if (ok) { await finalize(targets[i]); rec.final[i] = true; }
            rec.dests[i] = ok ? { dest: destinations[i], ok } : { dest: destinations[i], ok, error: 'size' };
          } catch (e) { rec.dests[i] = { dest: destinations[i], ok: false, error: e.message }; if (!rec.error) rec.error = e.message; }
        }
        rec.ok = rec.dests.every((d) => d && d.ok);
      }
    } catch (e) {
      if (e.message === 'CANCELLED') { recs.pop(); await Promise.all(targets.map(dropTmp)); break; }
      // source illisible : le fichier échoue partout
      rec.ok = false; rec.copied = false;
      rec.error = e.message;
      rec.dests = destinations.map((d) => ({ dest: d, ok: false, error: e.message }));
      await Promise.all(targets.map(dropTmp));
    }
    if (!verify || !rec.copied) { filesDone++; if (f.video) videosDone++; }
    tick(true);
  }

  // Phase 2 : vérification, une fois TOUTES les copies terminées ; une relecture par destination, toutes en parallèle
  // Le fichier ne prend son nom définitif que s'il est vérifié.
  if (verify && !ctl.cancelled) {
    phase = 'verify';
    filesDone = recs.filter((r) => !r.copied).length;           // fichiers en échec de copie : déjà comptés
    videosDone = recs.filter((r) => !r.copied && r.video).length;
    tick(true);
    const todo = recs.filter((r) => r.copied);
    const left = new Map(todo.map((r) => [r, destinations.length]));
    const worker = async (i) => {
      for (const rec of todo) {
        if (ctl.cancelled) return;
        if (!rec.dests[i]) {   // destination encore à vérifier (sinon : échec d'écriture déjà enregistré)
          current = rec.rel;
          tick(true);
          try {
            const h = await hashFile(tmpName(rec.targets[i]), algo, ctl, onBytes);
            const ok = h === rec.hash;
            if (ok) { await finalize(rec.targets[i]); rec.final[i] = true; }
            rec.dests[i] = { dest: destinations[i], ok };
          } catch (e) {
            if (e.message === 'CANCELLED') return;
            rec.dests[i] = { dest: destinations[i], ok: false, error: e.message };
            if (!rec.error) rec.error = e.message;
          }
        }
        const n = left.get(rec) - 1;
        left.set(rec, n);
        if (n === 0) {
          rec.ok = rec.dests.every((d) => d && d.ok);
          filesDone++; if (rec.video) videosDone++;
          tick(true);
        }
      }
    };
    await Promise.all(destinations.map((_, i) => worker(i)));
  }
  if (ctl.cancelled) await cleanup();

  // Résultats : seuls les fichiers dont le traitement est complet (copie, puis vérification)
  const results = recs
    .filter((r) => !r.copied || !verify || r.dests.every((d) => d))
    .map(({ f, targets, copied, final, ...r }) => { r.dests = r.dests.filter(Boolean); return r; });
  if (!ctl.cancelled) { done = work; tick(true); }

  return {
    source, destinations, subdir, verify, algo: verify ? algo : null, onlyVideos,
    files: results, totalBytes, filesPlanned: files.length,
    cancelled: ctl.cancelled, startedAt: t0, endedAt: Date.now(), pausedMs: ctl.pausedMs || 0
  };
}

module.exports = { scan, run, isVideo, isRealVideo };
