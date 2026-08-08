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

// GOD Engine: Refactored to handle MULTIPLE players of the same role
function resolveNightActions(room) {
  const deaths = new Set();
  
  // Extract living players by role
  const mafiaPlayers = Object.values(room.players).filter(p => p.role === 'MAFIA' && p.isAlive);
  const docPlayers = Object.values(room.players).filter(p => p.role === 'DOCTOR' && p.isAlive);
  const swPlayers = Object.values(room.players).filter(p => p.role === 'SEX_WORKER' && p.isAlive);

  // Map actions by player ID to target ID
  const mafiaActions = mafiaPlayers.map(p => ({ killerId: p.id, targetId: room.nightActions[p.id] })).filter(a => a.targetId);
  const protectedTargetIds = new Set(docPlayers.map(p => room.nightActions[p.id]).filter(Boolean));
  const swActions = swPlayers.map(p => ({ swId: p.id, targetId: room.nightActions[p.id] })).filter(a => a.targetId);

  // Identify if any Mafia is currently distracted by a SW
  const distractedMafiaIds = new Set();
  swActions.forEach(swAction => {
    if (mafiaPlayers.some(m => m.id === swAction.targetId)) {
      distractedMafiaIds.add(swAction.targetId); // That specific mafia's kill is blocked
    }
  });

  // Evaluate each Mafia kill independently
  mafiaActions.forEach(action => {
    // Loophole 1: The "Assassin's Embrace"
    if (distractedMafiaIds.has(action.killerId)) return; // Kill blocked by SW distraction
    
    // Direct Protection Rule
    if (protectedTargetIds.has(action.targetId)) return; // Kill blocked by Doctor

    let directKill = action.targetId;
    
    // Process Collateral Damage across all active Sex Workers
    swActions.forEach(sw => {
      const swPlayerId = sw.swId;
      const swTargetId = sw.targetId;

      // Loophole 4: "Bulletproof Crossfire" (Doc shields SW, SW visits X, Mafia hits X)
      if (protectedTargetIds.has(swPlayerId) && swTargetId === directKill && !protectedTargetIds.has(directKill)) {
        deaths.add(directKill);
        deaths.add(swPlayerId);
        // Find which doctor protected this SW and kill them too (Triangle A)
        docPlayers.forEach(doc => { if (room.nightActions[doc.id] === swPlayerId) deaths.add(doc.id); });
      }
      
      // Loopholes 2 & 3: "Shield-Piercing Collateral" (Doc shields X, SW visits X, Mafia hits SW)
      else if (protectedTargetIds.has(swTargetId) && directKill === swPlayerId) {
        deaths.add(swPlayerId);
        deaths.add(swTargetId);
        // Find which doctor protected X and kill them too (Triangle B)
        docPlayers.forEach(doc => { if (room.nightActions[doc.id] === swTargetId) deaths.add(doc.id); });
      }

      // Standard Collateral: Mafia targets SW
      else if (directKill === swPlayerId) {
        deaths.add(swPlayerId);
        if (swTargetId && !mafiaPlayers.some(m => m.id === swTargetId) && !protectedTargetIds.has(swTargetId)) {
          deaths.add(swTargetId);
        }
      }

      // Standard Collateral: Mafia targets Person X, SW is visiting them
      else if (directKill === swTargetId && !protectedTargetIds.has(swPlayerId)) {
        deaths.add(directKill);
        deaths.add(swPlayerId);
      }
    });

    // If no complex collateral applies, just kill the target
    deaths.add(directKill);
  });

  // Apply Deaths
  const eliminatedNames = [];
  deaths.forEach(id => {
    if (room.players[id] && room.players[id].isAlive) {
      room.players[id].isAlive = false;
      eliminatedNames.push(room.players[id].name);
    }
  });

  return eliminatedNames;
}

function investigatePlayer(targetPlayer) {
  if (!targetPlayer) return 'NO';
  const role = targetPlayer.role;
  if (role === 'MAFIA' || role === 'SEX_WORKER') return 'MAYBE';
  if (role === 'DOCTOR') return 'NO';
  if (role === 'VILLAGER') return Math.random() < 0.25 ? 'MAYBE' : 'NO';
  return 'NO';
}

function checkWinCondition(room) {
  const alivePlayers = Object.values(room.players).filter(p => p.isAlive);
  const aliveMafia = alivePlayers.filter(p => p.role === 'MAFIA');
  const aliveNonMafia = alivePlayers.filter(p => p.role !== 'MAFIA');

  if (aliveMafia.length === 0) return 'VILLAGERS';
  if (aliveMafia.length >= aliveNonMafia.length) return 'MAFIA';
  return null;
}

io.on('connection', (socket) => {
  
  // --- SERVER BROWSER ---
  socket.on('requestServerList', () => {
    const publicRooms = Object.values(rooms)
      .filter(r => r.isPublic && r.state === 'LOBBY')
      .map(r => ({
        code: r.code,
        hostName: r.players[r.host]?.name || 'Unknown',
        playerCount: Object.keys(r.players).length
      }));
    socket.emit('serverList', publicRooms);
  });

  // --- ROOM CREATION ---
  socket.on('createRoom', ({ name, isPublic }) => {
    const roomCode = generateRoomCode();
    rooms[roomCode] = {
      code: roomCode,
      isPublic: isPublic,
      host: socket.id,
      state: 'LOBBY', 
      timer: null,
      timeLeft: 0,
      players: {},
      nightActions: {}, 
      votes: {}
    };

    rooms[roomCode].players[socket.id] = { id: socket.id, name, role: 'VILLAGER', isAlive: true };
    socket.join(roomCode);
    socket.emit('roomCreated', { roomCode, playerId: socket.id });
    io.to(roomCode).emit('playerListUpdate', Object.values(rooms[roomCode].players));
  });

  // --- JOINING ---
  socket.on('joinRoom', ({ name, roomCode }) => {
    const room = rooms[roomCode?.toUpperCase()];
    if (!room) return socket.emit('errorMsg', 'Room not found.');
    if (room.state !== 'LOBBY') return socket.emit('errorMsg', 'Game already in progress.');

    room.players[socket.id] = { id: socket.id, name, role: 'VILLAGER', isAlive: true };
    socket.join(room.code);
    socket.emit('roomJoined', { roomCode: room.code, playerId: socket.id });
    io.to(room.code).emit('playerListUpdate', Object.values(room.players));
  });

  // --- RECONNECTION (SESSION STORAGE) ---
  socket.on('reconnectPlayer', ({ roomCode, playerId, name }) => {
    const room = rooms[roomCode];
    if (room && room.players[playerId]) {
      // Re-map the old player ID to this new socket ID seamlessly
      const oldPlayer = room.players[playerId];
      delete room.players[playerId];
      
      oldPlayer.id = socket.id;
      room.players[socket.id] = oldPlayer;
      
      if (room.host === playerId) room.host = socket.id; // Transfer host if needed

      socket.join(room.code);
      socket.emit('reconnectSuccess', { roomCode: room.code, playerId: socket.id, state: room.state, isHost: room.host === socket.id });
      io.to(room.code).emit('playerListUpdate', Object.values(room.players));
    } else {
      socket.emit('reconnectFailed');
    }
  });

  // Sync game state for reconnecting players mid-game
  socket.on('requestGameState', (roomCode) => {
    const room = rooms[roomCode];
    if (!room) return;
    const player = room.players[socket.id];
    
    socket.emit('gameStarted', {
      myRole: player.role,
      policePlayers: Object.values(room.players).filter(p => p.role === 'POLICE'),
      players: Object.values(room.players)
    });
    
    socket.emit('phaseChange', { phase: room.state, players: Object.values(room.players), timeLeft: room.timeLeft });
  });

  // --- START GAME & DYNAMIC ROLE SCALING ---
  socket.on('startGame', (roomCode) => {
    const room = rooms[roomCode];
    if (!room || room.host !== socket.id) return;

    const playerIds = Object.keys(room.players);
    const N = playerIds.length;
    if (N < 4) return socket.emit('errorMsg', 'At least 4 players required.');

    // Dynamic Role Math based on Rules
    let k = Math.floor(N / 6); 
    const docCount = 1 + k;     
    const policeCount = 1 + k;  
    const swCount = N > 9 ? 2 : 1;
    const mafiaCount = Math.max(1, Math.floor(N / 4)); // Scale mafia reasonably to balance

    let rolesPool = [];
    for(let i=0; i<mafiaCount; i++) rolesPool.push('MAFIA');
    for(let i=0; i<docCount; i++) rolesPool.push('DOCTOR');
    for(let i=0; i<policeCount; i++) rolesPool.push('POLICE');
    for(let i=0; i<swCount; i++) rolesPool.push('SEX_WORKER');

    // Fill the rest with Villagers
    while (rolesPool.length < N) rolesPool.push('VILLAGER');
    // If pool is accidentally too large, trim Villagers
    rolesPool = rolesPool.slice(0, N);
    
    // Shuffle Roles
    rolesPool.sort(() => Math.random() - 0.5);

    playerIds.forEach((id, idx) => {
      room.players[id].role = rolesPool[idx];
      room.players[id].isAlive = true;
    });

    const policePlayers = Object.values(room.players).filter(p => p.role === 'POLICE');

    playerIds.forEach((id) => {
      io.to(id).emit('gameStarted', {
        myRole: room.players[id].role,
        policePlayers: policePlayers,
        players: Object.values(room.players)
      });
    });

    startNightPhase(room);
  });

  function startNightPhase(room) {
    room.state = 'NIGHT';
    room.nightActions = {};
    room.votes = {};
    clearInterval(room.timer);

    io.to(room.code).emit('phaseChange', { phase: 'NIGHT', players: Object.values(room.players) });
  }

  socket.on('submitNightAction', ({ roomCode, targetId }) => {
    const room = rooms[roomCode];
    if (!room || room.state !== 'NIGHT') return;

    const player = room.players[socket.id];
    if (!player || !player.isAlive) return;

    const target = room.players[targetId];
    if (!target || !target.isAlive) return; 

    // Store action mapped by PLAYER ID (supports multiple docs/cops/mafias)
    room.nightActions[socket.id] = targetId;

    const activeNightPlayers = Object.values(room.players).filter(p => p.isAlive && ['MAFIA', 'DOCTOR', 'SEX_WORKER', 'POLICE'].includes(p.role));
    const allDone = activeNightPlayers.every(p => room.nightActions[p.id] !== undefined);

    if (allDone) {
      const eliminated = resolveNightActions(room);
      const winner = checkWinCondition(room);

      if (winner) {
        io.to(room.code).emit('gameOver', { winner, players: Object.values(room.players) });
        room.state = 'LOBBY';
      } else {
        // Evaluate All Police Results Independently
        const policePlayers = Object.values(room.players).filter(p => p.role === 'POLICE' && p.isAlive);
        policePlayers.forEach(cop => {
          const targetId = room.nightActions[cop.id];
          if (targetId) {
            const suspect = room.players[targetId];
            const result = investigatePlayer(suspect);
            io.to(cop.id).emit('policeResultBox', { targetName: suspect.name, result });
          }
        });
        
        startDayDiscussionPhase(room, eliminated);
      }
    }
  });

  function startDayDiscussionPhase(room, eliminatedNames) {
    room.state = 'DAY_DISCUSSION';
    room.timeLeft = 90;
    io.to(room.code).emit('phaseChange', { phase: 'DAY_DISCUSSION', eliminatedNames, players: Object.values(room.players), timeLeft: room.timeLeft });

    clearInterval(room.timer);
    room.timer = setInterval(() => {
      room.timeLeft -= 1;
      io.to(room.code).emit('timerUpdate', room.timeLeft);
      if (room.timeLeft <= 0) {
        clearInterval(room.timer);
        startDayVotePhase(room);
      }
    }, 1000);
  }

  function startDayVotePhase(room) {
    room.state = 'DAY_VOTE';
    room.votes = {};
    room.timeLeft = 15;
    io.to(room.code).emit('phaseChange', { phase: 'DAY_VOTE', players: Object.values(room.players), timeLeft: room.timeLeft });

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

  socket.on('submitVote', ({ roomCode, targetId }) => {
    const room = rooms[roomCode];
    if (!room || room.state !== 'DAY_VOTE') return;
    const player = room.players[socket.id];
    if (!player || !player.isAlive) return;

    room.votes[socket.id] = targetId;
    
    const livingCount = Object.values(room.players).filter(p => p.isAlive).length;
    if (Object.keys(room.votes).length >= livingCount) {
      clearInterval(room.timer);
      tallyVotes(room);
    }
  });

  function tallyVotes(room) {
    const voteCounts = {};
    Object.values(room.votes).forEach((targetId) => {
      if (targetId) voteCounts[targetId] = (voteCounts[targetId] || 0) + 1;
    });

    let highestVotes = 0;
    let lynchedId = null;

    Object.entries(voteCounts).forEach(([targetId, count]) => {
      if (count > highestVotes) { highestVotes = count; lynchedId = targetId; } 
      else if (count === highestVotes) { lynchedId = null; } // Tie
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
      setTimeout(() => { startNightPhase(room); }, 4000);
    }
  }

  socket.on('sendChatMessage', ({ roomCode, message }) => {
    const room = rooms[roomCode];
    if (!room) return;
    const player = room.players[socket.id];
    if (!player || !player.isAlive) return;

    io.to(room.code).emit('chatMessage', { sender: player.name, message, role: player.role === 'POLICE' ? 'POLICE' : null });
  });

  socket.on('disconnect', () => {
    Object.values(rooms).forEach(room => {
      // Don't delete immediately so they can reconnect via sessionStorage, but update list if in lobby
      if (room.players[socket.id] && room.state === 'LOBBY') {
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