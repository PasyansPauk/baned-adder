#!/usr/bin/env node
// Локальный сервер Baned Adder.
// • Раздаёт веб-приложение (папка public).
// • Если установлен ffmpeg — даёт быстрый рендер и анализ на компьютере (API /api/*).
// Без внешних зависимостей: только встроенные модули Node.js. Никаких ключей и облаков —
// файлы лежат во временной папке на этом компьютере и удаляются автоматически.
import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { pipeline } from 'node:stream/promises';
import { analyze, detectFfmpeg, probe, renderPart } from './media.js';
import { checkVideoUrl, detectYtDlp, downloadVideo } from './downloader.js';
import { sanitizeFileName } from '../public/js/core/util.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC = path.join(ROOT, 'public');
const PORT = Number(process.env.PORT) || 8787;
const HOST = process.env.HOST || '0.0.0.0';
const WORKSPACE = path.resolve(process.env.WORKSPACE || path.join(os.tmpdir(), 'baned-adder'));
const UPLOADS = path.join(WORKSPACE, 'uploads');
const JOBS_DIR = path.join(WORKSPACE, 'jobs');
const KEEP_HOURS = Number(process.env.KEEP_HOURS) || 24;
const MAX_UPLOAD = (Number(process.env.MAX_UPLOAD_GB) || 20) * 1024 ** 3;

// Что умеет этот сервер — приложение проверяет перед рендером.
const FEATURES = ['adChroma'];

// Отпечаток кода сервера на момент запуска: если файлы обновили (git pull), а сервер не перезапустили,
// он продолжает работать по старому коду — сообщаем об этом приложению.
function codeStamp() {
  const h = crypto.createHash('sha1');
  for (const dir of ['server', 'public/js/core']) {
    const abs = path.join(ROOT, dir);
    for (const f of fs.readdirSync(abs).filter((x) => x.endsWith('.js')).sort()) h.update(f).update(fs.readFileSync(path.join(abs, f)));
  }
  return h.digest('hex');
}
const STARTED_STAMP = codeStamp();

const ffmpeg = detectFfmpeg();
let ytdlp = detectYtDlp();
const jobs = new Map();
const renderQueue = [];
let rendering = false;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.txt': 'text/plain; charset=utf-8',
};

const ID_RE = /^[a-f0-9]{24}$/;
const newId = () => crypto.randomBytes(12).toString('hex');

function send(res, status, body, headers = {}) {
  const isObj = typeof body === 'object' && !Buffer.isBuffer(body);
  const data = isObj ? JSON.stringify(body) : body;
  res.writeHead(status, {
    'Content-Type': isObj ? 'application/json; charset=utf-8' : 'text/plain; charset=utf-8',
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(data);
}

async function readJson(req, limit = 32 * 1024 * 1024) {
  let size = 0;
  const chunks = [];
  for await (const c of req) {
    size += c.length;
    if (size > limit) throw Object.assign(new Error('Слишком большой запрос'), { status: 413 });
    chunks.push(c);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
  } catch {
    throw Object.assign(new Error('Некорректный JSON'), { status: 400 });
  }
}

function uploadPath(id) {
  if (!ID_RE.test(String(id))) throw Object.assign(new Error('Неизвестный файл'), { status: 400 });
  const meta = uploads.get(id);
  if (!meta) throw Object.assign(new Error('Файл не найден на сервере — загрузите заново'), { status: 404 });
  return meta.path;
}

const uploads = new Map(); // id → { path, name, size, info }

function lanUrls() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list || []) {
      if (a.family === 'IPv4' && !a.internal) out.push(`http://${a.address}:${PORT}/`);
    }
  }
  return out;
}

// ---------------------------------------------------------------- jobs

function createJob(type, extra = {}) {
  const job = {
    id: newId(),
    type,
    status: 'queued',
    progress: 0,
    message: '',
    results: [],
    created: Date.now(),
    controller: new AbortController(),
    ...extra,
  };
  jobs.set(job.id, job);
  return job;
}

function publicJob(job) {
  const { controller, specs, ...rest } = job;
  return rest;
}

async function runAnalysis(job, file) {
  job.status = 'running';
  try {
    job.result = await analyze(file, (p) => (job.progress = p), job.controller.signal);
    job.progress = 1;
    job.status = 'done';
  } catch (e) {
    job.status = job.controller.signal.aborted ? 'canceled' : 'error';
    job.error = e.message;
  }
}

async function runDownload(job, url) {
  job.status = 'running';
  const dir = path.join(JOBS_DIR, job.id);
  try {
    const r = await downloadVideo(url, dir, {
      signal: job.controller.signal,
      onProgress: (p, msg) => {
        job.progress = p;
        if (msg) job.message = msg;
      },
    });
    const st = await fsp.stat(r.file);
    // файл сразу доступен как исходник для анализа и рендера — повторно грузить не нужно
    const uploadId = newId();
    uploads.set(uploadId, { path: r.file, name: r.name, size: st.size, created: Date.now(), info: r.info });
    job.result = {
      uploadId,
      name: r.name,
      title: r.title,
      site: r.site,
      size: st.size,
      info: r.info,
      url: `/api/files/${job.id}/${encodeURIComponent(r.name)}`,
    };
    job.progress = 1;
    job.status = 'done';
    job.message = 'Готово';
  } catch (e) {
    job.status = job.controller.signal.aborted ? 'canceled' : 'error';
    job.error = job.controller.signal.aborted ? 'Отменено' : e.message;
    await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

async function pumpRenderQueue() {
  if (rendering) return;
  const job = renderQueue.shift();
  if (!job) return;
  rendering = true;
  job.status = 'running';
  const dir = path.join(JOBS_DIR, job.id);
  try {
    await fsp.mkdir(dir, { recursive: true });
    const src = uploadPath(job.sourceId);
    const srcInfo = uploads.get(job.sourceId).info || (await probe(src));
    const adAudio = new Map();
    for (const p of job.specs) {
      for (const av of p.spec.adVideos || []) {
        if (!adAudio.has(av.file)) adAudio.set(av.file, (await probe(uploadPath(av.file))).hasAudio);
      }
    }
    const used = new Set();
    for (let i = 0; i < job.specs.length; i++) {
      if (job.controller.signal.aborted) throw new Error('Отменено');
      const { spec, fileName } = job.specs[i];
      let base = sanitizeFileName(fileName, `part${i + 1}`);
      while (used.has(base)) base += '_';
      used.add(base);
      const name = `${base}.mp4`;
      const output = path.join(dir, name);
      job.current = i;
      job.message = `Часть ${i + 1} из ${job.specs.length}`;
      const t0 = Date.now();
      await renderPart(
        spec,
        {
          src,
          output,
          resolve: uploadPath,
          srcHasAudio: srcInfo.hasAudio,
          adHasAudio: (id) => adAudio.get(id),
          encoder: job.encoder === 'videotoolbox' && ffmpeg.encoders?.videotoolbox ? 'videotoolbox' : 'x264',
          quality: job.quality,
        },
        (p) => (job.progress = (i + p) / job.specs.length),
        job.controller.signal
      );
      const st = await fsp.stat(output);
      job.results.push({
        index: spec.partIndex ?? i,
        name,
        size: st.size,
        seconds: (Date.now() - t0) / 1000,
        url: `/api/files/${job.id}/${encodeURIComponent(name)}`,
      });
    }
    job.progress = 1;
    job.status = 'done';
    job.message = 'Готово';
  } catch (e) {
    job.status = job.controller.signal.aborted ? 'canceled' : 'error';
    job.error = e.message;
  } finally {
    rendering = false;
    pumpRenderQueue();
  }
}

// ---------------------------------------------------------------- handlers

async function handleUpload(req, res, url) {
  const name = String(url.searchParams.get('name') || 'file').slice(0, 200);
  const ext = (path.extname(name).toLowerCase().match(/^\.[a-z0-9]{1,5}$/) || ['.bin'])[0];
  const declared = Number(req.headers['content-length'] || 0);
  if (declared > MAX_UPLOAD) return send(res, 413, { error: 'Файл слишком большой' });
  const id = newId();
  const file = path.join(UPLOADS, id + ext);
  let size = 0;
  req.on('data', (c) => {
    size += c.length;
    if (size > MAX_UPLOAD) req.destroy(new Error('too large'));
  });
  try {
    await pipeline(req, fs.createWriteStream(file, { flags: 'wx' }));
  } catch (e) {
    await fsp.rm(file, { force: true });
    return send(res, 400, { error: 'Загрузка прервана' });
  }
  const meta = { path: file, name, size, created: Date.now() };
  if (url.searchParams.get('probe') === '1') {
    try {
      meta.info = await probe(file);
    } catch {
      meta.info = null;
    }
  }
  uploads.set(id, meta);
  send(res, 200, { id, size, info: meta.info || null });
}

async function serveFile(req, res, file, { download = false, name } = {}) {
  let st;
  try {
    st = await fsp.stat(file);
    if (!st.isFile()) throw new Error();
  } catch {
    return send(res, 404, 'Не найдено');
  }
  const type = MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
  const headers = {
    'Content-Type': type,
    'Accept-Ranges': 'bytes',
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control': file.startsWith(PUBLIC) ? 'no-cache' : 'no-store',
  };
  if (download) {
    const n = name || path.basename(file);
    const ascii = n.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
    const star = encodeURIComponent(n).replace(/['()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());
    headers['Content-Disposition'] = `attachment; filename="${ascii}"; filename*=UTF-8''${star}`;
  }
  // Range нужен Safari/iPhone для воспроизведения видео
  const range = req.headers.range && /^bytes=(\d*)-(\d*)$/.exec(req.headers.range);
  if (range) {
    let start = range[1] ? Number(range[1]) : st.size - Number(range[2]);
    let end = range[1] && range[2] ? Number(range[2]) : st.size - 1;
    if (!range[1]) end = st.size - 1;
    if (start < 0 || start >= st.size || end < start) {
      res.writeHead(416, { 'Content-Range': `bytes */${st.size}` });
      return res.end();
    }
    end = Math.min(end, st.size - 1);
    res.writeHead(206, { ...headers, 'Content-Range': `bytes ${start}-${end}/${st.size}`, 'Content-Length': end - start + 1 });
    if (req.method === 'HEAD') return res.end();
    return fs.createReadStream(file, { start, end }).pipe(res);
  }
  res.writeHead(200, { ...headers, 'Content-Length': st.size });
  if (req.method === 'HEAD') return res.end();
  fs.createReadStream(file).pipe(res);
}

async function route(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const p = decodeURIComponent(url.pathname);

  if (p.startsWith('/api/')) {
    if (p === '/api/status' && req.method === 'GET') {
      if (!ytdlp.available) ytdlp = detectYtDlp(); // вдруг поставили после запуска сервера
      return send(res, 200, {
        app: 'baned-adder',
        ffmpeg,
        ytdlp,
        lanUrls: lanUrls(),
        platform: process.platform,
        features: FEATURES,
        stale: codeStamp() !== STARTED_STAMP,
      });
    }
    if (!ffmpeg.available && p !== '/api/status') {
      return send(res, 503, { error: 'ffmpeg не найден. Установка описана в README (Homebrew, MacPorts или готовый файл)' });
    }
    if (p === '/api/upload' && req.method === 'POST') return handleUpload(req, res, url);

    let m;
    if ((m = p.match(/^\/api\/uploads\/([a-f0-9]{24})$/)) && req.method === 'DELETE') {
      const meta = uploads.get(m[1]);
      if (meta) {
        uploads.delete(m[1]);
        await fsp.rm(meta.path, { force: true });
      }
      return send(res, 200, { ok: true });
    }
    if (p === '/api/analyze' && req.method === 'POST') {
      const body = await readJson(req);
      const file = uploadPath(body.id);
      const job = createJob('analyze');
      runAnalysis(job, file);
      return send(res, 200, { jobId: job.id });
    }
    if (p === '/api/fetch' && req.method === 'POST') {
      const body = await readJson(req, 64 * 1024);
      if (!ytdlp.available) ytdlp = detectYtDlp();
      if (!ytdlp.available) return send(res, 503, { error: 'На компьютере не установлен yt-dlp. Установка описана в README (Homebrew, MacPorts или готовый файл)' });
      const check = checkVideoUrl(body.url);
      if (!check.ok) return send(res, 400, { error: check.error });
      const job = createJob('download', { site: check.site });
      runDownload(job, check.url);
      return send(res, 200, { jobId: job.id });
    }
    if (p === '/api/render' && req.method === 'POST') {
      const body = await readJson(req);
      uploadPath(body.sourceId);
      if (!Array.isArray(body.parts) || !body.parts.length || body.parts.length > 500) {
        return send(res, 400, { error: 'Нет частей для рендера' });
      }
      for (const part of body.parts) {
        for (const l of part.spec?.layers || []) uploadPath(l.file);
        for (const v of part.spec?.adVideos || []) uploadPath(v.file);
      }
      const job = createJob('render', {
        sourceId: body.sourceId,
        specs: body.parts,
        encoder: body.encoder,
        quality: body.quality,
        total: body.parts.length,
      });
      renderQueue.push(job);
      pumpRenderQueue();
      return send(res, 200, { jobId: job.id });
    }
    if ((m = p.match(/^\/api\/jobs\/([a-f0-9]{24})$/)) && req.method === 'GET') {
      const job = jobs.get(m[1]);
      return job ? send(res, 200, publicJob(job)) : send(res, 404, { error: 'Задача не найдена' });
    }
    if ((m = p.match(/^\/api\/jobs\/([a-f0-9]{24})\/cancel$/)) && req.method === 'POST') {
      const job = jobs.get(m[1]);
      if (job) {
        job.controller.abort();
        const qi = renderQueue.indexOf(job);
        if (qi >= 0) {
          renderQueue.splice(qi, 1);
          job.status = 'canceled';
        }
      }
      return send(res, 200, { ok: true });
    }
    if ((m = p.match(/^\/api\/files\/([a-f0-9]{24})\/([^/]+)$/)) && (req.method === 'GET' || req.method === 'HEAD')) {
      const name = path.basename(m[2]);
      if (!jobs.has(m[1]) || name !== m[2] || name.startsWith('.')) return send(res, 404, 'Не найдено');
      return serveFile(req, res, path.join(JOBS_DIR, m[1], name), {
        download: url.searchParams.get('download') === '1',
        name,
      });
    }
    return send(res, 404, { error: 'Нет такого метода API' });
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'Method not allowed');
  const rel = p === '/' ? 'index.html' : p.replace(/^\/+/, '');
  const file = path.resolve(PUBLIC, rel);
  if (!file.startsWith(PUBLIC + path.sep)) return send(res, 403, 'Forbidden');
  return serveFile(req, res, file);
}

async function cleanup() {
  const cutoff = Date.now() - KEEP_HOURS * 3600 * 1000;
  for (const dir of [UPLOADS, JOBS_DIR]) {
    let entries = [];
    try {
      entries = await fsp.readdir(dir);
    } catch {
      continue;
    }
    for (const e of entries) {
      const full = path.join(dir, e);
      try {
        const st = await fsp.stat(full);
        if (st.mtimeMs < cutoff) await fsp.rm(full, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
  }
  for (const [id, job] of jobs) if (job.created < cutoff && job.status !== 'running') jobs.delete(id);
  for (const [id, u] of uploads) if (u.created < cutoff) uploads.delete(id);
}

await fsp.mkdir(UPLOADS, { recursive: true });
await fsp.mkdir(JOBS_DIR, { recursive: true });
await cleanup();
setInterval(cleanup, 3600 * 1000).unref();

const server = http.createServer((req, res) => {
  route(req, res).catch((e) => {
    if (!res.headersSent) send(res, e.status || 500, { error: e.message || 'Ошибка сервера' });
    else res.destroy();
  });
});
server.requestTimeout = 0; // большие видео грузятся долго
server.headersTimeout = 60_000;

server.listen(PORT, HOST, () => {
  const line = '─'.repeat(56);
  console.log(`\n${line}\n  Baned Adder запущен\n${line}`);
  console.log(`  На этом компьютере:  http://localhost:${PORT}/`);
  if (HOST === '0.0.0.0') {
    for (const u of lanUrls()) console.log(`  С iPhone (та же Wi-Fi сеть):  ${u}`);
  }
  console.log(
    ffmpeg.available
      ? `  ffmpeg ${ffmpeg.version}: быстрый рендер включён` +
          (ffmpeg.encoders?.videotoolbox ? ' (+ аппаратный VideoToolbox)' : '')
      : '  ffmpeg не найден — доступен только рендер в браузере.\n  Установка описана в README (Homebrew, MacPorts или готовый файл)'
  );
  console.log(
    ytdlp.available
      ? `  yt-dlp ${ytdlp.version}: скачивание по ссылкам YouTube/TikTok включено`
      : '  yt-dlp не найден — скачивание по ссылкам выключено.\n  Установка описана в README'
  );
  console.log(`  Временные файлы: ${WORKSPACE} (удаляются через ${KEEP_HOURS} ч)`);
  console.log(`  Остановить: Ctrl+C\n${line}\n`);
});

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    console.error(`Порт ${PORT} занят. Запустите на другом: PORT=8790 npm start`);
    process.exit(1);
  }
  throw e;
});
