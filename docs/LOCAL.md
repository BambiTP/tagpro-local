# Single player (local only)

`npm run local` starts a version of the game with no multiplayer at all: no groups, accounts,
Play Now queue, peer to peer, feedback or player search. The server listens only on
`127.0.0.1`, so nobody else on your network or the internet can reach it.

```
npm install
npm run local          # then open http://localhost:3000  (PORT=xxxx to change the port)
```

On the page you pick:

- **Map**: any map in `maps/`, or random from `maps/rotation.json`. You can also add your own
  map (layout `.png` + logic `.json`).
- **Mode**: Capture the Flag, Gravity or Eggball.
- **Team** and **bots**: up to 3 bot teammates and 4 bot opponents. The bots run inside the
  server process (no network). With no bots you have the map to yourself.
- **Length**, **cap limit** and **map testing mode**.

Every game is saved as a replay (Replays button). Textures and Settings work like on the main
site and are kept in your browser. When you close the game tab, the game and its bots stop
after 10 seconds.

The code is `server/local.js`; it shares the game engine, maps, replays and game page with
the multiplayer server (`server/index.js`), which is unchanged.
