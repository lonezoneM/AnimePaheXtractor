const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const https = require('https');
const { AppImageUpdater, MacUpdater, NsisUpdater } = require('electron-updater');
const { Database } = require('./database');
const child_process = require('child_process');

// Open external files/URLs safely
const openCmd = (() => {
  switch (process.platform) {
    case 'win32': return 'start';
    case 'darwin': return 'open';
    default: return 'xdg-open';
  }
})();

// Configure updater
const updater = (() => {
  const options = {
    provider: 'github',
    owner: 'lonezoneM',
    repo: 'AnimePaheXtractor',
    requestHeaders: { 'Cache-Control': 'no-cache, no-store, must-revalidate' }
  };

  let u;
  switch (process.platform) {
    case 'win32': u = new NsisUpdater(options); break;
    case 'darwin': u = new MacUpdater(options); break;
    default: u = new AppImageUpdater(options);
  }

  u.autoDownload = false;
  u.autoInstallOnAppQuit = true;
  return u;
})();

// Ensure single instance
if (!app.requestSingleInstanceLock()) app.quit();

const isDev = process.argv.includes('--dev');

// Version parsing helper
function versionArray(str) {
  const match = str.match(/^(\d+)\.(\d+)\.(\d+)$/);
  if (!match) throw new Error(`Invalid version string: ${str}`);
  return match.slice(1, 4).map(n => BigInt(n));
}

const [verMajor, verMinor, verPatch] = versionArray(app.getVersion());

// Create main BrowserWindow
function createWindow() {
  const rendererPath = path.join(__dirname, 'renderer', 'index');

  const mainWindow = new BrowserWindow({
    width: 800,
    minWidth: 800,
    height: 450,
    minHeight: 450,
    frame: false,
    show: false,
    backgroundColor: '#0000',
    webPreferences: {
      preload: path.join(rendererPath, 'preload.js'),
      sandbox: true
    }
  });

  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  mainWindow.once('ready-to-show', () => mainWindow.show());
  mainWindow.once('closed', () => app.quit());
  mainWindow.loadFile(path.join(rendererPath, 'index.html'));

  if (isDev) mainWindow.webContents.openDevTools();

  return mainWindow;
}

// Download with resume support
async function downloadFile(db, downloadId, url, filepath, onProgress) {
  await fs.promises.mkdir(path.dirname(filepath), { recursive: true });

  let record = await db.select('downloads', '*', `id='${downloadId}'`);
  let start = record?.completedBytes || 0;

  const fileStream = fs.createWriteStream(filepath, { flags: start ? 'r+' : 'w', start });
  const options = { headers: {} };
  if (start) options.headers['Range'] = `bytes=${start}-`;

  return new Promise((resolve, reject) => {
    https.get(url, options, async res => {
      const total = parseInt(res.headers['content-length'] || '0') + start;
      res.on('data', async chunk => {
        fileStream.write(chunk);
        start += chunk.length;
        onProgress(start, total);
        await db.update('downloads', `id='${downloadId}'`, ['completedBytes', start], ['totalBytes', total]);
      });

      res.on('end', async () => {
        fileStream.close();
        await db.update('downloads', `id='${downloadId}'`, ['completedBytes', total], ['status', 'completed']);
        resolve();
      });

      res.on('error', err => {
        fileStream.close();
        reject(err);
      });
    });
  });
}

// App ready
app.whenReady().then(async () => {
  try {
    // Open or create config DB
    const configDB = await Database.open('config');
    await configDB.createTable(
      'settings',
      ['key', Database.TYPE.TEXT],
      ['value', Database.TYPE.BLOB]
    );

    // Open or create downloads DB
    const downloadsDB = await Database.open('downloads');
    await downloadsDB.createTable(
      'downloads',
      ['id', Database.TYPE.TEXT],
      ['url', Database.TYPE.TEXT],
      ['filepath', Database.TYPE.TEXT],
      ['completedBytes', Database.TYPE.NUMERIC],
      ['totalBytes', Database.TYPE.NUMERIC],
      ['status', Database.TYPE.TEXT]
    );

    // Fetch or select library path
    let dbPath = await configDB.select('settings', ['value'], 'key="library_path"');
    let libraryPath = dbPath?.value;

    if (!libraryPath) {
      const { canceled, filePaths } = await dialog.showOpenDialog({
        title: 'Select a folder to store multimedia',
        properties: ['openDirectory']
      });

      if (canceled || !filePaths?.[0]) return app.quit();

      libraryPath = filePaths[0];
      await configDB.insert('settings', ['key', 'library_path'], ['value', libraryPath]);
    }

    // Set library path in apextractor
    const apextractor = require('./apextractor');
    apextractor.library.directory = libraryPath;

    const mainWindow = createWindow();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });

    // IPC handlers
    ipcMain.on('mainWindow:minimize', () => mainWindow.minimize());
    ipcMain.on('mainWindow:close', () => mainWindow.close());

    ipcMain.on('command:open', (_, target) => {
      try {
        const url = new URL(target);
        child_process.exec(`${openCmd} "${url}"`);
      } catch {
        console.error('Invalid URL:', target);
      }
    });

    ipcMain.on('social:repo', () =>
      child_process.exec(`${openCmd} "https://github.com/lonezoneM/AnimePaheXtractor/"`)
    );

    ipcMain.handle('updater:check', async () => {
      const result = { severity: 0, version: undefined };
      try {
        const update = await updater.checkForUpdates();
        const [major, minor, patch] = versionArray(update.updateInfo.version);

        result.version = update.updateInfo.version;
        result.severity =
          major > verMajor ? 3 :
          minor > verMinor ? 2 :
          patch > verPatch ? 1 : 0;
      } catch (err) {
        console.error(err);
      }
      return result;
    });

    updater.signals.progress(percent => {
      mainWindow.webContents.send('updater:download-progress', percent);
    });

    ipcMain.handle('updater:download', async () => {
      try {
        await updater.downloadUpdate();
        return true;
      } catch (err) {
        console.error(err);
        return false;
      }
    });

    ipcMain.on('updater:install', () => updater.quitAndInstall(true, true));

    // Download IPC handlers
    ipcMain.handle('download:start', async (_, { id, url, filename }) => {
      const filepath = path.join(libraryPath, filename);
      let existing = await downloadsDB.select('downloads', '*', `id='${id}'`);
      if (!existing) {
        await downloadsDB.insert('downloads',
          ['id', id],
          ['url', url],
          ['filepath', filepath],
          ['completedBytes', 0],
          ['totalBytes', 0],
          ['status', 'pending']
        );
      }
      downloadFile(downloadsDB, id, url, filepath, (done, total) => {
        mainWindow.webContents.send('download:progress', { id, done, total });
      }).catch(err => {
        console.error('Download error', err);
      });
      return true;
    });

    ipcMain.handle('download:resume-all', async () => {
      const pendingDownloads = await downloadsDB.select('downloads', '*', `status!='completed'`, true);
      for (const dl of pendingDownloads) {
        downloadFile(downloadsDB, dl.id, dl.url, dl.filepath, (done, total) => {
          mainWindow.webContents.send('download:progress', { id: dl.id, done, total });
        }).catch(console.error);
      }
      return true;
    });

  } catch (err) {
    const msg = err instanceof Error ? err.stack || err.message : String(err);
    dialog.showErrorBox("'Aw, snap!'", msg);
    app.quit();
  }
});
