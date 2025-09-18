const { BrowserView, ipcMain } = require('electron');
const https = require('https');
const { PassThrough, EventEmitter } = require('stream');
const { promises: fs, constants: fs_consts } = require('fs');
const path = require('path');
const zlib = require('zlib');
const ffmpeg = require('fluent-ffmpeg');
const ffmpegPath = require('ffmpeg-static').replace('app.asar', 'app.asar.unpacked');

const { Database } = require('./database'); // Optimized DB

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
    this.database = await Database.open('ap');
  }
};

/** ------------------ AP Request Manager ------------------ */
const apRequest = {
  view: new BrowserView({ webPreferences: { sandbox: true } }),
  completedEvent: new EventEmitter(),
  completedSymbol: Symbol(),
  prepareViewPromise: null,

  init() {
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
apRequest.init();

/** ------------------ Utility Requests ------------------ */
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

  _b64Poster;
  get b64Poster() { return this._b64Poster; }
  set b64Poster(value) { this._b64Poster = `data:image/*;base64,${value.toString('base64')}`; }

  constructor({ id, session, title, episodes, poster }) {
    this.id = id;
    this.session = session;
    this.details = { title, episodes, poster };
    this.episodes = new Map();
  }

  async fetchPoster() {
    if (!this.b64Poster) {
      const buffer = await apRequest.fetch(this.details.poster, v => /image/.test(v));
      if (buffer instanceof Error) throw buffer;
      this.b64Poster = buffer;
      await Serie.db.update('series', `id = ${this.id}`, ['poster', buffer]);
    }
    return this.b64Poster;
  }

  async fetchPage(pageNumber) {
    const buffer = await apRequest.fetch(`https://animepahe.si/api?m=release&id=${this.session}&sort=episode_asc&page=${pageNumber}`);
    const data = JSON.parse(buffer);
    return data;
  }

  async fetchOptions(session) {
    const buffer = await apRequest.fetch(`https://animepahe.si/api?m=links&id=${this.session}&session=${session}&p=kwik`);
    const options = [];
    for (const item of JSON.parse(buffer).data)
      for (const key in item) { item[key].resolution = key; options.push(item[key]); }
    return options;
  }
}

/** ------------------ Extract Class with Resume Support ------------------ */
class Extract {
  static siblings = {};
  static db;

  static async init(db) { this.db = db; }

  static async create(serie, epList, preferred, updateStatus) {
    if (await fs.access(library.directory, fs_consts.F_OK).catch(() => true))
      return updateStatus('error', new Error(`folder "${library.directory}" doesn't exist`));

    const folder = serie.folder || serie.details.title.replace(/[^\w\s]/g, '_').replace(/\s/g, '-');
    serie.folder = folder;
    await Serie.db.update('series', `id = ${serie.id}`, ['folder', folder]);

    const currentDir = path.join(library.directory, folder);
    if (await fs.access(currentDir, fs_consts.F_OK).catch(() => true))
      await fs.mkdir(path.join(currentDir, '.data'), { recursive: true });

    const extract = new Extract(serie, currentDir, updateStatus);
    extract.queue(epList, preferred);
  }

  constructor(serie, currentDir, updateStatus) {
    this.serie = serie;
    this.currentDir = currentDir;
    this.updateStatus = updateStatus;
    this.list = new Set();
    this.queued = [];
    this.queueEvent = new EventEmitter();
    this.symbolUpdate = Symbol();
    this.runQueue();
  }

  async queue(epList, preferred) {
    const list = new Set(epList.split(',').map(n => +n));
    for (const ep of list) {
      if (!this.list.has(ep)) {
        this.list.add(ep);
        this.queued.push([ep, preferred]);
      }
    }
    this.queueEvent.emit(this.symbolUpdate);
    this.updateStatus('left', this.queued.length);
  }

  async runQueue() {
    while (true) {
      await new Promise(r => this.queueEvent.once(this.symbolUpdate, () => r(true)));

      while (this.queued.length > 0) {
        const [num, preferred] = this.queued.pop();
        this.updateStatus('left', this.queued.length);
        try {
          const ep = this.serie.episodes.get(num);
          if (!ep) throw `episode ${num} not found`;
          const outputFile = path.join(this.currentDir, `${num}.mp4`);
          if (await fs.access(outputFile).then(() => true, () => false)) continue;

          const options = await this.serie.fetchOptions(ep.session);
          const url = new URL(options[0].kwik); // Simplified for demo

          await this.downloadAndAssemble(url, num);
        } catch (err) {
          this.updateStatus('error', err.message || err);
        }
      }
    }
  }

  async downloadAndAssemble(url, num) {
    const tempFolder = path.join(this.currentDir, '.data', String(num));
    await fs.mkdir(tempFolder, { recursive: true });
    const m3u8Path = path.join(tempFolder, '.m3u8');
    const outputFile = path.join(this.currentDir, `${num}.mp4`);

    // Download M3U8
    const m3u8Data = await sendRequest({ url, referer: defReferer });
    await fs.writeFile(m3u8Path, m3u8Data);

    // Assemble via ffmpeg
    await new Promise((resolve, reject) => {
      ffmpeg()
        .input(m3u8Path)
        .inputOptions('-allowed_extensions ALL')
        .videoCodec('copy')
        .audioCodec('copy')
        .output(outputFile)
        .on('end', resolve)
        .on('error', reject)
        .run();
    });

    await fs.rm(tempFolder, { recursive: true });
    this.updateStatus('progress', 1);
  }
}

/** ------------------ Initialize ------------------ */
(async () => {
  await library.init();
  await Serie.init(library.database);
  await Extract.init(library.database);

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
})();
