'use strict';
const $ = (id) => document.getElementById(id);
// Langue de l'interface (réglage) : t('texte français', { param }) renvoie le texte dans la langue choisie
let LANG = 'fr';
const t = (k, p) => I18N.t(LANG, k, p);

// Textes statiques de la page : on mémorise le français d'origine pour pouvoir changer de langue à chaud
const STATIC_TEXT = [];
(function collectStatic() {
  const walker = document.createTreeWalker(document.documentElement, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT, {
    acceptNode: (n) => (n.nodeType === 1 && /^(SCRIPT|STYLE)$/.test(n.tagName) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT)
  });
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    if (n.nodeType === 3) { const fr = n.nodeValue.trim(); if (fr && /\p{L}/u.test(fr)) STATIC_TEXT.push({ node: n, fr, raw: n.nodeValue }); }
    else for (const attr of ['title', 'placeholder', 'aria-label']) {
      const fr = n.getAttribute(attr);
      if (fr) STATIC_TEXT.push({ node: n, attr, fr });
    }
  }
})();
function applyStatic() {
  for (const it of STATIC_TEXT) {
    const tr = t(it.fr);
    if (it.attr) it.node.setAttribute(it.attr, tr);
    else it.node.nodeValue = it.raw.replace(it.fr, () => tr);
  }
  document.documentElement.lang = LANG;
}
const MC_TYPE = 'application/x-mediacopy-source';
const MC_PRESET = 'application/x-mediacopy-preset';
const MC_LEVEL = 'application/x-mediacopy-level';
const PALETTE = ['#d9a441', '#4cc3a8', '#6ea0e0', '#9b8bd6', '#e5706b', '#6fbf73', '#d98ab0', '#b5bd5a'];
const state = {
  volumes: [],            // supports détectés
  sources: [],            // sources déposées {path,label,kind,size,info,error,tok}
  dests: [], missing: new Set(), free: {}, paused: false, phase: null,
  presets: [], currentPreset: '', structure: '{source}', selected: new Set(),   // selected = presets cochés pour suppression
  card: { auto: false, prefix: 'A', pad: 3, next: 1 }, day: 1,
  queue: [], history: [], queueRunning: false, current: null, runDone: 0
};
let idCounter = 0;
const newId = () => `${Date.now()}-${++idCounter}`;

function fmtBytes(n) {
  const u = LANG === 'en' ? ['B', 'KB', 'MB', 'GB', 'TB'] : ['o', 'Ko', 'Mo', 'Go', 'To'];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(i > 1 && n < 100 ? 1 : 0).replace('.', LANG === 'en' ? '.' : ',')} ${u[i]}`;
}
function fmtTime(s) {
  if (s == null || !isFinite(s)) return '--:--';
  s = Math.round(s);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
  const p = (x) => String(x).padStart(2, '0');
  return h ? `${h}:${p(m)}:${p(r)}` : `${p(m)}:${p(r)}`;
}
function fmtDate(ms) {
  const opts = { dateStyle: 'short', timeStyle: 'short' };
  try { return new Date(ms).toLocaleString(I18N.locale(LANG), opts); } catch { return new Date(ms).toLocaleString('fr-FR', opts); }
}
const verifMode = () => $('verif').value; // none | xxh64 | md5
const copyOpts = () => ({ verify: verifMode() !== 'none', algo: verifMode() === 'md5' ? 'md5' : 'xxh64' });
const lastSegment = (p) => p.split(/[\\/]/).filter(Boolean).pop() || p;
function h(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

// ---------- Nom de la copie (identifiant) et arborescence ----------
// Identifiant vide : nom du support (ou du dossier). Plusieurs sources : identifiant_nomDeLaSource.
function nameFor(s, total) {
  const id = $('offload-id').value.trim().replace(/[\\/]+/g, '-');
  if (!id) return s.kind === 'volume' ? s.label : null;
  return total > 1 ? `${id}_${s.label}` : id;
}
// Appareil / carte saisis sur chaque source ; la carte est par défaut le nom du support
const cleanSeg = (v) => String(v || '').replace(/[\\/]+/g, '-').trim();
// Numérotation automatique : préfixe + compteur du préréglage actif (A001, A002…). Le champ Carte saisi a la priorité.
const activePreset = () => state.presets.find((x) => x.name === state.currentPreset);
const cardName = (c, k = 0) => (c.prefix || '') + String((Number.isFinite(+c.next) ? +c.next : 1) + k).padStart(c.pad || 3, '0');
// Carte numérotée d'après les champs du formulaire de préréglage (aperçu en direct, avant enregistrement)
function modalCard(k = 0) {
  if (!$('m-card-auto').checked) return '';
  const pad = Math.min(6, Math.max(1, parseInt($('m-card-pad').value, 10) || 3));
  const n = Math.max(0, parseInt($('m-card-next').value, 10) || 0);
  return $('m-card-prefix').value.trim() + String(n + k).padStart(pad, '0');
}
function autoCard(k) { return state.card.auto ? cardName(state.card, k) : ''; }
// Jour de tournage {jour} : réglage du panneau Destination (enregistré dans le préréglage actif)
const curDay = () => state.day || 1;
const varsFor = (s, name, auto) => ({ jour: curDay(), appareil: cleanSeg(s && s.device), carte: cleanSeg(s && s.card) || auto || name || (s && s.label) || '' });
function subdirParts(tpl, source, label, vars = {}) {
  const now = new Date();
  const p = (n) => String(n).padStart(2, '0');
  const date = `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`;
  const heure = `${p(now.getHours())}-${p(now.getMinutes())}-${p(now.getSeconds())}`;
  const name = label || (source ? lastSegment(source) : 'Source');
  return tpl.replaceAll('{source}', name).replaceAll('{date}', date).replaceAll('{heure}', heure)
    .replaceAll('{AAAA}', String(now.getFullYear())).replaceAll('{MM}', p(now.getMonth() + 1)).replaceAll('{JJ}', p(now.getDate())).replaceAll('{jour}', String(vars.jour || curDay()))
    .replaceAll('{appareil}', vars.appareil || '').replaceAll('{carte}', vars.carte || name)
    .split(/[\\/]+/).map((s) => s.trim()).filter((s) => s && s !== '.' && s !== '..');
}
// Aperçu de l'arborescence (modal d'édition d'un préréglage)
function previewFor(dest0, structure, forModal = false) {
  const card0 = forModal ? modalCard(0) : autoCard(0);
  const dest = dest0 || '/destination';
  const sep = dest.includes('\\') ? '\\' : '/';
  const s0 = state.sources[0];
  const parts = [dest.replace(/[\\/]+$/, ''),
    ...subdirParts(structure, s0 && s0.path, s0 ? nameFor(s0, state.sources.length) : null,
      s0 ? varsFor(s0, s0.label, card0) : { appareil: 'CAM-A', carte: card0 || 'A001' }), 'fichier.mov'];
  return t('Exemple : {path}', { path: parts.join(sep) });
}
// Arborescence à venir (première source ; valeurs d'exemple si aucune source) : affichée sous chaque destination
function upcomingParts(structure) {
  const s0 = state.sources[0];
  return subdirParts(structure, s0 && s0.path, s0 ? nameFor(s0, state.sources.length) : null,
    s0 ? varsFor(s0, s0.label, autoCard(0)) : { appareil: 'CAM-A', carte: autoCard(0) || 'A001' });
}
function renderUpcoming() {
  const parts = upcomingParts(state.structure);
  const txt = parts.length ? parts.join(' / ') : t('(racine de la destination)');
  const more = state.sources.length > 1 ? ' · ' + t('+{n} autres sources', { n: state.sources.length - 1 }) : '';
  document.querySelectorAll('#dest-list .dest-tree').forEach((el) => { el.textContent = '↳ ' + txt + more; });
}
function updatePreview() {
  renderUpcoming();
  renderCounter();
  if (draft && modal.open) $('m-structure-preview').textContent = previewFor(draft.dests[0], $('m-structure').value, true);
}
$('offload-id').oninput = updatePreview;

// ---------- Glisser-déposer ----------
function wireDrop(zone, accepts, onDrop) {
  let depth = 0;
  const ok = (e) => [...e.dataTransfer.types].some(accepts);
  zone.addEventListener('dragenter', (e) => { if (!ok(e)) return; e.preventDefault(); depth++; zone.classList.add('dragover'); });
  zone.addEventListener('dragover', (e) => { if (!ok(e)) return; e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; });
  zone.addEventListener('dragleave', () => { depth = Math.max(0, depth - 1); if (!depth) zone.classList.remove('dragover'); });
  zone.addEventListener('drop', (e) => {
    if (!ok(e)) return;
    e.preventDefault(); depth = 0; zone.classList.remove('dragover');
    onDrop(e.dataTransfer);
  });
}
// Empêche Electron d'ouvrir un fichier déposé en dehors des zones
document.addEventListener('dragover', (e) => { if (!e.defaultPrevented) { e.preventDefault(); e.dataTransfer.dropEffect = 'none'; } });
document.addEventListener('drop', (e) => e.preventDefault());

async function foldersFrom(dt) {
  const paths = [...dt.files].map((f) => window.api.pathForFile(f)).filter(Boolean); // synchrone
  if (!paths.length) return [];
  const isDir = await window.api.pathsExist(paths);
  return paths.filter((_, i) => isDir[i]);
}

// ---------- Médias connectés ----------
function renderVolumes() {
  const box = $('vol-list');
  box.innerHTML = '';
  state.volumes.forEach((v) => {
    const b = h('button', 'vol' + (state.sources.some((s) => s.path === v.path) ? ' selected' : ''));
    b.type = 'button';
    b.draggable = true;
    b.title = t('Glisser vers la zone centrale (ou cliquer)');
    const meta = h('span', 'meta');
    meta.append(h('strong', '', v.label), h('small', '', v.path));
    b.append(meta, h('span', 'size', fmtBytes(v.size)));
    b.ondragstart = (e) => {
      e.dataTransfer.setData(MC_TYPE, JSON.stringify(v));
      e.dataTransfer.effectAllowed = 'copy';
    };
    b.onclick = () => addSource({ ...v, kind: 'volume' });
    box.append(b);
  });
  $('vol-empty').hidden = state.volumes.length > 0;
}

let lastVolumes = '';
async function refreshVolumes() {
  let list = [];
  try { list = await window.api.listVolumes(); } catch { /* ignoré */ }
  const key = JSON.stringify(list);
  if (key === lastVolumes) return;
  lastVolumes = key;
  state.volumes = list;
  renderVolumes();
  renderSources();
}
$('refresh-vols').onclick = () => { lastVolumes = ''; refreshVolumes(); };
window.addEventListener('focus', refreshVolumes);
setInterval(refreshVolumes, 4000);

// ---------- Sources déposées ----------
let srcTimer;
function setSrcStatus(text) {
  $('src-status').textContent = text;
  clearTimeout(srcTimer);
  if (text) srcTimer = setTimeout(() => { $('src-status').textContent = ''; }, 5000);
}
const isGone = (s) => s.kind === 'volume' && !state.volumes.some((v) => v.path === s.path);

// Déjà copiée ? D'après l'historique : même chemin, mêmes nombre de fichiers et poids, copie terminée sans échec.
// Les destinations ne sont pas revérifiées : c'est une indication, pas une garantie.
function copiedEntry(s) {
  if (!s.info) return null;
  const only = $('only-videos').checked;
  return state.history.find((x) => x.status === 'done' && x.opts.source === s.path && !!x.opts.onlyVideos === only &&
    x.info && x.info.count === s.info.count && x.info.bytes === s.info.bytes) || null;
}

function renderSources() {
  const known = new Set([...state.sources.map((x) => x.device), ...state.queue.map((t) => t.opts && t.opts.appareil),
    ...state.history.map((t) => t.opts && t.opts.appareil)].filter(Boolean));
  $('devices-list').replaceChildren(...[...known].map((d) => { const o = document.createElement('option'); o.value = d; return o; }));
  const ul = $('src-list');
  ul.innerHTML = '';
  let autoIdx = 0;   // les sources sans carte saisie se partagent les numéros à la suite
  state.sources.forEach((s) => {
    const auto = !cleanSeg(s.card) ? autoCard(autoIdx++) : '';
    const li = h('li', isGone(s) ? 'gone' : '');
    const meta = h('div', 'meta');
    meta.append(h('strong', '', s.label), h('small', '', s.path));
    if (isGone(s)) meta.append(h('small', 'bad', t('Support retiré : rebranchez-le ou retirez-le')));
    else if (s.error) meta.append(h('small', 'bad', t('Lecture impossible : {e}', { e: s.error })));
    else if (!s.info) meta.append(h('small', '', t('Analyse en cours…')));
    else {
      meta.append(h('small', '', t('{count} fichier(s) · {videos} média(s) · {size}', { count: s.info.count, videos: s.info.videos, size: fmtBytes(s.info.bytes) })));
      const e = copiedEntry(s);
      if (!e) meta.append(h('small', '', t('Pas encore copiée')));
      else {
        const n = e.opts.destinations.length;
        meta.append(h('small', e.opts.verify ? 'okline' : 'warnline',
          t('{status} · {n} destination(s) · {date}', {
            status: t(e.opts.verify ? 'Déjà copiée et vérifiée' : 'Déjà copiée, sans vérification'), n, date: fmtDate(e.endedAt) })));
      }
    }
    const usesDev = /\{appareil\}/.test(state.structure);
    if (usesDev && !cleanSeg(s.device)) meta.append(h('small', 'warnline', t('Appareil non renseigné : ce niveau sera ignoré')));
    const rm = h('button', 'rm', '×');
    rm.type = 'button'; rm.title = t('Retirer cette source'); rm.setAttribute('aria-label', t('Retirer {s}', { s: s.label }));
    rm.onclick = () => { state.sources = state.sources.filter((x) => x !== s); checkMissing().then(renderSources); renderSources(); updatePreview(); };
    li.append(meta, rm);
    const ids = h('div', 'src-ids');
    const mk = (ph, key, list) => {
      const inp = document.createElement('input');
      inp.type = 'text'; inp.placeholder = ph; inp.value = s[key] || ''; inp.spellcheck = false;
      inp.setAttribute('aria-label', t('{ph} pour {s}', { ph, s: s.label }));
      if (list) inp.setAttribute('list', list);
      inp.oninput = () => { s[key] = inp.value; updatePreview(); };
      return inp;
    };
    ids.append(mk(t('Appareil (ex. CAM-A)'), 'device', 'devices-list'), mk(auto ? t('Carte : {auto} (auto)', { auto }) : t('Carte (défaut : {label})', { label: s.label }), 'card'));
    li.append(ids);
    ul.append(li);
  });
  $('dropzone').classList.toggle('compact', state.sources.length > 0);
  $('src-clear').hidden = state.sources.length < 2;
  const ready = state.sources.filter((s) => s.info);
  $('src-total').textContent = ready.length && ready.length === state.sources.length
    ? t('{n} source(s) · {v} média(s) · {size}', { n: state.sources.length, v: ready.reduce((a, s) => a + s.info.videos, 0), size: fmtBytes(ready.reduce((a, s) => a + s.info.bytes, 0)) })
    : '';
  renderDests();   // met à jour l'espace libre / besoin
  renderVolumes();
  refresh();
}

async function scanSrc(s) {
  const tok = (s.tok = (s.tok || 0) + 1);
  s.info = null; s.error = null;
  renderSources();
  try {
    const info = await window.api.scan(s.path, $('only-videos').checked);
    if (s.tok === tok) s.info = info;
  } catch (e) {
    if (s.tok === tok) s.error = e.message;
  }
  if (s.tok === tok) renderSources();
}
const rescanAll = () => state.sources.forEach(scanSrc);

function addSource(entry) {
  if (state.sources.some((s) => s.path === entry.path)) return false;
  const s = {
    path: entry.path, label: entry.label || lastSegment(entry.path),
    kind: entry.kind || 'folder', size: entry.size || 0, device: '', card: '', info: null, error: null, tok: 0
  };
  state.sources.push(s);
  updatePreview();
  scanSrc(s);
  return true;
}

wireDrop($('source-zone'), (t) => t === MC_TYPE || t === 'Files', async (dt) => {
  const internal = dt.getData(MC_TYPE);
  if (internal) {
    try { addSource({ ...JSON.parse(internal), kind: 'volume' }); } catch { /* ignoré */ }
    return;
  }
  const dirs = await foldersFrom(dt);
  if (!dirs.length) { setSrcStatus(t('Seuls les dossiers et supports peuvent être déposés.')); return; }
  dirs.forEach((p) => addSource({ path: p, kind: 'folder' }));
});

$('pick-folder').onclick = async () => {
  const p = await window.api.pickSource();
  if (p) addSource({ path: p, kind: 'folder' });
};
$('src-clear').onclick = () => { state.sources = []; renderSources(); updatePreview(); };

// ---------- Zone Destination : preset déposé et/ou dossiers ajoutés à la main ----------
// Les destinations sont communes à toutes les cartes : elles viennent du préréglage (ou de la zone Destination)
const destsFor = () => state.dests;
const allDestPaths = () => [...state.dests];
async function checkMissing() {
  const paths = allDestPaths();
  if (!paths.length) { state.missing = new Set(); state.free = {}; return; }
  const [exists, free] = await Promise.all([window.api.pathsExist(paths), window.api.diskFree(paths)]);
  state.missing = new Set(paths.filter((_, i) => !exists[i]));
  state.free = Object.fromEntries(paths.map((p, i) => [p, free[i]]));
}
// octets à écrire sur une destination : cartes déposées + copies en attente
function neededFor(d) {
  const a = state.sources.filter((s) => s.info && destsFor(s).includes(d)).reduce((n, s) => n + s.info.bytes, 0);
  const b = state.queue.filter((t) => t.status === 'pending' && t.opts.destinations.includes(d)).reduce((n, t) => n + t.info.bytes, 0);
  return a + b;
}
function freeTag(d) {
  const f = state.free[d];
  if (f == null) return h('small', 'free', '');
  const need = neededFor(d);
  const bad = need > f;
  return h('small', 'free' + (bad ? ' bad' : ''), bad ? t('{free} libres · il faut {need}', { free: fmtBytes(f), need: fmtBytes(need) }) : t('{free} libres', { free: fmtBytes(f) }));
}

// Un préréglage est une « recette » de destination et de copie. Son arborescence et sa numérotation se règlent dans sa fenêtre
// (crayon) ou en modifiant le chemin complet d'une destination. « modifié » = destinations, arborescence, vérification ou option médias changées depuis.
// Les prochains numéros (carte, jour) avancent seuls : enregistrés à part, ils ne rendent pas le préréglage « modifié ».
const verifOf = (p) => (p.mode === 'simple' ? 'none' : (p.algo === 'md5' ? 'md5' : 'xxh64'));   // compatible avec les anciens presets
const cardOf = (p) => ({ auto: !!p.cardAuto, prefix: p.cardPrefix ?? 'A', pad: p.cardPad || 3 });
function presetDirty(p) {
  return JSON.stringify(p.destinations) !== JSON.stringify(state.dests) || (p.structure ?? '{source}') !== state.structure || verifOf(p) !== verifMode() || !!p.onlyVideos !== $('only-videos').checked;
}
// Réglages de copie du panneau, sous forme de champs de préréglage
function currentCopyFields() {
  const v = verifMode();
  return { destinations: [...state.dests], structure: state.structure, mode: v === 'none' ? 'simple' : 'verify', algo: v === 'md5' ? 'md5' : 'xxh64', onlyVideos: $('only-videos').checked };
}

async function savePresetFields(p, fields) {
  state.presets = await window.api.presetsSave({ ...p, ...fields });
}
// Les prochains numéros suivent le préréglage actif sans le marquer « modifié »
async function persistCounters() {
  const p = activePreset();
  if (p) await savePresetFields(p, { cardNext: state.card.next, dayNext: curDay() });
}
async function bumpCounter(n) { state.card.next = (Number.isFinite(+state.card.next) ? +state.card.next : 1) + n; await persistCounters(); renderCounter(); }

// Bloc « Tournage » (zone Destination) : jour et prochaine carte du préréglage actif ; visible si son arborescence / sa numérotation les utilisent.
// Sans preset : arborescence {source}, pas de numérotation.
const usesTok = (tok) => (state.structure || '').includes(tok);
function renderCounter() {
  const k = state.card, onC = !!k.auto && usesTok('{carte}'), onD = usesTok('{jour}');
  $('shoot-box').hidden = !(onC || onD);
  $('day-counter').hidden = !onD;
  $('card-counter').hidden = !onC;
  if (onD && document.activeElement !== $('day-next')) $('day-next').value = curDay();
  if (!onC) return;
  if (document.activeElement !== $('card-next')) $('card-next').value = k.next;
  $('card-next-name').textContent = cardName(k);
}
$('card-next').onchange = async () => {
  state.card.next = Math.min(999999, Math.max(0, parseInt($('card-next').value, 10) || 0));
  await persistCounters(); renderCounter(); renderSources(); updatePreview();
};
$('card-reset').onclick = async () => { state.card.next = 1; await persistCounters(); renderCounter(); renderSources(); updatePreview(); };
async function setDay(n) {
  state.day = Math.min(9999, Math.max(1, parseInt(n, 10) || 1));
  await persistCounters();
  renderCounter(); renderSources(); updatePreview();
}
$('day-next').onchange = () => setDay($('day-next').value);
$('day-minus').onclick = () => setDay(curDay() - 1);
$('day-plus').onclick = () => setDay(curDay() + 1);

let destSel = new Set();   // destinations cochées (pour suppression groupée)
function updateDestDelete() {
  const n = destSel.size;
  $('dest-delete').hidden = n === 0;
  $('dest-delete').textContent = t('Supprimer ({n})', { n });
}
$('dest-delete').onclick = async () => {
  state.dests = state.dests.filter((d) => !destSel.has(d));
  destSel.forEach((d) => state.missing.delete(d));
  destSel = new Set();
  renderDests();
};
// Modification d'une destination : le champ contient le chemin complet avec l'arborescence (ex. /Volumes/RAID/{date}/{appareil}/{carte}).
// Le chemin de destination est ce qui précède le premier niveau contenant une variable { } ; le reste est l'arborescence.
const joinTree = (dest, structure, sep) => [dest.replace(/[\\/]+$/, ''), ...(structure || '').split(/[\\/]+/).map((x) => x.trim()).filter(Boolean)].join(sep);
function splitFullPath(v) {
  const toks = v.trim().split(/([\\/]+)/);
  const k = toks.findIndex((x, n) => n % 2 === 0 && x.includes('{'));
  if (k < 0) return { dest: v.trim().replace(/(.)[\\/]+$/, '$1'), structure: '' };
  return {
    dest: toks.slice(0, k).join('').replace(/(.)[\\/]+$/, '$1'),
    structure: toks.slice(k).join('').split(/[\\/]+/).map((x) => x.trim()).filter(Boolean).join('/')
  };
}
function editDest(li, i) {
  const old = state.dests[i];
  const sep = old.includes('\\') ? '\\' : '/';
  const initial = joinTree(old, state.structure, sep);
  li.innerHTML = '';
  const input = document.createElement('input');
  input.type = 'text'; input.className = 'dest-edit'; input.value = initial; input.spellcheck = false;
  input.title = t('Chemin de destination suivi de l’arborescence (variables entre accolades)');
  input.setAttribute('aria-label', t('Chemin de la destination'));
  const browse = h('button', 'btn small', '…');
  browse.type = 'button'; browse.title = t('Choisir un dossier');
  browse.onmousedown = (e) => e.preventDefault();
  browse.onclick = async () => { const r = await window.api.pickDestinations(); if (r && r[0]) { input.value = joinTree(r[0], splitFullPath(input.value).structure, sep); input.focus(); } };
  let done = false;
  const finish = async (commit) => {
    if (done) return; done = true;
    const v = input.value.trim();
    if (commit && v && v !== initial) {
      const { dest, structure } = splitFullPath(v);
      if (dest && dest !== old) {
        const dup = state.dests.findIndex((d, k) => d === dest && k !== i);
        state.dests[i] = dest;
        if (dup >= 0) state.dests.splice(dup, 1);
        state.missing.delete(old); destSel.delete(old);
        await checkMissing();
      }
      if (structure) state.structure = structure;   // commune à toutes les destinations ; sans variable saisie, elle ne change pas
    }
    renderDests();
  };
  input.onkeydown = (e) => { if (e.key === 'Enter') finish(true); else if (e.key === 'Escape') finish(false); };
  input.onblur = () => setTimeout(() => finish(true), 120);
  li.append(input, browse);
  input.focus(); input.select();
}

// Menu du préréglage actif : liste des préréglages, le préréglage actuel est mis en évidence
function closePresetMenu() { const m = $('preset-menu'); if (m) { m.hidden = true; const b = document.querySelector('#dest-chip .chip-main'); if (b) b.setAttribute('aria-expanded', 'false'); } }
function togglePresetMenu() {
  const m = $('preset-menu');
  if (!m.hidden) { closePresetMenu(); return; }
  m.innerHTML = '';
  state.presets.forEach((p) => {
    const li = h('li', 'pm-item' + (p.name === state.currentPreset ? ' pm-current' : ''));
    li.setAttribute('role', 'option'); li.setAttribute('aria-selected', String(p.name === state.currentPreset));
    li.tabIndex = 0;
    const sw = h('span', 'swatch'); sw.style.background = p.color || PALETTE[0];
    li.append(sw, h('span', 'pm-name', p.name));
    if (p.name === state.currentPreset) li.append(h('span', 'tick', '✓'));
    const pick = async () => {
      closePresetMenu();
      if (p.name === state.currentPreset) return;
      const ap = activePreset();
      if (ap && presetDirty(ap) && !window.confirm(t('Abandonner les modifications non enregistrées de « {n} » ?', { n: ap.name }))) return;
      await applyPreset(p.name);
    };
    li.onclick = pick;
    li.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pick(); } else if (e.key === 'Escape') closePresetMenu(); };
    m.append(li);
  });
  m.hidden = false;
  const b = document.querySelector('#dest-chip .chip-main'); if (b) b.setAttribute('aria-expanded', 'true');
  (m.querySelector('.pm-current') || m.firstElementChild)?.focus();
}
document.addEventListener('click', (e) => { if (!e.target.closest('#preset-menu')) closePresetMenu(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closePresetMenu(); });

function renderDests() {
  renderCounter();
  const chip = $('dest-chip');
  const preset = state.presets.find((x) => x.name === state.currentPreset);
  chip.hidden = !preset;
  chip.innerHTML = '';
  if (preset) {
    const sw = h('span', 'swatch');
    sw.style.background = preset.color || PALETTE[0];
    const btn = h('button', 'chip-main');
    btn.type = 'button';
    btn.title = t('Changer de préréglage');
    btn.setAttribute('aria-haspopup', 'listbox'); btn.setAttribute('aria-expanded', String(!$('preset-menu').hidden));
    btn.append(sw, h('strong', '', preset.name), h('span', 'caret', '▾'));
    btn.onclick = (e) => { e.stopPropagation(); togglePresetMenu(); };
    chip.append(btn);
    if (presetDirty(preset)) chip.append(h('small', '', t('modifié')));
  } else closePresetMenu();

  const ul = $('dest-list');
  ul.innerHTML = '';
  destSel = new Set([...destSel].filter((d) => state.dests.includes(d)));
  state.dests.forEach((d, i) => {
    const li = h('li', (state.missing.has(d) ? 'missing' : '') + (destSel.has(d) ? ' picked' : ''));
    const cb = document.createElement('input');
    cb.type = 'checkbox'; cb.checked = destSel.has(d);
    cb.setAttribute('aria-label', t('Sélectionner {n} pour suppression', { n: d }));
    cb.onchange = () => { if (cb.checked) destSel.add(d); else destSel.delete(d); li.classList.toggle('picked', cb.checked); updateDestDelete(); };
    li.append(cb, h('span', 'dpath', d), freeTag(d));
    if (state.missing.has(d)) li.append(h('span', 'badge', t('introuvable')));
    const pen = h('button', 'pencil', '✎');
    pen.type = 'button'; pen.title = t('Modifier cette destination'); pen.setAttribute('aria-label', t('Modifier {n}', { n: d }));
    pen.onclick = () => editDest(li, i);
    li.append(pen);
    const rm = h('button', 'rm', '×');
    rm.type = 'button'; rm.title = t('Retirer cette destination'); rm.setAttribute('aria-label', t('Retirer {d}', { d }));
    rm.onclick = () => { state.missing.delete(d); state.dests.splice(i, 1); renderDests(); };
    li.append(rm);
    li.append(h('span', 'dest-tree', ''));
    ul.append(li);
  });
  $('dest-empty').classList.toggle('compact', state.dests.length > 0);
  $('dest-clear').hidden = state.dests.length === 0;
  const ap = activePreset(), dirty = !!(ap && presetDirty(ap));
  // visible seulement s'il y a quelque chose à enregistrer : preset modifié, ou destinations sans preset
  $('preset-save-current').hidden = ap ? !dirty : state.dests.length === 0;
  const saveTip = dirty ? t('Enregistrer les modifications de « {n} »', { n: ap.name }) : t('Enregistrer sous un nouveau préréglage');
  $('preset-save-current').title = saveTip; $('preset-save-current').setAttribute('aria-label', saveTip);
  $('preset-save-current').classList.toggle('dirty', dirty);
  updateDestDelete();

  const warns = [];
  const gone = state.dests.filter((d) => state.missing.has(d));
  if (gone.length) warns.push(t('Destination introuvable : {list}. Branchez le disque ou retirez-la.', { list: gone.join(', ') }));
  const full = state.dests.filter((d) => state.free[d] != null && neededFor(d) > state.free[d]);
  if (full.length) warns.push(t('Espace insuffisant sur {list}.', { list: full.join(', ') }));
  $('dest-warn').textContent = warns.join(' ');
  $('dest-warn').hidden = warns.length === 0;

  updatePreview();
  refresh();
}

async function addDests(list) {
  for (const p of list) if (!state.dests.includes(p)) state.dests.push(p);
  await checkMissing();
  renderDests();
}
$('add-dest').onclick = async () => addDests(await window.api.pickDestinations());
// Boutons d'insertion de variables + modèle « date / appareil / carte »
let levelEditor = null;   // champ de saisie de la pastille en cours de modification (s'il y en a une)
function wireTokens(box, input) {
  const add = (label, text, title, replace) => {
    const b = h('button', 'chip-btn', label);
    b.type = 'button'; b.title = t('{title} (cliquer, ou glisser dans la liste des niveaux)', { title });
    b.draggable = true;
    b.ondragstart = (e) => { e.dataTransfer.setData(MC_LEVEL, JSON.stringify({ token: text })); e.dataTransfer.effectAllowed = 'copy'; };
    // pendant l'édition d'une pastille, le bouton garde le focus dans le champ et insère la variable au curseur
    b.onmousedown = (e) => { if (levelEditor && levelEditor.isConnected) e.preventDefault(); };
    b.onclick = () => {
      if (levelEditor && levelEditor.isConnected && !replace) {
        levelEditor.setRangeText(text, levelEditor.selectionStart, levelEditor.selectionEnd, 'end');
        levelEditor.style.width = `${Math.max(6, levelEditor.value.length + 2)}ch`;
        levelEditor.focus();
        return;
      }
      const cur = input.value.trim();
      input.value = replace || !cur ? text : `${cur.replace(/\/+$/, '')}/${text}`;
      input.dispatchEvent(new Event('input'));
    };
    box.append(b);
  };
  add(t('Date / Appareil / Carte'), '{date}/{appareil}/{carte}', t('Modèle de tournage'), true);
  [['Date', '{date}'], ['AAAA', '{AAAA}'], ['MM', '{MM}'], ['JJ', '{JJ}'], ['Jour', '{jour}'], ['Appareil', '{appareil}'], ['Carte', '{carte}'], ['Source', '{source}']]
    .forEach(([l, tok]) => add(`+ ${t(l)}`, tok, t('Ajouter {t}', { t: tok }), false));
}
const renderTokens = () => {
  $('m-tokens').innerHTML = '';
  wireTokens($('m-tokens'), $('m-structure'));
};
renderTokens();

// Niveaux de dossiers : pastilles à réordonner par glisser-déposer (le champ texte reste la source de vérité)
const LEVEL_NAMES = { '{date}': 'Date', '{AAAA}': 'AAAA', '{MM}': 'MM', '{JJ}': 'JJ', '{jour}': 'Jour', '{appareil}': 'Appareil', '{carte}': 'Carte', '{source}': 'Source', '{heure}': 'Heure' };
// nom affiché d'un niveau : chaque variable est remplacée par son libellé (J1_{AAAA}_{MM} → J1_AAAA_MM)
const levelName = (seg) => seg.replace(/\{[A-Za-z]+\}/g, (m) => (LEVEL_NAMES[m] ? t(LEVEL_NAMES[m]) : m));
const hasToken = (seg) => /\{(date|AAAA|MM|JJ|jour|appareil|carte|source|heure)\}/.test(seg);
// contenu d'une pastille : texte en police fixe, variables en repères colorés
function levelContent(seg) {
  const box = h('span', 'lname');
  seg.split(/(\{[A-Za-z]+\})/).filter(Boolean).forEach((part) => {
    box.append(LEVEL_NAMES[part] ? h('span', 'tk', t(LEVEL_NAMES[part])) : h('span', 'tx', part));
  });
  return box;
}
const splitLevels = (v) => v.split(/[\\/]+/).map((x) => x.trim()).filter(Boolean);
function wireLevels(box, input) {
  let dragFrom = -1;
  const write = (segs) => { input.value = segs.join('/'); input.dispatchEvent(new Event('input')); };
  const clearMarks = () => box.querySelectorAll('.drop-before,.drop-after').forEach((n) => n.classList.remove('drop-before', 'drop-after'));
  const clean = (v) => v.replace(/[\\/]+/g, ' ').trim();   // saisie d'un nouveau niveau : « / » valide déjà le niveau
  let wantFocus = false;
  function render() {
    const segs = splitLevels(input.value);
    box.innerHTML = '';
    segs.forEach((seg, i) => {
      const li = h('span', 'level' + (LEVEL_NAMES[seg] ? ' token' : hasToken(seg) ? ' mixed' : ' custom'));
      li.draggable = true;
      li.dataset.i = String(i);
      li.title = t('Double-clic pour modifier');
      li.append(h('span', 'grip', '⋮⋮'), levelContent(seg));
      const x = h('button', 'lx', '×');
      x.type = 'button'; x.title = t('Retirer ce niveau'); x.setAttribute('aria-label', t('Retirer le niveau {n}', { n: levelName(seg) }));
      x.onclick = (e) => { e.preventDefault(); e.stopPropagation(); write(segs.filter((_, k) => k !== i)); };
      li.append(x);
      li.ondragstart = (e) => { dragFrom = i; e.dataTransfer.setData(MC_LEVEL, JSON.stringify({ from: i })); e.dataTransfer.effectAllowed = 'move'; li.classList.add('dragging'); };
      li.ondragend = () => { dragFrom = -1; li.classList.remove('dragging'); clearMarks(); };
      // double-clic : on modifie le niveau sur place (texte libre, variables, ou les deux : J1_{AAAA}_{MM}_{JJ})
      li.ondblclick = (e) => {
        if (e.target.closest('.lx') || li.querySelector('.level-edit')) return;
        const nm = li.querySelector('.lname');
        const ed = document.createElement('input');
        ed.type = 'text'; ed.className = 'level-edit'; ed.value = seg; ed.spellcheck = false;
        ed.style.width = `${Math.max(6, seg.length + 2)}ch`;
        ed.oninput = () => { ed.style.width = `${Math.max(6, ed.value.length + 2)}ch`; };
        li.draggable = false;
        nm.replaceWith(ed); ed.focus(); ed.select();
        levelEditor = ed;
        let done = false;
        const finish = (ok) => {
          if (done) return; done = true;
          if (levelEditor === ed) levelEditor = null;
          const v = ed.value.trim();
          const next = [...segs];
          if (ok && v) next[i] = v; else if (ok) next.splice(i, 1);
          write(next);
        };
        ed.onkeydown = (ev) => { if (ev.key === 'Enter') finish(true); else if (ev.key === 'Escape') finish(false); };
        ed.onblur = () => finish(true);
      };
      box.append(li);
    });
    // champ de saisie en fin de liste : texte libre → nouvelle pastille
    const typ = document.createElement('input');
    typ.type = 'text'; typ.className = 'level-input'; typ.spellcheck = false;
    typ.placeholder = segs.length ? t('Texte…') : t('Racine : tapez un nom de dossier ou ajoutez un niveau');
    typ.setAttribute('aria-label', t('Ajouter un niveau de texte libre'));
    let committed = false;
    const commit = () => {
      const v = clean(typ.value);
      if (!v || committed) return;
      committed = true; wantFocus = true;
      write([...splitLevels(input.value), v]);
    };
    typ.onkeydown = (e) => {
      if (e.key === 'Enter' || e.key === '/' || e.key === '\\') { e.preventDefault(); commit(); }
      else if (e.key === 'Backspace' && !typ.value) { const sg = splitLevels(input.value); if (sg.length) { wantFocus = true; write(sg.slice(0, -1)); } }
    };
    typ.onblur = commit;
    box.append(typ);
    if (wantFocus) { wantFocus = false; typ.focus(); }
  }
  box.addEventListener('click', (e) => { if (e.target === box) { const t = box.querySelector('.level-input'); if (t) t.focus(); } });
  const target = (e) => {
    const el = e.target.closest ? e.target.closest('.level') : null;
    if (!el || !box.contains(el)) return { idx: splitLevels(input.value).length, el: null, after: false };
    const r = el.getBoundingClientRect();
    const after = e.clientX > r.left + r.width / 2;
    return { idx: Number(el.dataset.i) + (after ? 1 : 0), el, after };
  };
  box.addEventListener('dragover', (e) => {
    if (!e.dataTransfer.types.includes(MC_LEVEL)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = dragFrom >= 0 ? 'move' : 'copy';
    clearMarks();
    const t = target(e);
    if (t.el) t.el.classList.add(t.after ? 'drop-after' : 'drop-before');
    else if (box.lastElementChild && box.lastElementChild.classList.contains('level')) box.lastElementChild.classList.add('drop-after');
  });
  box.addEventListener('dragleave', (e) => { if (!box.contains(e.relatedTarget)) clearMarks(); });
  box.addEventListener('drop', (e) => {
    const raw = e.dataTransfer.getData(MC_LEVEL);
    if (!raw) return;
    e.preventDefault(); e.stopPropagation();
    clearMarks();
    let data; try { data = JSON.parse(raw); } catch { return; }
    const segs = splitLevels(input.value);
    let { idx } = target(e);
    if (typeof data.from === 'number') {
      const [moved] = segs.splice(data.from, 1);
      if (data.from < idx) idx--;
      segs.splice(idx, 0, moved);
    } else if (data.token) segs.splice(idx, 0, data.token);
    dragFrom = -1;
    write(segs);
  });
  input.addEventListener('input', render);
  render();
  return render;
}
$('dest-clear').onclick = async () => {   // vide les destinations et désactive le préréglage (copie libre)
  state.dests = []; destSel = new Set(); noPreset();
  await checkMissing();
  renderPresetList();
  renderDests();
};
const renderMLevels = wireLevels($('m-levels'), $('m-structure'));
// on peut déposer ici un préréglage (glissé depuis la liste) ou des dossiers du Finder / de l'Explorateur
wireDrop($('dest-zone'), (t) => t === MC_PRESET || t === 'Files', async (dt) => {
  const raw = dt.getData(MC_PRESET);
  if (raw) { try { await applyPreset(JSON.parse(raw).name); } catch { /* ignoré */ } return; }
  const dirs = await foldersFrom(dt);
  if (dirs.length) addDests(dirs);
});

// ---------- Préréglages : liste (glisser vers Destination pour utiliser, cases pour supprimer, crayon pour modifier) ----------
let presetTimer;
function setStatus(text) {
  $('preset-status').textContent = text;
  clearTimeout(presetTimer);
  presetTimer = setTimeout(() => { $('preset-status').textContent = ''; }, 4000);
}

function renderPresetList() {
  state.selected = new Set([...state.selected].filter((n) => state.presets.some((p) => p.name === n)));
  const ul = $('preset-list');
  ul.innerHTML = '';
  state.presets.forEach((p) => {
    const li = h('li', 'preset');
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = state.selected.has(p.name);
    cb.setAttribute('aria-label', t('Sélectionner {n} pour suppression', { n: p.name }));
    cb.onchange = () => { if (cb.checked) state.selected.add(p.name); else state.selected.delete(p.name); li.classList.toggle('picked', cb.checked); refresh(); };
    li.classList.toggle('picked', cb.checked);

    const use = h('button', 'puse');
    use.type = 'button';
    use.draggable = true;
    use.title = t('Glisser vers Destination pour utiliser');
    const sw = h('span', 'swatch');
    sw.style.background = p.color || PALETTE[0];
    use.append(sw, h('span', 'pname', p.name));
    use.ondragstart = (e) => {
      e.dataTransfer.setData(MC_PRESET, JSON.stringify({ name: p.name }));
      e.dataTransfer.effectAllowed = 'copy';
    };

    const pen = h('button', 'pencil', '✎');
    pen.type = 'button'; pen.title = t('Modifier ce préréglage'); pen.setAttribute('aria-label', t('Modifier {n}', { n: p.name }));
    pen.onclick = () => openModal(p);
    li.append(cb, use, pen);
    ul.append(li);
  });
  $('preset-empty').hidden = state.presets.length > 0;
  refresh();
}

// Sans preset actif : copie « libre », arborescence {source}, pas de numérotation
function noPreset() {
  state.currentPreset = ''; state.structure = '{source}';
  state.card = { auto: false, prefix: 'A', pad: 3, next: 1 }; state.day = 1;
}
async function applyPreset(name) {
  const p = state.presets.find((x) => x.name === name);
  if (!p) return;
  state.currentPreset = p.name;
  state.dests = [...p.destinations];                      // le préréglage remplace le contenu de la zone Destination
  state.structure = p.structure ?? '{source}';
  $('verif').value = verifOf(p);
  state.card = { ...cardOf(p), next: Number.isFinite(+p.cardNext) ? +p.cardNext : 1 };
  state.day = p.dayNext || 1;
  const changed = $('only-videos').checked !== !!p.onlyVideos;
  $('only-videos').checked = !!p.onlyVideos;
  renderPresetList();
  await checkMissing();
  renderDests();
  if (changed) rescanAll();
}
// « + Nouveau » : éditeur de préréglage prérempli avec les réglages actuels du panneau
$('preset-new').onclick = () => openModal(null);
// Disquette : met à jour les réglages de copie du préréglage actif s'il a changé, sinon enregistre sous un nouveau préréglage
$('preset-save-current').onclick = async () => {
  const ap = activePreset();
  if (ap && presetDirty(ap)) {
    await savePresetFields(ap, currentCopyFields());
    renderPresetList(); renderDests();
    setStatus(t('Préréglage « {n} » enregistré.', { n: ap.name }));
  } else openModal(null);
};

// Suppression des préréglages cochés (les destinations déjà dans la zone Destination restent)
$('preset-delete').onclick = async () => {
  const names = [...state.selected];
  if (!names.length) return;
  const ask = names.length === 1 ? t('Supprimer le préréglage « {n} » ?', { n: names[0] }) : t('Supprimer {n} préréglages ({list}) ?', { n: names.length, list: names.join(', ') });
  if (!window.confirm(ask)) return;
  let list = state.presets;
  for (const n of names) list = await window.api.presetsDelete(n);
  state.presets = list;
  state.selected = new Set();
  if (names.includes(state.currentPreset)) noPreset();
  renderPresetList();
  renderDests();
  setStatus(names.length === 1 ? t('Préréglage « {n} » supprimé.', { n: names[0] }) : t('{n} préréglages supprimés.', { n: names.length }));
};

// ---------- Page d'un préréglage : tous ses réglages (brouillon : rien n'est appliqué avant « Enregistrer ») ----------
const modal = $('preset-modal');
let draft = null;
const mVerif = () => $('m-verif').value;

function openModal(preset) {
  const isNew = !preset;
  const base = preset || { ...currentCopyFields(), structure: state.structure, cardAuto: state.card.auto, cardPrefix: state.card.prefix, cardPad: state.card.pad, cardNext: state.card.next, dayNext: curDay() };
  draft = {
    dayNext: base.dayNext || 1,
    original: isNew ? '' : preset.name,
    color: isNew ? (PALETTE.find((c) => !state.presets.some((p) => p.color === c)) || PALETTE[0]) : (preset.color || PALETTE[0]),
    dests: [...base.destinations],
    free: {}, missing: new Set()
  };
  $('m-title').textContent = isNew ? t('Nouveau préréglage') : t('Modifier « {n} »', { n: preset.name });
  $('m-name').value = isNew ? '' : preset.name;
  $('m-structure').value = base.structure ?? '{source}'; renderMLevels();
  $('m-verif').value = verifOf(base);
  $('m-only-videos').checked = !!base.onlyVideos;
  $('m-card-auto').checked = !!base.cardAuto;
  $('m-card-prefix').value = base.cardPrefix ?? 'A';
  $('m-card-pad').value = base.cardPad || 3;
  $('m-card-next').value = Number.isFinite(+base.cardNext) ? +base.cardNext : 1;
  updateCardPreview();
  $('m-save').textContent = isNew ? t('Créer le préréglage') : t('Enregistrer');
  $('m-error').hidden = true;
  renderModalColors();
  renderDraftDests();
  modal.showModal();
  updatePreview();
  refreshDraft().then(renderDraftDests);
}
modal.addEventListener('close', () => { draft = null; });
function updateCardPreview() {
  const on = $('m-card-auto').checked;
  $('m-card-fields').classList.toggle('off', !on);
  ['m-card-prefix', 'm-card-pad', 'm-card-next'].forEach((id) => { $(id).disabled = !on; });
  const pad = Math.min(6, Math.max(1, parseInt($('m-card-pad').value, 10) || 3));
  const n = Math.max(0, parseInt($('m-card-next').value, 10) || 0);
  const pre = $('m-card-prefix').value.trim();
  const f = (k) => pre + String(n + k).padStart(pad, '0');
  $('m-card-preview').textContent = on ? t('Prochaines cartes : {list}…', { list: `${f(0)}, ${f(1)}, ${f(2)}` }) : '';
  if (draft && modal.open) updatePreview();
}
['m-card-auto', 'm-card-prefix', 'm-card-pad', 'm-card-next'].forEach((id) => { $(id).oninput = updateCardPreview; });

function renderModalColors() {
  const box = $('m-colors');
  box.innerHTML = '';
  PALETTE.forEach((c) => {
    const b = h('button');
    b.type = 'button';
    b.style.background = c;
    b.setAttribute('role', 'radio');
    b.setAttribute('aria-checked', String(c === draft.color));
    b.setAttribute('aria-label', t('Couleur {c}', { c }));
    b.onclick = () => { draft.color = c; renderModalColors(); };
    box.append(b);
  });
}

async function refreshDraft() {
  if (!draft) return;
  const paths = [...draft.dests];
  if (!paths.length) { draft.free = {}; draft.missing = new Set(); return; }
  const [ex, fr] = await Promise.all([window.api.pathsExist(paths), window.api.diskFree(paths)]);
  if (!draft) return;
  draft.missing = new Set(paths.filter((_, i) => !ex[i]));
  draft.free = Object.fromEntries(paths.map((d, i) => [d, fr[i]]));
}

function renderDraftDests() {
  if (!draft) return;
  const ul = $('m-dest-list');
  ul.innerHTML = '';
  draft.dests.forEach((d, i) => {
    const li = h('li', draft.missing.has(d) ? 'missing' : '');
    li.append(h('span', '', d));
    const f = draft.free[d];
    li.append(h('small', 'free', f == null ? '' : t('{free} libres', { free: fmtBytes(f) })));
    if (draft.missing.has(d)) li.append(h('span', 'badge', t('introuvable')));
    const rm = h('button', 'rm', '×');
    rm.type = 'button'; rm.title = t('Retirer cette destination'); rm.setAttribute('aria-label', t('Retirer {d}', { d }));
    rm.onclick = () => { draft.dests.splice(i, 1); renderDraftDests(); updatePreview(); refreshDraft().then(renderDraftDests); };
    li.append(rm);
    ul.append(li);
  });
  $('m-dest-empty').hidden = draft.dests.length > 0;
}

async function addDraftDests(list) {
  if (!draft) return;
  for (const p of list) if (!draft.dests.includes(p)) draft.dests.push(p);
  renderDraftDests(); updatePreview();
  await refreshDraft();
  renderDraftDests();
}
$('m-add-dest').onclick = async () => addDraftDests(await window.api.pickDestinations());
wireDrop(modal, (t) => t === 'Files', async (dt) => addDraftDests(await foldersFrom(dt)));
$('m-structure').oninput = updatePreview;
$('m-name').oninput = () => { $('m-error').hidden = true; };
$('m-cancel').onclick = () => modal.close();

$('m-save').onclick = async () => {
  const showErr = (msg) => { $('m-error').textContent = msg; $('m-error').hidden = false; };
  const name = $('m-name').value.trim();
  if (!name) { showErr(t('Donnez un nom au préréglage.')); $('m-name').focus(); return; }
  if (!draft.dests.length) { showErr(t('Ajoutez au moins une destination.')); return; }
  if (name !== draft.original && state.presets.some((p) => p.name === name)) { showErr(t('Un préréglage porte déjà ce nom.')); $('m-name').focus(); return; }
  const original = draft.original;
  const v = mVerif();
  let list = await window.api.presetsSave({
    name, destinations: draft.dests, structure: $('m-structure').value,
    mode: v === 'none' ? 'simple' : 'verify', algo: v === 'md5' ? 'md5' : 'xxh64',
    onlyVideos: $('m-only-videos').checked, color: draft.color,
    cardAuto: $('m-card-auto').checked, cardPrefix: $('m-card-prefix').value,
    cardPad: $('m-card-pad').value, cardNext: $('m-card-next').value,
    dayNext: draft.dayNext
  });
  if (original && name !== original) list = await window.api.presetsDelete(original);   // renommage
  state.presets = list;
  const wasActive = state.currentPreset === original;
  modal.close();
  if (!original || wasActive) await applyPreset(name);   // un préréglage créé ou modifié en cours d'usage devient actif
  else renderPresetList();
  setStatus(t('Préréglage « {n} » enregistré.', { n: name }));
};

$('only-videos').onchange = () => { renderDests(); rescanAll(); };
$('verif').onchange = renderDests;

function refresh() {
  const nSel = state.selected.size;
  $('preset-delete').disabled = nSel === 0;
  $('preset-delete').textContent = nSel ? t('Supprimer ({n})', { n: nSel }) : t('Supprimer');
  $('add-task').disabled = state.sources.length === 0 ||
    state.sources.some((x) => isGone(x) || destsFor(x).length === 0 || destsFor(x).some((d) => state.missing.has(d)));
  $('queue-start').disabled = state.queueRunning || !state.queue.some((t) => t.status === 'pending');
  $('queue-cancel').disabled = state.queue.length === 0;
  $('history-clear').disabled = state.history.length === 0;
}

// ---------- Copies : à venir et historique ----------
let addTimer;
function setAddStatus(text, isError = false) {
  const e = $('add-status');
  e.textContent = text;
  e.classList.toggle('bad', isError);
  clearTimeout(addTimer);
  if (text) addTimer = setTimeout(() => { e.textContent = ''; }, 6000);
}

const STATUS_LABEL = { pending: 'En attente', running: 'En cours', done: 'Terminé', failed: 'Échec', cancelled: 'Annulé' };
// message d'une copie : clé + paramètres (traduits à l'affichage), ou texte brut (erreur système)
const taskMsg = (x) => (x.msgKey ? t(x.msgKey, { ...x.msgParams, verb: x.msgVerb ? t(x.msgVerb) : '' }) : x.message);

function taskItem(t0, inHistory) {
  const paused = t0.status === 'running' && state.paused;
  const li = h('li', `task st-${t0.status}` + (paused ? ' paused' : ''));
  const meta = h('div', 'tmeta');
  const head = h('div', 'thead');
  if (t0.presetColor) {
    const sw = h('span', 'swatch');
    sw.style.background = t0.presetColor;
    sw.title = t0.presetName || '';
    head.append(sw);
  }
  head.append(h('strong', '', t0.label));
  head.append(h('span', 'chip', t(paused ? 'En pause' : STATUS_LABEL[t0.status])));
  const rm = h('button', 'rm', '×');
  rm.type = 'button';
  rm.title = t(inHistory ? 'Retirer de l’historique' : 'Retirer de la file');
  rm.setAttribute('aria-label', t('Retirer {s}', { s: t0.label }));
  rm.disabled = t0.status === 'running';
  rm.onclick = () => {
    if (inHistory) { state.history = state.history.filter((x) => x !== t0); saveHistory(); }
    else state.queue = state.queue.filter((x) => x !== t0);
    renderQueue();
  };
  head.append(rm);
  meta.append(head);
  const o = t0.opts;
  // infos complètes, sur plusieurs lignes si besoin (jamais tronquées)
  meta.append(h('small', 'tinfo', (inHistory ? `${fmtDate(t0.endedAt)} · ` : '') + `→ ${t0.subdir || t('(racine)')}`));
  meta.append(h('small', 'tinfo',
    t('{n} destination(s) · {v} média(s) · {size}', { n: o.destinations.length, v: t0.info.videos, size: fmtBytes(t0.info.bytes) }) + ' · ' +
    (o.verify ? t('vérifiée {algo}', { algo: o.algo === 'md5' ? 'MD5' : 'xxHash64' }) : t('sans vérification'))));
  if (taskMsg(t0)) meta.append(h('small', 'tmsg', taskMsg(t0)));
  li.append(meta);

  const actions = h('div', 'tactions');
  if (t0.status === 'running') {
    const pb = h('button', 'btn small', t(state.paused ? 'Reprendre' : 'Pause'));
    pb.type = 'button';
    pb.onclick = togglePause;
    actions.append(pb);
  }
  if (t0.report) {
    const b = h('button', 'btn small', t('Rapport'));
    b.type = 'button';
    b.onclick = () => window.api.openPath(t0.report);
    actions.append(b);
  }
  if (inHistory && (t0.status === 'failed' || t0.status === 'cancelled')) {
    const b = h('button', 'btn small primary', t('Relancer'));
    b.type = 'button';
    b.onclick = () => {
      state.queue.push({ ...t0, id: newId(), status: 'pending', message: '', msgKey: null, msgParams: null, msgVerb: null, report: null, endedAt: undefined });
      renderQueue();
    };
    actions.append(b);
  }
  if (actions.children.length) li.append(actions);
  return li;
}

function renderQueue() {
  const up = $('upcoming-list'), hi = $('history-list');
  up.innerHTML = ''; hi.innerHTML = '';
  state.queue.forEach((t) => up.append(taskItem(t, false)));
  state.history.forEach((t) => hi.append(taskItem(t, true)));
  $('sect-upcoming').hidden = state.queue.length === 0;
  $('sect-history').hidden = state.history.length === 0;
  $('queue-empty').hidden = state.queue.length + state.history.length > 0;
  $('queue-stop').hidden = !state.queueRunning;
  $('queue-start').hidden = state.queueRunning;
  renderSources();   // « déjà copiée » dépend de l'historique
  refresh();
}
const saveHistory = () => window.api.historySave(state.history).catch(() => {});
$('history-clear').onclick = () => { state.history = []; saveHistory(); renderQueue(); };

// ---------- Ajouter à la file (une copie par source) ----------
$('add-task').onclick = async () => {
  $('add-task').disabled = true;
  await checkMissing();                       // espace libre et disques présents, à jour
  const total = state.sources.length;
  const base = { structure: state.structure, ...copyOpts(), onlyVideos: $('only-videos').checked };
  const preset = state.presets.find((p) => p.name === state.currentPreset);
  const need = {};                            // octets déjà prévus par destination (copies en attente)
  state.queue.filter((t) => t.status === 'pending').forEach((t) =>
    t.opts.destinations.forEach((d) => { need[d] = (need[d] || 0) + t.info.bytes; }));
  let added = 0, autoUsed = 0;
  const problems = [];
  for (const s of [...state.sources]) {
    const dests = [...destsFor(s)];
    if (!dests.length) { problems.push(t('{label} : aucune destination', { label: s.label })); continue; }
    const gone = dests.find((d) => state.missing.has(d));
    if (gone) { problems.push(t('{label} : destination introuvable ({d})', { label: s.label, d: gone })); continue; }
    let info = s.info;
    if (!info) {
      try { info = await window.api.scan(s.path, base.onlyVideos); }
      catch (e) { problems.push(`${s.label} : ${e.message}`); continue; }
    }
    if (info.count === 0) { problems.push(t('{label} : aucun fichier à copier', { label: s.label })); continue; }
    const full = dests.find((d) => state.free[d] != null && (need[d] || 0) + info.bytes > state.free[d]);
    if (full) { problems.push(t('{label} : espace insuffisant sur {d}', { label: s.label, d: full })); continue; }
    dests.forEach((d) => { need[d] = (need[d] || 0) + info.bytes; });
    const name = nameFor(s, total);
    const auto = !cleanSeg(s.card) ? autoCard(autoUsed) : '';
    if (auto) autoUsed++;
    const vars = varsFor(s, name || s.label, auto);
    const opts = { ...base, destinations: dests, source: s.path, sourceLabel: name, appareil: vars.appareil, carte: vars.carte, jour: vars.jour };
    state.queue.push({
      id: newId(), label: name || s.label, opts, info,
      subdir: subdirParts(opts.structure, opts.source, name, vars).join('/'),
      work: info.bytes * (opts.verify ? 1 + opts.destinations.length : 1),
      presetName: preset ? preset.name : '', presetColor: preset ? (preset.color || PALETTE[0]) : '',
      status: 'pending', message: '', report: null
    });
    state.sources = state.sources.filter((x) => x !== s);
    added++;
  }
  if (autoUsed) await bumpCounter(autoUsed);
  renderSources(); renderQueue(); updatePreview();
  if (problems.length) setAddStatus(t('{added} ajoutée(s). Non ajoutée(s) : {problems}', { added, problems: problems.join(' ; ') }), true);
  else { $('offload-id').value = ''; updatePreview(); setAddStatus(t('{n} copie(s) ajoutée(s) à la file.', { n: added })); }
};

// ---------- Exécution ----------
$('queue-start').onclick = () => runQueue();
$('queue-stop').onclick = () => { state.queueRunning = false; state.paused = false; window.api.setPaused(false); window.api.cancel(); renderQueue(); };

// phase = { i, n, label, verify } (traduit à l'affichage, donc à chaud lors d'un changement de langue)
function renderPhase() {
  const ph = state.phase;
  if (!ph) { $('phase').textContent = t('Copie en cours'); return; }
  $('phase').textContent = (ph.label ? t('Copie {i}/{n} · {label} · ', { i: ph.i, n: ph.n, label: ph.label }) : '') +
    t(ph.verify ? 'Vérification' : 'Copie') + (state.paused ? t(' · en pause') : '');
}
async function togglePause() {
  state.paused = !state.paused;
  await window.api.setPaused(state.paused);
  renderPhase();
  renderQueue();
}
$('queue-cancel').onclick = () => {
  if (!state.queue.length) return;
  if (!window.confirm(t('Annuler la copie en cours et retirer toutes les copies en attente ?'))) return;
  state.queueRunning = false;
  state.paused = false;
  window.api.setPaused(false);
  state.queue = state.queue.filter((t) => t.status === 'running'); // la copie en cours se termine en « Annulé »
  window.api.cancel();
  renderQueue();
};

async function runQueue() {
  if (state.queueRunning) return;
  state.queueRunning = true;
  state.runDone = 0;
  renderQueue();
  while (state.queueRunning) {
    const t = state.queue.find((x) => x.status === 'pending');
    if (!t) break;
    await runTask(t);
    state.runDone++;
  }
  state.queueRunning = false;
  state.current = null;
  $('progress').hidden = true;
  renderQueue();
}

async function runTask(task) {
  task.status = 'running'; task.message = ''; task.msgKey = null; task.msgParams = null; task.msgVerb = null;
  state.paused = false;
  state.current = task;
  $('progress').hidden = false;
  $('bar-fill').style.width = '0%';
  $('pct').textContent = '0 %';
  $('current').textContent = '';
  renderQueue();

  let res;
  try { res = await window.api.start(task.opts); } catch (e) { res = { error: e.message }; }
  state.current = null;

  if (res.aborted) {
    task.status = 'cancelled'; task.msgKey = 'Remplacement refusé.';
  } else if (res.error) {
    task.status = 'failed'; task.message = res.error;
  } else {
    const s = res.stats;
    const verb = s.verify ? 'validé(s)' : 'copié(s)';      // clé de traduction, résolue à l'affichage
    task.report = res.reports[0] || null;
    if (s.cancelled) { task.status = 'cancelled'; task.msgKey = 'Annulé : {ok} fichier(s) {verb} sur {planned}.'; task.msgParams = { ok: s.ok, planned: s.planned }; }
    else if (s.failed) { task.status = 'failed'; task.msgKey = '{failed} échec(s) : {ok} fichier(s) {verb} sur {total}.'; task.msgParams = { failed: s.failed, ok: s.ok, total: s.total }; }
    else { task.status = 'done'; task.msgKey = '{ok} fichier(s) {verb}, dont {videos} média(s) · {time}'; task.msgParams = { ok: s.ok, videos: s.videos, time: fmtTime(s.durationMs / 1000) }; }
    task.msgVerb = verb;
  }
  // la copie quitte « à venir » et rejoint l'historique
  state.queue = state.queue.filter((x) => x !== task);
  const { work, ...entry } = task;
  state.history.unshift({ ...entry, endedAt: Date.now() });
  state.history = state.history.slice(0, 200);
  saveHistory();
  renderQueue();
}

window.api.onProgress((p) => {
  const cur = state.current;
  $('progress').classList.toggle('verifying', p.phase === 'verify');
  state.phase = { i: state.runDone + 1, n: state.runDone + state.queue.length, label: cur ? cur.label : '', verify: p.phase === 'verify' };
  renderPhase();
  $('pct').textContent = `${Math.floor(p.percent)} %`;
  $('bar-fill').style.width = `${p.percent}%`;
  $('eta').textContent = fmtTime(p.etaSec);
  $('videos').textContent = t('{left} sur {total}', { left: p.videosTotal - p.videosDone, total: p.videosTotal });
  $('files').textContent = `${p.filesDone} / ${p.filesTotal}`;
  $('speed').textContent = `${fmtBytes(p.speed)}/s`;
  $('current').textContent = p.current;
  const pendingWork = state.queue.filter((x) => x.status === 'pending').reduce((sum, x) => sum + (x.work || 0), 0);
  $('eta-queue').textContent = pendingWork > 0 && p.speed > 0
    ? t('Toute la file : {time}', { time: fmtTime((p.etaSec ?? 0) + pendingWork / p.speed) }) : '';
});

// ---------- Changement de langue : tout est redessiné à chaud ----------
function setLang(code) {
  LANG = I18N.LANGS.some((l) => l.code === code) ? code : 'fr';
  applyStatic();
  if (window.__gutterTitles) window.__gutterTitles();
  renderTokens();
  renderMLevels();
  renderVolumes();
  renderPresetList();
  renderQueue();          // redessine aussi les sources et les destinations
  renderPhase();
  updatePreview();
  if (modal.open) { $('m-title').textContent = draft && draft.original ? t('Modifier « {n} »', { n: draft.original }) : t('Nouveau préréglage'); }
}

(async () => {
  let cfg = null;
  try { cfg = await window.api.settingsGet(); } catch { /* réglages indisponibles : français */ }
  if (cfg) { settingsCache = cfg; LANG = cfg.lang; applyTheme(cfg.theme); applyStatic(); renderTokens(); }
  state.presets = await window.api.presetsList();
  try { state.history = await window.api.historyList(); } catch { state.history = []; }
  renderPresetList();
  renderDests();
  renderQueue();
  renderSources();
  updatePreview();
  await refreshVolumes();
})();

// ---------- À propos (bouton « i » et menu de l'application) ----------
{
  const dlg = $('about-modal');
  let info = null;
  async function openAbout() {
    if (dlg.open) return;
    if (!info) { try { info = await window.api.appInfo(); } catch { info = null; } }
    if (info) {
      $('about-version').textContent = t('Version {v}', { v: info.version });
      $('about-data').title = info.data;   // chemin du dossier de données en infobulle
    }
    dlg.showModal();
  }
  $('about-open').onclick = openAbout;
  window.api.onShowAbout(openAbout);
  $('about-close').onclick = () => dlg.close();
  $('about-data').onclick = () => { if (info) window.api.openPath(info.data); };
  $('about-repo').onclick = () => window.api.openRepo();
  // la version affichée suit la langue
  window.addEventListener('lang-changed', () => { if (info) $('about-version').textContent = t('Version {v}', { v: info.version }); });
}

// ---------- Réglages : format du rapport, langue, dossier des préréglages ----------
let settingsCache = null;
// Thème : « system » suit le système (prefers-color-scheme), « light » / « dark » forcent le thème
function applyTheme(theme) { document.documentElement.dataset.theme = ['light', 'dark'].includes(theme) ? theme : 'system'; }
{
  const dlg = $('settings-modal');
  const note = (text, bad = false) => { $('s-note').textContent = text || ''; $('s-note').classList.toggle('bad', bad); };
  function show() {
    const c = settingsCache; if (!c) return;
    $('s-report').value = c.reportFormat;
    $('s-theme').value = c.theme || 'system';
    $('s-thumbs').checked = c.thumbnails !== false;
    $('s-thumbs-note').hidden = c.ffmpeg !== false;
    $('s-lang').value = c.lang;
    $('s-presets-dir').textContent = c.presetsDirNow;
    $('s-presets-dir').title = c.presetsDirNow;
    $('s-dir-default').disabled = !c.presetsDir;
  }
  $('settings-open').onclick = async () => {
    try { settingsCache = await window.api.settingsGet(); } catch { /* garde le cache */ }
    note(''); show(); dlg.showModal();
  };
  // menu « Paramètres » de l'application : mêmes actions que les boutons de l'interface
  window.api.onMenuAction((what) => {
    if (document.querySelector('dialog[open]')) return;
    const id = { source: 'pick-folder', dest: 'add-dest', preset: 'preset-new', settings: 'settings-open' }[what];
    if (id) $(id).click();
  });
  $('s-close').onclick = () => dlg.close();
  $('s-report').onchange = async () => { settingsCache = await window.api.settingsSet({ reportFormat: $('s-report').value }); show(); };
  $('s-theme').onchange = async () => { settingsCache = await window.api.settingsSet({ theme: $('s-theme').value }); applyTheme(settingsCache.theme); show(); };
  $('s-thumbs').onchange = async () => { settingsCache = await window.api.settingsSet({ thumbnails: $('s-thumbs').checked }); show(); };
  $('s-lang').onchange = async () => {
    settingsCache = await window.api.settingsSet({ lang: $('s-lang').value });
    setLang(settingsCache.lang);
    window.dispatchEvent(new Event('lang-changed'));
    show();
  };
  // le dossier des préréglages a changé : on recharge la liste
  async function applyPresetsChange(res) {
    if (!res) return;
    if (res.error) { note(res.error, true); return; }
    settingsCache = res.settings;
    state.presets = res.presets;
    if (!state.presets.some((p) => p.name === state.currentPreset)) noPreset();
    renderPresetList(); renderDests();
    note(res.note);
    show();
  }
  $('s-pick-dir').onclick = async () => applyPresetsChange(await window.api.settingsPickPresetsDir());
  $('s-dir-default').onclick = async () => applyPresetsChange(await window.api.settingsResetPresetsDir());
  $('s-open-dir').onclick = () => { if (settingsCache) window.api.openPath(settingsCache.presetsDirNow); };
}


// ---------- Tailles réglables : largeur des colonnes, hauteur des blocs de chaque colonne ----------
(function layoutResize() {
  const cols = document.querySelector('.cols');
  const P = (c) => cols.querySelector(c);
  const KEY = 'eilan.layout2';
  const DEF = { c: [1, 1.2, 1.35], lp: 158, cs: 300 };
  let L = JSON.parse(JSON.stringify(DEF));
  try { const s = JSON.parse(localStorage.getItem(KEY) || 'null'); if (s && Array.isArray(s.c) && s.c.length === 3) L = { ...L, ...s }; } catch { /* valeurs par défaut */ }
  const MINW = 180, MINH = 90;
  const apply = () => {
    ['c1', 'c2', 'c3'].forEach((k, i) => cols.style.setProperty('--' + k, L.c[i] + 'fr'));
    ['lp', 'cs'].forEach((k) => cols.style.setProperty('--' + k, Math.round(L[k]) + 'px'));
  };
  const save = () => { try { localStorage.setItem(KEY, JSON.stringify(L)); } catch { /* ignoré */ } };
  const title = () => t('Glisser pour redimensionner · double-clic pour réinitialiser');
  const mk = (cls) => { const g = document.createElement('div'); g.className = 'gutter ' + cls; g.title = title(); cols.append(g); return g; };
  const gv1 = mk('v'), gv2 = mk('v'), ghL = mk('h'), ghC1 = mk('h');
  const rect = (el) => { const r = el.getBoundingClientRect(), o = cols.getBoundingClientRect(); return { l: r.left - o.left, t: r.top - o.top, r: r.right - o.left, b: r.bottom - o.top }; };
  function place() {
    const a = rect(P('.panel-avail')), s = rect(P('.panel-source'));
    const H = cols.clientHeight;
    const set = (g, x, y, w, h) => { g.style.left = x + 'px'; g.style.top = y + 'px'; g.style.width = w + 'px'; g.style.height = h + 'px'; };
    set(gv1, a.r, 0, 10, H); set(gv2, s.r, 0, 10, H);
    set(ghL, a.l, a.b, a.r - a.l, 10);       // médias connectés | presets
    set(ghC1, s.l, s.b, s.r - s.l, 10);      // source | destination
  }
  function fit() {   // garde les hauteurs compatibles avec la fenêtre
    const H = cols.clientHeight;
    L.lp = Math.max(MINH, Math.min(L.lp, H - 10 - MINH));
    L.cs = Math.max(MINH, Math.min(L.cs, H - 20 - 140));
    apply();
  }
  function drag(g, onMove, reset) {
    g.addEventListener('dblclick', () => { reset(); fit(); save(); place(); });
    g.addEventListener('pointerdown', (e) => {
      e.preventDefault(); g.setPointerCapture(e.pointerId);
      g.classList.add('drag'); document.body.classList.add('resizing');
      const x0 = e.clientX, y0 = e.clientY, w = [P('.panel-avail'), P('.panel-source'), P('.panel-queue')].map((p) => p.getBoundingClientRect().width);
      const start = { lp: L.lp, cs: L.cs, w };
      const move = (ev) => { onMove(ev.clientX - x0, ev.clientY - y0, start); fit(); place(); };
      const up = () => { g.classList.remove('drag'); document.body.classList.remove('resizing'); g.removeEventListener('pointermove', move); g.removeEventListener('pointerup', up); g.removeEventListener('pointercancel', up); save(); };
      g.addEventListener('pointermove', move); g.addEventListener('pointerup', up); g.addEventListener('pointercancel', up);
    });
  }
  const setCols = (w) => { L.c = w.map((x) => +(x / 100).toFixed(4)); };    // px/100 : les fr gardent les proportions
  drag(gv1, (dx, dy, s) => { const d = Math.max(MINW - s.w[0], Math.min(dx, s.w[1] - MINW)); setCols([s.w[0] + d, s.w[1] - d, s.w[2]]); }, () => { L.c = [...DEF.c]; });
  drag(gv2, (dx, dy, s) => { const d = Math.max(MINW - s.w[1], Math.min(dx, s.w[2] - MINW)); setCols([s.w[0], s.w[1] + d, s.w[2] - d]); }, () => { L.c = [...DEF.c]; });
  drag(ghL, (dx, dy, s) => { L.lp = s.lp - dy; }, () => { L.lp = DEF.lp; });
  drag(ghC1, (dx, dy, s) => { L.cs = s.cs + dy; }, () => { L.cs = DEF.cs; });
  new ResizeObserver(() => { fit(); place(); }).observe(cols);
  window.addEventListener('resize', () => { fit(); place(); });
  apply(); fit(); place();
  window.__gutterTitles = () => cols.querySelectorAll('.gutter').forEach((g) => { g.title = title(); });
})();
