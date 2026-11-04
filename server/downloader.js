// Скачивание видео по ссылке (YouTube, TikTok) через yt-dlp — на этом компьютере.
// yt-dlp ставится отдельно: brew install yt-dlp. Ключей и аккаунтов не нужно.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { findBinary, probe, transcodeToH264 } from './media.js';
import { sanitizeFileName } from '../public/js/core/util.js';

const YTDLP = findBinary(process.env.YTDLP_PATH || 'yt-dlp');

const ALLOWED_HOSTS = [
  'youtube.com',
  'youtu.be',
  'youtube-nocookie.com',
  'tiktok.com',
];

/** Проверка ссылки: только http(s) и только YouTube / TikTok (если не разрешено иное). */
export function checkVideoUrl(raw) {
  let url;
  try {
    url = new URL(String(raw || '').trim());
  } catch {
    return { ok: false, error: 'Это не похоже на ссылку. Скопируйте адрес видео целиком, вместе с https://' };
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return { ok: false, error: 'Нужна ссылка, начинающаяся с https://' };
  const host = url.hostname.toLowerCase().replace(/\.$/, '');
  const allowed = ALLOWED_HOSTS.some((h) => host === h || host.endsWith('.' + h));
  if (!allowed && process.env.FETCH_ANY_SITE !== '1') {
    return { ok: false, error: 'Поддерживаются ссылки YouTube и TikTok' };
  }
  const site = host.includes('tiktok') ? 'tiktok' : host.includes('youtu') ? 'youtube' : 'other';
  return { ok: true, url: url.toString(), site };
}

export function detectYtDlp() {
  try {
    const r = spawnSync(YTDLP, ['--version'], { encoding: 'utf8', timeout: 15000 });
    if (r.status !== 0) return { available: false };
    return { available: true, version: r.stdout.trim() };
  } catch {
    return { available: false };
  }
}

// Предпочитаем H.264 + AAC в MP4 (до 1080p): такой файл открывается и в Safari/iPhone,
// и в браузерном движке без перекодирования.
const FORMAT =
  'bv*[vcodec^=avc1][height<=1080]+ba[acodec^=mp4a]/' +
  'b[vcodec^=avc1][height<=1080]/b[vcodec^=h264][height<=1080]/' +
  'bv*[height<=1080]+ba/b[height<=1080]/b';

function friendlyError(stderr) {
  const s = stderr || '';
  if (/Sign in to confirm|not a bot/i.test(s)) return 'YouTube просит подтвердить, что вы не робот. Обновите yt-dlp (yt-dlp -U или brew upgrade yt-dlp) и попробуйте ещё раз.';
  if (/Private video|private/i.test(s) && /video/i.test(s)) return 'Видео закрыто (приватное) — скачать нельзя.';
  if (/age|confirm your age/i.test(s) && /restricted|inappropriate|age-restricted/i.test(s)) return 'Видео с ограничением по возрасту — без входа в аккаунт скачать нельзя.';
  if (/Video unavailable|not available|removed|This video has been removed/i.test(s)) return 'Видео недоступно (удалено или заблокировано в вашей стране).';
  if (/is live|live event|premieres in/i.test(s)) return 'Это прямая трансляция или премьера — дождитесь окончания.';
  if (/HTTP Error 403|Forbidden/i.test(s)) return 'Сайт не отдал видео (ошибка 403). Обычно помогает обновить yt-dlp: yt-dlp -U или brew upgrade yt-dlp';
  if (/HTTP Error 429|Too Many Requests/i.test(s)) return 'Слишком много запросов — сайт временно ограничил скачивание. Попробуйте через несколько минут.';
  if (/Unable to resolve|getaddrinfo|Network is unreachable|timed out/i.test(s)) return 'Нет интернета на компьютере или сайт не отвечает.';
  if (/Unsupported URL/i.test(s)) return 'По этой ссылке нет видео. Откройте видео и скопируйте ссылку ещё раз.';
  const last = s.trim().split('\n').filter((l) => /ERROR/.test(l)).pop() || s.trim().split('\n').pop() || '';
  return 'Не удалось скачать: ' + last.replace(/^ERROR:\s*/, '').slice(0, 300);
}

function runYtDlp(args, onLine, signal) {
  return new Promise((resolve, reject) => {
    const p = spawn(YTDLP, args, { signal });
    let stderr = '';
    let buf = '';
    const lines = [];
    const handle = (chunk) => {
      buf += chunk;
      const parts = buf.split(/\r?\n|\r/);
      buf = parts.pop();
      for (const l of parts) {
        lines.push(l);
        onLine(l);
      }
    };
    p.stdout.on('data', handle);
    p.stderr.on('data', (d) => {
      stderr = (stderr + d).slice(-8000);
      handle(String(d));
    });
    p.on('error', (e) => reject(e.code === 'ENOENT' ? new Error('yt-dlp не найден. Установка описана в README') : e));
    p.on('close', (code) => {
      if (buf) {
        lines.push(buf);
        onLine(buf);
      }
      resolve({ code, stderr, lines });
    });
  });
}

/**
 * Скачивает видео в dir. Возвращает { file, title, info }.
 * onProgress(доля 0..1, текст этапа)
 */
export async function downloadVideo(rawUrl, dir, { onProgress, signal } = {}) {
  const check = checkVideoUrl(rawUrl);
  if (!check.ok) throw new Error(check.error);
  await fsp.mkdir(dir, { recursive: true });

  const base = [
    '--no-playlist',
    '--newline',
    '--progress',
    '--no-colors',
    '--no-mtime',
    '--no-part',
    '-f',
    FORMAT,
    '--merge-output-format',
    'mp4',
    '-o',
    path.join(dir, 'source.%(ext)s'),
    '--print',
    'after_move:@@FILE@@%(filepath)s',
    '--print',
    'after_move:@@TITLE@@%(title)s',
  ];
  const ffmpegPath = findBinary('ffmpeg');
  if (path.isAbsolute(ffmpegPath)) base.unshift('--ffmpeg-location', ffmpegPath);
  // Новым версиям yt-dlp для YouTube нужен JS-движок — используем тот же Node.js, что запускает сервер.
  const jsExtra = ['--js-runtimes', `node:${process.execPath}`, '--remote-components', 'ejs:github'];

  let file = null;
  let title = '';
  let streams = 0;
  let lastPct = -1;
  const onLine = (l) => {
    if (l.startsWith('@@FILE@@')) file = l.slice(8).trim();
    else if (l.startsWith('@@TITLE@@')) title = l.slice(9).trim();
    else if (/^\[download\] Destination:/.test(l)) {
      streams++;
      lastPct = -1;
    } else if (/^\[Merger\]|^\[VideoConvertor\]|^\[FixupM3u8\]/.test(l)) onProgress?.(0.92, 'Склеиваю видео и звук…');
    const m = l.match(/^\[download\]\s+([\d.]+)%/);
    if (m) {
      const pct = Number(m[1]) / 100;
      if (Math.abs(pct - lastPct) < 0.005) return;
      lastPct = pct;
      // видео и звук YouTube качаются отдельно: первый поток — 0..80%, второй — 80..90%
      const p = streams <= 1 ? pct * 0.8 : 0.8 + pct * 0.1;
      onProgress?.(Math.min(0.9, p), 'Скачиваю…');
    }
  };

  onProgress?.(0, 'Получаю информацию о видео…');
  let r = await runYtDlp([...jsExtra, ...base, check.url], onLine, signal);
  if (r.code !== 0 && /no such option|unrecognized arguments/i.test(r.stderr)) {
    // старая версия yt-dlp без этих опций — пробуем без них
    r = await runYtDlp([...base, check.url], onLine, signal);
  }
  if (signal?.aborted) throw new Error('Отменено');
  if (r.code !== 0 || !file || !fs.existsSync(file)) throw new Error(friendlyError(r.stderr));

  // приводим к H.264, если сайт отдал что-то экзотическое (VP9/AV1/HEVC)
  let info = await probe(file);
  if (!info.hasVideo) throw new Error('По ссылке нет видео (только звук?)');
  if (info.videoCodec && info.videoCodec !== 'h264') {
    onProgress?.(0.93, 'Перекодирую в H.264 для совместимости…');
    const out = path.join(dir, 'source_h264.mp4');
    await transcodeToH264(file, out, info.duration, (p) => onProgress?.(0.93 + p * 0.06, 'Перекодирую в H.264…'), signal);
    await fsp.rm(file, { force: true });
    file = out;
    info = await probe(file);
  }

  const niceName = sanitizeFileName(title || 'video', 'video') + '.mp4';
  const finalPath = path.join(dir, niceName);
  if (finalPath !== file) await fsp.rename(file, finalPath);
  onProgress?.(1, 'Готово');
  return { file: finalPath, name: niceName, title: title || niceName, info, site: check.site };
}
