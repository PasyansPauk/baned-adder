import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkVideoUrl } from '../server/downloader.js';
import { sanitizeFileName } from '../public/js/core/util.js';

test('ссылки: YouTube и TikTok принимаются', () => {
  for (const u of [
    'https://www.youtube.com/watch?v=jNQXAC9IVRw',
    'https://youtu.be/jNQXAC9IVRw',
    'https://m.youtube.com/shorts/abc',
    'https://www.tiktok.com/@user/video/6718335390845095173',
    'https://vm.tiktok.com/ZMabc/',
  ]) assert.equal(checkVideoUrl(u).ok, true, u);
  assert.equal(checkVideoUrl('https://youtu.be/x').site, 'youtube');
  assert.equal(checkVideoUrl('https://vt.tiktok.com/x').site, 'tiktok');
});

test('ссылки: всё остальное отклоняется', () => {
  for (const u of [
    'не ссылка',
    'ftp://youtube.com/x',
    'file:///etc/passwd',
    'https://evil.com/youtube.com',
    'https://youtube.com.evil.com/x',
    'https://notyoutube.com/x',
    'http://192.168.1.1/',
    'http://localhost:8787/api/status',
  ]) assert.equal(checkVideoUrl(u).ok, false, u);
});

test('имена файлов из названий видео', () => {
  assert.equal(sanitizeFileName('Scramble up ur name & I’ll try 😍❤️ #fyp'), 'Scramble_up_ur_name_I_ll_try_fyp');
  assert.equal(sanitizeFileName('Кот 🐱 и пёс [4K]'), 'Кот_и_пёс_4K');
  assert.equal(sanitizeFileName('😍😍😍'), 'video');
});
