const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
app.get('/', (req, res) => res.send('Real Tournament : serveur en ligne'));

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

const PING_INTERVAL_MS = 60000;
const GAME_DURATION_MS = 15 * 60 * 1000;
const CAPTURE_DISTANCE_METERS = 25; // Portée de capture

const rooms = Object.create(null);

function getDistanceMeters(lat1, lon1, lat2, lon2) {
  const R = 6371e3;
  const rad = Math.PI / 180;
  const dLat = (lat2 - lat1) * rad;
  const dLon = (lon2 - lon1) * rad;
  const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
            Math.cos(lat1 * rad) * Math.cos(lat2 * rad) *
            Math.sin(dLon / 2) * Math.sin(dLon / 2);
  return R * (2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)));
}

function getRoom(code) {
  if (!rooms[code]) {
    rooms[code] = {
      players: {},
      radarTimer: null,
      gameTimer: null,
      shrinkTimer1: null,
      shrinkTimer2: null,
      gameStatus: 'waiting',
      gameEndTime: null,
      gameStartTime: null,
      winner: null,
      zoneCenter: null,
      zoneRadius: 300, // La zone commence à 300m
    };

    rooms[code].radarTimer = setInterval(() => {
      sendRadarPing(code);
    }, PING_INTERVAL_MS);
  }
  return rooms[code];
}

function publicPlayers(room) {
  return Object.entries(room.players).map(([id, p]) => ({
    id, name: p.name, role: p.role, captured: p.captured || false, capturedAt: p.capturedAt || null
  }));
}

function calculateNextShrink(room) {
  if (room.gameStatus !== 'running' || !room.gameStartTime) return null;
  const elapsed = Date.now() - room.gameStartTime;
  if (elapsed < 5 * 60 * 1000) return room.gameStartTime + 5 * 60 * 1000;
  if (elapsed < 10 * 60 * 1000) return room.gameStartTime + 10 * 60 * 1000;
  return null;
}

function gameState(room) {
  return {
    status: room.gameStatus,
    endTime: room.gameEndTime,
    serverTime: Date.now(),
    winner: room.winner,
    zoneCenter: room.zoneCenter,
    zoneRadius: room.zoneRadius,
    nextShrinkTime: calculateNextShrink(room),
  };
}

function checkWinCondition(code) {
  const room = rooms[code];
  if (!room || room.gameStatus !== 'running') return;

  const runners = Object.values(room.players).filter(p => p.role === 'RUNNER');
  const aliveRunners = runners.filter(p => !p.captured);

  if (runners.length > 0 && aliveRunners.length === 0) {
    if (room.gameTimer) clearTimeout(room.gameTimer);
    if (room.shrinkTimer1) clearTimeout(room.shrinkTimer1);
    if (room.shrinkTimer2) clearTimeout(room.shrinkTimer2);
    room.gameStatus = 'finished';
    room.winner = 'HUNTERS';
    io.to(code).emit('game_state', gameState(room));
    io.to(code).emit('announcement', '🏆 VICTOIRE DES CHASSEURS ! Tous les fugitifs ont été capturés.');
  }
}

function sendRadarPing(code) {
  const room = rooms[code];
  if (!room) return;
  const runners = Object.entries(room.players)
    .filter(([, p]) => p.role === 'RUNNER' && !p.captured && p.lat !== null)
    .map(([id, p]) => ({ id, name: p.name, lat: p.lat, lng: p.lng }));

  io.to(code + ':HUNTER').emit('radar_ping', runners);
}

io.on('connection', (socket) => {
  socket.on('join_room', ({ code, name, role }) => {
    if (!code || !name) return;
    const room = getRoom(code);

    socket.data.code = code;
    socket.join(code);
    socket.join(code + ':' + role);

    room.players[socket.id] = { name, role, lat: null, lng: null, captured: false, capturedAt: null };

    io.to(code).emit('players', publicPlayers(room));
    socket.emit('game_state', gameState(room));
  });

  socket.on('start_game', () => {
    const code = socket.data.code;
    if (!code || !rooms[code]) return;
    const room = rooms[code];

    Object.values(room.players).forEach(p => { p.captured = false; p.capturedAt = null; });
    if (room.gameTimer) clearTimeout(room.gameTimer);
    if (room.shrinkTimer1) clearTimeout(room.shrinkTimer1);
    if (room.shrinkTimer2) clearTimeout(room.shrinkTimer2);

    room.gameStatus = 'running';
    room.winner = null;
    room.gameStartTime = Date.now();
    room.gameEndTime = room.gameStartTime + GAME_DURATION_MS;
    room.zoneRadius = 300;

    const launcher = room.players[socket.id];
    if (launcher && launcher.lat !== null) room.zoneCenter = { lat: launcher.lat, lng: launcher.lng };

    io.to(code).emit('players', publicPlayers(room));
    io.to(code).emit('game_state', gameState(room));
    io.to(code).emit('announcement', '⚡ LA TRAQUE COMMENCE !');

    // Réduction de la zone
    room.shrinkTimer1 = setTimeout(() => {
      room.zoneRadius = 150;
      io.to(code).emit('game_state', gameState(room));
      io.to(code).emit('announcement', '⚠️ LA ZONE SE RÉDUIT À 150M !');
    }, 5 * 60 * 1000);

    room.shrinkTimer2 = setTimeout(() => {
      room.zoneRadius = 75;
      io.to(code).emit('game_state', gameState(room));
      io.to(code).emit('announcement', '🚨 ZONE FINALE : 75M !');
    }, 10 * 60 * 1000);

    room.gameTimer = setTimeout(() => {
      if (rooms[code] !== room) return;
      room.gameStatus = 'finished';
      room.winner = 'RUNNERS';
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
      io.to(code + ':HUNTER').emit('hunter_moved', { id: socket.id, name: player.name, lat, lng });
    }
  });

  socket.on('attempt_capture', () => {
    const code = socket.data.code;
    if (!code || !rooms[code]) return;
    const room = rooms[code];
    const hunter = room.players[socket.id];

    if (!hunter || hunter.role !== 'HUNTER' || hunter.lat === null || room.gameStatus !== 'running') {
      socket.emit('capture_result', { success: false, message: 'Action impossible pour le moment.' });
      return;
    }

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

    if (capturedRunner) {
      capturedRunner.runner.captured = true;
      capturedRunner.runner.capturedAt = Date.now();
      io.to(code).emit('players', publicPlayers(room));
      io.to(code).emit('announcement', `🚨 ${hunter.name} a CAPTURÉ ${capturedRunner.runner.name} !`);
      socket.emit('capture_result', { success: true, message: `Cible ${capturedRunner.runner.name} capturée !` });
      checkWinCondition(code);
    } else {
      socket.emit('capture_result', { success: false, message: 'Échec : aucun fugitif à portée (25m).' });
    }
  });

  socket.on('disconnect', () => {
    const code = socket.data.code;
    if (!code || !rooms[code]) return;
    const room = rooms[code];
    delete room.players[socket.id];
    io.to(code).emit('players', publicPlayers(room));

    if (Object.keys(room.players).length === 0) {
      clearInterval(room.radarTimer);
      if (room.gameTimer) clearTimeout(room.gameTimer);
      if (room.shrinkTimer1) clearTimeout(room.shrinkTimer1);
      if (room.shrinkTimer2) clearTimeout(room.shrinkTimer2);
      delete rooms[code];
    } else {
      checkWinCondition(code);
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Serveur Real Tournament en écoute sur le port ${PORT}`));