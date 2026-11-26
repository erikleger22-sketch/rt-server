const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
app.get('/', (req, res) => res.send('Real Tournament : serveur en ligne'));

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

const PING_INTERVAL_MS = 60000;
const GAME_DURATION_MS = 15 * 60 * 1000;
const CAPTURE_DISTANCE_METERS = 25; // Rayon de capture en mètres

const rooms = Object.create(null);

// Calcul de distance GPS en mètres (formule Haversine)
function getDistanceMeters(lat1, lon1, lat2, lon2) {
  const R = 6371e3;
  const rad = Math.PI / 180;
  const dLat = (lat2 - lat1) * rad;
  const dLon = (lon2 - lon1) * rad;
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(lat1 * rad) * Math.cos(lat2 * rad) *
    Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

function getRoom(code) {
  if (!rooms[code]) {
    rooms[code] = {
      players: {},
      radarTimer: null,
      gameTimer: null,
      gameStatus: 'waiting', // waiting, running, finished
      gameEndTime: null,
      winner: null,
    };

    rooms[code].radarTimer = setInterval(() => {
      sendRadarPing(code);
    }, PING_INTERVAL_MS);
  }
  return rooms[code];
}

function publicPlayers(room) {
  return Object.entries(room.players).map(([id, p]) => ({
    id,
    name: p.name,
    role: p.role,
    captured: p.captured || false,
  }));
}

function gameState(room) {
  return {
    status: room.gameStatus,
    endTime: room.gameEndTime,
    serverTime: Date.now(),
    winner: room.winner,
  };
}

function checkWinCondition(code) {
  const room = rooms[code];
  if (!room || room.gameStatus !== 'running') return;

  const runners = Object.values(room.players).filter(p => p.role === 'RUNNER');
  const aliveRunners = runners.filter(p => !p.captured);

  // S'il y a des fugitifs dans la partie et qu'ils sont TOUS capturés :
  if (runners.length > 0 && aliveRunners.length === 0) {
    if (room.gameTimer) clearTimeout(room.gameTimer);
    room.gameStatus = 'finished';
    room.winner = 'HUNTERS';
    io.to(code).emit('game_state', gameState(room));
    io.to(code).emit('announcement', '🏆 VICTOIRE DES CHASSEURS ! Tous les fugitifs ont été capturés.');
    console.log(`[${code}] Victoire des Chasseurs !`);
  }
}

function sendRadarPing(code) {
  const room = rooms[code];
  if (!room) return;

  const runners = Object.entries(room.players)
    .filter(([, p]) => p.role === 'RUNNER' && !p.captured && p.lat !== null)
    .map(([id, p]) => ({
      id,
      name: p.name,
      lat: p.lat,
      lng: p.lng,
    }));

  console.log(`[${code}] Ping radar : ${runners.length} fugitif(s) actif(s)`);
  io.to(code + ':HUNTER').emit('radar_ping', runners);
}

io.on('connection', (socket) => {
  socket.on('join_room', ({ code, name, role }) => {
    if (!code || !name) return;
    const room = getRoom(code);

    socket.data.code = code;
    socket.join(code);
    socket.join(code + ':' + role);

    room.players[socket.id] = {
      name,
      role,
      lat: null,
      lng: null,
      captured: false,
    };

    io.to(code).emit('players', publicPlayers(room));
    socket.emit('game_state', gameState(room));
  });

  socket.on('start_game', () => {
    const code = socket.data.code;
    if (!code || !rooms[code]) return;
    const room = rooms[code];

    // Réinitialiser les captures
    Object.values(room.players).forEach(p => p.captured = false);
    if (room.gameTimer) clearTimeout(room.gameTimer);

    room.gameStatus = 'running';
    room.winner = null;
    room.gameEndTime = Date.now() + GAME_DURATION_MS;

    io.to(code).emit('players', publicPlayers(room));
    io.to(code).emit('game_state', gameState(room));
    io.to(code).emit('announcement', '⚡ LA TRAQUE COMMENCE ! Durée : 15 minutes.');

    room.gameTimer = setTimeout(() => {
      if (rooms[code] !== room) return;
      room.gameStatus = 'finished';
      room.winner = 'RUNNERS'; // Les fugitifs ont survécu au chrono
      io.to(code).emit('game_state', gameState(room));
      io.to(code).emit('announcement', '🏆 TEMPS ÉCOULÉ ! VICTOIRE DES FUGITIFS !');
    }, GAME_DURATION_MS);
  });

  socket.on('location', ({ lat, lng }) => {
    const code = socket.data.code;
    if (!code || !rooms[code]) return;
    const player = rooms[code].players[socket.id];
    if (!player) return;

    player.lat = lat;
    player.lng = lng;

    if (player.role === 'HUNTER') {
      io.to(code + ':HUNTER').emit('hunter_moved', {
        id: socket.id,
        name: player.name,
        lat,
        lng,
      });
    }
  });

  // TENTATIVE D'ARRESTATION PAR UN CHASSEUR
  socket.on('attempt_capture', () => {
    const code = socket.data.code;
    if (!code || !rooms[code]) return;
    const room = rooms[code];
    const hunter = room.players[socket.id];

    if (!hunter || hunter.role !== 'HUNTER' || hunter.lat === null) {
      socket.emit('capture_result', { success: false, message: 'Position GPS invalide.' });
      return;
    }

    if (room.gameStatus !== 'running') {
      socket.emit('capture_result', { success: false, message: 'La partie n\'est pas en cours.' });
      return;
    }

    // Chercher le fugitif le plus proche non encore capturé
    let capturedRunner = null;
    let closestDist = Infinity;

    for (const [id, runner] of Object.entries(room.players)) {
      if (runner.role === 'RUNNER' && !runner.captured && runner.lat !== null) {
        const dist = getDistanceMeters(hunter.lat, hunter.lng, runner.lat, runner.lng);
        if (dist <= CAPTURE_DISTANCE_METERS && dist < closestDist) {
          closestDist = dist;
          capturedRunner = { id, runner };
        }
      }
    }

    if 