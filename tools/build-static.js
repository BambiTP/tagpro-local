// build-static.js - builds the single-player game as a static site (GitHub Pages, any file host):
// the real client pages + the engine and bots running in the browser (static/local-game.js).
//   node tools/build-static.js <outDir>
// Every path is made relative, so the site works from any folder (e.g. user.github.io/repo/).
const fs = require('fs');
const path = require('path');
const pages = require('../server/pages');
const gamepage = require('../server/gamepage');

const out = path.resolve(process.argv[2] || '');
if (!process.argv[2]) { console.error('usage: node tools/build-static.js <outDir>'); process.exit(1); }
const ROOT = path.join(__dirname, '..');
const PUBLIC = path.join(ROOT, 'public');
const STATIC = path.join(ROOT, 'static');
const KEEP = new Set(['.git', 'LICENSE', 'CNAME', 'config.json']); // the target repo's own files
const write = (rel, text) => { fs.mkdirSync(path.dirname(path.join(out, rel)), { recursive: true }); fs.writeFileSync(path.join(out, rel), text); };

// clear the old build, keeping the repo's own files and maps added there (by the Add maps workflow)
fs.mkdirSync(out, { recursive: true });
for (const f of fs.readdirSync(out)) if (!KEEP.has(f) && f !== 'maps') fs.rmSync(path.join(out, f), { recursive: true, force: true });

// ---- assets: everything the client loads (not the server-only bits) ----
const SKIP = new Set(['game.html', 'socket.io', 'localtrust.js', 'music.json']);
for (const f of fs.readdirSync(PUBLIC)) {
  if (SKIP.has(f)) continue;
  fs.cpSync(path.join(PUBLIC, f), path.join(out, f), { recursive: true, filter: (src) => !src.includes(path.join('sounds', 'music')) });
}
// event scripts load images by page-relative paths ("events/easter-2016/images/egg.png")
fs.cpSync(path.join(PUBLIC, 'R-62bb0909b74c-z', 'events'), path.join(out, 'events'), { recursive: true });
write('music.json', '[]'); // the music files aren't part of this repo

// root-absolute URLs in the client scripts -> relative ("/sounds/x" -> "./sounds/x")
// WebGL off by default; a choice saved on the Settings page still wins (see clientDefaults.js)
const { CANVAS_DEFAULT } = require('../server/clientDefaults');
const ROUTES = 'sounds|images|textures|games|music|replays|flairlog|favicon|groups|launcher|profile|cookies|vpn|banned|R-62bb0909b74c-z|R-965af4e7a4b8-z';
const relJs = (s) => s.replace(new RegExp(`(["'\`])/(?=(${ROUTES})\\b)`, 'g'), '$1./').replace('"./music?callback=?"', '"./music.json"')
  .replace(CANVAS_DEFAULT[0], CANVAS_DEFAULT[1]);
for (const dir of ['R-62bb0909b74c-z', 'R-965af4e7a4b8-z']) {
  const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
  for (const f of walk(path.join(out, dir)).filter((f) => f.endsWith('.js'))) fs.writeFileSync(f, relJs(fs.readFileSync(f, 'utf8')));
}

// ---- engine (runs in the page) ----
fs.mkdirSync(path.join(out, 'engine'), { recursive: true });
for (const f of ['box2d.js', 'constants.js', 'mapLoader.js', 'game.js']) fs.copyFileSync(path.join(ROOT, 'engine', f), path.join(out, 'engine', f));
fs.copyFileSync(path.join(ROOT, 'server', 'botBrain.js'), path.join(out, 'engine', 'botBrain.js'));
fs.copyFileSync(path.join(STATIC, 'local-game.js'), path.join(out, 'engine', 'local-game.js'));
fs.copyFileSync(path.join(STATIC, 'engine-worker.js'), path.join(out, 'engine', 'worker.js'));
for (const f of ['index.html', 'launcher.js', 'README.md']) fs.copyFileSync(path.join(STATIC, f), path.join(out, f));
// the site's own tools: Fortunate Maps downloads (Actions tab -> Add maps) and the map list
fs.mkdirSync(path.join(out, 'tools'), { recursive: true });
fs.copyFileSync(path.join(STATIC, 'add-maps.js'), path.join(out, 'tools', 'add-maps.js'));
fs.mkdirSync(path.join(out, '.github', 'workflows'), { recursive: true });
fs.copyFileSync(path.join(STATIC, 'add-maps.yml'), path.join(out, '.github', 'workflows', 'add-maps.yml'));
// the site's settings (kept between builds): sites to fetch Fortunate Maps through, see README
if (!fs.existsSync(path.join(out, 'config.json'))) write('config.json', JSON.stringify({ fortunateMapsProxies: ['https://cors.bambitp.workers.dev/?url='] }, null, 2) + '\n');
write('settings.json', JSON.stringify(require('./settings-spec')()));
write('defaults.json', JSON.stringify(Object.fromEntries(require('../server/groupDefaults.json').settings)));

// ---- pages: the real ones, made relative ----
pages.setStatsProvider(() => ({ STATS_PLAYERS: 1, STATS_GAMES: 1, STATS_ONLINE: 1 }));
const relHtml = (h) => h.replace(/(\b(?:src|href|action)=")\/(?!\/)/g, '$1./').replace(/(url\(['"]?)\/(?!\/)/g, '$1./');
// the game server runs in a Web Worker (engine/worker.js); the page only gets the fake socket
const ENGINE = '<script src="/engine/local-game.js"></script>';
function gamePage(mode) {
  let h = pages.render('game.html', { GAME_SOCKET: '/local', GAME_SERVER: 'local', GAME_ID: 'local', GAME_SOCKET_LABEL: 'This browser', GROUP_ID: 'null' });
  h = gamepage.withTextures(gamepage.DEFAULT_PACK, h);
  if (mode === 'eggball') h = gamepage.forRoom({ egg: true }, h);
  h = h.replace('<script type="text/javascript" src="/socket.io/socket.io.min.js"></script>', ENGINE);
  if (!h.includes('/engine/local-game.js')) throw new Error('game.html: socket.io script tag not found');
  h = h.replace('</body>', '    <script>window.tplApplyTextures && tplApplyTextures();</script>\n    </body>');
  return relHtml(h);
}
write('game.html', gamePage('classic'));
write('eggball.html', gamePage('eggball'));
// (the texture pack data's image URLs too: the picker saves them in the "textures" cookie)
for (const name of ['textures', 'settings']) {
  write(name + '.html', relHtml(pages.render(name + '.html')).replace(/href="\.\/(textures|settings)"/g, 'href="./$1.html"').replace(/"\/textures\//g, '"./textures/'));
}

// where the client and the real pages' links go: back home
const HOME = (up) => `<!doctype html><meta charset="utf-8"><title>TagPro Offline</title><script>location.replace('${up}' + location.hash)</script><a href="${up}">Home</a>\n`;
write('games/find/index.html', HOME('../../'));
// GitHub Pages shows 404.html for missing pages (the real header's links: groups, log in...): home
write('404.html', `<!doctype html><meta charset="utf-8"><title>TagPro Offline</title><script>
var p = location.pathname.split('/'); location.replace(location.hostname.endsWith('github.io') && p[1] ? '/' + p[1] + '/' : '/');
</script>\n`);
write('.nojekyll', '');

// ---- maps: this repo's maps plus any already in the target (added by its Add maps workflow) ----
fs.mkdirSync(path.join(out, 'maps'), { recursive: true });
for (const f of fs.readdirSync(path.join(ROOT, 'maps'))) if (!f.startsWith('upload-') && /\.(png|json)$/.test(f)) fs.copyFileSync(path.join(ROOT, 'maps', f), path.join(out, 'maps', f));
require('../static/add-maps').writeIndex(path.join(out, 'maps'));

console.log('built', out);
