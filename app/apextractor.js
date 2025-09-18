const { ipcMain } = require('electron');
const https = require('https');
const fs = require('fs').promises;
const path = require('path');
const zlib = require('zlib');
const ffmpeg = require('fluent-ffmpeg');
const ffmpegPath = require('ffmpeg-static');
ffmpeg.setFfmpegPath(ffmpegPath);

const defReferer = 'https://kwik.cx';

// --- Utilities ---
const packJSON = obj =>
  new Promise((res, rej) =>
    zlib.deflate(JSON.stringify(obj), (err, buf) => err ? rej(err) : res(buf))
  );

const unpackJSON = buf =>
  new Promise((res, rej) =>
    zlib.inflate(buf, (err, data) => err ? rej(err) : res(JSON.parse(data.toString())))
  );

async function sendRequest({ url, referer, checkHeaders = (h) => h['content-type'].includes('application') }) {
  if (!(url instanceof URL)) url = new URL(url);
  const headers = { Host: url.host, 'User-Agent': 'AnimePaheXtractor' };
  if (referer) headers.Referer = referer;

  return new Promise((resolve, reject) => {
    https.get(url.href, { headers, timeout: 60000 }, res => {
      const { statusCode } = res;
      let chunks = [];

      if (statusCode !== 200 || !checkHeaders(res.headers)) {
        return reject(new Error(`${statusCode} '${res.headers['content-type']}'`));
      }

      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks)));
    }).on('error', reject);
  });
}

// --- Extractor Class ---
class Extractor {
  constructor(serie, tempDir, outputDir, updateStatus) {
    this.serie = serie;
    this.tempDir = tempDir;
    this.outputDir = outputDir;
    this.updateStatus = updateStatus;
    this.queued = [];
    this.list = new Set();
    this.maxSlots = 7;
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

    // Check if there is resume metadata
    try {
      status = await unpackJSON(await fs.readFile(StatusPath));
      const existingM3U = await fs.readFile(M3UPath, 'utf-8');
      const metaMatch = existingM3U.match(/#EXT-X-METADATA:(.+)/);
      if (metaMatch) M3Umetadata = await unpackJSON(Buffer.from(metaMatch[1], 'base64'));
    } catch { /* no resume */ }

    // Fetch new M3U if needed
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

      // Mark all segments as not done
      status = {};
      segments.forEach((url, i) => status[i] = { url });

      M3Umetadata = { streamURL: streamURL.href, count: segments.length, key: keyBuffer?.toString('base64') };
      await fs.writeFile(M3UPath, `${segments.join('\n')}\n#EXT-X-METADATA:${(await packJSON(M3Umetadata)).toString('base64')}`);
      await fs.writeFile(StatusPath, await packJSON(status));
    }

    return { segments: Object.keys(status).map(k => status[k].url), keyBuffer: M3Umetadata.key ? Buffer.from(M3Umetadata.key, 'base64') : null, status, StatusPath, M3UPath, M3Umetadata };
  }

  async downloadSegment(url, filePath, progressCallback) {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    const writeStream = (await fs.open(filePath, 'a')).createWriteStream();

    return new Promise((resolve, reject) => {
      https.get(url, { headers: { Referer: defReferer, 'User-Agent': 'AnimePaheXtractor' } }, res => {
        const totalBytes = +res.headers['content-length'] || 0;
        let received = 0;

        res.on('data', chunk => {
          received += chunk.length;
          if (totalBytes) progressCallback(received / totalBytes);
        });

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

  async queueEpisodes(epList, preferred) {
    const list = await this.serie.getEpisodeListFromIntervals(epList);
    list.forEach(num => {
      if (!this.list.has(num)) {
        this.list.add(num);
        this.queued.push([num, preferred]);
      }
    });
    this.updateStatus('left', this.queued.length);
    this.runQueue();
  }

  async runQueue() {
    const slots = [];
    const trouble = [];
    while (this.queued.length || slots.length) {
      while (slots.length < this.maxSlots && this.queued.length) {
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
    this.updateStatus('end');
  }

  async processEpisode(num, preferred) {
    try {
      this.updateStatus('current', num);
      const ep = this.serie.episodes.get(num);
      if (!ep) throw new Error(`Episode ${num} missing`);

      const filename = `${ep.contains || num}.mp4`;
      const outputFile = path.join(this.outputDir, filename);
      const episodeTempDir = path.join(this.tempDir, num.toString());
      await fs.mkdir(episodeTempDir, { recursive: true });

      const options = await this.fetchEpisodeOptions(ep.session);
      const [url] = this.getBestMatch(options, preferred);

      const { segments, status, StatusPath, M3UPath } = await this.parseM3U(new URL(url), episodeTempDir);

      // Download missing segments
      for (const i of Object.keys(status)) {
        if (!status[i].done) {
          const segPath = path.join(episodeTempDir, `${i}.ts`);
          await this.downloadSegment(status[i].url, segPath, p => this.updateStatus('progress', p));
          status[i].done = true;
          await fs.writeFile(StatusPath, await packJSON(status));
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

// --- IPC example ---
ipcMain.handle('extract:start', async (_, serieID, epList, preferred) => {
  const serie = Serie.siblings[serieID]; // your Serie class
  if (!serie) return new Error('Serie not found');

  const extractor = new Extractor(
    serie,
    path.join(library.directory, '.data'),
    path.join(library.directory, serie.folder),
    (type, msg) => _?.sender?.send(`extract:updateStatus:${serie.id}`, [type, msg])
  );

  await extractor.queueEpisodes(epList, preferred);
  return 'Extraction started';
});

module.exports = { Extractor, packJSON, unpackJSON, sendRequest };
