const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
app.get('/', (req, res) => res.send('Real Tournament : serveur en ligne'));

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

// Délai entre deux pings radar (en millisecondes). 60000 = 1 minute.
const PING_INTERVAL_MS = 60000;

// Les salons en mémoire : { "ZONE-A": { players: {...}, timer: ... } }
const rooms = {};

function getRoom(code) {
  if (!rooms[code]) {
    rooms[code] = { players: {}, timer: null };
    rooms[code].timer = setInterval(() => sendRadarPing(code), PING_INTERVAL_MS);
  }
  return rooms[code];
}

function publicPlayers(room) {
  return Object.entries(room.players).map(([id, p]) => ({
    id,
    name: p.name,
    role: p.role,
  }));
}

// Envoie la position des fugitifs uniquement aux chasseurs
function sendRadarPing(code) {
  const room = rooms[code];
  if (!room) return;

  const runners = Object.entries(room.players)
    .filter(([, p]) => p.role === 'RUNNER' && p.lat !== null)
    .map(([id, p]) => ({ id, name: p.name, lat: p.lat, lng: p.lng }));

  console.log(`[${code}] Ping radar : ${runners.length} fugitif(s)`);
  io.to(code + ':HUNTER').emit('radar_ping', runners);
}

io.on('connection', (socket) => {
  console.log(`Connexion : ${socket.id}`);

  // Un joueur rejoint un salon
  socket.on('join_room', ({ code, name, role }) => {
    const room = getRoom(code);
    socket.data.code = code;
    socket.join(code);
    socket.join(code + ':' + role);
    room.players[socket.id] = { name, role, lat: null, lng: null };

    io.to(code).emit('players', publicPlayers(room));
    console.log(`${name} (${role}) a rejoint ${code}`);
  });

  // Un joueur envoie sa position
  socket.on('location', ({ lat, lng }) => {
    const code = socket.data.code;
    if (!code || !rooms[code]) return;

    const player = rooms[code].players[socket.id];
    if (!player) return;

    player.lat = lat;
    player.lng = lng;

    // Les chasseurs se voient entre eux en direct
    if (player.role === 'HUNTER') {
      io.to(code + ':HUNTER').emit('hunter_moved', {
        id: socket.id,
        name: player.name,
        lat,
        lng,
      });
    }
  });

  // Un joueur quitte ou ferme l'application
  socket.on('disconnect', () => {
    const code = socket.data.code;
    if (!code || !rooms[code]) return;

    const room = rooms[code];
    delete room.players[socket.id];
    io.to(code).emit('players', publicPlayers(room));

    // Si le salon est vide, on le supprime pour libérer la mémoire
    if (Object.keys(room.players).length === 0) {
      clearInterval(room.timer);
      delete rooms[code];
      console.log(`Salon ${code} fermé (vide)`);
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Serveur Real Tournament en écoute sur le port ${PORT}`);
});