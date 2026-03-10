const { app, BrowserWindow, ipcMain, screen, protocol, net } = require('electron');
const { spawn, execFileSync, execFile } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

function getLocalAppData() {
  if (process.env.LOCALAPPDATA) return process.env.LOCALAPPDATA;
  if (process.env.USERPROFILE) return path.join(process.env.USERPROFILE, 'AppData', 'Local');
  return path.join(os.homedir(), 'AppData', 'Local');
}

const USER_DATA_DIR = path.join(getLocalAppData(), 'Google', 'Chrome', 'User Data');
const LEGACY_ELECTRON_DATA_DIR = path.join(app.getPath('appData'), app.getName());
const APP_DATA_ROOT = path.join(app.getPath('appData'), 'chrome-profile-manager');
const APP_RUNTIME_ROOT = path.join(APP_DATA_ROOT, 'runtime-data');
const APP_SESSION_ROOT = path.join(APP_DATA_ROOT, 'session-data');
let configPath = null;
let mainWindow = null;
let statusTimer = null;
let lastTileLayout = null;
let profileWatcher = null;
let profileWatcherDebounce = null;
let lastProfileJson = '';

const managedProfiles = new Map();

app.disableHardwareAcceleration();
app.setPath('userData', APP_RUNTIME_ROOT);
app.setPath('sessionData', APP_SESSION_ROOT);

fs.mkdirSync(APP_DATA_ROOT, { recursive: true });
fs.mkdirSync(APP_RUNTIME_ROOT, { recursive: true });
fs.mkdirSync(APP_SESSION_ROOT, { recursive: true });

protocol.registerSchemesAsPrivileged([
  { scheme: 'chrome-profile', privileges: { bypassCSP: true, supportFetchAPI: true } },
]);

function getConfigPath() {
  if (!configPath) {
    configPath = path.join(app.getPath('userData'), 'workspaces.json');
  }
  return configPath;
}

function migrateLegacyWorkspaceFile() {
  try {
    const targetPath = getConfigPath();
    const legacyPath = path.join(LEGACY_ELECTRON_DATA_DIR, 'workspaces.json');

    if (fs.existsSync(targetPath) || !fs.existsSync(legacyPath)) return;
    fs.copyFileSync(legacyPath, targetPath);
  } catch (error) {
    console.error('Failed to migrate legacy workspace file:', error.message);
  }
}

function getChromeProfiles() {
  try {
    const localStatePath = path.join(USER_DATA_DIR, 'Local State');
    if (!fs.existsSync(localStatePath)) return [];

    const data = JSON.parse(fs.readFileSync(localStatePath, 'utf8'));
    const infoCache = data?.profile?.info_cache;
    if (!infoCache || typeof infoCache !== 'object') return [];

    const profiles = Object.entries(infoCache)
      .filter(([dir]) => dir !== 'Guest Profile' && dir !== 'System Profile')
      .map(([directory, info]) => {
        const picPath = path.join(USER_DATA_DIR, directory, 'Google Profile Picture.png');
        return {
          directory,
          name: info.name || directory,
          gaiaName: info.gaia_name || '',
          email: info.user_name || '',
          hasPhoto: fs.existsSync(picPath),
        };
      })
      .sort((a, b) => {
        if (a.directory === 'Default') return -1;
        if (b.directory === 'Default') return 1;
        const aNum = parseInt(a.directory.replace('Profile ', ''), 10) || 0;
        const bNum = parseInt(b.directory.replace('Profile ', ''), 10) || 0;
        return aNum - bNum;
      });

    return profiles;
  } catch (error) {
    console.error('Failed to read Chrome profiles:', error);
    return [];
  }
}

function getLinksPath() {
  return path.join(app.getPath('userData'), 'custom-links.json');
}

function loadLinks() {
  try {
    const target = getLinksPath();
    if (!fs.existsSync(target)) return [];
    const data = JSON.parse(fs.readFileSync(target, 'utf8'));
    if (!Array.isArray(data)) return [];
    return data.filter((item) => item && typeof item.name === 'string' && typeof item.url === 'string');
  } catch (error) {
    console.error('Failed to load links:', error);
    return [];
  }
}

function saveLinks(links) {
  try {
    fs.writeFileSync(getLinksPath(), JSON.stringify(links, null, 2));
  } catch (error) {
    console.error('Failed to save links:', error);
  }
}

function loadWorkspaces() {
  try {
    const target = getConfigPath();
    if (!fs.existsSync(target)) return [];
    const data = JSON.parse(fs.readFileSync(target, 'utf8'));
    if (!Array.isArray(data)) return [];
    return data.map((item) => ({
      name: item?.name || 'Unnamed',
      profileDirs: Array.isArray(item?.profileDirs) ? item.profileDirs : [],
      gridCols: Number.isInteger(item?.gridCols) ? item.gridCols : 2,
    }));
  } catch (error) {
    console.error('Failed to load workspaces:', error);
    return [];
  }
}

function saveWorkspaces(workspaces) {
  try {
    fs.writeFileSync(getConfigPath(), JSON.stringify(workspaces, null, 2));
  } catch (error) {
    console.error('Failed to save workspaces:', error);
  }
}

function findChromePath() {
  const candidates = {
    win32: [
      path.join(process.env['PROGRAMFILES'] || 'C:\\Program Files', 'Google', 'Chrome', 'Application', 'chrome.exe'),
      path.join(process.env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)', 'Google', 'Chrome', 'Application', 'chrome.exe'),
      path.join(getLocalAppData(), 'Google', 'Chrome', 'Application', 'chrome.exe'),
    ],
    darwin: [
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    ],
    linux: [
      '/usr/bin/google-chrome',
      '/usr/bin/google-chrome-stable',
      '/usr/bin/chromium-browser',
      '/usr/bin/chromium',
    ],
  };

  const list = candidates[process.platform] || [];
  return list.find((candidate) => fs.existsSync(candidate)) || null;
}

function computeGrid(count, preferredCols) {
  if (count <= 1) return { cols: 1, rows: 1 };
  const cols = Math.min(Math.max(preferredCols || Math.ceil(Math.sqrt(count)), 1), count);
  const rows = Math.ceil(count / cols);
  return { cols, rows };
}

function buildTileRects(count, preferredCols) {
  const { width, height, x: offsetX, y: offsetY } = screen.getPrimaryDisplay().workArea;
  const { cols, rows } = computeGrid(count, preferredCols);
  const tileWidth = Math.floor(width / cols);
  const tileHeight = Math.floor(height / rows);
  const rects = [];

  for (let index = 0; index < count; index += 1) {
    const col = index % cols;
    const row = Math.floor(index / cols);
    const x = offsetX + (col * tileWidth);
    const y = offsetY + (row * tileHeight);
    const rectWidth = col === cols - 1 ? width - (col * tileWidth) : tileWidth;
    const rectHeight = row === rows - 1 ? height - (row * tileHeight) : tileHeight;
    rects.push({ x, y, width: rectWidth, height: rectHeight });
  }

  return rects;
}

function repositionWindows(rects) {
  if (process.platform !== 'win32' || rects.length === 0) return;

  const rectsJson = JSON.stringify(rects.map(r => ({ x: r.x, y: r.y, w: r.width, h: r.height })));

  // Uses DwmGetWindowAttribute(DWMWA_EXTENDED_FRAME_BOUNDS) to detect invisible
  // window borders on Windows 10/11 and compensate so tiles fit perfectly edge-to-edge.
  const ps = `
Add-Type @"
using System;
using System.Runtime.InteropServices;
using System.Collections.Generic;
using System.Diagnostics;
using System.Text;

public struct RECT { public int Left, Top, Right, Bottom; }

public class WinTiler {
    [DllImport("user32.dll")] static extern bool SetWindowPos(IntPtr h, IntPtr a, int x, int y, int w, int h2, uint f);
    [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr h, int c);
    [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out RECT r);
    [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr h, int attr, out RECT r, int size);
    delegate bool EnumWindowsProc(IntPtr h, IntPtr l);
    [DllImport("user32.dll")] static extern bool EnumWindows(EnumWindowsProc cb, IntPtr l);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
    [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
    [DllImport("user32.dll", CharSet=CharSet.Auto)] static extern int GetWindowText(IntPtr h, StringBuilder sb, int max);
    [DllImport("user32.dll", CharSet=CharSet.Auto)] static extern int GetWindowTextLength(IntPtr h);
    [DllImport("user32.dll", CharSet=CharSet.Auto)] static extern int GetClassName(IntPtr h, StringBuilder sb, int max);

    public static List<IntPtr> GetChromeWindows() {
        var chromePids = new HashSet<uint>();
        foreach (var p in Process.GetProcessesByName("chrome")) {
            chromePids.Add((uint)p.Id);
        }
        var wins = new List<IntPtr>();
        EnumWindows((h, l) => {
            if (!IsWindowVisible(h) || GetWindowTextLength(h) == 0) return true;
            uint wp; GetWindowThreadProcessId(h, out wp);
            if (!chromePids.Contains(wp)) return true;
            var cls = new StringBuilder(256);
            GetClassName(h, cls, 256);
            if (cls.ToString() == "Chrome_WidgetWin_1") {
                var title = new StringBuilder(512);
                GetWindowText(h, title, 512);
                var t = title.ToString();
                if (t.Length > 0 && t != "Chrome Legacy Window") wins.Add(h);
            }
            return true;
        }, IntPtr.Zero);
        return wins;
    }

    public static void Tile(IntPtr[] handles, int[] xs, int[] ys, int[] ws, int[] hs) {
        int count = Math.Min(handles.Length, xs.Length);
        for (int i = 0; i < count; i++) {
            var h = handles[i];
            // Restore from maximized/minimized first
            ShowWindow(h, 9);

            // Step 1: place at target rect to measure border offsets
            SetWindowPos(h, IntPtr.Zero, xs[i], ys[i], ws[i], hs[i], 0x0040);

            // Step 2: measure invisible border offsets via DWM
            RECT wr, fr;
            GetWindowRect(h, out wr);
            int hr = DwmGetWindowAttribute(h, 9, out fr, Marshal.SizeOf(typeof(RECT)));
            if (hr != 0) continue; // DWM not available, skip compensation

            // Invisible border sizes (window rect is larger than visible frame)
            int bL = fr.Left - wr.Left;     // left invisible border
            int bT = fr.Top - wr.Top;       // top invisible border
            int bR = wr.Right - fr.Right;   // right invisible border
            int bB = wr.Bottom - fr.Bottom; // bottom invisible border

            // Step 3: re-place with compensation — expand by border amounts
            // so the VISIBLE part fills exactly the target rect
            int cx = xs[i] - bL;
            int cy = ys[i] - bT;
            int cw = ws[i] + bL + bR;
            int ch = hs[i] + bT + bB;
            SetWindowPos(h, IntPtr.Zero, cx, cy, cw, ch, 0x0040);
        }
    }
}
"@
$rects = '${rectsJson.replace(/'/g, "''")}' | ConvertFrom-Json
$wins = [WinTiler]::GetChromeWindows()
if ($wins.Count -eq 0) { exit }
$count = [Math]::Min($wins.Count, $rects.Count)
$handles = @(); $xs = @(); $ys = @(); $ws = @(); $hs = @()
for ($i = 0; $i -lt $count; $i++) {
    $handles += $wins[$i]
    $xs += $rects[$i].x; $ys += $rects[$i].y; $ws += $rects[$i].w; $hs += $rects[$i].h
}
[WinTiler]::Tile($handles, $xs, $ys, $ws, $hs)
`;

  execFile('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', ps],
    { timeout: 8000 }, (err) => {
      if (err) console.error('Reposition failed:', err.message);
    });
}

function retileAllManaged(preferredCols) {
  const running = Array.from(managedProfiles.entries()).filter(([, e]) => e.running);
  if (running.length === 0) return { ok: false, error: 'No managed Chrome windows are running.' };

  const dirs = running.map(([dir]) => dir);
  const cols = preferredCols || lastTileLayout?.preferredCols || Math.ceil(Math.sqrt(dirs.length));
  const rects = buildTileRects(dirs.length, cols);
  lastTileLayout = { dirs, rects, preferredCols: cols };

  repositionWindows(rects);
  return { ok: true, count: dirs.length };
}

function sendToUI(channel, payload) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send(channel, payload);
}

function listManagedStatuses() {
  return Array.from(managedProfiles.entries()).map(([profileDir, entry]) => ({
    profileDir,
    pid: entry.pid,
    running: entry.running,
    launchedAt: entry.launchedAt,
    chromePath: entry.chromePath,
  }));
}

function markStopped(profileDir) {
  const entry = managedProfiles.get(profileDir);
  if (!entry || !entry.running) return;
  entry.running = false;
  sendToUI('running-status-changed', listManagedStatuses());
}

function isPidRunning(pid) {
  if (!pid) return false;
  try {
    if (process.platform === 'win32') {
      const output = execFileSync('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], { encoding: 'utf8' });
      return output.toLowerCase().includes(`${pid}`) && !output.includes('No tasks are running');
    }
    process.kill(pid, 0);
    return true;
  } catch (_error) {
    return false;
  }
}

function refreshRunningStatuses() {
  let changed = false;
  for (const [profileDir, entry] of managedProfiles) {
    const running = isPidRunning(entry.pid);
    if (entry.running !== running) {
      entry.running = running;
      changed = true;
    }
    if (!running && entry.child && !entry.child.killed) {
      entry.child.removeAllListeners();
    }
  }
  if (changed) sendToUI('running-status-changed', listManagedStatuses());
}

function ensureStatusPolling() {
  if (statusTimer) return;
  statusTimer = setInterval(refreshRunningStatuses, 3000);
}

function stopStatusPolling() {
  if (!statusTimer) return;
  clearInterval(statusTimer);
  statusTimer = null;
}

function checkProfileChanges() {
  const newProfiles = getChromeProfiles();
  const newJson = JSON.stringify(newProfiles);
  if (newJson !== lastProfileJson) {
    lastProfileJson = newJson;
    sendToUI('profiles-changed', newProfiles);
  }
}

function startProfileWatcher() {
  const localStatePath = path.join(USER_DATA_DIR, 'Local State');

  // Initialize the cached state
  lastProfileJson = JSON.stringify(getChromeProfiles());

  // Watch the Local State file for changes (Chrome writes to it when profiles change)
  try {
    profileWatcher = fs.watch(localStatePath, { persistent: false }, () => {
      // Debounce: Chrome writes multiple times in quick succession
      clearTimeout(profileWatcherDebounce);
      profileWatcherDebounce = setTimeout(checkProfileChanges, 1500);
    });
  } catch (error) {
    console.error('Failed to watch Local State:', error.message);
  }

  // Also poll every 10 seconds as a fallback (watcher can miss events)
  setInterval(checkProfileChanges, 10000);
}

function stopProfileWatcher() {
  if (profileWatcher) {
    profileWatcher.close();
    profileWatcher = null;
  }
}

function closeManagedProfile(profileDir) {
  const entry = managedProfiles.get(profileDir);
  if (!entry || !entry.running) return false;

  try {
    if (process.platform === 'win32') {
      execFileSync('taskkill', ['/PID', String(entry.pid), '/T', '/F'], { stdio: 'ignore' });
    } else {
      process.kill(entry.pid, 'SIGTERM');
    }
  } catch (error) {
    console.error(`Failed to close profile ${profileDir}:`, error.message);
  }

  entry.running = false;
  return true;
}

function closeAllManagedProfiles() {
  let closedAny = false;
  for (const profileDir of managedProfiles.keys()) {
    if (closeManagedProfile(profileDir)) closedAny = true;
  }
  sendToUI('running-status-changed', listManagedStatuses());
  return closedAny;
}

function spawnChromeForProfiles(profileDirs, preferredCols, url) {
  const chromePath = findChromePath();
  if (!chromePath) {
    return { ok: false, error: 'Google Chrome was not found on this system.' };
  }

  const uniqueProfileDirs = Array.from(new Set(profileDirs)).filter(Boolean);
  if (uniqueProfileDirs.length === 0) {
    return { ok: false, error: 'No profiles were selected.' };
  }

  closeAllManagedProfiles();
  const rects = buildTileRects(uniqueProfileDirs.length, preferredCols);

  const launched = [];
  uniqueProfileDirs.forEach((profileDir, index) => {
    const rect = rects[index];
    const args = [
      `--user-data-dir=${USER_DATA_DIR}`,
      `--profile-directory=${profileDir}`,
      `--window-position=${rect.x},${rect.y}`,
      `--window-size=${Math.max(rect.width, 320)},${Math.max(rect.height, 240)}`,
      '--new-window',
      '--no-first-run',
      '--no-default-browser-check',
    ];
    if (url) args.push(url);

    try {
      const child = spawn(chromePath, args, {
        detached: process.platform !== 'win32',
        stdio: 'ignore',
      });

      child.unref();
      managedProfiles.set(profileDir, {
        pid: child.pid,
        running: true,
        launchedAt: Date.now(),
        chromePath,
        child,
      });

      child.once('exit', () => {
        markStopped(profileDir);
      });

      launched.push({ profileDir, pid: child.pid, rect });
    } catch (error) {
      console.error(`Failed to launch profile ${profileDir}:`, error);
    }
  });

  sendToUI('running-status-changed', listManagedStatuses());

  if (launched.length) {
    lastTileLayout = { dirs: uniqueProfileDirs, rects, preferredCols };
    // Force-reposition windows after Chrome has had time to create them.
    // Multiple passes: early windows may appear fast, others need more time.
    setTimeout(() => repositionWindows(rects), 2000);
    setTimeout(() => repositionWindows(rects), 4000);
    setTimeout(() => repositionWindows(rects), 7000);
  }

  return launched.length
    ? { ok: true, launched, statuses: listManagedStatuses() }
    : { ok: false, error: 'Chrome launch failed for all selected profiles.' };
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 960,
    minHeight: 640,
    title: 'Chrome Profile Manager',
    backgroundColor: '#0d1117',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.loadFile('index.html');

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

app.whenReady().then(() => {
  migrateLegacyWorkspaceFile();
  ensureStatusPolling();
  startProfileWatcher();

  // Serve Chrome profile pictures via chrome-profile://ProfileDir/photo
  protocol.handle('chrome-profile', (request) => {
    const url = new URL(request.url);
    const profileDir = decodeURIComponent(url.hostname);

    // Security: prevent path traversal — reject if directory contains
    // path separators, "..", or resolves outside the Chrome User Data folder.
    if (/[/\\]/.test(profileDir) || profileDir.includes('..')) {
      return new Response('', { status: 400 });
    }
    const picPath = path.join(USER_DATA_DIR, profileDir, 'Google Profile Picture.png');
    const resolved = path.resolve(picPath);
    if (!resolved.startsWith(path.resolve(USER_DATA_DIR) + path.sep)) {
      return new Response('', { status: 403 });
    }

    if (fs.existsSync(picPath)) {
      return net.fetch('file:///' + picPath.replace(/\\/g, '/'));
    }
    return new Response('', { status: 404 });
  });

  ipcMain.handle('get-profiles', () => getChromeProfiles());
  ipcMain.handle('get-workspaces', () => loadWorkspaces());
  ipcMain.handle('save-workspaces', (_event, workspaces) => {
    saveWorkspaces(workspaces);
    return true;
  });
  ipcMain.handle('launch-workspace', (_event, profileDirs, gridCols, url) => spawnChromeForProfiles(profileDirs, gridCols, url));
  ipcMain.handle('close-workspace', () => ({ ok: closeAllManagedProfiles(), statuses: listManagedStatuses() }));
  ipcMain.handle('get-running-statuses', () => listManagedStatuses());
  ipcMain.handle('close-profile', (_event, profileDir) => ({ ok: closeManagedProfile(profileDir), statuses: listManagedStatuses() }));
  ipcMain.handle('retile-windows', (_event, gridCols) => retileAllManaged(gridCols));
  ipcMain.handle('get-links', () => loadLinks());
  ipcMain.handle('save-links', (_event, links) => { saveLinks(links); return true; });

  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('before-quit', () => {
  closeAllManagedProfiles();
  stopStatusPolling();
  stopProfileWatcher();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
