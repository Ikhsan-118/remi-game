/**
 * RoomManager.js
 * =====================================================
 * Mengelola siklus hidup "Ruang Permainan" (Room):
 *  - Generate InviteCode unik (mudah dibaca, mudah diketik)
 *  - Mapping roomCode → GameState + daftar pemain
 *  - Validasi join (kapasitas, status, duplikat nama)
 *  - Auto-cleanup room yang sudah lama tidak aktif
 */

const { GameState } = require('../engine/GameState');

// Karakter yang dipakai untuk InviteCode — hindari 0/O dan 1/I yang membingungkan
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 5;
const MAX_PLAYERS = 4;
const MIN_PLAYERS = 2;
const ROOM_IDLE_TIMEOUT_MS = 30 * 60 * 1000; // 30 menit tanpa aktivitas → dibersihkan

class Room {
  constructor(code, hostId, hostName, options = {}) {
    this.code        = code;
    this.hostId      = hostId;
    this.status       = 'LOBBY';   // LOBBY | PLAYING | FINISHED
    this.options      = {
      useJokers:      options.useJokers ?? false,
      mode:           options.mode ?? 'traditional',
      maxPlayers:     options.maxPlayers ?? 4,
    };
    this.players      = [{ id: hostId, name: hostName, ready: false, connected: true, socketId: null }];
    this.game         = null;       // GameState instance, dibuat saat startGame()
    this.createdAt    = Date.now();
    this.lastActivity = Date.now();
  }

  touch() { this.lastActivity = Date.now(); }

  get playerCount() { return this.players.length; }
  get isFull()       { return this.playerCount >= this.options.maxPlayers; }
  get canStart()     { return this.playerCount >= MIN_PLAYERS && this.status === 'LOBBY'; }

  addPlayer(playerId, playerName) {
    if (this.status !== 'LOBBY') {
      return { success: false, reason: 'Permainan sudah dimulai, tidak bisa bergabung' };
    }
    if (this.isFull) {
      return { success: false, reason: `Ruang penuh (maksimal ${this.options.maxPlayers} pemain)` };
    }
    if (this.players.some(p => p.name.toLowerCase() === playerName.toLowerCase())) {
      return { success: false, reason: 'Nama sudah digunakan pemain lain di ruang ini' };
    }
    this.players.push({ id: playerId, name: playerName, ready: false, connected: true, socketId: null });
    this.touch();
    return { success: true };
  }

  removePlayer(playerId) {
    this.players = this.players.filter(p => p.id !== playerId);
    if (this.players.length > 0 && this.hostId === playerId) {
      this.hostId = this.players[0].id; // pindah host ke pemain berikutnya
    }
    this.touch();
  }

  setReady(playerId, ready) {
    const p = this.players.find(p => p.id === playerId);
    if (p) p.ready = ready;
    this.touch();
  }

  setConnected(playerId, connected) {
    const p = this.players.find(p => p.id === playerId);
    if (p) p.connected = connected;
    this.touch();
  }

  startGame() {
    if (!this.canStart) {
      return { success: false, reason: `Minimal ${MIN_PLAYERS} pemain untuk mulai` };
    }
    const playerIds = this.players.map(p => p.id);
    this.game = new GameState(playerIds, {
      useJokers: this.options.useJokers,
      mode:      this.options.mode
    });
    this.status = 'PLAYING';
    this.touch();
    return { success: true, snapshot: this.game.startRound() };
  }

  playerNameOf(playerId) {
    return this.players.find(p => p.id === playerId)?.name ?? playerId;
  }

  toLobbySummary() {
    return {
      code:       this.code,
      status:     this.status,
      hostId:     this.hostId,
      options:    this.options,
      players:    this.players.map(p => ({
        id: p.id, name: p.name, ready: p.ready, connected: p.connected,
        isHost: p.id === this.hostId
      }))
    };
  }
}

class RoomManager {
  constructor() {
    this.rooms = new Map(); // code → Room
  }

  _generateCode() {
    let code;
    do {
      code = Array.from({ length: CODE_LENGTH }, () =>
        CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)]
      ).join('');
    } while (this.rooms.has(code));
    return code;
  }

  createRoom(hostId, hostName, options = {}) {
    const code = this._generateCode();
    const room = new Room(code, hostId, hostName, options);
    this.rooms.set(code, room);
    return room;
  }

  getRoom(code) {
    return this.rooms.get((code || '').toUpperCase().trim());
  }

  joinRoom(code, playerId, playerName) {
    const room = this.getRoom(code);
    if (!room) {
      return { success: false, reason: `Kode ruang "${code}" tidak ditemukan` };
    }
    const result = room.addPlayer(playerId, playerName);
    if (!result.success) return result;
    return { success: true, room };
  }

  removeRoomIfEmpty(code) {
    const room = this.rooms.get(code);
    if (room && room.players.length === 0) {
      this.rooms.delete(code);
      return true;
    }
    return false;
  }

  /** Bersihkan room yang sudah idle terlalu lama (jalankan via setInterval) */
  cleanupIdleRooms() {
    const now = Date.now();
    let removed = 0;
    for (const [code, room] of this.rooms.entries()) {
      if (now - room.lastActivity > ROOM_IDLE_TIMEOUT_MS) {
        this.rooms.delete(code);
        removed++;
      }
    }
    return removed;
  }

  get totalRooms() { return this.rooms.size; }
}

module.exports = { RoomManager, Room, MAX_PLAYERS, MIN_PLAYERS };