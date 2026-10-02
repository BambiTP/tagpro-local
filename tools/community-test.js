const { chromium } = require('playwright');
const base = process.argv[2] || 'http://localhost:3000';
const shot = (n) => __dirname + '/../ref/shots/' + n + '.png';
(async () => {
  const b = await chromium.launch(); const page = await b.newPage({ viewport: { width: 1280, height: 900 } });
  page.on('pageerror', (e) => console.log('PAGEERROR', e.message));
  await page.goto(base + '/feedback'); console.log('logged out feedback shows login link:', await page.locator('a[href="/login"].btn').count() > 0);
  const user = 'fb' + Math.floor(Math.random() * 1e5);
  await page.goto(base + '/login'); const reg = page.locator('form[action="/register"]');
  await reg.locator('[name=username]').fill(user); await reg.locator('[name=password]').fill('secret123');
  await Promise.all([page.waitForNavigation(), reg.locator('button').click()]);
  await page.goto(base + '/feedback');
  await page.fill('textarea[name=body]', 'Portals feel great now!\nSecond line of details.');
  await Promise.all([page.waitForNavigation(), page.click('form[action="/feedback"] button')]);
  console.log('thread url:', page.url().replace(base, ''));
  await page.waitForTimeout(16000); // flood protection: 15s between posts
  await page.fill('textarea[name=body]', 'Agreed, nice work.');
  await Promise.all([page.waitForNavigation(), page.click('form[action$="/reply"] button')]);
  console.log('posts in thread:', await page.locator('a[href^="/profile/"]').count());
  await page.screenshot({ path: shot('feedback-thread') });
  await page.goto(base + '/playersearch?q=' + user);
  console.log('search results:', await page.locator('a[href^="/profile/"]').count());
  await page.locator('a[href^="/profile/"]').first().click(); await page.waitForLoadState();
  console.log('profile page:', page.url().replace(base, ''), '| heading:', (await page.textContent('h1')).trim());
  await page.screenshot({ path: shot('public-profile') });
  await b.close();
})();
