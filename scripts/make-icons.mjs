// Генерирует PNG-иконки из public/icons/icon.svg (нужен Playwright с Chromium).
// Запуск: node scripts/make-icons.mjs
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// require (а не import), чтобы находился и глобально установленный playwright через NODE_PATH
const { chromium } = createRequire(import.meta.url)('playwright');
const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public', 'icons');
const svg = fs.readFileSync(path.join(dir, 'icon.svg'), 'utf8');
const browser = await chromium.launch();
const page = await browser.newPage();
for (const size of [180, 192, 512]) {
  await page.setViewportSize({ width: size, height: size });
  await page.setContent(`<html><body style="margin:0;background:#0f1115">${svg.replace('<svg ', `<svg width="${size}" height="${size}" `)}</body></html>`);
  await page.screenshot({ path: path.join(dir, `icon-${size}.png`), omitBackground: false });
}
await browser.close();
console.log('ok');
