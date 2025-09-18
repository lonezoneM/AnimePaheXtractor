const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const https = require('https');
const { AppImageUpdater, MacUpdater, NsisUpdater } = require('electron-updater');
const child_process = require('child_process');

const databaseModule = require('./database');

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
    const configDB = await databaseModule.Database.open('config');
    await configDB.createTable(
      'settings',
      ['key', databaseModule.Database.TYPE.TEXT],
      ['value', databaseModule.Database.TYPE.BLOB]
    );

    // Open or create downloads DB
    const downloadsDB = await databaseModule.Database.open('downloads');
    await downloadsDB.createTable(
      'downloads',
      ['id', databaseModule.Database.TYPE.TEXT],
      ['url', databaseModule.Database.TYPE.TEXT],
      ['filepath', databaseModule.Database.TYPE.TEXT],
      ['completedBytes', databaseModule.Database.TYPE.NUMERIC],
      ['totalBytes', databaseModule.Database.TYPE.NUMERIC],
      ['status', databaseModule.Database.TYPE.TEXT]
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

    // Set library path and initialize the main database module
    databaseModule.library.directory = libraryPath;
    await databaseModule.init();

    const mainWindow = createWindow();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });

    // IPC handlers from the old database.js file
    ipcMain.handle('serie:getDetailsFromID', (_, id) => {
        try { return databaseModule.Serie.getDetailsFromID(id); }
        catch (err) { return err; }
    });

    ipcMain.handle('serie:fetchPoster', async (_, id) => {
        try { return await databaseModule.Serie.siblings[id].fetchPoster(); }
        catch (err) { return err; }
    });

    ipcMain.handle('extract:start', ({ sender }, serieID, epList, preferred) => {
        try {
            const serie = databaseModule.Serie.siblings[serieID];
            if (!serie) throw new Error('Serie not found');
            databaseModule.Extract.create(serie, epList, preferred, (type, msg) => sender.send(`extract:updateStatus:${serieID}`, [type, msg]));
            return `Extraction started for "${serie.details.title}"`;
        } catch (err) { return err; }
    });

    // The other IPC handlers in main.js remain the same
    ipcMain.on('mainWindow:minimize', () => mainWindow.minimize());
    ipcMain.on('mainWindow:close', () => mainWindow.close());
    // ... (rest of the IPC handlers from main.js)
  } catch (err) {
    const msg = err instanceof Error ? err.stack || err.message : String(err);
    dialog.showErrorBox("'Aw, snap!'", msg);
    app.quit();
  }
});
