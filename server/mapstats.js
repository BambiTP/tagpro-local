// mapstats.js - data for the real Maps page (/maps.json + the /maps/ socket): the installed
// rotation with this server's play counts (from replays) and players' in-game map ratings.
const fs = require('fs');
const path = require('path');
const sessions = require('./sessions');

const MAPS = path.join(__dirname, '..', 'maps');
const RATINGS = path.join(__dirname, '..', 'data', 'mapratings.json');
let ratings = {}; // mapName -> { voterId: -1 | 0 | 1 }
try { ratings = JSON.parse(fs.readFileSync(RATINGS, 'utf8')); } catch (e) { ratings = {}; }
const save = () => { fs.writeFileSync(RATINGS + '.tmp', JSON.stringify(ratings)); fs.renameSync(RATINGS + '.tmp', RATINGS); };

let replaysIndex = () => [];
let MAP_TYPES = {};
try { MAP_TYPES = require('../ref-data/map-types.json'); } catch (e) { MAP_TYPES = {}; }

function rotationMaps() {
  let keys = [];
  try { keys = JSON.parse(fs.readFileSync(path.join(MAPS, 'rotation.json'), 'utf8')); } catch (e) { keys = []; }
  return keys.map((k) => {
    try { const j = JSON.parse(fs.readFileSync(path.join(MAPS, k + '.json'), 'utf8')); return { key: String(k), info: j.info || {} }; } catch (e) { return null; }
  }).filter(Boolean);
}

function entry(m, plays) {
  const r = Object.values(ratings[m.info.name] || {});
  const likes = r.filter((v) => v > 0).length, dislikes = r.filter((v) => v < 0).length, meh = r.filter((v) => v === 0).length;
  const total = r.length;
  return {
    _id: m.key.padStart(24, '0'), key: m.info.name, name: m.info.name, author: m.info.author || 'Unknown',
    category: 'rotation', displayStats: true, totalPlays: plays[m.info.name] || 0,
    totalLikes: likes, totalDislikes: dislikes, totalIndifferents: meh,
    averageRating: total ? (likes - dislikes) / total : 0, totalUsers: total, isDeleted: false, weight: 1,
    averageLikes: total ? Math.round(likes / total * 100) : 0, averageDislikes: total ? Math.round(dislikes / total * 100) : 0,
    averageIndifferents: total ? Math.round(meh / total * 100) : 0, score: total ? Math.round(likes / total * 100) : 0,
    type: MAP_TYPES[m.info.name] || 'ctf', inCasualRotation: true, seasonalStats: [], communityFavoured: false, communityDisfavoured: false,
  };
}

function allMapData() {
  const plays = {};
  for (const g of replaysIndex()) plays[g.mapName] = (plays[g.mapName] || 0) + 1;
  const rotation = {};
  for (const m of rotationMaps()) { const e = entry(m, plays); rotation[e._id] = e; }
  return { rotation, trial: {}, classic: {}, retired: {}, group: {}, racing: {}, minigames: {} };
}

const voterId = (session) => (session.account ? 'a:' + session.account.id : 's:' + session.id);

function rate(session, mapName, value) {
  const v = Math.max(-1, Math.min(1, Math.round(Number(value))));
  if (!mapName || !Number.isFinite(v)) return;
  (ratings[mapName] || (ratings[mapName] = {}))[voterId(session)] = v;
  save();
}

function attach(io, getIndex) {
  replaysIndex = getIndex;
  io.of('/maps/').on('connection', (socket) => {
    const session = sessions.fromSocket(socket);
    socket.emit('allMapData', allMapData()); // pushed to everyone; the page only asks again when logged in
    socket.emit(session && session.account ? 'userLoggedIn' : 'userNotLoggedIn');
    socket.on('getMapData', () => socket.emit('allMapData', allMapData()));
    socket.on('getVotingData', () => {
      const me = session && voterId(session), out = [];
      for (const e of Object.values(allMapData().rotation)) {
        const v = ratings[e.name] && ratings[e.name][me];
        if (v !== undefined) out.push({ mapId: e._id, category: 'rotation', rating: v, favoured: false, disfavoured: false });
      }
      socket.emit('votingData', out);
    });
    socket.on('mapRating', (d) => {
      if (!session || !session.account || !d) return;
      const e = Object.values(allMapData().rotation).find((x) => x._id === d.mapId || x.name === d.name);
      if (e) { rate(session, e.name, d.rating); socket.emit('ratedMap', { mapId: e._id, rating: d.rating }); }
    });
    socket.on('touch', () => {});
  });
}

module.exports = { allMapData, rate, attach };
