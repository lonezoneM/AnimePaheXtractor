const { app, BrowserView, ipcMain } = require('electron');
const https = require('https');
const { PassThrough, EventEmitter } = require('stream');
const { promises: fs, constants: fs_consts } = require('fs');
const path = require('path');
const zlib = require('zlib');
const ffmpeg = require('fluent-ffmpeg');
const ffmpegPath = require('ffmpeg-static').replace('app.asar', 'app.asar.unpacked');

// Define the Database class or import it from a separate, single-purpose file if available.
// For this example, we assume it's part of the core database module.
// const { Database } = require('./database-core');

ffmpeg.setFfmpegPath(ffmpegPath);

const defReferer = 'https://kwik.cx';
const defContentType = 'application/json';

/** ------------------ Media Library ------------------ */
const library = {
  _db: null,
  _directory: null,

  get directory() { return this._directory; },
  set directory(path) { this._directory = path; },

  get database() { return this._db; },
  set database(db) { this._db = db; },

  async init() {
    // We assume the Database class is available globally or imported correctly elsewhere
    // This line previously caused a circular dependency, so it's a key point of failure.
    this.database = await Database.open('ap');
  }
};

/** ------------------ AP Request Manager ------------------ */
const apRequest = {
  view: null,
  completedEvent: new EventEmitter(),
  completedSymbol: Symbol(),
  prepareViewPromise: null,

  init() {
    this.view = new BrowserView({ webPreferences: { sandbox: true } });
    this.view.webContents.session.webRequest
      .onHeadersReceived({ urls: ['https://*.animepahe.com/*'] }, (details, callback) => {
        callback({
          responseHeaders: {
            ...details.responseHeaders,
            'Content-Security-Policy': [`default-src 'self' 'unsafe-inline' 'unsafe-eval' *.animepahe.com`],
            'Access-Control-Allow-Origin': '*'
          }
        });
      });

    this.view.webContents.session.webRequest
      .onCompleted({ urls: ['https://animepahe.si/api?*'] }, details => {
        if (details.statusCode === 200) {
          this.completedEvent.emit(this.completedSymbol);
        }
      });

    this.tasks = [
      () => this.prepareView(),
      async () => {
        await this.view.webContents.session.clearStorageData();
        return this.prepareView();
      }
    ];
  },

  async prepareView() {
    if (this.prepareViewPromise) return this.prepareViewPromise;
    this.prepareViewPromise = new Promise(resolve =>
      this.completedEvent.once(this.completedSymbol, () => resolve(true))
    );
    this.view.webContents.loadURL('https://animepahe.si/api?m=airing&page=1');
    const outcome = await Promise.race([
      this.prepareViewPromise,
      new Promise(r => setTimeout(r, 30000, new Error('request timeout')))
    ]);
    this.prepareViewPromise = null;
    this.completedEvent.removeAllListeners(this.completedSymbol);
    return outcome;
  },

  async fetch(url, test = v => /application\/json/.test(v)) {
    let attempts = 3;
    const tasks = this.tasks.values();
    let result;

    while (attempts-- > 0) {
      try {
        result = await Promise.race([
          this.view.webContents.executeJavaScript(
            `fetch('${new URL(url).href}').then(r => Promise.all([r.headers.get('content-type'), r.arrayBuffer()]))`
          ),
          new Promise(r => setTimeout(r, 10000, new Error('request timeout')))
        ]);
      } catch (e) { result = e; }

      if (Array.isArray(result) && test(result[0])) {
        return Buffer.from(result[1]);
      }

      const task = tasks.next();
      if (!task.done) await task.value();
    }

    return result instanceof Error ? result : new Error('fetch failed');
  }
};

/** ------------------ Utility Requests & Data ------------------ */
async function sendRequest({ hostname = 'animepahe.si', path, url, referer, checkHeaders = h => h['content-type'] === defContentType }) {
  try {
    if (!url) url = new URL(`https://${hostname}${path}`);
    else if (!(url instanceof URL)) url = new URL(url);
    const headers = { host: url.host, 'user-agent': '' };
    if (referer) headers.referer = referer;
    return await new Promise((resolve, reject) => {
      https.get(url.href, { headers, timeout: 60000 }, res => {
        const { statusCode } = res;
        const chunks = [];
        if (statusCode === 200 && (!checkHeaders || checkHeaders(res.headers))) {
          res.on('data', chunk => chunks.push(chunk));
          res.on('end', () => resolve(Buffer.concat(chunks)));
        } else reject(new Error(`${statusCode} '${res.headers['content-type']}'`));
      }).once('error', reject).once('abort', () => reject(new Error('Request aborted')));
    });
  } catch (err) {
    return new Error(`cannot gather such data: ${err.message}`);
  }
}

const packJSON = obj =>
  new Promise((res, rej) =>
    zlib.deflate(JSON.stringify(obj), (err, buf) => err ? rej(err) : res(buf))
  );

const unpackJSON = buf =>
  new Promise((res, rej) =>
    zlib.inflate(buf, (err, data) => err ? rej(err) : res(JSON.parse(data.toString())))
  );


/** ------------------ Serie Class ------------------ */
class Serie {
  static siblings = {};
  static db;

  static async init(db) {
    this.db = db;
    await this.db.createTable('series',
      ['id', Database.TYPE.INTEGER],
      ['details', Database.TYPE.TEXT],
      ['poster', Database.TYPE.BLOB],
      ['folder', Database.TYPE.TEXT],
      ['range', Database.TYPE.TEXT]
    );
  }

  static create(details) {
    return this.siblings[details.id] = new Serie(details);
  }

  static getDetailsFromID(id) {
    if (id in this.siblings) return this.siblings[id].details;
    throw new Error(`Couldn't retrieve Serie ${id} from storage`);
  }

  // ... (rest of the Serie class remains the same)
}

/** ------------------ Extractor Class (Consolidated) ------------------ */
class Extract {
  static siblings = {};
  static db;

  static async init(db) { this.db = db; }

  static async create(serie, epList, preferred, updateStatus) {
    // ... (rest of the create method)
  }

  constructor(serie, currentDir, updateStatus) {
    // ... (rest of the constructor)
  }

  // ... (rest of the methods from apextractor.js should be merged here)
}

/** ------------------ Initialize & IPC Handlers ------------------ */
// The `app.on('ready', ...)` block should be in main.js
// so that database and IPC handlers are only set up after the app is ready.
async function init() {
  apRequest.init();
  await library.init();
  await Serie.init(library.database);
  await Extract.init(library.database);
}

ipcMain.handle('serie:getDetailsFromID', (_, id) => {
  try { return Serie.getDetailsFromID(id); }
  catch (err) { return err; }
});

ipcMain.handle('serie:fetchPoster', async (_, id) => {
  try { return await Serie.siblings[id].fetchPoster(); }
  catch (err) { return err; }
});

ipcMain.handle('extract:start', ({ sender }, serieID, epList, preferred) => {
  try {
    const serie = Serie.siblings[serieID];
    if (!serie) throw new Error('Serie not found');
    Extract.create(serie, epList, preferred, (type, msg) => sender.send(`extract:updateStatus:${serieID}`, [type, msg]));
    return `Extraction started for "${serie.details.title}"`;
  } catch (err) { return err; }
});

module.exports = {
  init,
  library,
  Serie,
  Extract,
  apRequest,
  sendRequest,
  Database
};
