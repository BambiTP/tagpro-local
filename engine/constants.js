// constants.js - shared values. MAP_OBJECT_BITS and the collision filters are copied from the
// shared module bundled in the official client (global-game.js, "sharedConstants").
(function () {
const MAP_OBJECT_BITS = { STRUCTURE: -1, FLAG: 2, MARSBALL: 4, BUFF: 8, OTHER: 16, RED_PLAYER: 32, BLUE_PLAYER: 64, ALL_PLAYERS: 96, DEFAULT_OBJECTS: 126 };

function getPlayerCollisions(ghostMode, isRed) {
  const t = MAP_OBJECT_BITS;
  const n = isRed ? t.RED_PLAYER : t.BLUE_PLAYER;
  let r;
  switch (ghostMode) {
    case 'noPlayerCollisions': r = t.ALL_PLAYERS; break;
    case 'noTeamCollisions': r = n; break;
    case 'noEnemyCollisions': r = isRed ? t.BLUE_PLAYER : t.RED_PLAYER; break;
    case 'noMarsBallCollisions': r = t.MARSBALL; break;
    case 'noPlayerOrMarsCollisions': r = t.MARSBALL | t.ALL_PLAYERS; break;
    default: r = 0;
  }
  return { categoryBits: n, maskBits: t.DEFAULT_OBJECTS & ~r };
}

function getMarsballCollisions(ghostMode) {
  const t = MAP_OBJECT_BITS;
  const i = (ghostMode === 'noMarsBallCollisions' || ghostMode === 'noPlayerOrMarsCollisions') ? t.ALL_PLAYERS : 0;
  return { categoryBits: t.MARSBALL, maskBits: t.DEFAULT_OBJECTS & ~i };
}

const STATES = { ACTIVE: 1, ENDED: 2, COUNTDOWN: 3, INACTIVE: 4, OVERTIME: 5, EXITED: 6, CLUTCH: 7 };

// Physics, straight from the client's prediction code (tagpro.world)
const PHYSICS = {
  SCALE: 100,            // px per metre
  TILE: 0.4,             // metres per tile
  STEP: 1 / 60,
  VELOCITY_ITERATIONS: 8,
  POSITION_ITERATIONS: 3,
  BALL_RADIUS: 0.19,
  BALL_DENSITY: 1,
  BALL_FRICTION: 0.5,
  BALL_RESTITUTION: 0.2,
  LINEAR_DAMPING: 0.5,
  ANGULAR_DAMPING: 0.5,
  WALL_FRICTION: 0.5,
  WALL_RESTITUTION: 0.2,
  MAX_SPEED: 2.5,        // "ms"
  ACCEL: 0.025,          // "ac" per tick
  GRAVITY_WELL_RANGE: 2.6,
  GRAVITY_WELL_FORCE: 0.06,
  MARSBALL_RADIUS: 0.39,
};

// Gameplay tuning. Timings are measured from real replays (ref/replays); forces are
// starting estimates to be calibrated against replays (tools/ calibration scripts).
const TUNING = {
  JUKE_JUICE_ACCEL: 0.031,      // ac seen in replays with grip
  TEAM_TILE_ACCEL: 0.031,
  TOP_SPEED_MAX: 3.5,           // topspeed powerup (not in public rotation)
  BOOST_SPEED: 7.5,             // m/s after a boost
  // explosions: radial dv = STRENGTH * (RADIUS - d), fitted to real replays (tools/calib/*.py)
  BOMB_RADIUS: 2.8, BOMB_STRENGTH: 4.0,              // 7 tiles, n=1678
  ROLLING_BOMB_RADIUS: 1.67, ROLLING_BOMB_STRENGTH: 3.84,
  POP_RADIUS: 1.4, POP_STRENGTH: 1.5,                // "poosts": 3.5 tiles, n=1720 (+ tagger collision, see game.js)
  PORTAL_RADIUS: 1.6, PORTAL_STRENGTH: 1.37,         // 4 tiles, centred on the destination (bomb type 3 packet)
  TOUCH_RADIUS: { flag: 0.15, boost: 0.15, powerup: 0.15, bomb: 0.15, spike: 0.14, button: 0.15, portal: 0.15 },
  WARNING_FRAMES: 12, WARNING_FRAME_MS: 250,        // ".101".. ".112" respawn warnings
  AFK_WARN_MS: 25000, AFK_KICK_MS: 30000,
  MAPTEST_AFK_KICK_MS: 5 * 60000,                    // map testing mode: 5 minutes
  GRAB_INVINCIBLE_MS: 250,                           // flag carrier can't be popped right after grabbing
  SNAPSHOT_TICKS: 15,                                // full position delta every 250ms
  CLOCKSYNC_MS: 15000,
  COUNTDOWN_MS: 20000,
  END_LINGER_MS: 60000,
};

const api = { MAP_OBJECT_BITS, getPlayerCollisions, getMarsballCollisions, STATES, PHYSICS, TUNING };
if (typeof module !== 'undefined' && module.exports) module.exports = api;
else globalThis.TPConstants = api;
})();
