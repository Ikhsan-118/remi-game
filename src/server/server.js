/**
 * server.js — WebSocket server Remi Indonesia
 *
 * UPDATE v3:
 *  ✓ NEW: next_round — lanjut babak berikutnya, skor dipertahankan
 *  ✓ NEW: new_game   — mulai game baru, reset skor
 *  ✓ NEW: relay roundHistory ke client di round_over
 *  ✓ FIX: vc_signal relay
 */

const WebSocket = require('ws');
const crypto    = require('crypto');
const { RoomManager } = require('./RoomManager');

const PORT        = process.env.PORT || 8080;
const roomManager = new RoomManager();

const connMeta      = new Map(); // ws → {playerId, roomCode}
const playerSockets = new Map(); // playerId → ws

const wss = new WebSocket.Server({ port: PORT });
console.log(`🃏 Remi WebSocket server berjalan di port ${PORT}`);

function send(ws, payload) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(payload));
}
function sendToPlayer(playerId, payload) {
  const s = playerSockets.get(playerId);
  if (s) send(s, payload);
}
function broadcastToRoom(room, payload, excludeId=null) {
  room.players.forEach(p => { if (p.id !== excludeId) sendToPlayer(p.id, payload); });
}

function broadcastGameState(room) {
  if (!room.game) return;
  const pub = room.game.snapshotPublic();
  broadcastToRoom(room, {type:'state_update', snapshot:pub});
  room.players.forEach(p => {
    const gp = room.game.players.find(x => x.id === p.id);
    if (!gp) return;
    sendToPlayer(p.id, {
      type:'private_hand',
      hand:  gp.hand.map(c=>c.toString()),
      melds: gp.melds.map(m=>m.map(c=>c.toString())),
      hasBaseSeries: gp.hasBaseSeries
    });
  });
}

function broadcastLobby(room) {
  broadcastToRoom(room, {type:'lobby_update', room:room.toLobbySummary()});
}

wss.on('connection', ws => {
  console.log('Koneksi baru');

  ws.on('message', raw => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return send(ws, {type:'error', message:'Format JSON tidak valid'}); }
    handleMessage(ws, msg);
  });

  ws.on('close', () => {
    const meta = connMeta.get(ws);
    if (!meta) return;
    const {playerId, roomCode} = meta;
    const room = roomManager.getRoom(roomCode);
    if (room) {
      const playerName = room.playerNameOf(playerId);
      if (room.status === 'PLAYING' && room.game) {
        room.game.playerDisconnect(playerId);
        room.setConnected(playerId, false);
        broadcastToRoom(room, {type:'player_disconnected', playerId, playerName});
        broadcastGameState(room);
      } else {
        room.removePlayer(playerId);
        roomManager.removeRoomIfEmpty(roomCode);
        if (roomManager.getRoom(roomCode)) broadcastLobby(room);
      }
    }
    connMeta.delete(ws);
    playerSockets.delete(playerId);
  });

  ws.on('error', err => console.error('WS error:', err.message));
});

function handleMessage(ws, msg) {
  const handlers = {
    create_room:  handleCreateRoom,
    join_room:    handleJoinRoom,
    set_ready:    handleSetReady,
    start_game:   handleStartGame,
    next_round:   handleNextRound,
    new_game:     handleNewGame,
    draw_stock:   handleDrawStock,
    draw_discard: handleDrawDiscard,
    place_meld:   handlePlaceMeld,
    discard:      handleDiscard,
    reconnect:    handleReconnect,
    leave_room:   handleLeaveRoom,
    vc_signal:    handleVcSignal
  };
  const h = handlers[msg.type];
  if (!h) return send(ws, {type:'error', message:`Tipe pesan tidak dikenal: ${msg.type}`});
  try { h(ws, msg); } catch(e) {
    console.error('Handler error:', e);
    send(ws, {type:'error', message:'Terjadi kesalahan internal server'});
  }
}

// ── LOBBY ──

function handleCreateRoom(ws, msg) {
  const playerId   = crypto.randomUUID();
  const playerName = (msg.name||'Pemain').trim().slice(0,20);
  if (!playerName) return send(ws, {type:'error', message:'Nama tidak boleh kosong'});
  const room = roomManager.createRoom(playerId, playerName, msg.options||{});
  connMeta.set(ws, {playerId, roomCode:room.code});
  playerSockets.set(playerId, ws);
  send(ws, {type:'room_created', code:room.code, playerId, room:room.toLobbySummary()});
  console.log(`Room dibuat: ${room.code} oleh ${playerName}`);
}

function handleJoinRoom(ws, msg) {
  const playerId   = crypto.randomUUID();
  const playerName = (msg.name||'Pemain').trim().slice(0,20);
  if (!playerName) return send(ws, {type:'error', message:'Nama tidak boleh kosong'});
  const code = (msg.code||'').toUpperCase().trim();
  if (!code) return send(ws, {type:'error', message:'Kode ruang tidak boleh kosong'});
  const result = roomManager.joinRoom(code, playerId, playerName);
  if (!result.success) return send(ws, {type:'error', message:result.reason});
  const room = result.room;
  connMeta.set(ws, {playerId, roomCode:room.code});
  playerSockets.set(playerId, ws);
  send(ws, {type:'room_joined', code:room.code, playerId, room:room.toLobbySummary()});
  broadcastLobby(room);
  console.log(`${playerName} bergabung ke ${room.code}`);
}

function handleSetReady(ws, msg) {
  const meta = connMeta.get(ws);
  if (!meta) return send(ws, {type:'error', message:'Sesi tidak valid'});
  const room = roomManager.getRoom(meta.roomCode);
  if (!room) return send(ws, {type:'error', message:'Ruang tidak ditemukan'});
  room.setReady(meta.playerId, !!msg.ready);
  broadcastLobby(room);
}

function handleStartGame(ws, msg) {
  const meta = connMeta.get(ws);
  if (!meta) return send(ws, {type:'error', message:'Sesi tidak valid'});
  const room = roomManager.getRoom(meta.roomCode);
  if (!room) return send(ws, {type:'error', message:'Ruang tidak ditemukan'});
  if (room.hostId !== meta.playerId) return send(ws, {type:'error', message:'Hanya host yang bisa memulai'});
  const result = room.startGame();
  if (!result.success) return send(ws, {type:'error', message:result.reason});
  broadcastToRoom(room, {type:'game_started', snapshot:result.snapshot});
  broadcastGameState(room);
  console.log(`Game dimulai di ${room.code}`);
}

function handleNextRound(ws, msg) {
  const meta = connMeta.get(ws);
  if (!meta) return;
  const room = roomManager.getRoom(meta.roomCode);
  if (!room) return;
  // Any player can request next round — host starts it
  // Reset to lobby and send lobby update so host can start
  room.returnToLobbyAfterRound();
  broadcastLobby(room);
  broadcastToRoom(room, {type:'round_prep', message:`Bersiap untuk babak berikutnya! Klik Siap Main lalu host mulai.`});
}

function handleNewGame(ws, msg) {
  const meta = connMeta.get(ws);
  if (!meta) return;
  const room = roomManager.getRoom(meta.roomCode);
  if (!room) return;
  // Reset game entirely (scores gone)
  room.game = null;
  room.returnToLobbyAfterRound();
  broadcastLobby(room);
  broadcastToRoom(room, {type:'round_prep', message:`Game baru dimulai. Skor direset. Klik Siap Main!`});
}

function handleLeaveRoom(ws, msg) {
  const meta = connMeta.get(ws);
  if (!meta) return;
  const room = roomManager.getRoom(meta.roomCode);
  if (room) {
    const name = room.playerNameOf(meta.playerId);
    room.removePlayer(meta.playerId);
    roomManager.removeRoomIfEmpty(meta.roomCode);
    if (roomManager.getRoom(meta.roomCode)) broadcastLobby(room);
    console.log(`${name} keluar dari ${meta.roomCode}`);
  }
  connMeta.delete(ws);
  playerSockets.delete(meta.playerId);
}

// ── IN-GAME ──

function _getCtx(ws) {
  const meta = connMeta.get(ws);
  if (!meta) return null;
  const room = roomManager.getRoom(meta.roomCode);
  if (!room || !room.game) return null;
  return {meta, room, game:room.game};
}

function handleDrawStock(ws, msg) {
  const ctx = _getCtx(ws);
  if (!ctx) return send(ws, {type:'error', message:'Tidak ada permainan aktif'});
  const r = ctx.game.drawFromStock(ctx.meta.playerId);
  if (!r.success) return send(ws, {type:'error', message:r.reason});
  if (r.gameOver) return _endRound(ctx.room, r);
  broadcastGameState(ctx.room);
}

function handleDrawDiscard(ws, msg) {
  const ctx = _getCtx(ws);
  if (!ctx) return send(ws, {type:'error', message:'Tidak ada permainan aktif'});
  const pos = typeof msg.positionFromTop === 'number' ? msg.positionFromTop : 0;
  const r = ctx.game.drawFromDiscard(ctx.meta.playerId, pos, msg.intendedMeld||null);
  if (!r.success) return send(ws, {type:'error', message:r.reason});
  broadcastGameState(ctx.room);
}

function handlePlaceMeld(ws, msg) {
  const ctx = _getCtx(ws);
  if (!ctx) return send(ws, {type:'error', message:'Tidak ada permainan aktif'});
  if (!Array.isArray(msg.cardIds)||msg.cardIds.length<3) return send(ws, {type:'error', message:'Minimal 3 kartu untuk kombinasi'});
  const r = ctx.game.placeMeld(ctx.meta.playerId, msg.cardIds);
  if (!r.success) return send(ws, {type:'error', message:r.reason});
  broadcastGameState(ctx.room);
}

function handleDiscard(ws, msg) {
  const ctx = _getCtx(ws);
  if (!ctx) return send(ws, {type:'error', message:'Tidak ada permainan aktif'});
  if (!msg.cardId) return send(ws, {type:'error', message:'Pilih kartu yang ingin dibuang'});
  const r = ctx.game.discard(ctx.meta.playerId, msg.cardId, !!msg.attemptClose);
  if (!r.success) return send(ws, {type:'error', message:r.reason});
  if (r.gameOver) return _endRound(ctx.room, r);
  broadcastGameState(ctx.room);
}

function _endRound(room, result) {
  const enriched = (result.roundScores||[]).map(rs => ({...rs, playerName:room.playerNameOf(rs.playerId)}));
  broadcastToRoom(room, {
    type:'round_over',
    winner:result.winner, winnerName:result.winnerName, stockEmpty:result.stockEmpty,
    roundScores:enriched, totalScores:result.totalScores,
    roundHistory:result.roundHistory || []
  });
  broadcastGameState(room);
  // Move room back to lobby state so players can ready up for next round
  room.returnToLobbyAfterRound();
  console.log(`Putaran selesai di ${room.code}. Pemenang: ${result.winnerName||'(stock habis)'}`);
}

function handleReconnect(ws, msg) {
  if (!msg.playerId||!msg.code) return send(ws, {type:'error', message:'playerId dan code diperlukan'});
  const room = roomManager.getRoom(msg.code);
  if (!room) return send(ws, {type:'error', message:'Ruang tidak ditemukan'});
  if (!room.players.some(p=>p.id===msg.playerId)) return send(ws, {type:'error', message:'Pemain tidak ditemukan'});
  if (room.game) {
    const r = room.game.playerReconnect(msg.playerId);
    if (!r.success) return send(ws, {type:'error', message:r.reason});
  }
  room.setConnected(msg.playerId, true);
  connMeta.set(ws, {playerId:msg.playerId, roomCode:room.code});
  playerSockets.set(msg.playerId, ws);
  const name = room.playerNameOf(msg.playerId);
  send(ws, {type:'reconnected', room:room.toLobbySummary(), snapshot:room.game?room.game.snapshotForPlayer(msg.playerId):null});
  broadcastToRoom(room, {type:'player_reconnected', playerId:msg.playerId, playerName:name}, msg.playerId);
  if (room.game) broadcastGameState(room);
  console.log(`${name} reconnect ke ${room.code}`);
}

function handleVcSignal(ws, msg) {
  const meta = connMeta.get(ws);
  if (!meta) return;
  const room = roomManager.getRoom(meta.roomCode);
  if (!room) return;
  const payload = {type:'vc_signal', action:msg.action, fromId:meta.playerId, toId:msg.toId||null, sdp:msg.sdp||null, candidate:msg.candidate||null};
  if (msg.toId) sendToPlayer(msg.toId, payload);
  else broadcastToRoom(room, payload, meta.playerId);
}

setInterval(() => {
  const n = roomManager.cleanupIdleRooms();
  if (n > 0) console.log(`Bersihkan ${n} room idle`);
}, 5 * 60 * 1000);

module.exports = {wss, roomManager};
