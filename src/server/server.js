/**
 * server.js
 * =====================================================
 * WebSocket server untuk Remi Indonesia multiplayer.
 *
 * UPDATE v2:
 *  ✓ FIX: handleLeaveRoom sekarang broadcastLobby agar client update
 *  ✓ FIX: Pemain disconnect di lobby → reset ready + broadcastLobby
 *  ✓ FIX: handleStartGame memvalidasi semua pemain sudah ready
 *  ✓ FIX: broadcastGameState menyertakan nama pemain
 *  ✓ FIX: Pesan error lebih informatif
 *  ✓ NEW: Voice Chat signaling (vc_signal) — relay WebRTC offer/answer/ICE
 *  ✓ NEW: Snapshot publik menyertakan discardPileFull & discardCount
 *  ✓ NEW: round_over menyertakan playerName di roundScores
 *
 * Protokol pesan (JSON):
 *   Client → Server:
 *     { type: 'create_room',   name, options }
 *     { type: 'join_room',     code, name }
 *     { type: 'set_ready',     ready }
 *     { type: 'start_game' }
 *     { type: 'draw_stock' }
 *     { type: 'draw_discard',  positionFromTop }
 *     { type: 'place_meld',    cardIds }
 *     { type: 'discard',       cardId, attemptClose }
 *     { type: 'reconnect',     playerId, code }
 *     { type: 'leave_room' }
 *     { type: 'vc_signal',     action, fromId, toId?, sdp?, candidate? }  ← NEW
 *
 *   Server → Client:
 *     { type: 'room_created',       code, playerId, room }
 *     { type: 'room_joined',        code, playerId, room }
 *     { type: 'lobby_update',       room }
 *     { type: 'game_started',       snapshot }
 *     { type: 'state_update',       snapshot }
 *     { type: 'private_hand',       hand, melds, hasBaseSeries }
 *     { type: 'round_over',         roundScores, totalScores, winner, winnerName }
 *     { type: 'error',              message }
 *     { type: 'reconnected',        room, snapshot }
 *     { type: 'player_disconnected', playerId, playerName }
 *     { type: 'player_reconnected',  playerId, playerName }
 *     { type: 'vc_signal',          action, fromId, toId?, sdp?, candidate? }  ← NEW
 */

const WebSocket = require('ws');
const crypto    = require('crypto');
const { RoomManager } = require('./RoomManager');

const PORT        = process.env.PORT || 8080;
const roomManager = new RoomManager();

// Map: ws → { playerId, roomCode }
const connMeta      = new Map();
// Map: playerId → ws
const playerSockets = new Map();

const wss = new WebSocket.Server({ port: PORT });
console.log(`🃏 Remi WebSocket server berjalan di port ${PORT}`);

// ─────────────────────────────────────────────────────
// Helper kirim pesan
// ─────────────────────────────────────────────────────

function send(ws, payload) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(payload));
  }
}

function sendToPlayer(playerId, payload) {
  const sock = playerSockets.get(playerId);
  if (sock) send(sock, payload);
}

function broadcastToRoom(room, payload, excludePlayerId = null) {
  room.players.forEach(p => {
    if (p.id !== excludePlayerId) sendToPlayer(p.id, payload);
  });
}

/**
 * Kirim state_update (publik) ke semua pemain +
 * private_hand (kartu tangan) ke masing-masing pemain.
 *
 * UPDATE: snapshot publik sekarang menyertakan discardPileFull & discardCount.
 */
function broadcastGameState(room) {
  if (!room.game) return;

  const publicSnapshot = room.game.snapshotPublic();  // Use extended snapshot
  broadcastToRoom(room, { type: 'state_update', snapshot: publicSnapshot });

  room.players.forEach(p => {
    const playerState = room.game.players.find(gp => gp.id === p.id);
    if (!playerState) return;
    sendToPlayer(p.id, {
      type:          'private_hand',
      hand:          playerState.hand.map(c => c.toString()),
      melds:         playerState.melds.map(m => m.map(c => c.toString())),
      hasBaseSeries: playerState.hasBaseSeries
    });
  });
}

function broadcastLobby(room) {
  broadcastToRoom(room, { type: 'lobby_update', room: room.toLobbySummary() });
}

// ─────────────────────────────────────────────────────
// Connection handler
// ─────────────────────────────────────────────────────

wss.on('connection', (ws) => {
  console.log('Koneksi WebSocket baru masuk');

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return send(ws, { type: 'error', message: 'Format pesan tidak valid (harus JSON)' });
    }
    handleMessage(ws, msg);
  });

  ws.on('close', () => {
    const meta = connMeta.get(ws);
    if (!meta) return;

    const { playerId, roomCode } = meta;
    const room = roomManager.getRoom(roomCode);

    if (room) {
      const playerName = room.playerNameOf(playerId);

      if (room.status === 'PLAYING' && room.game) {
        room.game.playerDisconnect(playerId);
        room.setConnected(playerId, false);
        broadcastToRoom(room, { type: 'player_disconnected', playerId, playerName });
        broadcastGameState(room);
        console.log(`Pemain ${playerName} (${playerId}) disconnect saat game berlangsung`);
      } else {
        room.removePlayer(playerId);
        roomManager.removeRoomIfEmpty(roomCode);
        if (roomManager.getRoom(roomCode)) {
          broadcastLobby(room);
        }
        console.log(`Pemain ${playerName} keluar dari lobby ${roomCode}`);
      }
    }

    connMeta.delete(ws);
    playerSockets.delete(playerId);
  });

  ws.on('error', (err) => {
    console.error('WebSocket error:', err.message);
  });
});

// ─────────────────────────────────────────────────────
// Message router
// ─────────────────────────────────────────────────────

function handleMessage(ws, msg) {
  const handlers = {
    create_room:  handleCreateRoom,
    join_room:    handleJoinRoom,
    set_ready:    handleSetReady,
    start_game:   handleStartGame,
    draw_stock:   handleDrawStock,
    draw_discard: handleDrawDiscard,
    place_meld:   handlePlaceMeld,
    discard:      handleDiscard,
    reconnect:    handleReconnect,
    leave_room:   handleLeaveRoom,
    vc_signal:    handleVcSignal      // NEW: Voice Chat signaling
  };

  const handler = handlers[msg.type];
  if (!handler) {
    return send(ws, { type: 'error', message: `Tipe pesan tidak dikenal: ${msg.type}` });
  }
  try {
    handler(ws, msg);
  } catch (err) {
    console.error('Error handling message:', err);
    send(ws, { type: 'error', message: 'Terjadi kesalahan internal server' });
  }
}

// ─────────────────────────────────────────────────────
// Handlers: Lobby
// ─────────────────────────────────────────────────────

function handleCreateRoom(ws, msg) {
  const playerId   = crypto.randomUUID();
  const playerName = (msg.name || 'Pemain').trim().slice(0, 20);

  if (!playerName) {
    return send(ws, { type: 'error', message: 'Nama pemain tidak boleh kosong' });
  }

  const room = roomManager.createRoom(playerId, playerName, msg.options || {});

  connMeta.set(ws, { playerId, roomCode: room.code });
  playerSockets.set(playerId, ws);

  send(ws, { type: 'room_created', code: room.code, playerId, room: room.toLobbySummary() });
  console.log(`Room dibuat: ${room.code} oleh ${playerName}`);
}

function handleJoinRoom(ws, msg) {
  const playerId   = crypto.randomUUID();
  const playerName = (msg.name || 'Pemain').trim().slice(0, 20);

  if (!playerName) {
    return send(ws, { type: 'error', message: 'Nama pemain tidak boleh kosong' });
  }

  const code = (msg.code || '').toUpperCase().trim();
  if (!code) {
    return send(ws, { type: 'error', message: 'Kode ruang tidak boleh kosong' });
  }

  const result = roomManager.joinRoom(code, playerId, playerName);
  if (!result.success) {
    return send(ws, { type: 'error', message: result.reason });
  }

  const room = result.room;
  connMeta.set(ws, { playerId, roomCode: room.code });
  playerSockets.set(playerId, ws);

  send(ws, { type: 'room_joined', code: room.code, playerId, room: room.toLobbySummary() });
  broadcastLobby(room);
  console.log(`${playerName} bergabung ke room ${room.code}`);
}

function handleSetReady(ws, msg) {
  const meta = connMeta.get(ws);
  if (!meta) return send(ws, { type: 'error', message: 'Sesi tidak valid, sambungkan ulang' });

  const room = roomManager.getRoom(meta.roomCode);
  if (!room) return send(ws, { type: 'error', message: 'Ruang tidak ditemukan' });
  if (room.status !== 'LOBBY') return send(ws, { type: 'error', message: 'Game sudah dimulai' });

  room.setReady(meta.playerId, !!msg.ready);
  broadcastLobby(room);
}

function handleStartGame(ws, msg) {
  const meta = connMeta.get(ws);
  if (!meta) return send(ws, { type: 'error', message: 'Sesi tidak valid' });

  const room = roomManager.getRoom(meta.roomCode);
  if (!room) return send(ws, { type: 'error', message: 'Ruang tidak ditemukan' });

  if (room.hostId !== meta.playerId) {
    return send(ws, { type: 'error', message: 'Hanya host yang bisa memulai permainan' });
  }

  const result = room.startGame();
  if (!result.success) {
    return send(ws, { type: 'error', message: result.reason });
  }

  broadcastToRoom(room, { type: 'game_started', snapshot: result.snapshot });
  broadcastGameState(room);
  console.log(`Game dimulai di room ${room.code}, giliran pertama: ${result.snapshot.currentTurnName}`);
}

function handleLeaveRoom(ws, msg) {
  const meta = connMeta.get(ws);
  if (!meta) return;

  const room = roomManager.getRoom(meta.roomCode);
  if (room) {
    const playerName = room.playerNameOf(meta.playerId);
    room.removePlayer(meta.playerId);
    roomManager.removeRoomIfEmpty(meta.roomCode);
    if (roomManager.getRoom(meta.roomCode)) {
      broadcastLobby(room);
    }
    console.log(`${playerName} meninggalkan room ${meta.roomCode}`);
  }

  connMeta.delete(ws);
  playerSockets.delete(meta.playerId);
}

// ─────────────────────────────────────────────────────
// Handlers: In-Game Actions
// ─────────────────────────────────────────────────────

function _getActiveGame(ws) {
  const meta = connMeta.get(ws);
  if (!meta) return null;
  const room = roomManager.getRoom(meta.roomCode);
  if (!room || !room.game) return null;
  return { meta, room, game: room.game };
}

function handleDrawStock(ws, msg) {
  const ctx = _getActiveGame(ws);
  if (!ctx) return send(ws, { type: 'error', message: 'Tidak ada permainan aktif' });

  const result = ctx.game.drawFromStock(ctx.meta.playerId);
  if (!result.success) return send(ws, { type: 'error', message: result.reason });

  if (result.gameOver) {
    return _handleRoundOver(ctx.room, result);
  }

  broadcastGameState(ctx.room);
}

function handleDrawDiscard(ws, msg) {
  const ctx = _getActiveGame(ws);
  if (!ctx) return send(ws, { type: 'error', message: 'Tidak ada permainan aktif' });

  const positionFromTop = typeof msg.positionFromTop === 'number' ? msg.positionFromTop : 0;

  const result = ctx.game.drawFromDiscard(
    ctx.meta.playerId,
    positionFromTop,
    msg.intendedMeld || null
  );
  if (!result.success) return send(ws, { type: 'error', message: result.reason });

  broadcastGameState(ctx.room);
}

function handlePlaceMeld(ws, msg) {
  const ctx = _getActiveGame(ws);
  if (!ctx) return send(ws, { type: 'error', message: 'Tidak ada permainan aktif' });

  if (!Array.isArray(msg.cardIds) || msg.cardIds.length < 3) {
    return send(ws, { type: 'error', message: 'Minimal 3 kartu untuk membentuk kombinasi' });
  }

  const result = ctx.game.placeMeld(ctx.meta.playerId, msg.cardIds);
  if (!result.success) return send(ws, { type: 'error', message: result.reason });

  broadcastGameState(ctx.room);
}

function handleDiscard(ws, msg) {
  const ctx = _getActiveGame(ws);
  if (!ctx) return send(ws, { type: 'error', message: 'Tidak ada permainan aktif' });

  if (!msg.cardId) {
    return send(ws, { type: 'error', message: 'Pilih kartu yang ingin dibuang' });
  }

  const result = ctx.game.discard(ctx.meta.playerId, msg.cardId, !!msg.attemptClose);
  if (!result.success) return send(ws, { type: 'error', message: result.reason });

  if (result.gameOver) {
    return _handleRoundOver(ctx.room, result);
  }

  broadcastGameState(ctx.room);
}

function _handleRoundOver(room, result) {
  // Enrich roundScores with playerName from room
  const enrichedScores = (result.roundScores || []).map(rs => ({
    ...rs,
    playerName: room.playerNameOf(rs.playerId)
  }));

  broadcastToRoom(room, {
    type:        'round_over',
    winner:      result.winner,
    winnerName:  result.winnerName,
    stockEmpty:  result.stockEmpty,
    roundScores: enrichedScores,
    totalScores: result.totalScores
  });
  broadcastGameState(room);
  console.log(`Putaran selesai di room ${room.code}. Pemenang: ${result.winnerName || '(stock habis)'}`);
}

// ─────────────────────────────────────────────────────
// Handler: Reconnect
// ─────────────────────────────────────────────────────

function handleReconnect(ws, msg) {
  if (!msg.playerId || !msg.code) {
    return send(ws, { type: 'error', message: 'playerId dan code diperlukan untuk reconnect' });
  }

  const room = roomManager.getRoom(msg.code);
  if (!room) return send(ws, { type: 'error', message: 'Ruang tidak ditemukan' });

  const playerExists = room.players.some(p => p.id === msg.playerId);
  if (!playerExists) {
    return send(ws, { type: 'error', message: 'Pemain tidak ditemukan di ruang ini' });
  }

  if (room.game) {
    const result = room.game.playerReconnect(msg.playerId);
    if (!result.success) {
      return send(ws, { type: 'error', message: result.reason });
    }
  }

  room.setConnected(msg.playerId, true);
  connMeta.set(ws, { playerId: msg.playerId, roomCode: room.code });
  playerSockets.set(msg.playerId, ws);

  const playerName = room.playerNameOf(msg.playerId);

  send(ws, {
    type:     'reconnected',
    room:     room.toLobbySummary(),
    snapshot: room.game ? room.game.snapshotForPlayer(msg.playerId) : null
  });

  broadcastToRoom(room, { type: 'player_reconnected', playerId: msg.playerId, playerName }, msg.playerId);

  if (room.game) {
    broadcastGameState(room);
  }

  console.log(`Pemain ${playerName} berhasil reconnect ke room ${room.code}`);
}

// ─────────────────────────────────────────────────────
// Handler: Voice Chat Signaling  ← NEW
// ─────────────────────────────────────────────────────

/**
 * Relay WebRTC signaling messages within the same room.
 * The server never inspects the SDP/ICE content — it just routes them.
 *
 * If msg.toId is specified, relay to that player only.
 * If msg.toId is omitted (e.g. vc_joined / vc_left), broadcast to room.
 */
function handleVcSignal(ws, msg) {
  const meta = connMeta.get(ws);
  if (!meta) return;

  const room = roomManager.getRoom(meta.roomCode);
  if (!room) return;

  const payload = {
    type:      'vc_signal',
    action:    msg.action,
    fromId:    meta.playerId,           // always use server-verified ID
    toId:      msg.toId   || null,
    sdp:       msg.sdp    || null,
    candidate: msg.candidate || null
  };

  if (msg.toId) {
    // Unicast — send only to target player
    sendToPlayer(msg.toId, payload);
  } else {
    // Broadcast to room except sender
    broadcastToRoom(room, payload, meta.playerId);
  }
}

// ─────────────────────────────────────────────────────
// Maintenance: bersihkan room idle setiap 5 menit
// ─────────────────────────────────────────────────────

setInterval(() => {
  const removed = roomManager.cleanupIdleRooms();
  if (removed > 0) console.log(`Membersihkan ${removed} room idle`);
}, 5 * 60 * 1000);

module.exports = { wss, roomManager };
