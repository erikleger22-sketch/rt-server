const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();

app.get('/', (req, res) => {
  res.send('Real Tournament : serveur en ligne');
});

const server = http.createServer(app);

const io = new Server(server, {
  cors: { origin: '*' },
});

const PING_INTERVAL_MS = 60000;
const GAME_DURATION_MS = 15 * 60 * 1000;

const rooms = Object.create(null);

function getRoom(code) {
  if (!rooms[code]) {
    rooms[code] = {
      players: {},
      radarTimer: null,
      gameTimer: null,
      gameStatus: 'waiting',
      gameEndTime: null,
    };

    rooms[code].radarTimer = setInterval(() => {
      sendRadarPing(code);
    }, PING_INTERVAL_MS);
  }

  return rooms[code];
}

function publicPlayers(room) {
  return Object.entries(room.players).map(([id, player]) => ({
    id,
    name: player.name,
    role: player.role,
  }));
}

function gameState(room) {
  return {
    status: room.gameStatus,
    endTime: room.gameEndTime,
    serverTime: Date.now(),
  };
}

function sendRadarPing(code) {
  const room = rooms[code];
  if (!room) return;

  const runners = Object.entries(room.players)
    .filter(([, player]) => {
      return player.role === 'RUNNER' && player.lat !== null;
    })
    .map(([id, player]) => ({
      id,
      name: player.name,
      lat: player.lat,
      lng: player.lng,
    }));

  console.log(`[${code}] Ping radar : ${runners.length} fugitif(s)`);
  io.to(code + ':HUNTER').emit('radar_ping', runners);
}

io.on('connection', (socket) => {
  console.log(`Connexion : ${socket.id}`);

  socket.on('join_room', (data) => {
    if (
      !data ||
      typeof data.code !== 'string' ||
      typeof data.name !== 'string' ||
      !['HUNTER', 'RUNNER'].includes(data.role)
    ) {
      return;
    }

    const { code, name, role } = data;

    if (!code.trim() || !name.trim() || socket.data.code) return;

    const room = getRoom(code);

    socket.data.code = code;
    socket.join(code);
    socket.join(code + ':' + role);

    room.players[socket.id] = {
      name,
      role,
      lat: null,
      lng: null,
    };

    io.to(code).emit('players', publicPlayers(room));

    // Un joueur qui rejoint reçoit l'état actuel de la partie.
    socket.emit('game_state', gameState(room));

    console.log(`${name} (${role}) a rejoint ${code}`);
  });

  socket.on('start_game', () => {
    const code = socket.data.code;
    if (!code || !rooms[code]) return;

    const room = rooms[code];
    if (!room.players[socket.id]) return;

    // Ne remet pas le chrono à zéro si une partie est déjà lancée.
    if (room.gameStatus === 'running') {
      socket.emit('game_state', gameState(room));
      return;
    }

    if (room.gameTimer) {
      clearTimeout(room.gameTimer);
    }

    room.gameStatus = 'running';
    room.gameEndTime = Date.now() + GAME_DURATION_MS;

    io.to(code).emit('game_state', gameState(room));

    room.gameTimer = setTimeout(() => {
      if (rooms[code] !== room) return;

      room.gameStatus = 'finished';
      room.gameTimer = null;

      io.to(code).emit('game_state', gameState(room));
      console.log(`[${code}] Temps écoulé`);
    }, GAME_DURATION_MS);

    console.log(`[${code}] Partie lancée pour 15 minutes`);
  });

  socket.on('location', (data) => {
    if (
      !data ||
      !Number.isFinite(data.lat) ||
      !Number.isFinite(data.lng) ||
      data.lat < -90 ||
      data.lat > 90 ||
      data.lng < -180 ||
      data.lng > 180
    ) {
      return;
    }

    const code = socket.data.code;
    if (!code || !rooms[code]) return;

    const player = rooms[code].players[socket.id];
    if (!player) return;

    player.lat = data.lat;
    player.lng = data.lng;

    if (player.role === 'HUNTER') {
      io.to(code + ':HUNTER').emit('hunter_moved', {
        id: socket.id,
        name: player.name,
        lat: data.lat,
        lng: data.lng,
      });
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

      if (room.gameTimer) {
        clearTimeout(room.gameTimer);
      }

      delete rooms[code];
      console.log(`Salon ${code} fermé (vide)`);
    }
  });
});

const PORT = process.env.PORT || 3000;

server.listen(PORT, () => {
  console.log(`Serveur Real Tournament en écoute sur le port ${PORT}`);
});