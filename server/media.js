// Работа с ffmpeg/ffprobe: проверка наличия, probe, анализ (паузы + смены сцен), рендер частей.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { LoudnessMeter, detectSilences } from '../public/js/core/audio.js';
import { buildFfmpegArgs, encoderArgs } from './ffmpeg-graph.js';

/**
 * Полный путь к программе. Кроме PATH смотрим папки Homebrew (Apple Silicon и Intel), MacPorts и ~/.brew: при запуске двойным кликом
 * (start.command) PATH бывает урезанным, и brew-программы иначе «не находятся».
 */
export function findBinary(name) {
  if (name.includes('/') || name.includes('\\')) return name;
  const home = process.env.HOME || '';
  const dirs = [
    ...(process.env.PATH || '').split(path.delimiter),
    '/opt/homebrew/bin', // Homebrew на Apple Silicon
    '/usr/local/bin', // Homebrew на Intel, ручная установка
    '/opt/local/bin', // MacPorts
    ...(home ? [path.join(home, '.brew/bin'), path.join(home, 'bin')] : []), // brew в домашней папке
    '/usr/bin',
  ];
  const exts = process.platform === 'win32' ? ['.exe', '.cmd', ''] : [''];
  for (const d of dirs) {
    if (!d) continue;
    for (const e of exts) {
      const full = path.join(d, name + e);
      try {
        fs.accessSync(full, fs.constants.X_OK);
        return full;
      } catch {
        /* нет здесь */
      }
    }
  }
  return name;
}

const FFMPEG = findBinary(process.env.FFMPEG_PATH || 'ffmpeg');
const FFPROBE = findBinary(process.env.FFPROBE_PATH || 'ffprobe');

export function detectFfmpeg() {
  try {
    const v = spawnSync(FFMPEG, ['-hide_banner', '-version'], { encoding: 'utf8' });
    if (v.status !== 0) return { available: false };
    const enc = spawnSync(FFMPEG, ['-hide_banner', '-encoders'], { encoding: 'utf8' }).stdout || '';
    const p = spawnSync(FFPROBE, ['-version'], { encoding: 'utf8' });
    return {
      available: p.status === 0,
      version: (v.stdout.match(/ffmpeg version (\S+)/) || [])[1] || 'unknown',
      encoders: {
        x264: /\blibx264\b/.test(enc),
        videotoolbox: /\bh264_videotoolbox\b/.test(enc),
      },
    };
  } catch {
    return { available: false };
  }
}

export function probe(file) {
  return new Promise((resolve, reject) => {
    const p = spawn(FFPROBE, ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file]);
    let out = '';
    let err = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (err += d));
    p.on('error', reject);
    p.on('close', (code) => {
      if (code !== 0) return reject(new Error('ffprobe: ' + err.trim().slice(-300)));
      try {
        const j = JSON.parse(out);
        const v = j.streams.find((s) => s.codec_type === 'video');
        const a = j.streams.find((s) => s.codec_type === 'audio');
        const rot = Number(v?.tags?.rotate || v?.side_data_list?.find((x) => x.rotation !== undefined)?.rotation || 0);
        const swap = Math.abs(rot) % 180 === 90;
        resolve({
          duration: Number(j.format?.duration) || Number(v?.duration) || 0,
          width: swap ? v?.height : v?.width,
          height: swap ? v?.width : v?.height,
          hasVideo: !!v,
          hasAudio: !!a,
          videoCodec: v?.codec_name || null,
        });
      } catch (e) {
        reject(e);
      }
    });
  });
}

const timeFromStderr = (line) => {
  const m = line.match(/time=(\d+):(\d+):(\d+(?:\.\d+)?)/);
  return m ? Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) : null;
};

/** Анализ громкости: PCM 8 кГц моно → паузы. */
function analyzeAudio(file, duration, onProgress, signal) {
  return new Promise((resolve, reject) => {
    const rate = 8000;
    const p = spawn(FFMPEG, ['-hide_banner', '-nostdin', '-i', file, '-vn', '-sn', '-ac', '1', '-ar', String(rate), '-f', 'f32le', 'pipe:1'], { signal });
    const meter = new LoudnessMeter(rate);
    let rest = Buffer.alloc(0);
    let samples = 0;
    p.stdout.on('data', (chunk) => {
      const buf = rest.length ? Buffer.concat([rest, chunk]) : chunk;
      const usable = buf.length - (buf.length % 4);
      const arr = new Float32Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + usable));
      meter.push(arr);
      samples += arr.length;
      rest = buf.subarray(usable);
      if (duration) onProgress?.(Math.min(1, samples / rate / duration));
    });
    p.stderr.on('data', () => {});
    p.on('error', reject);
    p.on('close', (code) => {
      if (code !== 0 && !samples) return resolve([]);
      const { db, hopSec } = meter.result();
      resolve(detectSilences(db, hopSec));
    });
  });
}

/** Смены сцен через фильтр scene (на уменьшенных кадрах — быстро). */
function analyzeScenes(file, duration, onProgress, signal) {
  return new Promise((resolve, reject) => {
    const p = spawn(
      FFMPEG,
      ['-hide_banner', '-nostdin', '-i', file, '-an', '-sn', '-vf', "scale=192:-2,select='gt(scene,0.28)',metadata=print:file=-", '-f', 'null', '-'],
      { signal }
    );
    const scenes = [];
    let pending = null;
    let out = '';
    p.stdout.on('data', (d) => {
      out += d;
      const lines = out.split('\n');
      out = lines.pop();
      for (const line of lines) {
        const t = line.match(/pts_time:([\d.]+)/);
        if (t) pending = Number(t[1]);
        const s = line.match(/lavfi\.scene_score=([\d.]+)/);
        if (s && pending !== null) {
          scenes.push({ t: Math.round(pending * 1000) / 1000, score: Math.min(1, Number(s[1])) });
          pending = null;
        }
      }
    });
    p.stderr.on('data', (d) => {
      const t = timeFromStderr(String(d));
      if (t !== null && duration) onProgress?.(Math.min(1, t / duration));
    });
    p.on('error', reject);
    p.on('close', () => resolve(scenes));
  });
}

export async function analyze(file, onProgress, signal) {
  const info = await probe(file);
  const prog = { a: info.hasAudio ? 0 : 1, v: 0 };
  const report = () => onProgress?.((prog.a + prog.v) / 2);
  const [silences, scenes] = await Promise.all([
    info.hasAudio ? analyzeAudio(file, info.duration, (x) => ((prog.a = x), report()), signal) : [],
    analyzeScenes(file, info.duration, (x) => ((prog.v = x), report()), signal),
  ]);
  return { ...info, silences, scenes, engine: 'ffmpeg' };
}

/** Рендер одной части. */
export function renderPart(spec, io, onProgress, signal) {
  return new Promise((resolve, reject) => {
    let args;
    try {
      args = buildFfmpegArgs(spec, io);
    } catch (e) {
      return reject(e);
    }
    const p = spawn(FFMPEG, args, { signal });
    let tail = '';
    let buf = '';
    p.stdout.on('data', (d) => {
      buf += d;
      const lines = buf.split('\n');
      buf = lines.pop();
      for (const line of lines) {
        const m = line.match(/^out_time_us=(\d+)/);
        if (m) onProgress?.(Math.min(1, Number(m[1]) / 1e6 / spec.duration));
      }
    });
    p.stderr.on('data', (d) => (tail = (tail + d).slice(-4000)));
    p.on('error', reject);
    p.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(signal?.aborted ? 'Отменено' : 'ffmpeg завершился с ошибкой:\n' + tail.trim().split('\n').slice(-6).join('\n')));
    });
  });
}

/** Перекодирование в H.264/AAC MP4 (для видео в VP9/AV1/HEVC, скачанных по ссылке). */
export function transcodeToH264(input, output, duration, onProgress, signal) {
  return new Promise((resolve, reject) => {
    const args = [
      '-hide_banner', '-nostdin', '-y', '-i', input,
      '-map', '0:v:0', '-map', '0:a:0?',
      ...encoderArgs('x264', 'high'),
      '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart',
      '-progress', 'pipe:1', '-nostats', output,
    ];
    const p = spawn(FFMPEG, args, { signal });
    let buf = '';
    let tail = '';
    p.stdout.on('data', (d) => {
      buf += d;
      const lines = buf.split('\n');
      buf = lines.pop();
      for (const line of lines) {
        const m = line.match(/^out_time_us=(\d+)/);
        if (m && duration) onProgress?.(Math.min(1, Number(m[1]) / 1e6 / duration));
      }
    });
    p.stderr.on('data', (d) => (tail = (tail + d).slice(-2000)));
    p.on('error', reject);
    p.on('close', (code) => (code === 0 ? resolve() : reject(new Error('Не удалось перекодировать видео: ' + tail.trim().split('\n').pop()))));
  });
}
