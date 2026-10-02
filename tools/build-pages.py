# Turns the real TagPro pages saved in ref/ into local templates in server/pages/.
# Placeholders filled per request by the server: {{GROUP_ID}} {{GROUP_NAME}} {{GAME_SOCKET}} {{GAME_ID}} {{GAME_SERVER}}
import re, pathlib
root = pathlib.Path(__file__).resolve().parent.parent
out = root / 'server/pages'; out.mkdir(parents=True, exist_ok=True)

def common(h):
    # ads / analytics
    h = re.sub(r'<script async src="https://pagead2[^>]*>\s*</script>', '', h)
    h = re.sub(r'<ins class="adsbygoogle[\s\S]*?</ins>\s*<script>[\s\S]*?</script>', '', h)
    h = re.sub(r'<script async src="https://www.googletagmanager[^>]*></script>\s*<script>[\s\S]*?</script>', '', h)
    h = re.sub(r'<script>\s*\(function\(d\)[\s\S]*?</script>', '', h)  # third-party loader at page end
    h = h.replace('//static.koalabeast.com/R-62bb0909b74c-z/compact/redirect.js', '/R-62bb0909b74c-z/compact/redirect.js')
    # hosts -> this server
    h = h.replace('tagproConfig.musicHost = "tagpro.koalabeast.com"', 'tagproConfig.musicHost = location.host')
    h = h.replace('tagproConfig.cdn = "static.koalabeast.com"', 'tagproConfig.cdn = location.host')
    h = re.sub(r"tagproConfig.cookieHost = '[^']*'", 'tagproConfig.cookieHost = location.hostname', h)
    h = re.sub(r'tagproConfig.serverPort = \d+', 'tagproConfig.serverPort = location.port || 80', h)
    h = h.replace('https://tagpro.koalabeast.com/', '/').replace('//static.koalabeast.com/', '/')
    h = h.replace('/textures/musclescupgradients/', '/textures/classic/')
    h = re.sub(r'(id="groupId"[^>]*value=")[a-z]{8}"|(value=")[a-z]{8}("[^>]*id="groupId")', lambda m: (m.group(1) or m.group(2)) + '{{GROUP_ID}}' + ('"' if m.group(1) else m.group(3)), h)
    h = re.sub(r'<div>\d+ players in \d+ games', '<div>{{STATS_PLAYERS}} players in {{STATS_GAMES}} games', h)
    h = re.sub(r'<div>\d+ total users online</div>', '<div>{{STATS_ONLINE}} total users online</div>', h)
    return h

def page(src, dst, fn=lambda h: h):
    h = fn(common((root / 'ref' / src).read_text()))
    (out / dst).write_text(h)
    print(dst, len(h), 'koalabeast refs left:', len(re.findall(r'koalabeast\.com(?!/)', h)) )

def game(h):
    h = re.sub(r'tagproConfig.gameSocket = "[^"]*"', 'tagproConfig.gameSocket = location.origin + "{{GAME_SOCKET}}"', h)
    h = re.sub(r'tagproConfig.gameServer = "[^"]*"', 'tagproConfig.gameServer = "{{GAME_SERVER}}"', h)
    h = re.sub(r'tagproConfig.gameId = "[^"]*"', 'tagproConfig.gameId = "{{GAME_ID}}"', h)
    h = re.sub(r'(<div id="gameSocket">\s*)[^<\s]+', r'\1{{GAME_SOCKET_LABEL}}', h)
    return h

def group(h):
    h = h.replace('data-static="static.koalabeast.com"', 'data-static=""')
    h = h.replace('value="hvptqfho"', 'value="{{GROUP_ID}}"')
    h = h.replace('value="Some Group" name="groupName"', 'value="{{GROUP_NAME}}" name="groupName"')
    return h

page('game-live-real.html', 'game.html', game)
page('group-real.html', 'group.html', group)
def groups(h):
    a = h.index('<div id="groups-list" class="row groups-list">'); a = h.index('>', a) + 1
    b = h.index('</div>\n                </div>\n            </div>\n        </div>\n    </div>\n</div>', a)
    item = h[a:b]
    first = item[:item.index('<div class="col-md-6">', item.index('<div class="col-md-6">') + 1)]
    (out / 'group-item.html').write_text(first)
    return h[:a] + '\n{{GROUPS_LIST}}\n                    ' + h[b:]
page('groups-real.html', 'groups.html', groups)
page('home-real.html', 'home.html')
page('settings-real.html', 'settings.html')

def replays_page(h):
    return h.replace('<input type="hidden" id="userId" value="">', '<input type="hidden" id="userId" value="{{USER_ID}}">')
page('replays-real.html', 'replays.html', replays_page)

# replay viewer: the real game page in replay mode
def replay_viewer(h):
    h = re.sub(r"tagproConfig.replayKey = '[^']*'", "tagproConfig.replayKey = '{{REPLAY_KEY}}'", h)
    return h
page('game-replay.html', 'replay.html', replay_viewer)

# generic card page (login, profile) built from the real settings page layout
def card(h):
    a = h.index('<div class="card">') + len('<div class="card">')
    b = h.index('</form>', a) + len('</form>')
    h = h[:a] + '\n{{CARD}}\n' + h[b:]
    h = h.replace('/R-965af4e7a4b8-z/compact/global-settings.js', '{{PAGE_SCRIPT}}')
    h = re.sub(r'<title>[\s\S]*?</title>', '<title>{{TITLE}}</title>', h, count=1)
    return h
page('settings-real.html', 'card.html', card)
page('find-live-real.html', 'find.html')
