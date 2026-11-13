'use strict';

// Proposed shear inputs must retain their provenance and respect project overrides.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { before, after, test } = require('node:test');
const { chromium } = require('playwright');

let server;
let browser;
let origin;

before(async () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'));
  server = http.createServer((request, response) => {
    response.writeHead(request.url === '/' ? 200 : 204, { 'Content-Type': 'text/html; charset=utf-8' });
    response.end(request.url === '/' ? html : undefined);
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  origin = `http://127.0.0.1:${server.address().port}`;
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
  const errors = [];
  const externalRequests = [];
  await context.route('**/*', route => {
    const url = route.request().url();
    if (/^https?:/.test(url) && new URL(url).origin !== origin) {
      externalRequests.push(url);
      return route.abort();
    }
    return route.continue();
  });
  const page = await context.newPage();
  page.on('pageerror', error => errors.push(error.message));
  try {
    await page.goto(origin);
    await page.waitForFunction(() => !!window.SectionStudio && !!window.ShearSuggestions);
    await body(page);
    assert.deepEqual(errors, [], 'No uncaught browser errors');
    assert.deepEqual(externalRequests, [], 'Suggestions require no external service');
  } finally {
    await context.close();
  }
}

function near(actual, expected, tolerance = 1e-5) {
  assert.ok(Number.isFinite(actual) && Math.abs(actual - expected) <= tolerance,
    `Expected ${expected} ± ${tolerance}; received ${actual}`);
}

async function downloadBytes(page, selector) {
  const [download] = await Promise.all([page.waitForEvent('download'), page.locator(selector).click()]);
  assert.equal(await download.failure(), null);
  return fs.promises.readFile(await download.path());
}

test('gross-width proposals match an analytical hollow box and geometric transformations', async () => {
  await withPage(async page => {
    const values = await page.evaluate(() => {
      const model = SectionStudio.getModel();
      // Two 200 mm webs and two 300 mm slabs, independent of the drawing origin.
      const geometry = {
        outer: [[-2, -1], [2, -1], [2, 1], [-2, 1]],
        inner: [[-1.8, -0.7], [1.8, -0.7], [1.8, 0.7], [-1.8, 0.7]],
      };
      const describe = g => ShearSuggestions.evaluate({ ...model, geometry: g }).widths;
      const transform = (scale, dx, dy, reverse) => Object.fromEntries(Object.entries(geometry).map(([key, ring]) => {
        const next = ring.map(([x, y]) => [x * scale + dx, y * scale + dy]);
        return [key, reverse ? next.reverse() : next];
      }));
      return [describe(geometry), describe(transform(1, 1e5, -1e5, true)), describe(transform(2, 0, 0, false))];
    });
    near(values[0].Y.value, 400);
    near(values[0].Z.value, 600);
    near(values[1].Y.value, 400);
    near(values[1].Z.value, 600);
    near(values[2].Y.value, 800);
    near(values[2].Z.value, 1200);
    assert.equal(values[0].Y.assumed, true, 'Gross candidate is not a verified effective width');
    assert.equal(values[0].Z.assumed, true);
  });
});

test('invalid geometry or units never produce a usable width proposal', async () => {
  await withPage(async page => {
    const cases = await page.evaluate(() => {
      const model = SectionStudio.getModel();
      const valid = { outer: [[-2, -1], [2, -1], [2, 1], [-2, 1]], inner: [[-1, -0.5], [1, -0.5], [1, 0.5], [-1, 0.5]] };
      const inputs = [
        { ...model, geometry: { outer: [], inner: [] } },
        { ...model, geometry: { ...valid, outer: [[-2, -1], [2, 1], [2, -1], [-2, 1]] } },
        { ...model, geometry: { ...valid, inner: valid.inner.map(([x, y]) => [x + 20, y]) } },
        { ...model, geometry: valid, design: { ...model.design, coordinateUnits: 'mm' } },
      ];
      return inputs.map(input => ShearSuggestions.evaluate(input).widths);
    });
    for (const widths of cases) {
      assert.equal(widths.Y.value, null);
      assert.equal(widths.Z.value, null);
    }
  });
});

test('tendon inventory uses actual per-case strands and separates axial prestress from transverse Vp', async () => {
  await withPage(async page => {
    const data = await page.evaluate(() => {
      const model = SectionStudio.getModel();
      const initial = ShearSuggestions.evaluate(model);
      const changed = structuredClone(model);
      const id = changed.tendons[0].id;
      changed.cases[0].tendonStrands = { [id]: 20 };
      const proposed = ShearSuggestions.evaluate(changed);
      const resolved = ShearProject.describe(changed, null).resolved;
      const invalid = structuredClone(changed);
      invalid.cases[0].tendonStrands[id] = 0;
      return { initial, proposed, resolved: { VpY: resolved.VpY, VpZ: resolved.VpZ }, invalid: ShearSuggestions.evaluate(invalid).inventory };
    });
    assert.equal(data.initial.inventory.tendonCount, 62);
    assert.equal(data.initial.inventory.cases[0].strands, 930);
    near(data.initial.inventory.cases[0].area, 130200);
    near(data.initial.inventory.cases[0].Pe, 154384.65);
    assert.equal(data.proposed.inventory.cases[0].strands, 935);
    assert.equal(data.proposed.inventory.cases[1].strands, 930);
    near(data.proposed.inventory.cases[0].Pe, 154384.65 * 935 / 930);
    near(data.proposed.inventory.cases[1].Pe, 154384.65);
    assert.equal(data.resolved.VpY, 0, 'Straight-tendon proposal must not use total axial Pe as Vp');
    assert.equal(data.resolved.VpZ, 0);
    assert.ok(data.invalid.errors.length > 0, 'Invalid strand schedules must be reported');
    assert.ok(data.invalid.cases.every(item => item.Pe === null), 'Do not publish partial prestress totals');
    near(data.initial.widths.Y.value, 1495.2006, 0.01);
    near(data.initial.widths.Z.value, 879.31034, 0.01);
  });
});

test('legacy manual inputs are preserved and automatic beta requires its stated 45-degree assumption', async () => {
  await withPage(async page => {
    const data = await page.evaluate(() => {
      const model = SectionStudio.getModel();
      model.design.shearTorsion = { bvY: 700, betaY: 3, lambda: 0.85, VpY: 0, kductY: 0.8 };
      const legacy = ShearProject.describe(model, SectionStudio.getResults());
      model.design.shearTorsion = { thetaMode: 'manual', theta: 30 };
      const angle = ShearProject.describe(model, SectionStudio.getResults());
      model.design.shearTorsion.betaY = 2.6;
      model.design.shearTorsion.betaYMode = 'manual';
      const override = ShearProject.describe(model, SectionStudio.getResults());
      return { legacy: { settings: legacy.settings, resolved: legacy.resolved }, angle: { resolved: angle.resolved, source: angle.parameterSources.betaY }, override: override.resolved.betaY };
    });
    for (const [key, value] of Object.entries({ bvY: 700, betaY: 3, lambda: 0.85, VpY: 0, kductY: 0.8 })) {
      assert.equal(data.legacy.settings[`${key}Mode`], 'manual', `${key} must retain legacy meaning`);
      assert.equal(data.legacy.resolved[key], value);
    }
    assert.equal(data.angle.resolved.betaY, null);
    assert.equal(data.angle.resolved.betaZ, null);
    assert.ok(data.angle.source.reason || data.angle.source.note);
    assert.equal(data.override, 2.6);
  });
});

test('the total-shear screen exposes sources, preserves manual edits, and exports provenance', async () => {
  await withPage(async page => {
    await page.locator('.ribbon-tab[data-tab="shear"]').click();
    await page.locator('[data-shear-key="dcrMode"]').selectOption('total');
    assert.equal(await page.locator('#shear-model-suggestions').isVisible(), true);
    assert.match(await page.locator('#shear-model-suggestions').innerText(), /62/);
    for (const key of ['bvY', 'bvZ', 'betaY', 'betaZ', 'lambda', 'kductY', 'kductZ', 'VpY', 'VpZ']) {
      const input = page.locator(`[data-shear-key="${key}"]`);
      assert.equal(await input.evaluate(element => element.readOnly), true, `${key}: automatic proposal must identify its source`);
      assert.notEqual(await input.inputValue(), '', `${key}: missing proposal`);
      assert.ok((await page.locator(`[data-shear-parameter-source="${key}"]`).innerText()).trim().length > 10);
    }
    await page.locator('[data-shear-key="bvYMode"]').selectOption('manual');
    const input = page.locator('[data-shear-key="bvY"]');
    assert.equal(await input.evaluate(element => element.readOnly), false);
    await input.fill('725');
    await input.press('Tab');
    await page.waitForFunction(() => SectionStudio.getModel().design.shearTorsion.bvY === 725);
    await page.reload();
    await page.waitForFunction(() => !!window.SectionStudio);
    assert.equal(await page.locator('[data-shear-key="bvY"]').inputValue(), '725');
    assert.equal(await page.locator('[data-shear-key="bvYMode"]').inputValue(), 'manual');
    const json = JSON.parse((await downloadBytes(page, '#btn-save')).toString('utf8'));
    assert.equal(json.model.design.shearTorsion.bvY, 725);
    assert.equal(json.model.design.shearTorsion.bvYMode, 'manual');
    const csv = (await downloadBytes(page, '#btn-export-shear')).toString('utf8');
    assert.match(csv, /Mode bvY/);
    assert.match(csv, /manual/);
    assert.match(csv, /Sumber VpY/);
    assert.match(csv, /[Uu]sulan|[Aa]sumsi/);
    assert.match(csv, /725/);
    await page.locator('[data-table="shear-results"]:visible').first().click();
    const proposalNotes = page.locator('[data-shear-proposal-note]:visible');
    assert.ok(await proposalNotes.count() >= 2, 'Both the DCR summary and result detail must disclose proposals');
    for (const note of await proposalNotes.allTextContents()) {
      assert.match(note, /bv,z/);
      assert.doesNotMatch(note, /bv,y/, 'Manual width must not be presented as an automatic assumption');
    }
  });
});
