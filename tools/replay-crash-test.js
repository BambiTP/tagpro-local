const { chromium } = require('playwright');
const [base, key] = process.argv.slice(2);
(async () => {
  const b = await chromium.launch({ args: ['--use-gl=swiftshader', '--ignore-gpu-blocklist'] });
  const page = await b.newPage({ viewport: { width: 1280, height: 800 } });
  page.on('pageerror', (e) => console.log('PAGEERROR', e.message));
  page.on('console', (m) => { if (m.type() === 'error') console.log('console.error', m.text().slice(0, 200)); });
  page.on('dialog', (d) => { console.log('DIALOG', d.message()); d.dismiss(); });
  page.on('framenavigated', (f) => { if (f === page.mainFrame()) console.log('NAV', f.url()); });
  await page.goto(base + '/game?replay=' + key, { waitUntil: 'domcontentloaded' });
  for (let i = 0; i < 6; i++) {
    await page.waitForTimeout(5000);
    const st = await page.evaluate(() => typeof tagpro !== 'undefined' ? { state: tagpro.state, players: Object.keys(tagpro.players || {}).length } : null).catch((e) => 'eval failed: ' + e.message);
    console.log('t+' + (i + 1) * 5 + 's', page.url().replace(base, ''), JSON.stringify(st));
  }
  await b.close();
})();
