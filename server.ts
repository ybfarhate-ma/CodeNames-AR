import express from 'express';
import { createServer as createViteServer } from 'vite';
import { createServer } from 'http';
import { Server } from 'socket.io';
import path from 'path';
import { fileURLToPath } from 'url';
import { GameState, Card, CardType, Player } from './src/types';
import { v4 as uuidv4 } from 'uuid';
import { ARABIC_WORDS } from './src/words';
import { WORD_THEMES } from './src/wordThemes';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = 3000;
const app = express();
const server = createServer(app);
const io = new Server(server, {
  cors: { origin: '*' }
});

const rooms = new Map<string, GameState>();
const roomTimers = new Map<string, NodeJS.Timeout>();

function clearRoomTimer(roomId: string) {
  const timer = roomTimers.get(roomId);
  if (timer) {
    clearInterval(timer);
    roomTimers.delete(roomId);
  }
}

function startRoomTimer(roomId: string) {
  clearRoomTimer(roomId);
  const room = rooms.get(roomId);
  if (!room || room.status !== 'playing' || room.settings.isPaused || !room.endTime) return;
  
  const timerSeconds = Number(room.settings?.timerSeconds ?? 120);
  if (timerSeconds <= 0) return; // Unlimited time or invalid

  const timer = setInterval(() => {
    const room = rooms.get(roomId);
    if (!room || room.status !== 'playing' || room.settings.isPaused) {
      clearRoomTimer(roomId);
      return;
    }

    if (Date.now() >= room.endTime) {
      handleTimerExpired(roomId);
    }
  }, 1000);
  
  roomTimers.set(roomId, timer);
}

function switchTurn(room: GameState, roomId: string) {
  // Clear any existing timer just in case
  clearRoomTimer(roomId);

  room.log.push({
    id: uuidv4(),
    text: `انتهى دور الفريق ${room.currentTurn === 'red' ? 'الأحمر' : 'الأزرق'}`,
    type: 'turn',
    timestamp: Date.now()
  });

  room.currentTurn = room.currentTurn === 'red' ? 'blue' : 'red';
  room.turnPhase = 'giving_clue';
  room.currentClue = null;
  room.turnStartTime = Date.now();
  
  // Set new endTime based on configuration
  const timerSeconds = Number(room.settings?.timerSeconds ?? 120);
  room.endTime = timerSeconds > 0 ? Date.now() + (timerSeconds * 1000) : Date.now();
  
  room.selections = {};
  
  // Restart the timer for the new turn
  startRoomTimer(roomId);
  
  broadcastRoomState(roomId);
}

function handleTimerExpired(roomId: string) {
  const room = rooms.get(roomId);
  if (!room) return;

  room.log.push({
    id: uuidv4(),
    text: `انتهى الوقت وفقد الفريق ${room.currentTurn === 'red' ? 'الأحمر' : 'الأزرق'} دورهم`,
    type: 'system',
    team: room.currentTurn,
    timestamp: Date.now()
  });
  
  // Logic Fix: Explicitly pass turn to the other team's Spymaster.
  // The team is flipped, phase is set to 'giving_clue', and clue is reset.
  room.currentTurn = room.currentTurn === 'red' ? 'blue' : 'red';
  room.turnPhase = 'giving_clue';
  room.currentClue = null;
  room.turnStartTime = Date.now();
  const timerSeconds = Number(room.settings?.timerSeconds ?? 120);
  room.endTime = timerSeconds > 0 ? Date.now() + (timerSeconds * 1000) : Date.now();
  room.selections = {};
  
  clearRoomTimer(roomId);
  startRoomTimer(roomId);
  broadcastRoomState(roomId);
}

function generateBoard(options: { customWords?: string[], theme?: string }): { cards: Card[], startingTeam: 'red' | 'blue' } {
  let words = [...ARABIC_WORDS];
  
  if (options.customWords && options.customWords.length > 0) {
    words = options.customWords;
  } else if (options.theme && WORD_THEMES[options.theme]) {
    words = WORD_THEMES[options.theme].words;
  }

  // Shuffle words and pick 25
  const shuffledWords = [...words].sort(() => Math.random() - 0.5).slice(0, 25);
  
  // Fill if we don't have enough words
  while (shuffledWords.length < 25) {
    const randomWord = ARABIC_WORDS[Math.floor(Math.random() * ARABIC_WORDS.length)];
    if (!shuffledWords.includes(randomWord)) {
      shuffledWords.push(randomWord);
    }
  }
  
  const startingTeam = Math.random() < 0.5 ? 'red' : 'blue';
  const redCount = startingTeam === 'red' ? 9 : 8;
  const blueCount = startingTeam === 'blue' ? 9 : 8;
  const neutralCount = 7;
  const assassinCount = 1;

  const types: CardType[] = [
    ...Array(redCount).fill('red'),
    ...Array(blueCount).fill('blue'),
    ...Array(neutralCount).fill('neutral'),
    ...Array(assassinCount).fill('assassin'),
  ];
  
  // Shuffle types
  types.sort(() => Math.random() - 0.5);

  const cards: Card[] = shuffledWords.map((word, index) => ({
    id: index,
    word,
    type: types[index],
    revealed: false
  }));

  return { cards, startingTeam };
}

function scrubGameState(room: GameState, playerId: string): GameState {
  const player = room.players.find(p => p.id === playerId);
  const isSpymaster = player?.role === 'spymaster';
  
  // If game is completed, reveal ALL cards to everyone
  const isGameOver = room.status === 'completed' || room.winner !== null;

  return {
    ...room,
    cards: room.cards.map(card => {
      // 1. Spymasters always see the true type.
      // 2. Revealed cards ALWAYS show their true type to everyone.
      // 3. If game is over, everyone sees all colors.
      if (isSpymaster || card.revealed || isGameOver) {
        return { 
          ...card,
          // Explicitly ensure the real type is being sent if it's revealed or spymaster
          type: card.type 
        };
      }
      
      // 4. Unrevealed cards look neutral to operatives.
      return { ...card, type: 'neutral' as any }; 
    })
  };
}

// Helper for broadcasting scrubbed state
const broadcastRoomState = (roomId: string) => {
  const room = rooms.get(roomId);
  if (!room) return;

  // We need to send a targeted update to each player in the room
  const clients = io.sockets.adapter.rooms.get(roomId);
  if (!clients) return;

  for (const clientId of clients) {
    const clientSocket = io.sockets.sockets.get(clientId);
    if (clientSocket) {
      clientSocket.emit('roomState', scrubGameState(room, clientId));
    }
  }
};

io.on('connection', (socket) => {
  socket.on('joinRoom', ({ roomId, name, gender }) => {
    socket.join(roomId);

    const isFirstPlayer = !rooms.has(roomId);
    let room = rooms.get(roomId);
    if (!room) {
      room = {
        roomId,
        creatorId: socket.id,
        status: 'lobby',
        players: [],
        cards: [],
        currentTurn: 'red', // Will be overridden on start
        turnPhase: 'giving_clue',
        currentClue: null,
        winner: null,
        score: { red: 0, blue: 0 },
        startingTeam: 'red',
        showExitButton: false,
        log: [],
        chat: [],
        settings: { timerSeconds: 120, customWords: [], theme: 'general' },
        selections: {}
      };
      rooms.set(roomId, room);
    }

    const newPlayer: Player = {
      id: socket.id,
      name: name || `Player ${Math.floor(Math.random() * 1000)}`,
      team: 'spectator',
      role: 'operative',
      isCreator: isFirstPlayer,
      gender
    };
    room.players.push(newPlayer);

    broadcastRoomState(roomId);
  });

  socket.on('sendMessage', ({ roomId, text }) => {
    const room = rooms.get(roomId);
    if (room) {
      const player = room.players.find(p => p.id === socket.id);
      if (player) {
        room.chat.push({
          id: uuidv4(),
          sender: player.name,
          text: text,
          timestamp: Date.now()
        });
        if (room.chat.length > 100) room.chat.shift();
        broadcastRoomState(roomId);
      }
    }
  });

  socket.on('updateProfile', ({ roomId, name, avatar }) => {
    const room = rooms.get(roomId);
    if (room) {
      const player = room.players.find(p => p.id === socket.id);
      if (player) {
        if (name) player.name = name;
        if (avatar) player.avatar = avatar;
        broadcastRoomState(roomId);
      }
    }
  });

  socket.on('proposeNameChange', ({ roomId, targetPlayerId, newName, senderName }) => {
    io.to(roomId).emit('nameProposalReceived', { targetPlayerId, newName, senderName });
  });

  socket.on('approveNameChange', ({ roomId, targetPlayerId, newName }) => {
    const room = rooms.get(roomId);
    if (room) {
      const player = room.players.find(p => p.id === targetPlayerId);
      if (player) {
        player.name = newName;
        broadcastRoomState(roomId);
      }
    }
  });

  socket.on('joinTeam', ({ roomId, team, role }) => {
    const room = rooms.get(roomId);
    if (room) {
      const player = room.players.find(p => p.id === socket.id);
      if (player) {
        player.team = team;
        player.role = role;
        broadcastRoomState(roomId);
      }
    }
  });

  socket.on('updateSettings', ({ roomId, settings }) => {
    const room = rooms.get(roomId);
    if (room && room.status === 'lobby') {
      room.settings = { ...room.settings, ...settings };
      broadcastRoomState(roomId);
    }
  });

  socket.on('updateCustomWords', ({ roomId, customWords }) => {
    const room = rooms.get(roomId);
    if (room && room.status === 'lobby') {
      room.settings.customWords = customWords;
      broadcastRoomState(roomId);
    }
  });

  socket.on('startGame', ({ roomId }) => {
    const room = rooms.get(roomId);
    if (room && (room.status === 'lobby' || room.status === 'waiting')) {
      const { cards, startingTeam } = generateBoard({ 
        customWords: room.settings.customWords, 
        theme: room.settings.theme 
      });
      room.cards = cards;
      room.startingTeam = startingTeam;
      room.currentTurn = startingTeam;
      room.turnPhase = 'giving_clue';
      room.currentClue = null;
      room.winner = null;
      room.turnStartTime = Date.now();
      
      const timerSeconds = Number(room.settings?.timerSeconds ?? 120);
      room.endTime = timerSeconds > 0 ? Date.now() + (timerSeconds * 1000) : Date.now();
      
      room.log = [];
      room.selections = {};
      room.score = {
        red: cards.filter(c => c.type === 'red').length,
        blue: cards.filter(c => c.type === 'blue').length,
      };
      room.status = 'playing';
      
      startRoomTimer(roomId);
      broadcastRoomState(roomId);
    }
  });

  socket.on('closeRoom', ({ roomId }) => {
    const room = rooms.get(roomId);
    if (!room || room.creatorId !== socket.id) {
        return;
    }
    
    // Notify all clients to leave
    io.to(roomId).emit('roomClosed');
    
    // Clean up
    clearRoomTimer(roomId);
    rooms.delete(roomId);
  });

  socket.on('returnToLobby', ({ roomId }) => {
    const room = rooms.get(roomId);
    if (!room || room.creatorId !== socket.id) {
        return;
    }
    clearRoomTimer(roomId);
    room.status = 'waiting';
    room.cards = [];
    room.winner = null;
    room.currentTurn = 'red';
    room.turnPhase = 'giving_clue';
    room.currentClue = null;
    room.score = { red: 0, blue: 0 };
    room.log = [{
        id: uuidv4(),
        text: 'تمت إعادة تعيين اللعبة للوبي.',
        type: 'system',
        timestamp: Date.now()
    }];
    room.selections = {};
    broadcastRoomState(roomId);
  });

  socket.on('submitClue', ({ roomId, word, count }) => {
    const room = rooms.get(roomId);
    if (!room || room.status !== 'playing') return;

    const player = room.players.find(p => p.id === socket.id);
    if (!player || player.role !== 'spymaster' || player.team !== room.currentTurn) return;

    room.currentClue = { word, count, guessesLeft: count === 0 ? 0 : count + 1 };
    room.turnPhase = 'guessing';
    room.turnStartTime = Date.now();
    
    // Reset timer for the operative's guessing phase
    const timerSeconds = Number(room.settings?.timerSeconds ?? 120);
    room.endTime = timerSeconds > 0 ? Date.now() + (timerSeconds * 1000) : Date.now();
    
    room.log.push({
      id: uuidv4(),
      text: `${player.name} أعطى تلميح: "${word}" (${count === 0 ? '∞' : count})`,
      type: 'clue',
      team: room.currentTurn,
      playerName: player.name,
      timestamp: Date.now()
    });

    if (room.log.length > 50) room.log.shift();

    startRoomTimer(roomId);
    broadcastRoomState(roomId);
  });

  socket.on('revealCard', ({ roomId, cardId }) => {
    const room = rooms.get(roomId);
    if (!room || room.status !== 'playing' || room.turnPhase !== 'guessing') return;

    const player = room.players.find(p => p.id === socket.id);
    if (!player || player.role === 'spymaster' || player.team === 'spectator') return;
    if (player.team !== room.currentTurn) return;

    const card = room.cards.find(c => c.id === cardId);
    if (!card || card.revealed) return;

    card.revealed = true;
    card.revealedBy = player.name;
    delete room.selections[cardId];

    // const switchTurn = () => { -- removed local definition
    //   room.log.push({
    //     id: uuidv4(),
    //     text: `انتهى دور الفريق ${room.currentTurn === 'red' ? 'الأحمر' : 'الأزرق'}`,
    //     type: 'turn',
    //     timestamp: Date.now()
    //   });
    //   room.currentTurn = room.currentTurn === 'red' ? 'blue' : 'red';
    //   room.turnPhase = 'giving_clue';
    //   room.currentClue = null;
    //   room.turnStartTime = Date.now();
    //   room.selections = {};
    // };

    let guessResult = '';
    if (card.type === room.currentTurn) guessResult = '✅';
    else if (card.type === 'assassin') guessResult = '💀';
    else guessResult = '❌';

    room.log.push({
      id: uuidv4(),
      text: `${player.name} اختار: "${card.word}" ${guessResult}`,
      type: 'guess',
      team: room.currentTurn,
      playerName: player.name,
      timestamp: Date.now()
    });

    if (room.log.length > 50) room.log.shift();

    if (card.type === 'assassin') {
      // The team that revealed the assassin card loses immediately.
      // So the winner is the OPPOSITE team.
      if (room.currentTurn === 'red') {
        room.winner = 'blue';
      } else {
        room.winner = 'red';
      }
      room.status = 'completed';
    } else if (card.type === 'neutral') {
      switchTurn(room, roomId);
    } else if (card.type === 'red' || card.type === 'blue') {
      room.score[card.type]--;
      
      if (room.score[card.type] === 0) {
        room.winner = card.type;
        room.status = 'completed';
      } else if (card.type !== room.currentTurn) {
        switchTurn(room, roomId);
      } else {
        // Correct guess
        if (room.currentClue && room.currentClue.count > 0) {
          room.currentClue.guessesLeft--;
          if (room.currentClue.guessesLeft <= 0) {
            switchTurn(room, roomId);
          }
        }
      }
    }

    if (room.status === 'playing' && card.type !== 'assassin') {
      startRoomTimer(roomId);
    } else {
      clearRoomTimer(roomId);
    }
    io.to(roomId).emit('cardRevealed', card);
    broadcastRoomState(roomId);
  });

  socket.on('endTurn', ({ roomId }) => {
    const room = rooms.get(roomId);
    if (room && room.status === 'playing' && room.turnPhase === 'guessing') {
      const player = room.players.find(p => p.id === socket.id);
      if (player && player.team === room.currentTurn && player.role === 'operative') {
        room.log.push({
          id: uuidv4(),
          text: `${player.name} أنهى الدور`,
          type: 'system',
          team: room.currentTurn,
          playerName: player.name,
          timestamp: Date.now()
        });
        
        switchTurn(room, roomId);
        broadcastRoomState(roomId);
      }
    }
  });

  socket.on('transferAdminDirect', ({ roomId, newAdminId }) => {
    const room = rooms.get(roomId);
    if (!room) return;

    if (room.creatorId === socket.id) {
      room.creatorId = newAdminId;
      room.log.push({
        id: uuidv4(),
        timestamp: Date.now(),
        type: 'system',
        text: `انتقلت إدارة الغرفة إلى: ${room.players.find(p => p.id === newAdminId)?.name || 'Unknown'} بقرار من الأدمن`
      });
      broadcastRoomState(roomId);
      io.to(newAdminId).emit('adminRequestFeedback', { approved: true, message: 'لقد تم تعيينك كأدمن للغرفة' });
    }
  });

  socket.on('requestAdminPrivilege', ({ roomId }) => {
    const room = rooms.get(roomId);
    if (!room) return;
    const player = room.players.find(p => p.id === socket.id);
    if (!player) return;

    const creator = room.players.find(p => p.id === room.creatorId);
    if (creator) {
      io.to(creator.id).emit('adminPrivilegeRequested', { 
        requesterId: player.id, 
        requesterName: player.name 
      });
    }
  });

  socket.on('approveAdminRequest', ({ roomId, requesterId }) => {
    const room = rooms.get(roomId);
    if (!room) return;

    if (room.creatorId === socket.id) {
      room.creatorId = requesterId;
      room.log.push({
        id: uuidv4(),
        timestamp: Date.now(),
        type: 'system',
        text: `تمت الموافقة على طلب الإشراف. المدير الجديد: ${room.players.find(p => p.id === requesterId)?.name || 'Unknown'}`
      });
      broadcastRoomState(roomId);
      io.to(requesterId).emit('adminRequestFeedback', { approved: true, message: 'تم قبول طلبك! أنت الآن مدير الغرفة' });
    }
  });

  socket.on('rejectAdminRequest', ({ roomId, requesterId }) => {
    const room = rooms.get(roomId);
    if (!room) return;

    if (room.creatorId === socket.id) {
      io.to(requesterId).emit('adminRequestFeedback', { approved: false, message: 'رفض الأدمن طلبك بالحصول على الإشراف' });
    }
  });

  socket.on('resetGame', ({ roomId }) => {
    const room = rooms.get(roomId);
    if (room) {
      clearRoomTimer(roomId);
      room.status = 'lobby';
      room.cards = [];
      room.winner = null;
      room.players.forEach(player => {
        player.team = 'spectator';
        player.role = 'operative';
      });
      broadcastRoomState(roomId);
    }
  });

  socket.on('setExitButtonVisibility', ({ roomId, show }) => {
    const room = rooms.get(roomId);
    if (room) {
      room.showExitButton = show;
      broadcastRoomState(roomId);
    }
  });

  socket.on('togglePause', ({ roomId }) => {
    const room = rooms.get(roomId);
    if (room && room.status === 'playing') {
      if (room.creatorId !== socket.id) return;

      if (room.settings.isPaused) {
        const pausedDuration = Date.now() - (room.pauseTime || Date.now());
        room.turnStartTime = (room.turnStartTime || Date.now()) + pausedDuration;
        room.settings.isPaused = false;
        room.pauseTime = undefined;
        room.log.push({
          id: uuidv4(),
          text: `تم استئناف الوقت بواسطة الإدارة`,
          type: 'system',
          timestamp: Date.now()
        });
        startRoomTimer(roomId);
      } else {
        room.settings.isPaused = true;
        room.pauseTime = Date.now();
        room.log.push({
          id: uuidv4(),
          text: `تم إيقاف الوقت مؤقتاً بواسطة الإدارة`,
          type: 'system',
          timestamp: Date.now()
        });
        clearRoomTimer(roomId);
      }
      broadcastRoomState(roomId);
      io.to(roomId).emit('timerStatusChanged', { isPaused: room.settings.isPaused });
    }
  });

  socket.on('endGame', ({ roomId }) => {
    const room = rooms.get(roomId);
    if (room && room.creatorId === socket.id) {
      clearRoomTimer(roomId);
      room.status = 'lobby';
      room.cards = [];
      room.currentClue = null;
      room.winner = null;
      room.log.push({
        id: uuidv4(),
        text: `تم إنهاء اللعبة والعودة للوبي بواسطة الإدارة`,
        type: 'system',
        timestamp: Date.now()
      });
      broadcastRoomState(roomId);
    }
  });

  socket.on('kickPlayer', ({ roomId, targetId }) => {
    const room = rooms.get(roomId);
    if (room && room.creatorId === socket.id && targetId !== socket.id) {
      const targetPlayer = room.players.find(p => p.id === targetId);
      if (targetPlayer) {
        // Find if target is in the room
        room.players = room.players.filter(p => p.id !== targetId);
        
        Object.keys(room.selections).forEach(cardId => {
          const cid = parseInt(cardId);
          room.selections[cid] = (room.selections[cid] || []).filter(name => name !== targetPlayer.name);
          if (room.selections[cid].length === 0) delete room.selections[cid];
        });

        room.log.push({
          id: uuidv4(),
          text: `تم طرد ${targetPlayer.name} من الغرفة`,
          type: 'system',
          timestamp: Date.now()
        });
        
        broadcastRoomState(roomId);
        // Force the kicked socket to leave
        const targetSocket = io.sockets.sockets.get(targetId);
        if (targetSocket) {
          targetSocket.emit('kicked');
          targetSocket.leave(roomId);
        }
      }
    }
  });

  socket.on('toggleTeamsLock', ({ roomId }) => {
    const room = rooms.get(roomId);
    if (room && room.creatorId === socket.id) {
      room.settings.teamsLocked = !room.settings.teamsLocked;
      room.log.push({
        id: uuidv4(),
        text: room.settings.teamsLocked ? `تم قفل الفرق` : `تم فتح الفرق`,
        type: 'system',
        timestamp: Date.now()
      });
      broadcastRoomState(roomId);
    }
  });

  socket.on('timerExpired', ({ roomId }) => {
    // Client-side timer can still trigger this as a fallback, 
    // but the server now handles it actively.
    // Prevent multiple triggers from clients + server
    const room = rooms.get(roomId);
    if (!room || !room.endTime) return;
    if (room.settings?.timerSeconds === 0) return; // Ignore if unlimited time
    if (Date.now() >= room.endTime - 1000) {
      handleTimerExpired(roomId);
    }
  });

  socket.on('sendReaction', ({ roomId, emoji }) => {
    io.to(roomId).emit('playerReaction', { playerId: socket.id, emoji });
  });

  socket.on('sendReaction', (data: { roomId: string, emoji: string, senderId: string }) => {
    io.to(data.roomId).emit('receiveReaction', {
        id: Date.now().toString() + Math.random(),
        emoji: data.emoji,
        senderId: data.senderId
    });
});

  socket.on('sendReactionExtended', ({ roomId, type }) => {
    io.to(roomId).emit('playerReactionExtended', { playerId: socket.id, type });
  });

  socket.on('toggleSelection', ({ roomId, cardId }) => {
    const room = rooms.get(roomId);
    if (!room || room.status !== 'playing' || room.turnPhase !== 'guessing') return;

    const player = room.players.find(p => p.id === socket.id);
    if (!player || player.role === 'spymaster' || player.team !== room.currentTurn) return;

    if (!room.selections[cardId]) {
      room.selections[cardId] = [];
    }

    const index = room.selections[cardId].indexOf(player.name);
    if (index > -1) {
      room.selections[cardId].splice(index, 1);
      if (room.selections[cardId].length === 0) {
        delete room.selections[cardId];
      }
    } else {
      room.selections[cardId].push(player.name);
    }

    broadcastRoomState(roomId);
  });

  socket.on('randomizeTeams', ({ roomId }) => {
    const room = rooms.get(roomId);
    if(room && room.status === 'lobby') {
      const players = room.players;
      if(players.length === 0) return;
      
      // randomize
      const shuffled = [...players].sort(() => Math.random() - 0.5);
      
      let redCount = Math.floor(shuffled.length / 2);
      
      shuffled.forEach((p, idx) => {
        if (idx < redCount) {
            p.team = 'red';
        } else {
            p.team = 'blue';
        }
        // Set all to operative first
        p.role = 'operative';
      });
      
      // Assign spymasters randomly
      const redTeam = shuffled.filter(p => p.team === 'red');
      const blueTeam = shuffled.filter(p => p.team === 'blue');
      
      if(redTeam.length > 0) redTeam[Math.floor(Math.random() * redTeam.length)].role = 'spymaster';
      if(blueTeam.length > 0) blueTeam[Math.floor(Math.random() * blueTeam.length)].role = 'spymaster';

      broadcastRoomState(roomId);
    }
  });

  socket.on('updatePlayerName', ({ roomId, name }) => {
    const room = rooms.get(roomId);
    if (room) {
      const player = room.players.find(p => p.id === socket.id);
      if (player) {
        player.name = name;
        broadcastRoomState(roomId);
      }
    }
  });

  socket.on('disconnect', () => {
    rooms.forEach((room, roomId) => {
      const initialLength = room.players.length;
      const exitingPlayer = room.players.find(p => p.id === socket.id);
      
      room.players = room.players.filter(p => p.id !== socket.id);
      if (room.players.length < initialLength) {
        // If creator left, assign new creator
        if (room.creatorId === socket.id && room.players.length > 0) {
          const newAdmin = room.players[0];
          room.creatorId = newAdmin.id;
          newAdmin.isCreator = true;
          room.log.push({
            id: uuidv4(),
            text: `انتقلت الإدارة تلقائياً إلى: ${newAdmin.name}`,
            type: 'system',
            timestamp: Date.now()
          });
          io.to(roomId).emit('hostMigrated', newAdmin.name);
        }

        // Remove selections by this player
        if (exitingPlayer) {
          Object.keys(room.selections).forEach(cardId => {
            const cid = parseInt(cardId);
            room.selections[cid] = room.selections[cid].filter(name => name !== exitingPlayer.name);
            if (room.selections[cid].length === 0) delete room.selections[cid];
          });
        }

        if (room.players.length === 0) {
          rooms.delete(roomId);
        } else {
          broadcastRoomState(roomId);
        }
      }
    });
  });

  socket.on('leaveRoom', ({ roomId }) => {
    const room = rooms.get(roomId);
    if (room) {
      const exitingPlayer = room.players.find(p => p.id === socket.id);
      room.players = room.players.filter(p => p.id !== socket.id);
      
      if (exitingPlayer) {
          Object.keys(room.selections).forEach(cardId => {
            const cid = parseInt(cardId);
            room.selections[cid] = (room.selections[cid] || []).filter(name => name !== exitingPlayer.name);
            if (room.selections[cid].length === 0) delete room.selections[cid];
          });
      }

      if (room.players.length === 0) {
        rooms.delete(roomId);
      } else {
        broadcastRoomState(roomId);
      }
      socket.leave(roomId);
    }
  });
});

async function startServer() {
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  server.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer();
