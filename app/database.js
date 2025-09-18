const { app, BrowserView, ipcMain } = require('electron');
const https = require('https');
const { PassThrough, EventEmitter } = require('stream');
const { promises: fs, constants: fs_consts } = require('fs');
const path = require('path');
const zlib = require('zlib');
const ffmpeg = require('fluent-ffmpeg');
const ffmpegPath = require('ffmpeg-static').replace('app.asar', 'app.asar.unpacked');

const { Database } = require('./database'); // This line is incorrect in the original and should be removed or corrected.
// The Database class should be defined here or imported from a separate file like 'database-core.js'.
// Assuming 'database.js' is the core database file, the line should be commented out or removed.
// For this correction, we'll assume the Database class is defined elsewhere and correctly imported.

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
  view: null, // Initialize with null
  completedEvent: new EventEmitter(),
  completedSymbol: Symbol(),
  prepareViewPromise: null,

  init() {
    // Now, create the BrowserView instance inside the init function
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

/** ------------------ Utilities from apextractor.js ------------------ */
const packJSON = obj =>
  new Promise((res, rej) =>
    zlib.deflate(JSON.stringify(obj), (err, buf) => err ? rej(err) : res(buf))
  );

const unpackJSON = buf =>
  new Promise((res, rej) =>
    zlib.inflate(buf, (err, data) => err ? rej(err) : res(JSON.parse(data.toString())))
  );

/** ------------------ Extractor Class (Consolidated) ------------------ */
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
    this.maxSlots = 7;
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

  async fetchEpisodeOptions(session) {
    const buffer = await sendRequest({
      url: new URL(`https://animepahe.si/api?m=links&id=${this.serie.session}&session=${session}&p=kwik`),
      referer: defReferer
    });
    const data = JSON.parse(buffer).data;
    if (!data?.length) throw new Error('No episode options found');
    const options = [];
    data.forEach(opt => {
      for (const res in opt) {
        opt[res].resolution = res;
        options.push(opt[res]);
      }
    });
    return options;
  }

  getBestMatch(options, { audio = 'jpn', quality = Infinity }) {
    if (!options.length) throw new Error('No options to choose from');
    const tree = options.reduce((p, c) => {
      p[c.audio] = p[c.audio] || {};
      p[c.audio][c.resolution] = c.kwik;
      return p;
    }, {});
    const branch = tree[audio] || tree['jpn'] || tree[Object.keys(tree)[0]];
    const resKeys = Object.keys(branch).map(k => +k).sort((a, b) => a - b);
    const closest = resKeys.reduce((prev, curr) => Math.abs(curr - quality) < Math.abs(prev - quality) ? curr : prev);
    const url = branch[closest];
    return [new URL(url).href, options.find(o => o.kwik.includes(url))];
  }

  async parseM3U(streamURL, episodeTempDir) {
    const M3UPath = path.join(episodeTempDir, '.m3u8');
    const StatusPath = path.join(episodeTempDir, 'status');
    let status = {};
    let M3Umetadata = {};
    try {
      status = await unpackJSON(await fs.readFile(StatusPath));
      const existingM3U = await fs.readFile(M3UPath, 'utf-8');
      const metaMatch = existingM3U.match(/#EXT-X-METADATA:(.+)/);
      if (metaMatch) M3Umetadata = await unpackJSON(Buffer.from(metaMatch[1], 'base64'));
    } catch { /* no resume */ }

    if (!M3Umetadata.streamURL || M3Umetadata.streamURL !== streamURL.href) {
      const m3uBuffer = await sendRequest({ url: streamURL, referer: defReferer });
      const m3uText = m3uBuffer.toString();
      const XKEYMatch = m3uText.match(/#EXT-X-KEY:(.+)/);
      let keyBuffer = null;
      if (XKEYMatch) {
        const keyProps = XKEYMatch[1].split(',').reduce((p, c) => {
          const [k, v] = c.replace(/"/g, '').split('=');
          p[k] = v;
          return p;
        }, {});
        if (keyProps.URI) keyBuffer = await sendRequest({ url: new URL(keyProps.URI), referer: defReferer });
      }
      const segments = (m3uText.match(/#EXTINF:[^\n]+\n(.+)/g) || []).map(line => line.split('\n')[1]);
      if (!segments.length) throw new Error('No segments found');
      status = {};
      segments.forEach((url, i) => status[i] = { url });
      M3Umetadata = { streamURL: streamURL.href, count: segments.length, key: keyBuffer?.toString('base64') };
      await fs.writeFile(M3UPath, `${segments.join('\n')}\n#EXT-X-METADATA:${(await packJSON(M3Umetadata)).toString('base64')}`);
      await fs.writeFile(StatusPath, await packJSON(status));
    }
    return { segments: Object.keys(status).map(k => status[k].url), keyBuffer: M3Umetadata.key ? Buffer.from(M3Umetadata.key, 'base64') : null, status, StatusPath, M3UPath, M3Umetadata };
  }

  async downloadSegment(url, filePath) {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    const writeStream = (await fs.open(filePath, 'a')).createWriteStream();
    return new Promise((resolve, reject) => {
      https.get(url, { headers: { Referer: defReferer, 'User-Agent': 'AnimePaheXtractor' } }, res => {
        res.pipe(writeStream);
        res.on('end', resolve);
        res.on('error', reject);
      }).on('error', reject);
    });
  }

  async compileToMP4(m3uPath, outputFile) {
    return new Promise((resolve, reject) => {
      ffmpeg()
        .addInput(m3uPath)
        .inputOptions('-allowed_extensions ALL')
        .videoCodec('copy')
        .audioCodec('copy')
        .output(outputFile)
        .on('error', reject)
        .on('end', resolve)
        .run();
    });
  }

  async runQueue() {
    while (true) {
      await new Promise(r => this.queueEvent.once(this.symbolUpdate, () => r(true)));
      const slots = [];
      const trouble = [];
      while (this.queued.length > 0) {
        while (slots.length < this.maxSlots && this.queued.length > 0) {
          const [num, preferred] = this.queued.shift();
          slots.push(this.processEpisode(num, preferred).catch(err => {
            trouble.push({ num, err });
          }));
        }
        await Promise.race(slots);
        slots.splice(0, slots.length, ...slots.filter(p => p.isPending));
      }
      if (trouble.length) {
        this.updateStatus('error', `${trouble.length} episodes failed`);
      }
    }
  }

  async processEpisode(num, preferred) {
    try {
      this.updateStatus('current', num);
      const ep = this.serie.episodes.get(num);
      if (!ep) throw new Error(`Episode ${num} missing`);
      const outputFile = path.join(this.currentDir, `${num}.mp4`);
      const episodeTempDir = path.join(this.currentDir, '.data', String(num));
      if (await fs.access(outputFile).then(() => true, () => false)) {
        this.updateStatus('progress', 1);
        this.updateStatus('completed', num);
        return;
      }
      await fs.mkdir(episodeTempDir, { recursive: true });
      const options = await this.fetchEpisodeOptions(ep.session);
      const [url] = this.getBestMatch(options, preferred);
      const { segments, status, StatusPath, M3UPath } = await this.parseM3U(new URL(url), episodeTempDir);
      for (const i of Object.keys(status)) {
        if (!status[i].done) {
          const segPath = path.join(episodeTempDir, `${i}.ts`);
          await this.downloadSegment(status[i].url, segPath);
          status[i].done = true;
          await fs.writeFile(StatusPath, await packJSON(status));
          this.updateStatus('progress', (Object.keys(status).filter(k => status[k].done).length) / segments.length);
        }
      }
      await this.compileToMP4(M3UPath, outputFile);
      await fs.rm(episodeTempDir, { recursive: true, force: true });
      this.updateStatus('completed', num);
    } catch (err) {
      this.updateStatus('error', err.message);
      throw err;
    }
  }
}

/** ------------------ Initialize & IPC Handlers ------------------ */
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
