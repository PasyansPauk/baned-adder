// Мини-генератор QR-кодов (байтовый режим, уровень коррекции M, версии 1–10).
// Нужен, чтобы открыть приложение на iPhone, просто наведя камеру на экран Mac.

// [ec-кодовых слов на блок, [[блоков, data-слов], ...]]
const TABLE_M = [
  null,
  [10, [[1, 16]]],
  [16, [[1, 28]]],
  [26, [[1, 44]]],
  [18, [[2, 32]]],
  [24, [[2, 43]]],
  [16, [[4, 27]]],
  [18, [[4, 31]]],
  [22, [[2, 38], [2, 39]]],
  [22, [[3, 36], [2, 37]]],
  [26, [[4, 43], [1, 44]]],
];
const ALIGN = [null, [], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34], [6, 22, 38], [6, 24, 42], [6, 26, 46], [6, 28, 50]];

function gfMul(x, y) {
  let z = 0;
  for (let i = 7; i >= 0; i--) {
    z = (z << 1) ^ ((z >>> 7) * 0x11d);
    z ^= ((y >>> i) & 1) * x;
  }
  return z & 0xff;
}

function rsDivisor(degree) {
  const result = new Array(degree).fill(0);
  result[degree - 1] = 1;
  let root = 1;
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < result.length; j++) {
      result[j] = gfMul(result[j], root);
      if (j + 1 < result.length) result[j] ^= result[j + 1];
    }
    root = gfMul(root, 0x02);
  }
  return result;
}

function rsRemainder(data, divisor) {
  const result = new Array(divisor.length).fill(0);
  for (const b of data) {
    const factor = b ^ result.shift();
    result.push(0);
    divisor.forEach((coef, i) => (result[i] ^= gfMul(coef, factor)));
  }
  return result;
}

const getBit = (x, i) => ((x >>> i) & 1) !== 0;

export function encodeQR(text) {
  const bytes = Array.from(new TextEncoder().encode(text));
  let version = 0;
  let dataCap = 0;
  for (let v = 1; v <= 10; v++) {
    const [, groups] = TABLE_M[v];
    const cap = groups.reduce((s, [n, d]) => s + n * d, 0);
    const bits = 4 + (v < 10 ? 8 : 16) + bytes.length * 8;
    if (bits <= cap * 8) {
      version = v;
      dataCap = cap;
      break;
    }
  }
  if (!version) throw new Error('Слишком длинный текст для QR');

  // --- битовый поток
  const bb = [];
  const put = (val, len) => {
    for (let i = len - 1; i >= 0; i--) bb.push((val >>> i) & 1);
  };
  put(0b0100, 4);
  put(bytes.length, version < 10 ? 8 : 16);
  bytes.forEach((b) => put(b, 8));
  put(0, Math.min(4, dataCap * 8 - bb.length));
  while (bb.length % 8) bb.push(0);
  const data = [];
  for (let i = 0; i < bb.length; i += 8) data.push(bb.slice(i, i + 8).reduce((a, b) => (a << 1) | b, 0));
  for (let pad = 0xec; data.length < dataCap; pad ^= 0xec ^ 0x11) data.push(pad);

  // --- блоки и коррекция ошибок
  const [ecLen, groups] = TABLE_M[version];
  const div = rsDivisor(ecLen);
  const blocks = [];
  let off = 0;
  for (const [n, d] of groups) {
    for (let i = 0; i < n; i++) {
      const dat = data.slice(off, off + d);
      off += d;
      blocks.push({ dat, ecc: rsRemainder(dat, div) });
    }
  }
  const codewords = [];
  const maxD = Math.max(...blocks.map((b) => b.dat.length));
  for (let i = 0; i < maxD; i++) for (const b of blocks) if (i < b.dat.length) codewords.push(b.dat[i]);
  for (let i = 0; i < ecLen; i++) for (const b of blocks) codewords.push(b.ecc[i]);

  // --- матрица
  const size = version * 4 + 17;
  const mod = Array.from({ length: size }, () => new Array(size).fill(false));
  const fn = Array.from({ length: size }, () => new Array(size).fill(false));
  const setF = (x, y, dark) => {
    mod[y][x] = dark;
    fn[y][x] = true;
  };
  for (let i = 0; i < size; i++) {
    setF(6, i, i % 2 === 0);
    setF(i, 6, i % 2 === 0);
  }
  const finder = (cx, cy) => {
    for (let dy = -4; dy <= 4; dy++)
      for (let dx = -4; dx <= 4; dx++) {
        const d = Math.max(Math.abs(dx), Math.abs(dy));
        const x = cx + dx;
        const y = cy + dy;
        if (x >= 0 && x < size && y >= 0 && y < size) setF(x, y, d !== 2 && d !== 4);
      }
  };
  finder(3, 3);
  finder(size - 4, 3);
  finder(3, size - 4);
  const al = ALIGN[version];
  for (let i = 0; i < al.length; i++)
    for (let j = 0; j < al.length; j++) {
      if ((i === 0 && j === 0) || (i === 0 && j === al.length - 1) || (i === al.length - 1 && j === 0)) continue;
      for (let dy = -2; dy <= 2; dy++)
        for (let dx = -2; dx <= 2; dx++) setF(al[i] + dx, al[j] + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
    }
  const drawFormat = (mask) => {
    const d = (0 << 3) | mask; // уровень M = 00
    let rem = d;
    for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
    const bits = ((d << 10) | rem) ^ 0x5412;
    for (let i = 0; i <= 5; i++) setF(8, i, getBit(bits, i));
    setF(8, 7, getBit(bits, 6));
    setF(8, 8, getBit(bits, 7));
    setF(7, 8, getBit(bits, 8));
    for (let i = 9; i < 15; i++) setF(14 - i, 8, getBit(bits, i));
    for (let i = 0; i < 8; i++) setF(size - 1 - i, 8, getBit(bits, i));
    for (let i = 8; i < 15; i++) setF(8, size - 15 + i, getBit(bits, i));
    setF(8, size - 8, true);
  };
  drawFormat(0);
  if (version >= 7) {
    let rem = version;
    for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
    const bits = (version << 12) | rem;
    for (let i = 0; i < 18; i++) {
      const a = size - 11 + (i % 3);
      const b = Math.floor(i / 3);
      setF(a, b, getBit(bits, i));
      setF(b, a, getBit(bits, i));
    }
  }
  let bi = 0;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < size; vert++) {
      for (let j = 0; j < 2; j++) {
        const x = right - j;
        const upward = ((right + 1) & 2) === 0;
        const y = upward ? size - 1 - vert : vert;
        if (!fn[y][x] && bi < codewords.length * 8) {
          mod[y][x] = getBit(codewords[bi >>> 3], 7 - (bi & 7));
          bi++;
        }
      }
    }
  }

  const maskFn = [
    (x, y) => (x + y) % 2 === 0,
    (x, y) => y % 2 === 0,
    (x) => x % 3 === 0,
    (x, y) => (x + y) % 3 === 0,
    (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0,
    (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
    (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0,
    (x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0,
  ];
  const applyMask = (m) => {
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) if (!fn[y][x] && maskFn[m](x, y)) mod[y][x] = !mod[y][x];
  };
  const penalty = () => {
    let p = 0;
    const lines = [];
    for (let i = 0; i < size; i++) {
      lines.push(mod[i]);
      lines.push(mod.map((r) => r[i]));
    }
    for (const line of lines) {
      let run = 1;
      for (let i = 1; i <= size; i++) {
        if (i < size && line[i] === line[i - 1]) run++;
        else {
          if (run >= 5) p += 3 + run - 5;
          run = 1;
        }
      }
      const s = line.map((v) => (v ? '1' : '0')).join('');
      p += 40 * ((s.match(/(?=10111010000)/g) || []).length + (s.match(/(?=00001011101)/g) || []).length);
    }
    for (let y = 0; y < size - 1; y++)
      for (let x = 0; x < size - 1; x++) {
        const c = mod[y][x];
        if (c === mod[y][x + 1] && c === mod[y + 1][x] && c === mod[y + 1][x + 1]) p += 3;
      }
    const dark = mod.flat().filter(Boolean).length;
    p += 10 * Math.floor(Math.abs((dark * 100) / (size * size) - 50) / 5);
    return p;
  };
  let best = 0;
  let bestP = Infinity;
  for (let m = 0; m < 8; m++) {
    applyMask(m);
    drawFormat(m);
    const p = penalty();
    if (p < bestP) {
      bestP = p;
      best = m;
    }
    applyMask(m); // откат (XOR)
  }
  applyMask(best);
  drawFormat(best);
  return { size, modules: mod, version, mask: best };
}

/** Рисует QR в canvas. */
export function drawQR(canvas, text, scale = 8, margin = 4) {
  const qr = encodeQR(text);
  const n = qr.size + margin * 2;
  canvas.width = n * scale;
  canvas.height = n * scale;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = '#000';
  for (let y = 0; y < qr.size; y++)
    for (let x = 0; x < qr.size; x++) if (qr.modules[y][x]) ctx.fillRect((x + margin) * scale, (y + margin) * scale, scale, scale);
  return qr;
}
