const { chromium } = require('playwright');
const base = process.argv[2] || 'http://localhost:3000';
(async () => {
  const b = await chromium.launch(); const page = await b.newPage({ viewport: { width: 1280, height: 900 } });
  page.on('pageerror', (e) => console.log('PAGEERROR', e.message));
  page.on('console', (m) => { if (m.type() === 'error') console.log('console.error', m.text().slice(0, 150)); });
  await page.goto(base + '/games/find');
  await page.evaluate(() => {
    const s = joinerSocketInstance && joinerSocketInstance.joinerSocket;
    if (s) { const emit = s.emit.bind(s); s.emit = (...a) => { console.log('EMIT ' + a[0]); return emit(...a); }; s.onAny((ev) => console.log('RECV ' + ev)); }
  }).catch((e) => console.log('hook failed', e.message));
  page.on('console', (m) => { if (/^(EMIT|RECV)/.test(m.text())) console.log(m.text()); });
  for (let i = 0; i < 4; i++) {
    await page.waitForTimeout(2000);
    const txt = await page.evaluate(() => [...document.querySelectorAll('#joiner-status, .joiner-status, #launcher-status, .status, #status')].map((e) => e.id + ':' + e.textContent.trim().replace(/\s+/g, ' ')).join(' | '));
    console.log('t+' + (i + 1) * 2 + 's status:', txt);
  }
  await page.screenshot({ path: __dirname + '/../ref/shots/queue-page.png' });
  await b.close();
})();
