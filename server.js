const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

const rooms = {};

// Helper: Generate 6-letter Room Code
function generateRoomCode() {
  return Math.random().toString(36).substring(2, 8).toUpperCase();
}

// GOD Engine: Resolve Night Actions according to strict rules
function resolveNightActions(room) {
  const deaths = new Set();
  const actions = room.nightActions;

  const mafiaTarget = actions.MAFIA;
  const doctorTarget = actions.DOCTOR;
  const swTarget = actions.SEX_WORKER;

  const mafiaPlayer = Object.values(room.players).find(p => p.role === 'MAFIA');
  const doctorPlayer = Object.values(room.players).find(p => p.role === 'DOCTOR');
  const swPlayer = Object.values(room.players).find(p => p.role === 'SEX_WORKER');

  if (mafiaTarget) {
    let killBlocked = false;

    // Doctor Protection Rule
    if (doctorTarget === mafiaTarget) {
      killBlocked = true; // Target protected by Doctor
    }

    // Sex Worker visiting Mafia Rule
    if (swPlayer && swTarget === mafiaPlayer?.id && mafiaTarget === swPlayer.id) {
      // If SW has sex with Mafia and Mafia targets SW -> Kill Fails
      killBlocked = true;
    }

    if (!killBlocked) {
      if (swPlayer && mafiaTarget === swPlayer.id) {
        // Mafia targets Sex Worker
        deaths.add(swPlayer.id);
        // If SW was having sex with Person X, Person X dies too
        if (swTarget && swTarget !== mafiaPlayer?.id) {
          deaths.add(swTarget);
        }
      } else {
        // Mafia targets Person X
        deaths.add(mafiaTarget);
        // If SW was having sex with Person X, SW dies too
        if (swPlayer && swTarget === mafiaTarget) {
          deaths.add(swPlayer.id);
        }
      }
    }
  }

  // Apply Deaths
  const eliminatedNames = [];
  deaths.forEach(id => {
    if (room.players[id]) {
      room.players[id].isAlive = false;
      eliminatedNames.push(room.players[id].name);
    }
  });

  return eliminatedNames;
}

// Police Investigation Logic (Probabilities)
function investigatePlayer(targetPlayer) {
  const role = targetPlayer.role;
  if (role === 'MAFIA' || role === 'SEX_WORKER') return 'MAYBE';
  if (role === 'DOCTOR') return 'NO';
  if (role === 'VILLAGER') return Math.random() < 0.25 ? 'MAYBE' : 'NO';
  return 'NO';
}

// Check Win Conditions
function checkWinCondition(room) {
  const alivePlayers = Object.values(room.players).filter(p => p.isAlive);
  const aliveMafia = alivePlayers.filter(p => p.role === 'MAFIA');
  const aliveNonMafia = alivePlayers.filter(p => p.role !== 'MAFIA');

  if (aliveMafia.length === 0) {
    return 'VILLAGERS';
  }
  if (aliveMafia.length >= aliveNonMafia.length) {
    return 'MAFIA';
  }
  return null;
}

io.on('connection', (socket) => {
  // Create Room
  socket.on('createRoom', ({ name }) => {
    const roomCode = generateRoomCode();
    rooms[roomCode] = {
      code: roomCode,
      host: socket.id,
      state: 'LOBBY', // LOBBY, NIGHT, DAY
      timer: null,
      timeLeft: 0,
      players: {},
      nightActions: {},
      votes: {},
      policeRevealedId: null
    };

    rooms[roomCode].players[socket.id] = {
      id: socket.id,
      name,
      role: 'VILLAGER',
      isAlive: true
    };

    socket.join(roomCode);
    socket.emit('roomCreated', { roomCode, playerId: socket.id });
    io.to(roomCode).emit('playerListUpdate', Object.values(rooms[roomCode].players));
  });

  // Join Room
  socket.on('joinRoom', ({ name, roomCode }) => {
    const room = rooms[roomCode?.toUpperCase()];
    if (!room) {
      return socket.emit('errorMsg', 'Room not found.');
    }
    if (room.state !== 'LOBBY') {
      return socket.emit('errorMsg', 'Game already in progress.');
    }

    room.players[socket.id] = {
      id: socket.id,
      name,
      role: 'VILLAGER',
      isAlive: true
    };

    socket.join(room.code);
    socket.emit('roomJoined', { roomCode: room.code, playerId: socket.id });
    io.to(room.code).emit('playerListUpdate', Object.values(room.players));
  });

  // Start Game (GOD Allocates Roles)
  socket.on('startGame', (roomCode) => {
    const room = rooms[roomCode];
    if (!room || room.host !== socket.id) return;

    const playerIds = Object.keys(room.players);
    if (playerIds.length < 4) {
      return socket.emit('errorMsg', 'At least 4 players are required to start.');
    }

    // Role assignment pool
    const rolesPool = ['MAFIA', 'DOCTOR', 'SEX_WORKER', 'POLICE'];
    while (rolesPool.length < playerIds.length) {
      rolesPool.push('VILLAGER');
    }

    // Shuffle roles
    rolesPool.sort(() => Math.random() - 0.5);

    playerIds.forEach((id, idx) => {
      room.players[id].role = rolesPool[idx];
      room.players[id].isAlive = true;

      if (rolesPool[idx] === 'POLICE') {
        room.policeRevealedId = id;
      }
    });

    // Send private role to each individual + broadcast police identity to everyone
    playerIds.forEach((id) => {
      io.to(id).emit('gameStarted', {
        myRole: room.players[id].role,
        policePlayer: room.players[room.policeRevealedId],
        players: Object.values(room.players)
      });
    });

    startNightPhase(room);
  });

  // Start Night Phase
  function startNightPhase(room) {
    room.state = 'NIGHT';
    room.nightActions = {};

    io.to(room.code).emit('phaseChange', {
      phase: 'NIGHT',
      players: Object.values(room.players)
    });
  }

  // Handle Night Action
  socket.on('submitNightAction', ({ roomCode, targetId }) => {
    const room = rooms[roomCode];
    if (!room || room.state !== 'NIGHT') return;

    const player = room.players[socket.id];
    if (!player || !player.isAlive) return;

    room.nightActions[player.role] = targetId;

    // Special Case: Police Action gives immediate direct response to police player
    if (player.role === 'POLICE' && targetId) {
      const targetPlayer = room.players[targetId];
      const result = investigatePlayer(targetPlayer);
      socket.emit('policeResult', { targetName: targetPlayer.name, result });
    }

    // Check if all living night roles have submitted
    const activeRoles = Object.values(room.players)
      .filter(p => p.isAlive && ['MAFIA', 'DOCTOR', 'SEX_WORKER', 'POLICE'].includes(p.role))
      .map(p => p.role);

    const allDone = activeRoles.every(role => room.nightActions[role] !== undefined);

    if (allDone) {
      const eliminated = resolveNightActions(room);
      const winner = checkWinCondition(room);

      if (winner) {
        io.to(room.code).emit('gameOver', { winner, players: Object.values(room.players) });
        room.state = 'LOBBY';
      } else {
        startDayPhase(room, eliminated);
      }
    }
  });

  // Start Day Phase
  function startDayPhase(room, eliminatedNames) {
    room.state = 'DAY';
    room.votes = {};
    room.timeLeft = 90;

    io.to(room.code).emit('phaseChange', {
      phase: 'DAY',
      eliminatedNames,
      players: Object.values(room.players),
      timeLeft: room.timeLeft
    });

    clearInterval(room.timer);
    room.timer = setInterval(() => {
      room.timeLeft -= 1;
      io.to(room.code).emit('timerUpdate', room.timeLeft);

      if (room.timeLeft <= 0) {
        clearInterval(room.timer);
        tallyVotes(room);
      }
    }, 1000);
  }

  // Handle Vote
  socket.on('submitVote', ({ roomCode, targetId }) => {
    const room = rooms[roomCode];
    if (!room || room.state !== 'DAY') return;

    const player = room.players[socket.id];
    if (!player || !player.isAlive) return;

    room.votes[socket.id] = targetId;
    io.to(room.code).emit('voteUpdated', { voterId: socket.id, targetId });

    // Check if all living players voted
    const livingCount = Object.values(room.players).filter(p => p.isAlive).length;
    if (Object.keys(room.votes).length >= livingCount) {
      clearInterval(room.timer);
      tallyVotes(room);
    }
  });

  // Tally Votes at Day End
  function tallyVotes(room) {
    const voteCounts = {};
    Object.values(room.votes).forEach((targetId) => {
      if (targetId) {
        voteCounts[targetId] = (voteCounts[targetId] || 0) + 1;
      }
    });

    let highestVotes = 0;
    let lynchedId = null;

    Object.entries(voteCounts).forEach(([targetId, count]) => {
      if (count > highestVotes) {
        highestVotes = count;
        lynchedId = targetId;
      } else if (count === highestVotes) {
        lynchedId = null; // Tie results in no lynch
      }
    });

    let lynchedPlayerName = null;
    if (lynchedId && room.players[lynchedId]) {
      room.players[lynchedId].isAlive = false;
      lynchedPlayerName = room.players[lynchedId].name;
    }

    const winner = checkWinCondition(room);

    if (winner) {
      io.to(room.code).emit('gameOver', { winner, players: Object.values(room.players) });
      room.state = 'LOBBY';
    } else {
      io.to(room.code).emit('dayResult', { lynchedPlayerName });
      setTimeout(() => {
        startNightPhase(room);
      }, 4000);
    }
  }

  // Chat Broadcast
  socket.on('sendChatMessage', ({ roomCode, message }) => {
    const room = rooms[roomCode];
    if (!room) return;
    const player = room.players[socket.id];
    if (!player || !player.isAlive) return;

    io.to(room.code).emit('chatMessage', {
      sender: player.name,
      message,
      role: player.role === 'POLICE' ? 'POLICE' : null // Only show Police status if applicable
    });
  });

  // Disconnect Handling
  socket.on('disconnect', () => {
    Object.values(rooms).forEach(room => {
      if (room.players[socket.id]) {
        delete room.players[socket.id];
        io.to(room.code).emit('playerListUpdate', Object.values(room.players));
      }
    });
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`GOD System active. Game running at http://localhost:${PORT}`);
});