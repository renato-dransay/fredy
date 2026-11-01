/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */
// Run after yarn build:frontend with vite preview listening on 127.0.0.1:4178.
// API fixtures are intercepted in Chrome; this never writes to an actual Fredy instance.
import { fileURLToPath, pathToFileURL } from 'node:url';
const root = fileURLToPath(new URL('../../../', import.meta.url));
const { default: puppeteer } = await import(
  pathToFileURL(`${root}/node_modules/puppeteer-core/lib/puppeteer/puppeteer-core.js`).href
);
const log = (...values) =>
  process.stdout.write(
    values.map((value) => (typeof value === 'string' ? value : JSON.stringify(value))).join(' ') + '\n',
  );
import { mkdir } from 'node:fs/promises';
const artifacts = `${root}/work/autonomous-implementation/ui-simplification/screenshots`;
await mkdir(artifacts, { recursive: true });
const browser = await puppeteer.launch({
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: true,
  args: ['--no-sandbox', '--enable-webgl', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});
const page = await browser.newPage();
const errors = [];
page.on('pageerror', (e) => {
  errors.push(e.message);
  log('PAGEERROR', e.stack);
});
const criteria = [
  {
    id: 'rooms',
    text: 'At least three total rooms',
    kind: 'min_rooms',
    value: 3,
    weight: 2,
    required: true,
    verdict: 'met',
  },
  {
    id: 'kitchen',
    text: 'A separate kitchen with enough space for a dining table',
    kind: 'semantic',
    weight: 2,
    verdict: 'met',
  },
  {
    id: 'lease',
    text: 'An indefinite lease without a mandatory short-term limit',
    kind: 'semantic',
    weight: 1,
    verdict: 'unknown',
  },
  {
    id: 'pets',
    text: 'Explicit permission for a large dog to live in the apartment',
    kind: 'semantic',
    weight: 2,
    required: true,
    verdict: 'unknown',
  },
  {
    id: 'budget',
    text: 'Monthly rent including charges must not exceed 1800 euros',
    kind: 'max_price',
    value: 1800,
    weight: 2,
    required: true,
    verdict: 'unmet',
  },
  {
    id: 'outdoor',
    text: 'Balcony or terrace accessible directly from the apartment',
    kind: 'semantic',
    weight: 1,
    verdict: 'met',
  },
];
let profile = {
  document: 'Our apartment requirements',
  criteria: criteria.map(({ verdict: _verdict, ...c }) => c),
  version: 1,
  instructions: 'Default assessment guidance.',
};
let saved = null;
let evaluationCalls = 0;
let theme = 'dark';
let invalidOnly = false;
const rows = Array.from({ length: 8 }, (_, i) => ({
  id: `flat${i}`,
  title:
    i === 0
      ? 'Bright apartment with balcony and separate kitchen'
      : `Quiet apartment ${i + 1} with generous living space`,
  price: 1400 + i * 120,
  size: 80 + i * 2,
  rooms: 3,
  address: `${i + 1} Sample Street, Berlin`,
  job_id: 'berlin',
  job_name: 'Berlin rentals',
  provider: 'immoscout',
  dealType: 'rent',
  is_active: 1,
  isWatched: 0,
  published_at: Date.now() - i * 86400000,
  created_at: Date.now(),
  latitude: 52.5 + i * 0.005,
  longitude: 13.38 + i * 0.008,
  description:
    'A bright apartment with a balcony, a separate kitchen and three rooms. The building has a lift. Contact the landlord for lease and pet details.',
  notes: '',
  images: [],
  travelTimes: [],
  status: null,
  fitSummary: { score: 64, coverage: 70, hardFailure: true, hardUnknown: true, stale: false },
}));
await page.setRequestInterception(true);
page.on('request', async (req) => {
  const u = new URL(req.url()),
    p = u.pathname;
  if (!p.startsWith('/api/')) return req.continue();
  let body = {};
  if (p.includes('/events'))
    return req.respond({ status: 200, contentType: 'text/event-stream', body: ': fixture\n\n' });
  if (p.endsWith('/image')) return req.respond({ status: 404, body: '' });
  if (p === '/api/login/user') body = { userId: 'preview', username: 'Preview', isAdmin: true };
  else if (p === '/api/user/settings') body = { language: 'en', theme, listings_view_mode: 'grid', home_addresses: [] };
  else if (p === '/api/jobs') body = [{ id: 'berlin', name: 'Berlin rentals', provider: [{ id: 'immoscout' }] }];
  else if (p === '/api/jobs/provider') body = [{ id: 'immoscout', name: 'ImmoScout24', countries: ['de'] }];
  else if (p === '/api/listings/table')
    body = { result: rows, totalNumber: rows.length, page: 1, availableProviders: ['immoscout'] };
  else if (p === '/api/listings/map')
    body = {
      listings: [
        ...(invalidOnly ? [] : rows),
        { ...rows[0], id: 'invalid-lat', latitude: 999 },
        { ...rows[0], id: 'invalid-lng', longitude: 999 },
      ],
    };
  else if (p === '/api/fit/profile') {
    if (req.method() === 'POST') {
      saved = JSON.parse(req.postData());
      profile = { ...saved, version: profile.version + 1 };
    }
    body = { profile, provider: { configured: true, model: 'typesafe/jev-1.14' } };
  } else if (p === '/api/fit/automation') body = { jobs: [], jobIds: [], configured: true };
  else if (p.startsWith('/api/fit/listings/')) {
    if (p.endsWith('/evaluate')) evaluationCalls++;
    body = { result: { ...rows[0].fitSummary, criteria }, stale: false };
  } else if (p.startsWith('/api/applications/listings/'))
    body = {
      application: { id: 'application', status: 'submitted', visitAt: null, followUpAt: null, subject: '', body: '' },
      events: [],
    };
  else if (p.match(/^\/api\/listings\/flat\d+$/)) body = rows.find((r) => r.id === p.split('/').at(-1));
  else if (p.endsWith('/priceHistory')) body = [];
  else if (p.endsWith('/attachments')) body = { attachments: [], maxMb: 10, maxPerListing: 5 };
  else if (p.includes('/travel-times')) body = { travelTimes: [] };
  else if (p.includes('/transit/stops/nearby')) body = { stops: [] };
  else if (p === '/api/version') body = { version: '30.1.2' };
  else if (['/api/jobs/shareableUserList', '/api/jobs/notificationAdapter'].includes(p)) body = [];
  await req.respond({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
});
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const assert = (ok, msg) => {
  if (!ok) throw Error(msg);
};
const goto = async (route) => {
  await page.goto(`http://127.0.0.1:4178/#${route}`, { waitUntil: 'networkidle2', timeout: 60000 });
};
const overflow = () => page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
try {
  await page.setViewport({ width: 1440, height: 1000 });
  await goto('/listings');
  await page.waitForSelector('.listingsGrid__card');
  assert((await page.$$eval('.listingsGrid__card', (els) => els.length)) === 8, 'Grid listings missing');
  assert(
    await page.$eval('.listingsGrid__card .fitSummary', (el) => !el.open),
    'Repeated summary must start collapsed',
  );
  await page.click('.listingsGrid__card .fitSummary__toggle');
  assert(page.url().endsWith('/listings'), 'Summary click navigated away');
  assert(await page.$eval('.listingsGrid__card .fitSummary', (el) => el.open), 'Summary did not disclose warnings');
  await page.click('.listingsGrid__card .fitSummary__toggle');
  for (const width of [1440, 390]) {
    await page.setViewport({ width, height: 1000 });
    await pause(350);
    assert(!(await overflow()), `Grid overflow ${width}`);
    await page.screenshot({ path: `${artifacts}/listings-${width}.png` });
  }
  await page.setViewport({ width: 1440, height: 1000 });
  await goto('/listings/listing/flat0');
  await page.waitForSelector('.fitCard__chip');
  const initial = await page.evaluate(() => ({
    photo: document.querySelector('.listing-detail__sec--media').getBoundingClientRect().top,
    fit: document.querySelector('.fitCard').getBoundingClientRect().top,
    application: document.querySelector('.listing-detail__sec--application details').open,
    keywords: [...document.querySelectorAll('.fitCard__chipText')].map((e) => e.textContent),
    iconCount: document.querySelectorAll('.fitCard__icon').length,
  }));
  assert(
    initial.photo < initial.fit && !initial.application && initial.iconCount === 6,
    'Detail hierarchy or icons failed',
  );
  log('DETAIL', JSON.stringify(initial));
  const chip = await page.$('.fitCard__chip');
  await chip.focus();
  await page.keyboard.press('Enter');
  assert(await page.$eval('.fitCard__criterion', (el) => el.open), 'Keyboard chip disclosure failed');
  await page.keyboard.press('Enter');
  const pets = await page.$$('.fitCard__criterion');
  await pets.at(-1).click();
  assert(await pets.at(-1).evaluate((el) => el.open), 'Touch/click criterion disclosure failed');
  for (const currentTheme of ['dark', 'light']) {
    await page.evaluate((t) => document.body.setAttribute('theme-mode', t), currentTheme);
    for (const width of [1440, 390]) {
      await page.setViewport({ width, height: 1000 });
      await pause(450);
      assert(!(await overflow()), `Detail overflow ${currentTheme} ${width}`);
      const order = await page.evaluate(() => ({
        photo: document.querySelector('.listing-detail__sec--media').getBoundingClientRect().top,
        fit: document.querySelector('.fitCard').getBoundingClientRect().top,
      }));
      assert(order.photo < order.fit, 'Photo does not lead at narrow width');
      await page.screenshot({ path: `${artifacts}/detail-${currentTheme}-${width}.png` });
    }
  }
  await page.setViewport({ width: 1440, height: 1000 });
  await goto('/settings/search-profile');
  await page.waitForSelector('textarea[maxlength="4000"]');
  const instructions = await page.$('textarea[maxlength="4000"]');
  await instructions.evaluate((el) => {
    el.focus();
    el.select();
  });
  await page.keyboard.type('Require explicit pet permission and an indefinite lease.');
  const label = await page.$('input[maxlength="32"]');
  await label.type('Living rooms');
  await page.select('.searchWorkspace__criterion select', 'pets');
  await page.$$eval('button', (buttons) => buttons.find((b) => b.textContent.trim() === 'Save requirements').click());
  await pause(500);
  log('SAVED', JSON.stringify(saved));
  assert(
    saved?.instructions === 'Require explicit pet permission and an indefinite lease.',
    'Instructions not saved from UI',
  );
  assert(saved.criteria[0].label === 'Living rooms' && saved.criteria[0].icon === 'pets', 'Chip metadata not saved');
  await goto('/settings/search-profile');
  await page.waitForSelector('textarea[maxlength="4000"]');
  assert(
    (await page.$eval('textarea[maxlength="4000"]', (el) => el.value)) === saved.instructions,
    'Instructions did not reload',
  );
  for (const width of [1440, 390]) {
    await page.setViewport({ width, height: 1000 });
    await pause(300);
    assert(!(await overflow()), `Settings overflow ${width}`);
    await page.screenshot({ path: `${artifacts}/settings-${width}.png` });
  }
  assert(evaluationCalls === 0, 'Reading/editing UI triggered inference');
  log('SETTINGS save/reload + no inference PASS');
  await page.setViewport({ width: 1440, height: 1000 });
  await goto('/map?transit=false');
  await page.waitForSelector('.map-fit-pin');
  await pause(1500);
  assert(
    await page.$eval('.map-results__showAll', (el) => el.textContent.includes('8')),
    'Invalid positions affected result count',
  );
  assert(await page.$('.map-panel--folded'), 'Desktop filters initially open');
  await page.click('.map-panel__legendDisclosure > summary');
  assert(await page.$eval('.map-panel__legendDisclosure', (el) => el.open), 'Legend unavailable while filters closed');
  await page.click('.map-panel__legendDisclosure > summary');
  await page.click('.map-panel__foldToggle');
  assert(await page.$('.map-panel__disclosure'), 'Layer group missing');
  assert(!(await page.$eval('.map-panel__disclosure', (el) => el.open)), 'Map layers not initially folded');
  await page.click('.map-panel__disclosure > summary');
  assert(await page.$eval('.map-panel__disclosure', (el) => el.open), 'Map layers cannot expand');
  await page.click('.map-panel__foldToggle');
  for (let i = 0; i < 5; i++) {
    await page.click('.maplibregl-ctrl-zoom-in');
    await pause(200);
  }
  await pause(500);
  await page.click('.map-results__showAll');
  await pause(600);
  assert(
    (await page.$$eval('.map-results__card', (els) => els.length)) === 8,
    'Show all did not reframe current matches',
  );
  assert(!page.url().includes('priceMin'), 'Unexpected filter mutation');
  for (const width of [1440, 390]) {
    await page.setViewport({ width, height: 1000 });
    await pause(800);
    assert(!(await overflow()), `Map overflow ${width}`);
    await page.screenshot({ path: `${artifacts}/map-${width}.png` });
  }
  await page.click('.map-panel__foldToggle');
  const pendingThumb = await page.$('.range-slider__thumb');
  await pendingThumb.focus();
  await page.keyboard.press('ArrowRight');
  await goto('/map?transit=false&priceMin=2000');
  await page.waitForSelector('.map-fit-pin');
  await pause(800);
  await page.click('.map-results__showAll');
  await pause(400);
  assert(
    (await page.$$eval('.map-results__card', (els) => els.length)) === 3 && page.url().includes('priceMin=2000'),
    'Recovery cleared filters or count mismatch',
  );
  invalidOnly = true;
  await goto('/map?transit=false');
  await page.reload({ waitUntil: 'networkidle2' });
  await page.waitForSelector('.map-results__showAll');
  await pause(800);
  assert((await page.$$eval('.map-fit-pin', (els) => els.length)) === 0, 'Invalid rows created pins');
  assert(
    await page.$eval('.map-results__showAll', (el) => el.disabled && el.textContent.includes('0')),
    'All-invalid recovery action not disabled',
  );
  log('MIXED/ALL INVALID POSITIONS + FILTER RETENTION + PENDING INPUT NAVIGATION PASS');
  assert(errors.length === 0, 'Browser errors: ' + errors.join('; '));
  log('INTEGRATED UI ACCEPTANCE PASS');
} catch (e) {
  await page.screenshot({ path: `${artifacts}/diagnostic.png` });
  log('STATE', await page.evaluate(() => ({ url: location.href, text: document.body.innerText.slice(0, 3000) })));
  throw e;
} finally {
  await browser.close();
}
