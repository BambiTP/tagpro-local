const { chromium } = require('playwright');
const [base, key] = process.argv.slice(2);
(async () => {
  const b = await chromium.launch({ args: ['--use-gl=swiftshader', '--ignore-gpu-blocklist'] });
  const page = await b.newPage({ viewport: { width: 1280, height: 800 } });
  page.on('pageerror', (e) => console.log('PAGEERROR', e.message));
  page.on('dialog', (d) => { console.log('DIALOG', d.message()); d.dismiss(); });
  await page.goto(base + '/replays');
  await page.waitForTimeout(2500);
  await page.screenshot({ path: __dirname + '/../ref/shots/replays-page.png' });
  console.log('replay rows on page:', await page.locator('table tbody tr').count());
  await page.goto(base + '/game?replay=' + key, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(12000);
  const st = await page.evaluate(() => ({ state: tagpro.state, players: Object.values(tagpro.players || {}).map((p) => p.name), map: !!tagpro.map }));
  console.log('viewer:', JSON.stringify(st));
  await page.screenshot({ path: __dirname + '/../ref/shots/replay-viewer.png' });
  await b.close();
})();
