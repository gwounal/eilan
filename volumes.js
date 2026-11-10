'use strict';
// Détection des clés USB et cartes mémoire uniquement (les disques durs et SSD externes sont exclus)
const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');

const run = (cmd, args) => new Promise((resolve) => {
  execFile(cmd, args, { timeout: 10000, windowsHide: true, maxBuffer: 4 * 1024 * 1024 },
    (err, stdout) => resolve(err ? null : stdout));
});

// ---------- Linux : lsblk ----------
// Retenu : disque non rotatif (pas un disque dur) ET marqué amovible (RM), ou carte mmcblk montée sous /media.
async function listLinux() {
  const cols = 'NAME,LABEL,SIZE,MOUNTPOINT,RM,ROTA,TYPE,FSTYPE';
  let out = await run('lsblk', ['-J', '-b', '-o', cols + ',MOUNTPOINTS']);
  if (!out) out = await run('lsblk', ['-J', '-b', '-o', cols]); // anciennes versions de lsblk
  if (!out) return [];

  let tree;
  try { tree = JSON.parse(out).blockdevices || []; } catch { return []; }

  const truthy = (v) => v === true || v === 1 || v === '1';
  const SYSTEM = new Set(['/', '/boot', '/boot/efi', '/home', '/usr', '/var', '[SWAP]']);
  const found = [];

  function walk(dev, flags) {
    const mounts = [...(Array.isArray(dev.mountpoints) ? dev.mountpoints : []), dev.mountpoint]
      .filter(Boolean);
    for (const mp of mounts) {
      if (SYSTEM.has(mp)) continue;
      const underMedia = /^\/(run\/)?media\//.test(mp);
      if (flags.removable || (flags.mmc && underMedia)) {
        found.push({
          path: mp,
          label: dev.label || path.basename(mp),
          size: Number(dev.size) || 0,
          fs: dev.fstype || ''
        });
      }
    }
    (dev.children || []).forEach((c) => walk(c, flags));
  }

  tree.filter((d) => d.type === 'disk').forEach((d) => {
    const rotational = truthy(d.rota); // disque dur à plateaux : exclu
    walk(d, {
      removable: !rotational && truthy(d.rm),
      mmc: !rotational && String(d.name || '').startsWith('mmcblk')
    });
  });
  return found;
}

// ---------- macOS : /Volumes + diskutil ----------
async function listMac() {
  let names;
  try { names = await fs.promises.readdir('/Volumes'); } catch { return []; }
  const found = [];
  for (const n of names) {
    if (n.startsWith('.') || n.startsWith('com.apple.')) continue;
    const p = path.join('/Volumes', n);
    try {
      if ((await fs.promises.realpath(p)) === '/') continue; // disque de démarrage
      const info = await run('diskutil', ['info', p]);
      if (!info) continue; // volume réseau ou inconnu
      const removable = /Removable Media:\s+Removable/i.test(info) || /Protocol:\s+Secure Digital/i.test(info);
      if (!removable) continue; // disque dur / SSD externe
      const st = await fs.promises.statfs(p);
      found.push({ path: p, label: n, size: st.blocks * st.bsize, fs: '' });
    } catch { /* volume inaccessible */ }
  }
  return found;
}

// ---------- Windows : PowerShell ----------
// Retenu : lecteurs « amovibles » (clés, cartes) et disques SD/MMC. Les disques USB « fixes » sont exclus.
async function listWindows() {
  const script = `
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$ErrorActionPreference = 'SilentlyContinue'
$sd = @(Get-Disk | Where-Object { $_.BusType -in 'SD','MMC' } | Get-Partition | Where-Object { $_.DriveLetter } | ForEach-Object { [string]$_.DriveLetter })
$vols = @(Get-Volume | Where-Object { $_.DriveLetter -and ($_.DriveType -eq 'Removable' -or $sd -contains [string]$_.DriveLetter) } | ForEach-Object { [pscustomobject]@{ path = ([string]$_.DriveLetter + ':\\'); label = $_.FileSystemLabel; size = [int64]$_.Size; fs = $_.FileSystem } })
ConvertTo-Json -InputObject $vols -Compress
`;
  const enc = Buffer.from(script, 'utf16le').toString('base64');
  const out = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', enc]);
  if (!out) return [];
  try {
    const data = JSON.parse(out.trim() || '[]');
    return (Array.isArray(data) ? data : [data]).filter((v) => v && v.size > 0);
  } catch { return []; }
}

async function listVolumes() {
  let list;
  if (process.platform === 'win32') list = await listWindows();
  else if (process.platform === 'darwin') list = await listMac();
  else list = await listLinux();

  const seen = new Set();
  return list
    .filter((v) => v.path && !seen.has(v.path) && seen.add(v.path))
    .map((v) => ({
      path: v.path,
      label: v.label || (process.platform === 'win32' ? `Disque ${v.path.replace(/[:\\]+/g, '')}` : path.basename(v.path)),
      size: v.size || 0,
      fs: v.fs || ''
    }))
    .sort((a, b) => a.path.localeCompare(b.path));
}

module.exports = { listVolumes };
