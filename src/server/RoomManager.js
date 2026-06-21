/**
 * RoomManager.js
 * =====================================================
 * Kelola room & InviteCode untuk Remi Indonesia.
 *
 * FIX KRITIS: File ini sebelumnya berisi duplikat dari server.js
 * (bukan class RoomManager), sehingga `const { RoomManager } =
 * require('./RoomManager')` di server.js menghasilkan `undefined`
 * dan `new RoomManager()` crash saat server start — itulah sebabnya
 * server tidak pernah listen dan client tidak bisa connect sama sekali.
 * Sekarang file ini berisi implementasi RoomManager & Room yang benar.
 *
 * Tanggung jawab:
 *  - Membuat room baru dengan kode undangan unik (5 karakter)
 *  - Join room berdasarkan kode
 *  - Kelola status ready / start game / kembali ke lobby setelah round
 *  - Bersihkan room yang sudah kosong atau idle terlalu lama
 */

const crypto = require('crypto');
const { GameState, MIN_PLAYERS, MAX_PLAYERS } = require('../engine/GameState');

const CODE_CHARS    = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // tanpa I/O/0/1 biar tidak ambigu
const CODE_LENGTH   = 5;
const IDLE_TIMEOUT  = 30 * 60 * 1000; // 30 menit tanpa aktivitas → dianggap idle

function generateCode() {
  let code = '';
  for (let i = 0; i < CODE_LENGTH; i++) {
    code += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
  }
  return code;
}

// ─────────────────────────────────────────────────────
// Room
// ─────────────────────────────────────────────────────

class Room {
  constructor(code, hostId, hostName, options = {}) {
    this.code    = code;
    this.hostId  = hostId;
    this.status  = 'LOBBY'; // LOBBY | PLAYING
    this.options = {
      mode:       options.mode       || 'traditional',
      useJokers:  options.useJokers  ?? true,
      maxPlayers: Math.min(Math.max(options.maxPlayers || 4, MIN_PLAYERS), MAX_PLAYERS)
    };

    this.players = [{
      id:        hostId,
      name:      hostName,
      ready:     false,
      isHost:    true,
      connected: true
    }];

    this.game        = null;
    this.lastActivity = Date.now();
  }

  touch() {
    this.lastActivity = Date.now();
  }

  playerNameOf(playerId) {
    const p = this.players.find(p => p.id === playerId);
    return p ? p.name : playerId;
  }

  addPlayer(playerId, playerName) {
    if (this.players.some(p => p.id === playerId)) {
      return { success: false, reason: 'Pemain sudah ada di room ini' };
    }
    if (this.status !== 'LOBBY') {
      return { success: false, reason: 'Permainan sudah dimulai, tidak bisa bergabung' };
    }
    if (this.players.length >= this.options.maxPlayers) {
      return { success: false, reason: `Room penuh (maksimal ${this.options.maxPlayers} pemain)` };
    }

    this.players.push({
      id:        playerId,
      name:      playerName,
      ready:     false,
      isHost:    false,
      connected: true
    });
    this.touch();
    return { success: true };
  }

  removePlayer(playerId) {
    this.players = this.players.filter(p => p.id !== playerId);

    // Jika host keluar, pindahkan status host ke pemain berikutnya
    if (this.players.length > 0 && !this.players.some(p => p.isHost)) {
      this.players[0].isHost = true;
      this.hostId             = this.players[0].id;
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
    this.touch();

    if (this.players.length < MIN_PLAYERS) {
      return { success: false, reason: `Minimal ${MIN_PLAYERS} pemain untuk memulai` };
    }

    // Melanjutkan game yang sudah ada (mis. setelah round_over) → skor tetap
    if (this.game) {
      const playerIds = this.players.map(p => p.id);
      const sameRoster = playerIds.length === this.game.players.length &&
        playerIds.every(id => this.game.players.some(gp => gp.id === id));

      if (!sameRoster) {
        // Roster berubah → mulai game baru dari nol
        this.game = null;
      } else {
        if (!this.players.every(p => p.ready)) {
          return { success: false, reason: 'Semua pemain harus siap (ready) dulu' };
        }
        const snapshot = this.game.startNextRound();
        this.status = 'PLAYING';
        return { success: true, snapshot, continued: true };
      }
    }

    if (!this.players.every(p => p.ready)) {
      return { success: false, reason: 'Semua pemain harus siap (ready) dulu' };
    }

    const playerIds   = this.players.map(p => p.id);
    const playerNames = {};
    this.players.forEach(p => { playerNames[p.id] = p.name; });

    this.game = new GameState(playerIds, playerNames, {
      useJokers: this.options.useJokers,
      mode:      this.options.mode
    });

    const snapshot = this.game.startRound();
    this.status = 'PLAYING';

    return { success: true, snapshot, continued: false };
  }

  /**
   * Dipanggil setelah satu putaran selesai (round_over) — kembalikan
   * room ke status LOBBY dan reset status "siap" semua pemain, supaya
   * host bisa menekan "Mulai Permainan" lagi untuk lanjut (skor
   * akumulasi tetap dipertahankan di this.game.scores) atau pemain
   * keluar dari room sepenuhnya.
   */
  returnToLobbyAfterRound() {
    this.status = 'LOBBY';
    this.players.forEach(p => { p.ready = false; });
    this.touch();
  }

  toLobbySummary() {
    return {
      code:    this.code,
      hostId:  this.hostId,
      status:  this.status,
      options: this.options,
      players: this.players.map(p => ({
        id:        p.id,
        name:      p.name,
        ready:     p.ready,
        isHost:    p.isHost,
        connected: p.connected
      }))
    };
  }
}

// ─────────────────────────────────────────────────────
// RoomManager
// ─────────────────────────────────────────────────────

class RoomManager {
  constructor() {
    this.rooms = new Map(); // code → Room
  }

  _generateUniqueCode() {
    let code;
    let attempts = 0;
    do {
      code = generateCode();
      attempts++;
    } while (this.rooms.has(code) && attempts < 50);
    return code;
  }

  createRoom(hostId, hostName, options = {}) {
    const code = this._generateUniqueCode();
    const room = new Room(code, hostId, hostName, options);
    this.rooms.set(code, room);
    return room;
  }

  joinRoom(code, playerId, playerName) {
    const room = this.rooms.get(code);
    if (!room) {
      return { success: false, reason: 'Kode ruang tidak ditemukan' };
    }
    const result = room.addPlayer(playerId, playerName);
    if (!result.success) {
      return result;
    }
    return { success: true, room };
  }

  getRoom(code) {
    return this.rooms.get(code) || null;
  }

  removeRoomIfEmpty(code) {
    const room = this.rooms.get(code);
    if (room && room.players.length === 0) {
      this.rooms.delete(code);
      return true;
    }
    return false;
  }

  /** Hapus room yang tidak ada aktivitas lebih dari IDLE_TIMEOUT */
  cleanupIdleRooms() {
    const now = Date.now();
    let removed = 0;
    for (const [code, room] of this.rooms.entries()) {
      if (now - room.lastActivity > IDLE_TIMEOUT) {
        this.rooms.delete(code);
        removed++;
      }
    }
    return removed;
  }
}

module.exports = { RoomManager, Room };
