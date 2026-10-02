const { chromium } = require('playwright');
(async () => {
  const b = await chromium.launch(); const page = await b.newPage({ viewport: { width: 1280, height: 1100 } });
  page.on('pageerror', (e) => console.log('PAGEERROR', e.message));
  await page.goto('http://localhost:3000/maps'); await page.waitForTimeout(3000);
  console.log('page text has Asida:', (await page.textContent('body')).includes('Asida'));
  await page.screenshot({ path: __dirname + '/../ref/shots/maps-page.png' });
  await b.close();
})();
