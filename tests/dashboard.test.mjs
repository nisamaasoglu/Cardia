import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const WEB = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'web');
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.mp3': 'audio/mpeg' };
const DEVICE = '10.0.0.5';

let server, base, browser;

before(async () => {
  server = http.createServer((req, res) => {
    const file = path.join(WEB, decodeURIComponent(new URL(req.url, 'http://x').pathname === '/' ? '/index.html' : new URL(req.url, 'http://x').pathname));
    if (!file.startsWith(WEB) || !fs.existsSync(file)) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}/`;
  browser = await chromium.launch();
});

after(async () => {
  await browser?.close();
  server?.close();
});

function reading(over = {}) {
  return { raw: 512, bpm: 72, ibi: 833, amplitude: 300, quality: 1, beats: 10, uptime: 1000, wave: Array.from({ length: 96 }, (_, i) => 400 + (i % 12) * 20), ...over };
}

async function openWithDevice(respond) {
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e));
  await page.route(`http://${DEVICE}/**`, route => respond(route));
  await page.goto(`${base}?ip=${DEVICE}`);
  return { page, errors };
}

const json = body => route => route.fulfill({ status: 200, contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': '*' }, body: JSON.stringify(body) });

test('demo mode is labelled as demo and keeps the heart rate in the resting range', async () => {
  const page = await browser.newPage();
  await page.goto(`${base}?demo=1`);
  await page.waitForFunction(() => document.getElementById('bpm').textContent !== '--');
  assert.equal(await page.textContent('#status'), 'Demo');
  assert.match(await page.textContent('#beat-source'), /simulated ECG/);
  const bpm = Number(await page.textContent('#bpm'));
  assert.ok(bpm >= 60 && bpm <= 100, `demo BPM ${bpm}`);
  assert.equal(await page.isHidden('#alert'), true);
  await page.close();
});

test('a live reading in range shows the value, marks the source live and keeps the alert hidden', async () => {
  const { page, errors } = await openWithDevice(json(reading()));
  await page.waitForFunction(() => document.getElementById('status').textContent === 'Live');
  assert.equal(await page.textContent('#bpm'), '72');
  assert.match(await page.textContent('#beat-source'), new RegExp(`live from ${DEVICE}`));
  assert.equal(await page.textContent('#m-ibi'), '833 ms');
  assert.equal(await page.textContent('#m-quality'), 'good');
  assert.equal(await page.isHidden('#alert'), true);
  assert.deepEqual(errors, []);
  await page.close();
});

test('a high heart rate raises the alert and names the direction', async () => {
  const { page } = await openWithDevice(json(reading({ bpm: 128 })));
  await page.waitForSelector('#alert', { state: 'visible' });
  assert.equal(await page.textContent('#alert-title'), 'Heart rate above the resting range (128 BPM)');
  assert.match(await page.getAttribute('#bpm', 'class'), /out-of-range/);
  await page.close();
});

test('a low heart rate raises the alert as below range', async () => {
  const { page } = await openWithDevice(json(reading({ bpm: 48 })));
  await page.waitForSelector('#alert', { state: 'visible' });
  assert.equal(await page.textContent('#alert-title'), 'Heart rate below the resting range (48 BPM)');
  await page.close();
});

test('a weak signal shows no number and never raises the alert', async () => {
  const { page } = await openWithDevice(json(reading({ bpm: 150, quality: 0 })));
  await page.waitForFunction(() => document.getElementById('m-quality').textContent === 'weak');
  assert.equal(await page.textContent('#bpm'), '--');
  assert.match(await page.textContent('#beat-source'), /check the electrode contact/);
  assert.equal(await page.isHidden('#alert'), true);
  await page.close();
});

test('an unreachable board falls back to demo mode instead of a dead screen', async () => {
  const { page } = await openWithDevice(route => route.abort());
  await page.waitForFunction(() => document.getElementById('status').textContent === 'Demo', null, { timeout: 5000 });
  assert.match(await page.textContent('#beat-source'), /simulated ECG/);
  await page.close();
});

test('the simulated panel stays inside its bounds and is labelled sim', async () => {
  const page = await browser.newPage();
  await page.goto(`${base}?demo=1`);
  const [sys, dia] = (await page.textContent('#s-bp')).split('/').map(Number);
  const spo2 = parseInt(await page.textContent('#s-spo2'), 10);
  assert.ok(sys >= 105 && sys <= 135 && dia >= 65 && dia <= 88);
  assert.ok(spo2 >= 94 && spo2 <= 99);
  assert.equal(await page.locator('.metric--sim em', { hasText: 'sim' }).count(), 3);
  await page.close();
});
