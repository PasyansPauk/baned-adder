// Сборка команды ffmpeg для одной части. Чистая функция: на вход — спецификация части
// (её готовит браузер из плана), на выход — массив аргументов для spawn('ffmpeg', args).
//
// Схема:
//   исходник (-ss начало части) → fps → вписывание в кадр (blur/crop/pad) → split на сегменты
//   сегменты: обычный фрагмент (trim) | стоп-кадр (1 кадр → размытие/затемнение → tpad clone)
//   concat всех сегментов (видео + звук)
//   → поверх: видеобаннеры, PNG-слои (надписи, карточки рекламы) с fade/slide, полоска-таймер
//
// Все числа в выражениях — наши (не пользовательский ввод), цвета проверяются регуляркой.

const n3 = (v) => {
  const x = Math.round(Number(v) * 1000) / 1000;
  if (!Number.isFinite(x)) throw new Error('Некорректное число в спецификации');
  return String(x);
};
const int = (v) => {
  const x = Math.round(Number(v));
  if (!Number.isFinite(x)) throw new Error('Некорректное число в спецификации');
  return String(x);
};
const evenInt = (v) => String(Math.max(2, Math.round(Number(v) / 2) * 2));
const hex = (c) => (/^#[0-9a-f]{6}$/i.test(c || '') ? '0x' + c.slice(1) : '0xff3b5c');

function fitChain(fit, W, H) {
  if (fit === 'crop') return `scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H}`;
  if (fit === 'pad') return `scale=${W}:${H}:force_original_aspect_ratio=decrease,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:black`;
  // blur: размытый «фон» из того же видео + видео целиком по центру
  const bw = evenInt(W / 12);
  const bh = evenInt(H / 12);
  return (
    `split=2[fbg][ffg];` +
    `[fbg]scale=${bw}:${bh}:force_original_aspect_ratio=increase,crop=${bw}:${bh},boxblur=2:1,scale=${W}:${H},drawbox=c=black@0.25:t=fill[fbg2];` +
    `[ffg]scale=${W}:${H}:force_original_aspect_ratio=decrease[ffg2];` +
    `[fbg2][ffg2]overlay=(W-w)/2:(H-h)/2`
  );
}

/** Выражение вертикального сдвига для slide-анимации (совпадает с layerAnim в core/layout.js). */
function slideExpr(y, P, S, E, F) {
  if (!(P > 0) || !(F > 0)) return n3(y);
  return `${n3(y)}+${n3(P)}*(1-clip((t-${n3(S)})/${n3(F)},0,1))+${n3(P)}*clip((t-${n3(E - F)})/${n3(F)},0,1)`;
}

function alphaFades(S, E, F) {
  if (!(F > 0)) return '';
  return `,fade=t=in:st=${n3(S)}:d=${n3(F)}:alpha=1,fade=t=out:st=${n3(E - F)}:d=${n3(F)}:alpha=1`;
}

/**
 * @param {object} spec — см. public/js/engine-server.js → buildServerSpec
 * @param {object} io — { src, output, resolve(fileId) → путь, srcHasAudio, adHasAudio(fileId) → bool, encoder, quality }
 */
export function buildFfmpegArgs(spec, io) {
  const W = int(spec.W);
  const H = int(spec.H);
  const fps = int(spec.fps || 30);
  const D = Number(spec.duration);
  const len = Number(spec.srcEnd) - Number(spec.srcStart);
  if (!(D > 0) || !(len > 0)) throw new Error('Пустая часть');
  const segs = spec.segments || [];
  if (!segs.length) throw new Error('Нет сегментов');

  const args = ['-hide_banner', '-nostdin', '-y'];
  const filters = [];
  let inputs = 0;
  const addInput = (...a) => {
    args.push(...a);
    return inputs++;
  };

  addInput('-ss', n3(spec.srcStart), '-t', n3(len + 0.5), '-i', io.src);

  // --- видео: нормализация и сегменты
  const K = segs.length;
  const vNames = segs.map((_, i) => `s${i}`);
  const splitTail = K > 1 ? `,split=${K}${vNames.map((v) => `[${v}]`).join('')}` : `[${vNames[0]}]`;
  filters.push(`[0:v]setpts=PTS-STARTPTS,fps=${fps},${fitChain(spec.fit, W, H)},setsar=1,format=yuv420p${splitTail}`);
  const A_FMT = 'aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo';
  const aNames = segs.map((_, i) => `as${i}`);
  const contentCount = segs.filter((s) => s.type === 'content').length;
  if (io.srcHasAudio && contentCount) {
    const contentA = segs.map((s, i) => (s.type === 'content' ? aNames[i] : null)).filter(Boolean);
    filters.push(
      `[0:a]asetpts=PTS-STARTPTS,${A_FMT}` +
        (contentA.length > 1 ? `,asplit=${contentA.length}${contentA.map((a) => `[${a}]`).join('')}` : `[${contentA[0]}]`)
    );
  }
  const silence = (d) => `aevalsrc=0|0:c=stereo:s=48000:d=${n3(d)},aformat=sample_fmts=fltp:channel_layouts=stereo`;

  // видеобаннеры в паузе: их звук идёт вместо звука ролика
  const adVideos = spec.adVideos || [];
  const adAudioBySeg = new Map();
  const adVideoInputs = adVideos.map((av) => {
    const idx = addInput('-t', n3(Number(av.end) - Number(av.start) + 0.2), '-i', io.resolve(av.file));
    if (av.audioSeg >= 0 && io.adHasAudio(av.file)) adAudioBySeg.set(av.audioSeg, idx);
    return idx;
  });

  const fadeA = Math.max(0, Number(spec.audioFade) || 0);
  const concatIn = [];
  segs.forEach((seg, i) => {
    const prevAd = i > 0 && segs[i - 1].type === 'freeze';
    const nextAd = i < K - 1 && segs[i + 1].type === 'freeze';
    if (seg.type === 'content') {
      const d = Number(seg.end) - Number(seg.start);
      filters.push(`[${vNames[i]}]trim=start=${n3(seg.start)}:end=${n3(seg.end)},setpts=PTS-STARTPTS[v${i}]`);
      if (io.srcHasAudio) {
        let chain = `[${aNames[i]}]atrim=start=${n3(seg.start)}:end=${n3(seg.end)},asetpts=PTS-STARTPTS`;
        const f = Math.min(fadeA, d / 3);
        if (f > 0 && prevAd) chain += `,afade=t=in:st=0:d=${n3(f)}`;
        if (f > 0 && nextAd) chain += `,afade=t=out:st=${n3(d - f)}:d=${n3(f)}`;
        // выравниваем длину звука по видео (на случай неточности в конце файла)
        chain += `,apad,atrim=duration=${n3(d)}`;
        filters.push(chain + `[a${i}]`);
      } else filters.push(`${silence(d)}[a${i}]`);
    } else {
      // стоп-кадр: последний кадр перед паузой
      const d = Number(seg.dur);
      const frame = Math.max(0, Math.round(Number(seg.t) * Number(fps)) - 1);
      let chain = `[${vNames[i]}]trim=start_frame=${frame}:end_frame=${frame + 1},setpts=PTS-STARTPTS`;
      const blur = Math.round(Number(seg.blur) || 0);
      if (blur > 0) {
        const r = Math.min(blur, Math.floor(Math.min(Number(W), Number(H)) / 4) - 1);
        chain += `,boxblur=luma_radius=${r}:luma_power=2:chroma_radius=${Math.max(1, Math.floor(r / 2))}:chroma_power=2`;
      }
      const dim = Number(seg.dim) || 0;
      if (dim > 0) chain += `,drawbox=c=black@${n3(Math.min(0.95, dim))}:t=fill`;
      chain += `,tpad=stop_mode=clone:stop_duration=${n3(d + 1)},trim=duration=${n3(d)},setpts=PTS-STARTPTS[v${i}]`;
      filters.push(chain);
      const adIn = adAudioBySeg.get(i);
      if (adIn !== undefined) {
        filters.push(
          `[${adIn}:a]atrim=duration=${n3(d)},asetpts=PTS-STARTPTS,${A_FMT},afade=t=in:st=0:d=0.08,` +
            `afade=t=out:st=${n3(Math.max(0, d - 0.25))}:d=0.25,apad,atrim=duration=${n3(d)}[a${i}]`
        );
      } else filters.push(`${silence(d)}[a${i}]`);
    }
    concatIn.push(`[v${i}][a${i}]`);
  });
  filters.push(`${concatIn.join('')}concat=n=${K}:v=1:a=1[base][aout]`);

  // --- слои поверх готовой ленты
  let cur = 'base';
  let k = 0;
  const next = () => `o${k++}`;

  adVideos.forEach((av, j) => {
    const S = Number(av.start);
    const E = Number(av.end);
    const F = Number(av.fade) || 0;
    const name = next();
    filters.push(
      `[${adVideoInputs[j]}:v]setpts=PTS-STARTPTS,fps=${fps},scale=${evenInt(av.w)}:${evenInt(av.h)},setsar=1,format=yuva420p` +
        chromaKey(av.chroma) +
        alphaFades(0, E - S, F) +
        `,tpad=start_duration=${n3(S)}:color=black@0[av${j}]`
    );
    filters.push(
      `[${cur}][av${j}]overlay=x=${int(av.x)}:y='${slideExpr(av.y, av.slide, S, E, F)}':enable='between(t,${n3(S)},${n3(E)})':eof_action=pass[${name}]`
    );
    cur = name;
  });

  for (const layer of spec.layers || []) {
    const idx = addInput('-loop', '1', '-framerate', fps, '-t', n3(D + 0.5), '-i', io.resolve(layer.file));
    const S = Number(layer.start);
    const E = Number(layer.end);
    const F = Number(layer.fade) || 0;
    const ln = `l${idx}`;
    const name = next();
    filters.push(`[${idx}:v]format=rgba${alphaFades(S, E, F)}[${ln}]`);
    filters.push(
      `[${cur}][${ln}]overlay=x=${int(layer.x)}:y='${slideExpr(layer.y, layer.slide, S, E, F)}':enable='between(t,${n3(S)},${n3(E)})'[${name}]`
    );
    cur = name;
  }

  (spec.progress || []).forEach((p, j) => {
    const S = Number(p.start);
    const E = Number(p.end);
    const F = Number(p.fade) || 0;
    const w = evenInt(p.w);
    const h = evenInt(p.h);
    const src = (c) => `color=c=${c}:s=${w}x${h}:r=${fps}:d=${n3(D + 0.5)},format=rgba`;
    filters.push(`${src('white@0.35')}${alphaFades(S, E, F)}[pt${j}]`);
    filters.push(`${src(hex(spec.accent))}[pa${j}]`);
    filters.push(`${src('black@0')}[pz${j}]`);
    // полоса двойной ширины (цвет | прозрачно) и «окно» crop, которое по ней едет — так растёт заливка
    filters.push(
      `[pa${j}][pz${j}]hstack=inputs=2,crop=w=${w}:h=${h}:x='${w}*(1-clip((t-${n3(S)})/${n3(Math.max(0.01, E - S))},0,1))':y=0${alphaFades(S, E, F)}[pb${j}]`
    );
    const n1 = next();
    filters.push(`[${cur}][pt${j}]overlay=x=${int(p.x)}:y=${int(p.y)}:enable='between(t,${n3(S)},${n3(E)})'[${n1}]`);
    const n2 = next();
    filters.push(`[${n1}][pb${j}]overlay=x=${int(p.x)}:y=${int(p.y)}:enable='between(t,${n3(S)},${n3(E)})'[${n2}]`);
    cur = n2;
  });

  filters.push(`[${cur}]format=yuv420p[vout]`);

  args.push('-filter_complex', filters.join(';'), '-map', '[vout]', '-map', '[aout]');
  args.push('-t', n3(D), '-r', fps);
  args.push(...encoderArgs(io.encoder, io.quality, Number(W) * Number(H)));
  args.push('-c:a', 'aac', '-b:a', '160k', '-movflags', '+faststart', '-progress', 'pipe:1', '-nostats', io.output);
  return args;
}

/** Хромакей видеобаннера: зелёный (или выбранный) фон становится прозрачным. */
function chromaKey(c) {
  if (!c) return '';
  const key = /^#[0-9a-f]{6}$/i.test(c.color || '') ? '0x' + c.color.slice(1) : '0x00ff00';
  const sim = Math.min(0.5, Math.max(0.01, (Number(c.similarity) || 30) / 200));
  const blend = Math.min(0.5, Math.max(0, (Number(c.smooth) || 0) / 200));
  return `,chromakey=color=${key}:similarity=${n3(sim)}:blend=${n3(blend)}`;
}

export function encoderArgs(encoder, quality = 'high', pixels = 1080 * 1920) {
  const crf = { high: 19, medium: 23, small: 27 }[quality] ?? 21;
  if (encoder === 'videotoolbox') {
    const base = { high: 12, medium: 7, small: 4 }[quality] ?? 8;
    const mbps = Math.max(2, Math.round((base * pixels) / (1080 * 1920)));
    return ['-c:v', 'h264_videotoolbox', '-b:v', `${mbps}M`, '-pix_fmt', 'yuv420p', '-profile:v', 'high', '-tag:v', 'avc1'];
  }
  return ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', String(crf), '-pix_fmt', 'yuv420p', '-profile:v', 'high', '-tag:v', 'avc1'];
}
