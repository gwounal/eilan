'use strict';
const { BrowserWindow } = require('electron');
const fsp = require('fs').promises;
const path = require('path');
const os = require('os');

const I18N = require('./src/i18n');
const { analyzeMedia } = require('./thumbs');

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// Rapport dans la langue des réglages ; format : pdf | txt | md
function makeFmt(lang) {
  const t = (k, p) => I18N.t(lang, k, p);
  const loc = I18N.locale(lang);
  const dec = lang === 'en' ? '.' : ',';
  const units = lang === 'en' ? ['B', 'KB', 'MB', 'GB', 'TB'] : ['o', 'Ko', 'Mo', 'Go', 'To'];
  const bytes = (n) => {
    if (n < 1024) return `${n} ${units[0]}`;
    let i = 0;
    do { n /= 1024; i++; } while (n >= 1024 && i < units.length - 1);
    return `${n.toFixed(n >= 100 ? 0 : 1).replace('.', dec)} ${units[i]}`;
  };
  const date = (d) => { try { return new Date(d).toLocaleString(loc); } catch { return new Date(d).toLocaleString('fr-FR'); } };
  const duration = (ms) => {
    const sec = Math.round(ms / 1000);
    const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
    return h ? t('{h} h {m} min {s} s', { h, m, s }) : m ? t('{m} min {s} s', { m, s }) : t('{s} s', { s });
  };
  const num = (n, d = 3) => String(+n.toFixed(d)).replace('.', dec);
  const fps = (n) => `${num(n)} fps`;
  const khz = (hz) => `${num(hz / 1000, 3)} kHz`;
  return { t, bytes, date, duration, fps, khz };
}

// Format (codec, résolution) et fréquence (images/s pour une vidéo, kHz pour un son)
function tech(entry, f) {
  const i = entry && entry.info;
  if (!i) return { format: '', freq: '' };
  if (i.video) {
    const dim = i.video.width && i.video.height ? ` · ${i.video.width}×${i.video.height}` : '';
    return { format: i.video.label + dim, freq: i.video.fps ? f.fps(i.video.fps) : '' };
  }
  return { format: i.audio.label, freq: i.audio.hz ? f.khz(i.audio.hz) : '' };
}

function validation(r, verify, f) {
  if (r.error) return { cls: 'bad', text: f.t('Échec : {e}', { e: r.error }) };
  if (!r.ok) return { cls: 'bad', text: verify ? f.t('Non : hash différent') : f.t('Non : taille différente') };
  const n = r.dests.length;
  return verify
    ? { cls: 'ok', text: f.t('Oui ({n}/{n})', { n }) }
    : { cls: 'warn', text: f.t('Copiée, non vérifiée') };
}

// Données communes aux trois formats
function model(s, f, lang, infos = new Map()) {
  const videos = s.files.filter((x) => x.video);
  const okCount = s.files.filter((x) => x.ok).length;
  const others = s.files.length - videos.length;
  const algo = s.algo.toUpperCase();
  return {
    title: f.t('Rapport de copie') + (s.sourceName ? (lang === 'fr' ? ' : ' : ': ') + s.sourceName : ''),
    sub: f.t('{state} le {date}', { state: s.cancelled ? f.t('Copie interrompue par l’utilisateur') : f.t('Copie terminée'), date: f.date(s.endedAt) }),
    meta: [
      [f.t('Source'), s.source],
      [f.t('Destination(s)'), s.destinations],
      [f.t('Arborescence'), s.subdir || f.t('(racine de la destination)')],
      [f.t('Mode'), s.verify ? f.t('Copie avec vérification ({algo})', { algo }) : f.t('Copie simple')],
      [f.t('Début / durée'), `${f.date(s.startedAt)} / ${f.duration(s.endedAt - s.startedAt - (s.pausedMs || 0))}`],
      [f.t('Volume copié'), f.bytes(s.totalBytes)]
    ],
    summary: f.t('{n} fichier(s) média listé(s)', { n: videos.length }) + (others ? f.t(', {n} autre(s) fichier(s) copié(s)', { n: others }) : '') + '. ' +
      f.t(s.verify ? 'Fichiers validés : {ok} / {planned}.' : 'Fichiers copiés : {ok} / {planned}.', { ok: okCount, planned: s.filesPlanned }) +
      (s.files.length - okCount ? ' ' + f.t('Échecs : {n}.', { n: s.files.length - okCount }) : ''),
    head: [f.t('Nom'), f.t('Poids'), f.t('Copie validée'), f.t('Date')],
    thumbHead: f.t('Vignette'),
    techHead: [f.t('Format'), f.t('Fréquence')],
    hasTech: videos.some((r) => infos.get(r.rel) && infos.get(r.rel).info),
    rows: videos.map((r) => ({
      key: r.rel, name: r.name, ...tech(infos.get(r.rel), f), hash: s.verify && r.hash ? `${algo} ${r.hash}` : '',
      size: f.bytes(r.size), v: validation(r, s.verify, f), date: r.date ? f.date(r.date) : '-'
    })),
    none: f.t('Aucun fichier média.'), failed: s.files.length - okCount
  };
}

function buildHtml(s, lang, infos = new Map()) {
  const f = makeFmt(lang);
  const m = model(s, f, lang, infos);
  const thumbOf = (k) => infos.get(k) && infos.get(k).thumb;
  const withThumbs = [...infos.values()].some((e) => e.thumb);
  const withTech = m.hasTech;
  const cell = (r) => `<td class="th">${thumbOf(r.key) ? `<img src="data:image/jpeg;base64,${thumbOf(r.key).toString('base64')}">` : ''}</td>`;
  const rows = m.rows.map((r) => `<tr>
      ${withThumbs ? cell(r) : ''}
      <td><div class="name">${esc(r.name)}</div>${r.hash ? `<div class="hash">${esc(r.hash)}</div>` : ''}</td>
      ${withTech ? `<td>${esc(r.format)}</td><td class="num">${esc(r.freq)}</td>` : ''}
      <td class="num">${esc(r.size)}</td>
      <td class="${r.v.cls}">${esc(r.v.text)}</td>
      <td>${esc(r.date)}</td>
    </tr>`).join('');
  const meta = m.meta.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${Array.isArray(v) ? v.map(esc).join('<br>') : esc(v)}</dd>`).join('');
  return `<!doctype html><html lang="${lang === 'br' ? 'br' : lang}"><head><meta charset="utf-8"><style>
    body{font:11px/1.45 system-ui,"Segoe UI",Helvetica,Arial,sans-serif;color:#17252e;margin:0}
    h1{font-size:20px;margin:0 0 4px}
    .sub{color:#5b6b75;margin-bottom:16px}
    .meta{display:grid;grid-template-columns:140px 1fr;gap:3px 12px;margin-bottom:16px}
    .meta dt{color:#5b6b75}.meta dd{margin:0;word-break:break-all}
    .summary{padding:10px 12px;border:1px solid #cfd8de;margin-bottom:16px}
    table{width:100%;border-collapse:collapse}
    thead{display:table-header-group}
    th{text-align:left;border-bottom:2px solid #17252e;padding:6px 6px;font-weight:600}
    td{padding:6px;border-bottom:1px solid #dde4e8;vertical-align:top}
    tr{page-break-inside:avoid}
    .num{text-align:right;white-space:nowrap}
    .th{width:120px;padding-right:0}.th img{display:block;width:auto;max-width:112px;max-height:66px;border-radius:3px;border:1px solid #dde4e8}
    .name{font-weight:600;word-break:break-all}
    .hash{font:9px ui-monospace,Menlo,Consolas,monospace;color:#5b6b75}
    .ok{color:#2f7d4a;font-weight:600}.bad{color:#b3261e;font-weight:600}.warn{color:#8a5a00;font-weight:600}
  </style></head><body>
    <h1>${esc(m.title)}</h1>
    <div class="sub">${esc(m.sub)}</div>
    <dl class="meta">${meta}</dl>
    <div class="summary">${esc(m.summary)}</div>
    <table><thead><tr>${withThumbs ? `<th>${esc(m.thumbHead)}</th>` : ''}<th>${esc(m.head[0])}</th>${withTech ? `<th>${esc(m.techHead[0])}</th><th class="num">${esc(m.techHead[1])}</th>` : ''}<th class="num">${esc(m.head[1])}</th><th>${esc(m.head[2])}</th><th>${esc(m.head[3])}</th></tr></thead>
    <tbody>${rows || `<tr><td colspan="${4 + (withThumbs ? 1 : 0) + (withTech ? 2 : 0)}">${esc(m.none)}</td></tr>`}</tbody></table>
  </body></html>`;
}

const mdEsc = (x) => String(x).replace(/[|\\`*_]/g, (c) => '\\' + c).replace(/\r?\n/g, ' ');
function buildMarkdown(s, lang, thumbRel = new Map(), infos = new Map()) {
  const m = model(s, makeFmt(lang), lang, infos);
  const withThumbs = thumbRel.size > 0;
  const tc = m.hasTech;
  const out = [`# ${mdEsc(m.title)}`, '', `_${m.sub}_`, ''];
  for (const [k, v] of m.meta) {
    if (Array.isArray(v)) { out.push(`- **${k}**:`); v.forEach((d) => out.push(`  - \`${d}\``)); }
    else out.push(`- **${k}**: ${v}`);
  }
  out.push('', `> ${m.summary}`, '');
  const hd = [m.head[0], ...(tc ? m.techHead : []), ...m.head.slice(1)];
  out.push(`| ${withThumbs ? m.thumbHead + ' | ' : ''}${hd.join(' | ')} |`, `| ${withThumbs ? '--- | ' : ''}--- | ${tc ? '--- | ---: | ' : ''}---: | --- | --- |`);
  if (!m.rows.length) out.push(`| ${withThumbs ? ' | ' : ''}${m.none} |${' |'.repeat(hd.length - 1)}`);
  m.rows.forEach((r) => out.push(`| ${withThumbs ? (thumbRel.get(r.key) ? `![](${thumbRel.get(r.key)})` : '') + ' | ' : ''}${mdEsc(r.name)}${r.hash ? `<br>\`${r.hash}\`` : ''} | ${tc ? `${mdEsc(r.format)} | ${mdEsc(r.freq)} | ` : ''}${r.size} | ${mdEsc(r.v.text)} | ${r.date} |`));
  return out.join('\n') + '\n';
}

function buildText(s, lang, infos = new Map()) {
  const m = model(s, makeFmt(lang), lang, infos);
  const w = Math.max(...m.meta.map(([k]) => k.length)) + 2;
  const out = [m.title, '='.repeat(Math.min(72, m.title.length)), m.sub, ''];
  for (const [k, v] of m.meta) {
    const lines = Array.isArray(v) ? v : [v];
    lines.forEach((l, i) => out.push((i ? '' : k).padEnd(w) + l));
  }
  out.push('', m.summary, '');
  m.rows.forEach((r, i) => {
    out.push(`${String(i + 1).padStart(3)}. ${r.name}`);
    if (r.format || r.freq) out.push(`     ${m.techHead[0]}: ${r.format || '-'} | ${m.techHead[1]}: ${r.freq || '-'}`);
    out.push(`     ${m.head[1]}: ${r.size} | ${m.head[2]}: ${r.v.text} | ${m.head[3]}: ${r.date}`);
    if (r.hash) out.push(`     ${r.hash}`);
  });
  if (!m.rows.length) out.push(m.none);
  return out.join('\n') + '\n';
}

async function makePdf(html) {
  const tmp = path.join(os.tmpdir(), `eilan-${Date.now()}.html`);
  await fsp.writeFile(tmp, html, 'utf8');
  const w = new BrowserWindow({ show: false });
  try {
    await w.loadFile(tmp);
    return await w.webContents.printToPDF({ pageSize: 'A4', printBackground: true });
  } finally {
    w.destroy();
    fsp.unlink(tmp).catch(() => {});
  }
}

async function writeReports(summary, { lang = 'fr', format = 'pdf', thumbnails = true } = {}) {
  const ext = ['pdf', 'txt', 'md'].includes(format) ? format : 'pdf';
  const d = new Date(summary.endedAt);
  const p2 = (n) => String(n).padStart(2, '0');
  const stamp = `${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}_${p2(d.getHours())}${p2(d.getMinutes())}${p2(d.getSeconds())}`;
  const tag = summary.sourceName ? summary.sourceName.replace(/[^\p{L}\p{N}-]+/gu, '_') + '_' : '';
  const prefix = I18N.t(lang, 'Rapport_copie');
  const base = `${prefix}_${tag}${stamp}`;

  // analyse des médias (format, fréquence) et vignettes (PDF et Markdown), à partir de la source
  let infos = new Map();
  {
    const items = summary.files.filter((x) => x.video && x.abs).map((x) => ({ key: x.rel, file: x.abs, thumb: thumbnails && ext !== 'txt' && !!x.thumbable }));
    try { infos = await analyzeMedia(items); } catch { infos = new Map(); }
  }
  const thumbs = new Map([...infos].filter(([, e]) => e.thumb).map(([k, e]) => [k, e.thumb]));
  const thumbDir = `${base}_${I18N.t(lang, 'vignettes')}`;
  const thumbRel = new Map([...thumbs.keys()].map((k, i) => [k, `${thumbDir}/${String(i + 1).padStart(4, '0')}.jpg`]));

  const data = ext === 'pdf' ? await makePdf(buildHtml(summary, lang, infos))
    : ext === 'md' ? buildMarkdown(summary, lang, thumbRel, infos) : buildText(summary, lang, infos);
  const out = [];
  for (const dest of summary.destinations) {
    const p = path.join(dest, `${base}.${ext}`);
    try {
      if (ext === 'md' && thumbs.size) {
        await fsp.mkdir(path.join(dest, thumbDir), { recursive: true });
        for (const [k, buf] of thumbs) await fsp.writeFile(path.join(dest, thumbRel.get(k)), buf);
      }
      await fsp.writeFile(p, data, ext === 'pdf' ? undefined : 'utf8'); out.push(p);
    } catch { /* destination non inscriptible */ }
  }
  return out;
}

module.exports = { writeReports, buildHtml };
