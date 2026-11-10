'use strict';
process.env.UV_THREADPOOL_SIZE = process.env.UV_THREADPOOL_SIZE || '16'; // plus de threads disque : lectures/écritures parallèles
const { app, BrowserWindow, ipcMain, dialog, shell, nativeTheme, screen, Menu } = require('electron');
const path = require('path');
const fs = require('fs');
const { scan, run } = require('./copier');
const { writeReports } = require('./report');
const { listVolumes } = require('./volumes');
const I18N = require('./src/i18n');

// Même dossier de données en développement et en version installée
app.setName('Eilañ');
const dataDir = path.join(app.getPath('appData'), 'Eilan');
// anciens noms de l'application : on récupère les préréglages et l'historique existants
for (const old of ['CopyCheck', 'MediaCopy']) {
  const oldDir = path.join(app.getPath('appData'), old);
  try { if (fs.existsSync(oldDir) && !fs.existsSync(dataDir)) fs.renameSync(oldDir, dataDir); } catch { /* on repart d'un dossier neuf */ }
}
app.setPath('userData', dataDir);

// ---------- Réglages généraux : langue, format du rapport, dossier des préréglages ----------
const settingsFile = () => path.join(app.getPath('userData'), 'settings.json');
const settings = { lang: 'fr', reportFormat: 'pdf', presetsDir: '', thumbnails: true, theme: 'system' };
let langSaved = false;   // sinon la langue du système est utilisée au démarrage (app.getLocale() demande que l'app soit prête)
try {
  const saved = JSON.parse(fs.readFileSync(settingsFile(), 'utf8'));
  if (I18N.LANGS.some((l) => l.code === saved.lang)) { settings.lang = saved.lang; langSaved = true; }
  if (['pdf', 'txt', 'md'].includes(saved.reportFormat)) settings.reportFormat = saved.reportFormat;
  if (typeof saved.presetsDir === 'string') settings.presetsDir = saved.presetsDir;
  if (typeof saved.thumbnails === 'boolean') settings.thumbnails = saved.thumbnails;
  if (['system', 'light', 'dark'].includes(saved.theme)) settings.theme = saved.theme;
} catch { /* premier lancement : valeurs par défaut */ }
const saveSettings = () => {
  try { fs.mkdirSync(dataDir, { recursive: true }); fs.writeFileSync(settingsFile(), JSON.stringify(settings, null, 2), 'utf8'); } catch { /* ignoré */ }
};
const tr = (k, p) => I18N.t(settings.lang, k, p);
const presetsDirNow = () => settings.presetsDir || dataDir;
const settingsInfo = () => ({ ...settings, presetsDirNow: presetsDirNow(), defaultPresetsDir: dataDir, ffmpeg: !!require('./thumbs').findFfmpeg() });
// macOS : l'option `icon` de la fenêtre est ignorée ; en développement le Dock affiche sinon l'icône d'Electron
const APP_ICON = path.join(__dirname, 'build', process.platform === 'darwin' ? 'icon-mac.png' : 'icon.png');
app.whenReady().then(() => { if (process.platform === 'darwin' && app.dock) app.dock.setIcon(APP_ICON); });

// Thème : suivre le système (défaut), clair ou foncé ; s'applique aussi aux boîtes de dialogue du système
nativeTheme.themeSource = settings.theme;
const windowBg = () => (nativeTheme.shouldUseDarkColors ? '#14161a' : '#eef0f3');

let win = null;
let ctl = null;

function createWindow() {
  win = new BrowserWindow({
    width: Math.min(1500, screen.getPrimaryDisplay().workAreaSize.width),
    height: Math.min(900, screen.getPrimaryDisplay().workAreaSize.height),
    minWidth: 1000, minHeight: 680,
    icon: APP_ICON,
    backgroundColor: windowBg(),
    title: 'Eilañ',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  win.setMenuBarVisibility(false);
  win.on('close', (e) => {
    if (!ctl) return;
    const r = dialog.showMessageBoxSync(win, {
      type: 'warning', buttons: [tr('Continuer la copie'), tr('Quitter')], defaultId: 0, cancelId: 0,
      message: tr('Une copie est en cours.'),
      detail: tr('Quitter maintenant l’interrompra et laissera des fichiers incomplets.')
    });
    if (r === 0) e.preventDefault();
  });
  win.loadFile(path.join(__dirname, 'src', 'index.html'));
}

// Une seule page « À propos » : celle de l'application. Le menu l'ouvre au lieu du panneau natif.
function buildMenu() {
  const about = { label: tr('À propos d’Eilañ'), click: () => { if (win) win.webContents.send('show-about'); } };
  const mac = process.platform === 'darwin';
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    ...(mac ? [{ label: app.name, submenu: [about, { type: 'separator' }, { role: 'services' }, { type: 'separator' },
      { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' }, { type: 'separator' }, { role: 'quit' }] }] : []),
    { role: 'editMenu' }, { role: 'viewMenu' }, { role: 'windowMenu' },
    ...(mac ? [] : [{ label: tr('Aide'), submenu: [about] }])
  ]));
}
app.whenReady().then(() => {
  if (!langSaved) { const l = (app.getLocale() || 'fr').toLowerCase(); settings.lang = l.startsWith('br') ? 'br' : l.startsWith('fr') ? 'fr' : 'en'; }
  buildMenu(); createWindow();
});
app.on('window-all-closed', () => app.quit());

// ---------- Préréglages (destinations + arborescence + options) ----------
const presetsFile = () => path.join(presetsDirNow(), 'presets.json');
function readPresets() {
  try {
    const list = JSON.parse(fs.readFileSync(presetsFile(), 'utf8'));
    return Array.isArray(list) ? list : [];
  } catch { return []; }
}
function writePresets(list) {
  fs.mkdirSync(path.dirname(presetsFile()), { recursive: true });
  fs.writeFileSync(presetsFile(), JSON.stringify(list, null, 2), 'utf8');
}

ipcMain.handle('presets-list', () => readPresets());

ipcMain.handle('settings-get', () => settingsInfo());
ipcMain.handle('settings-set', (_e, patch) => {
  if (patch && I18N.LANGS.some((l) => l.code === patch.lang)) settings.lang = patch.lang;
  if (patch && ['pdf', 'txt', 'md'].includes(patch.reportFormat)) settings.reportFormat = patch.reportFormat;
  if (patch && typeof patch.thumbnails === 'boolean') settings.thumbnails = patch.thumbnails;
  if (patch && ['system', 'light', 'dark'].includes(patch.theme)) {
    settings.theme = patch.theme;
    nativeTheme.themeSource = settings.theme;
    if (win && !win.isDestroyed()) win.setBackgroundColor(windowBg());
  }
  saveSettings();
  buildMenu();
  return settingsInfo();
});
// Nouveau dossier de préréglages : si un fichier presets.json s'y trouve on l'utilise, sinon on y copie les préréglages actuels
ipcMain.handle('settings-pick-presets-dir', async () => {
  const r = await dialog.showOpenDialog(win, {
    title: tr('Choisir le dossier des préréglages'), defaultPath: presetsDirNow(), properties: ['openDirectory', 'createDirectory']
  });
  if (r.canceled) return null;
  const dir = r.filePaths[0];
  try {
    const target = path.join(dir, 'presets.json');
    let note = 'Préréglages copiés dans le nouveau dossier.';
    if (fs.existsSync(target)) note = 'Ce dossier contient déjà des préréglages : ils sont maintenant utilisés.';
    else {
      const current = readPresets();
      fs.writeFileSync(target, JSON.stringify(current, null, 2), 'utf8');
    }
    settings.presetsDir = path.resolve(dir) === dataDir ? '' : dir;
    saveSettings();
    return { settings: settingsInfo(), presets: readPresets(), note: tr(note) };
  } catch (e) {
    return { error: tr('Dossier impossible à utiliser : {e}', { e: e.message }) };
  }
});
ipcMain.handle('settings-reset-presets-dir', () => {
  settings.presetsDir = '';
  saveSettings();
  return { settings: settingsInfo(), presets: readPresets(), note: '' };
});

ipcMain.handle('presets-save', (_e, p) => {
  const preset = {
    name: String(p.name || '').trim(),
    destinations: (Array.isArray(p.destinations) ? p.destinations : []).map(String),
    structure: String(p.structure ?? '{source}'),
    mode: p.mode === 'simple' ? 'simple' : 'verify',
    algo: p.algo === 'md5' ? 'md5' : 'xxh64',
    onlyVideos: !!p.onlyVideos,
    color: /^#[0-9a-f]{6}$/i.test(String(p.color || '')) ? p.color : '',
    // numérotation automatique des cartes (A001, A002…)
    cardAuto: !!p.cardAuto,
    cardPrefix: String(p.cardPrefix ?? 'A').replace(/[\\/<>:"|?*\x00-\x1f]/g, '').trim().slice(0, 20),
    cardPad: Math.min(6, Math.max(1, parseInt(p.cardPad, 10) || 3)),
    cardNext: Math.min(999999, Math.max(0, parseInt(p.cardNext, 10) || 1)),
    // jour de tournage courant ({jour}) : J1, J2…
    dayNext: Math.min(9999, Math.max(1, parseInt(p.dayNext, 10) || 1))
  };
  if (!preset.name) return readPresets();
  const list = readPresets().filter((x) => x.name !== preset.name);
  list.push(preset);
  list.sort((a, b) => a.name.localeCompare(b.name));
  writePresets(list);
  return list;
});

ipcMain.handle('presets-delete', (_e, name) => {
  const list = readPresets().filter((x) => x.name !== name);
  writePresets(list);
  return list;
});

// ---------- Historique des copies terminées ----------
const historyFile = () => path.join(app.getPath('userData'), 'history.json');
ipcMain.handle('history-list', () => {
  try {
    const list = JSON.parse(fs.readFileSync(historyFile(), 'utf8'));
    return Array.isArray(list) ? list : [];
  } catch { return []; }
});
ipcMain.handle('history-save', (_e, list) => {
  try {
    fs.mkdirSync(path.dirname(historyFile()), { recursive: true });
    fs.writeFileSync(historyFile(), JSON.stringify((Array.isArray(list) ? list : []).slice(0, 200), null, 2), 'utf8');
  } catch { /* historique non critique */ }
});

ipcMain.handle('paths-exist', (_e, paths) =>
  paths.map((p) => { try { return fs.statSync(p).isDirectory(); } catch { return false; } })
);

// vrai si child est égal à parent ou situé dedans (gère aussi les racines de disque Windows)
function isInside(child, parent) {
  const rel = path.relative(parent, child);
  return rel === '' || (rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel));
}

// ---------- Arborescence : variables {source} {date} {heure} ----------
function resolveSubdir(template, sourceName, vars = {}) {
  const now = new Date();
  const p2 = (n) => String(n).padStart(2, '0');
  const date = `${now.getFullYear()}-${p2(now.getMonth() + 1)}-${p2(now.getDate())}`;
  const heure = `${p2(now.getHours())}-${p2(now.getMinutes())}-${p2(now.getSeconds())}`;
  return String(template)
    .replaceAll('{source}', sourceName)
    .replaceAll('{date}', date)
    .replaceAll('{heure}', heure)
    .replaceAll('{AAAA}', String(now.getFullYear()))
    .replaceAll('{MM}', p2(now.getMonth() + 1))
    .replaceAll('{JJ}', p2(now.getDate()))
    .replaceAll('{jour}', String(vars.jour || 1))
    .replaceAll('{appareil}', vars.appareil || '')
    .replaceAll('{carte}', vars.carte || sourceName)
    .split(/[\\/]+/)
    .map((s) => s.trim().replace(/[<>:"|?*\x00-\x1f]/g, '_'))
    .filter((s) => s && s !== '.' && s !== '..')
    .join(path.sep);
}

// ---------- Sélection et analyse ----------
ipcMain.handle('pick-source', async () => {
  const r = await dialog.showOpenDialog(win, { properties: ['openDirectory'] });
  return r.canceled ? null : r.filePaths[0];
});

ipcMain.handle('pick-destinations', async () => {
  const r = await dialog.showOpenDialog(win, {
    properties: ['openDirectory', 'multiSelections', 'createDirectory']
  });
  return r.canceled ? [] : r.filePaths;
});

ipcMain.handle('scan', async (_e, source, onlyVideos) => {
  const files = await scan(source, onlyVideos);
  return {
    count: files.length,
    videos: files.filter((f) => f.video).length,
    bytes: files.reduce((s, f) => s + f.size, 0)
  };
});

ipcMain.handle('list-volumes', () => listVolumes().catch(() => []));
ipcMain.handle('app-info', () => ({
  name: 'Eilañ', version: app.getVersion(),
  data: app.getPath('userData')
}));
ipcMain.handle('open-path', (_e, p) => shell.openPath(p));
ipcMain.handle('set-paused', (_e, v) => { if (ctl) ctl.paused = !!v; return !!(ctl && ctl.paused); });
ipcMain.handle('disk-free', (_e, paths) => Promise.all(paths.map(async (p) => {
  try { const st = await fs.promises.statfs(p); return st.bavail * st.bsize; } catch { return null; }
})));
ipcMain.handle('cancel', () => { if (ctl) ctl.cancelled = true; });

// ---------- Lancement de la copie ----------
async function startTask(opts) {
  const source = path.resolve(opts.source);
  const destinations = [...new Set(opts.destinations.map((d) => path.resolve(d)))];
  // Racine d'un disque (ex. E:\) : pas de nom de dossier, on utilise le nom du volume
  const sourceName = (opts.sourceLabel || path.basename(source) || source.replace(/[:\\/]+/g, '')).replace(/[\\/]+/g, '-');
  const subdir = resolveSubdir(opts.structure ?? '{source}', sourceName, {
    appareil: String(opts.appareil || '').replace(/[\\/]+/g, '-').trim(),
    carte: String(opts.carte || '').replace(/[\\/]+/g, '-').trim(),
    jour: Math.max(0, parseInt(opts.jour, 10) || 1)
  });

  // Garde-fous : destination présente (évite de créer un faux dossier si un disque est débranché)
  for (const d of destinations) {
    let isDir = false;
    try { isDir = fs.statSync(d).isDirectory(); } catch { /* introuvable */ }
    if (!isDir) {
      return { error: tr('Destination introuvable : « {d} ». Branchez le disque ou retirez-la de la liste.', { d }) };
    }
    const root = path.join(d, subdir);
    if (isInside(root, source)) {
      return { error: tr('La destination « {root} » est dans la source (ou la remplacerait).', { root }) };
    }
  }

  const files = await scan(source, opts.onlyVideos);

  const conflicts = destinations.filter((d) =>
    files.some((f) => fs.existsSync(path.join(d, subdir, f.rel)))
  );
  if (conflicts.length) {
    const r = await dialog.showMessageBox(win, {
      type: 'warning',
      buttons: [tr('Annuler'), tr('Remplacer')],
      defaultId: 0, cancelId: 0,
      message: tr('Des fichiers de même nom existent déjà dans {n} destination(s).', { n: conflicts.length }),
      detail: tr('Ils seront remplacés par ceux de la source.')
    });
    if (r.response === 0) return { aborted: true };
  }

  const needed = files.reduce((s, f) => s + f.size, 0);
  for (const d of destinations) {
    try {
      const st = await fs.promises.statfs(d);
      if (st.bavail * st.bsize < needed) {
        return { error: tr('Espace insuffisant sur « {d} ».', { d }) };
      }
    } catch { /* statfs indisponible : on continue */ }
  }

  ctl = { cancelled: false };
  const emit = (p) => win && !win.isDestroyed() && win.webContents.send('progress', p);
  const summary = await run({ ...opts, source, destinations, subdir }, ctl, emit);
  ctl = null;
  summary.sourceName = sourceName;

  const reports = summary.files.length ? await writeReports(summary, { lang: settings.lang, format: settings.reportFormat, thumbnails: settings.thumbnails }) : [];
  const ok = summary.files.filter((f) => f.ok).length;
  return {
    reports,
    stats: {
      total: summary.files.length,
      planned: summary.filesPlanned,
      videos: summary.files.filter((f) => f.video).length,
      ok,
      failed: summary.files.length - ok,
      cancelled: summary.cancelled,
      verify: summary.verify,
      durationMs: summary.endedAt - summary.startedAt - (summary.pausedMs || 0)
    }
  };
}

// Une erreur (source illisible, disque retiré…) devient un échec de tâche, pas un plantage
ipcMain.handle('start', async (_e, opts) => {
  try {
    return await startTask(opts);
  } catch (e) {
    ctl = null;
    return { error: e.message };
  }
});
