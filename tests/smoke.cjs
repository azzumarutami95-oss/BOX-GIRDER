'use strict';

// Exercise the shipped HTML in a real browser; no application server or CDN is needed.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { before, after, test } = require('node:test');
const { chromium } = require('playwright');

let browser;
let server;
let baseURL;

before(async () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'));
  server = http.createServer((request, response) => {
    if (request.url === '/' || request.url === '/index.html') {
      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      response.end(html);
    } else {
      response.writeHead(request.url === '/favicon.ico' ? 204 : 404);
      response.end();
    }
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  baseURL = `http://127.0.0.1:${server.address().port}`;
  const executablePath = process.env.CHROMIUM_PATH ||
    (fs.existsSync('/usr/bin/chromium') ? '/usr/bin/chromium' : undefined);
  browser = await chromium.launch({ executablePath, headless: true });
});

after(async () => {
  await browser?.close();
  if (server) await new Promise(resolve => server.close(resolve));
});

async function withPage(body) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await context.newPage();
  const errors = [];
  const externalRequests = [];
  page.on('pageerror', error => errors.push(error.message));
  await context.route('**/*', route => {
    const url = route.request().url();
    if (/^https?:/.test(url) && new URL(url).origin !== baseURL) {
      externalRequests.push(url);
      return route.abort();
    }
    return route.continue();
  });
  try {
    const response = await page.goto(baseURL);
    assert.equal(response.status(), 200);
    await page.waitForFunction(() => !!window.SectionStudio);
    await body(page);
    assert.deepEqual(errors, [], 'The application must not raise uncaught browser errors');
    assert.deepEqual(externalRequests, [], 'The bundled application must work without external requests');
  } finally {
    await context.close();
  }
}

async function downloaded(page, selector) {
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.locator(selector).click(),
  ]);
  assert.equal(await download.failure(), null);
  return { name: download.suggestedFilename(), bytes: await fs.promises.readFile(await download.path()) };
}

test('starts offline with the original section and numerical results', async () => {
  await withPage(async page => {
    assert.equal(await page.title(), 'Box Girder Studio');
    assert.match(await page.locator('.brand').innerText(), /Box\s+Girder\s+Studio/i);
    await page.locator('#btn-run').click();
    const summary = await page.evaluate(() => {
      const model = SectionStudio.getModel();
      const result = SectionStudio.getResults();
      return {
        name: model.name, tendons: model.tendons.length, rebar: model.rebar.length,
        ok: result.ok, axes: Object.keys(result.axes),
        cases: result.cases.map(item => ({ id: item.id, phiMn: item.phiMn })),
        warnings: result.warnings.map(item => item.code),
        drawnObjects: document.querySelectorAll('#section-svg path, #section-svg circle').length,
      };
    });
    assert.equal(summary.name, 'EL-POT-27-EL45');
    assert.equal(summary.tendons, 62);
    assert.equal(summary.rebar, 286);
    assert.equal(summary.ok, true);
    assert.deepEqual(summary.axes.sort(), ['momentY', 'momentZ']);
    const reference = { negative: 855480.6826876674, positive: 190559.2410749423 };
    assert.equal(summary.cases.length, 2);
    for (const item of summary.cases) {
      assert.ok(Math.abs(item.phiMn - reference[item.id]) < 0.01, `${item.id}: baseline capacity changed`);
    }
    assert.ok(summary.drawnObjects > 300, 'The section, tendons, and reinforcement should be rendered');
    assert.ok(summary.warnings.includes('MISSING_DEMAND'));
    assert.ok(summary.warnings.includes('INITIAL_CRACKING'));
  });
});

test('all ten work areas open, and the language selection survives reload', async () => {
  await withPage(async page => {
    const tabs = await page.locator('.ribbon-tab').evaluateAll(elements => elements.map(element => element.dataset.tab));
    assert.deepEqual(tabs, ['reference', 'model', 'material', 'tendon', 'loads', 'psc', 'shear', 'analysis', 'results', 'report']);
    for (const tab of tabs) {
      await page.locator(`.ribbon-tab[data-tab="${tab}"]`).click();
      assert.equal(await page.locator('.ribbon-tab.active').getAttribute('data-tab'), tab);
      assert.ok((await page.locator('#table-tabs').innerText()).trim().length > 0, `${tab}: missing workspace commands`);
    }
    await page.locator('#ui-language').selectOption('en');
    assert.equal(await page.locator('.ribbon-tab[data-tab="results"]').innerText(), 'Analysis Results');
    await page.reload();
    await page.waitForFunction(() => !!window.SectionStudio);
    assert.equal(await page.locator('#ui-language').inputValue(), 'en');
    await page.locator('#ui-language').selectOption('id');
    assert.equal(await page.locator('.ribbon-tab[data-tab="results"]').innerText(), 'Hasil Analisis');
  });
});

test('JSON round trip, legacy import, CSV and formula workbook exports work', async () => {
  await withPage(async page => {
    const original = await page.evaluate(() => SectionStudio.getModel());
    const saved = await downloaded(page, '#btn-save');
    assert.match(saved.name, /\.json$/);
    const project = JSON.parse(saved.bytes.toString('utf8'));
    assert.equal(project.application, 'Box Girder Studio');
    assert.equal(project.version, 1);
    assert.deepEqual(project.model, original);
    await page.locator('#file-input').setInputFiles({ name: 'round-trip.json', mimeType: 'application/json', buffer: saved.bytes });
    await page.waitForFunction(() => SectionStudio.getWorkspaces().tabs.length === 2);
    assert.deepEqual(await page.evaluate(() => SectionStudio.getModel()), original);
    project.application = 'Girder Section Studio';
    await page.locator('#file-input').setInputFiles({
      name: 'legacy.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(project)),
    });
    await page.waitForFunction(() => SectionStudio.getWorkspaces().tabs.length === 3);
    assert.deepEqual(await page.evaluate(() => SectionStudio.getModel()), original);
    assert.equal(await page.evaluate(() => SectionStudio.getResults().ok), true);

    await page.locator('.ribbon-tab[data-tab="results"]').click();
    const csv = await downloaded(page, '#btn-export');
    assert.match(csv.name, /\.csv$/);
    const text = csv.bytes.toString('utf8');
    assert.match(text, /EL-POT-27-EL45/);
    assert.match(text, /Lentur negatif/);
    assert.match(text, /Lentur positif/);
    assert.match(text, /INITIAL_CRACKING/);
    const xlsx = await downloaded(page, '#btn-manual-excel');
    assert.match(xlsx.name, /\.xlsx$/);
    assert.equal(xlsx.bytes.subarray(0, 2).toString(), 'PK');
    const workbook = await page.evaluate(bytes => {
      const book = XLSX.read(Uint8Array.from(bytes), { type: 'array', cellFormula: true });
      return {
        title: book.Props.Title,
        sheets: book.SheetNames,
        formulas: Object.values(book.Sheets).reduce((sum, sheet) => sum + Object.values(sheet).filter(cell => cell?.f).length, 0),
      };
    }, [...xlsx.bytes]);
    assert.match(workbook.title, /Box Girder Studio/);
    assert.ok(workbook.sheets.length >= 4, 'Workbook must contain calculation sheets');
    assert.ok(workbook.formulas > 50, 'Workbook must retain calculation formulas');
  });
});

test('coordinate edits persist and closing a workspace can be undone', async () => {
  await withPage(async page => {
    const original = await page.evaluate(() => SectionStudio.getModel().tendons[0].x);
    const updated = original + 0.01;
    const coordinate = page.locator('[data-coordinate="tendons.0.x"]');
    await coordinate.fill(String(updated));
    await coordinate.press('Tab');
    await page.waitForFunction(value => SectionStudio.getModel().tendons[0].x === value, updated);
    assert.equal(await page.evaluate(() => SectionStudio.getResults().ok), true);
    await page.reload();
    await page.waitForFunction(() => !!window.SectionStudio);
    assert.equal(await page.evaluate(() => SectionStudio.getModel().tendons[0].x), updated);
    const initialId = await page.evaluate(() => SectionStudio.getWorkspaces().activeId);
    await page.locator('#workspace-new').click();
    await page.waitForFunction(() => SectionStudio.getWorkspaces().tabs.length === 2);
    const newId = await page.evaluate(() => SectionStudio.getWorkspaces().activeId);
    assert.notEqual(newId, initialId);
    await page.locator(`[data-workspace-close="${newId}"]`).click();
    assert.equal(await page.evaluate(() => SectionStudio.getWorkspaces().tabs.length), 1);
    assert.equal(await page.evaluate(() => SectionStudio.getModel().tendons[0].x), updated);
    await page.locator('#workspace-undo-close').click();
    const restored = await page.evaluate(() => SectionStudio.getWorkspaces());
    assert.equal(restored.tabs.length, 2);
    assert.equal(restored.activeId, newId);
    await page.locator(`[data-workspace-id="${initialId}"]`).click();
    assert.equal(await page.evaluate(() => SectionStudio.getModel().tendons[0].x), updated);
  });
});
