'use strict';
const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('api', {
  pickSource: () => ipcRenderer.invoke('pick-source'),
  pickDestinations: () => ipcRenderer.invoke('pick-destinations'),
  scan: (source, onlyVideos) => ipcRenderer.invoke('scan', source, onlyVideos),
  start: (opts) => ipcRenderer.invoke('start', opts),
  cancel: () => ipcRenderer.invoke('cancel'),
  settingsGet: () => ipcRenderer.invoke('settings-get'),
  settingsSet: (patch) => ipcRenderer.invoke('settings-set', patch),
  settingsPickPresetsDir: () => ipcRenderer.invoke('settings-pick-presets-dir'),
  settingsResetPresetsDir: () => ipcRenderer.invoke('settings-reset-presets-dir'),
  appInfo: () => ipcRenderer.invoke('app-info'),
  openPath: (p) => ipcRenderer.invoke('open-path', p),
  openRepo: () => ipcRenderer.invoke('open-repo'),
  pathForFile: (file) => { try { return webUtils.getPathForFile(file); } catch { return ''; } },
  historyList: () => ipcRenderer.invoke('history-list'),
  historySave: (list) => ipcRenderer.invoke('history-save', list),
  listVolumes: () => ipcRenderer.invoke('list-volumes'),
  setPaused: (v) => ipcRenderer.invoke('set-paused', v),
  diskFree: (paths) => ipcRenderer.invoke('disk-free', paths),
  pathsExist: (paths) => ipcRenderer.invoke('paths-exist', paths),
  presetsList: () => ipcRenderer.invoke('presets-list'),
  presetsSave: (preset) => ipcRenderer.invoke('presets-save', preset),
  presetsDelete: (name) => ipcRenderer.invoke('presets-delete', name),
  onShowAbout: (cb) => {
    ipcRenderer.removeAllListeners('show-about');
    ipcRenderer.on('show-about', () => cb());
  },
  onMenuAction: (cb) => {
    ipcRenderer.removeAllListeners('menu-action');
    ipcRenderer.on('menu-action', (_e, what) => cb(what));
  },
  onProgress: (cb) => {
    ipcRenderer.removeAllListeners('progress');
    ipcRenderer.on('progress', (_e, p) => cb(p));
  }
});
