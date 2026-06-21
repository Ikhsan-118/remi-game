/**
 * RoomManager.js
 * =====================================================
 * Mengelola siklus hidup "Ruang Permainan" (Room).
 *
 * PERBAIKAN:
 *  ✓ FIX: Reset ready semua pemain saat pemain baru bergabung
 *         (mencegah game mulai dengan 1 orang yang sudah "siap" dari sebelumnya)
 *  ✓ FIX: startGame() meneruskan map nama pemain ke GameState
 *  ✓ FIX: canStart tidak bisa true jika ada pemain yang belum siap (strict check)
 *  ✓ FIX: Lebih jelas tracking status koneksi saat game berlangsung
 */

const { GameState } = require('../engine/GameState');

// Karakter InviteCode — hindari 0/O dan 1/I yang membingungkan
const CODE_CHARS        = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CODE_LENGTH       = 5;
const MAX_PLAYERS       = 4;
const MIN_PLAYERS       = 2;
const ROOM_IDLE_TIMEOUT = 30 * 60 * 1000; // 30 menit → dihapus

class Room {
  constructor(code, hostId, hostName, options = {}) {
    this.code     = code;
    this.hostId   = hostId;
    this.status   = 'LOBBY';   // 'LOBBY' | 'PLAYING' | 'FINISHED'
    this.options  = {
      useJokers:  options.useJokers  ?? false,
      mode:       options.mode       ?? 'traditional',
      maxPlayers: options.maxPlayers ?? 4
    };
    this.players      = [{ id: hostId, name: hostName, ready: false, connected: true, socketId: null }];
    this.game         = null;
    this.createdAt    = Date.now();
    this.lastActivity = Date.now();
  }

  touch() { this.lastActivity = Date.now(); }

  get playerCount() { return this.players.length; }
  get isFull()      { return this.playerCount >= this.options.maxPlayers; }

  /** 
   * canStart: cukup minimal pemain, semua sudah siap, dan masih di lobby.
   * FIX: sebelumnya tidak cek apakah semua sudah siap (allReady).
   */
  get canStart() {
    return (
      this.playerCount >= MIN_PLAYERS &&
      this.status === 'LOBBY' &&
      this.players.every(p => p.ready)
    );
  }

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

    // FIX: Reset ready semua pemain saat ada pemain baru bergabung
    // Ini mencegah skenario: 2 pemain siap → 1 keluar → 1 baru join → host langsung mulai
    this.players.forEach(p => { p.ready = false; });

    this.players.push({ id: playerId, name: playerName, ready: false, connected: true, socketId: null });
    this.touch();
    return { success: true };
  }

  removePlayer(playerId) {
    this.players = this.players.filter(p => p.id !== playerId);

    // Pindah host ke pemain pertama yang tersisa
    if (this.players.length > 0 && this.hostId === playerId) {
      this.hostId = this.players[0].id;
    }

    // FIX: Reset ready semua pemain yang tersisa saat ada yang keluar
    // Ini memastikan game tidak bisa dimulai tanpa konfirmasi ulang
    if (this.status === 'LOBBY') {
      this.players.forEach(p => { p.ready = false; });
    }

    this.touch();
  }

  setReady(playerId, ready) {
    const p = this.players.find(p => p.id === playerId);
    if (p) { p.ready = ready; }
    this.touch();
  }

  setConnected(playerId, connected) {
    const p = this.players.find(p => p.id === playerId);
    if (p) { p.connected = connected; }
    this.touch();
  }

  /**
   * Mulai game: buat GameState dengan map nama pemain.
   * FIX: teruskan playerNames ke GameState agar nama muncul di snapshot.
   */
  startGame() {
    if (this.playerCount < MIN_PLAYERS) {
      return { success: false, reason: `Minimal ${MIN_PLAYERS} pemain untuk mulai` };
    }
    if (this.status !== 'LOBBY') {
      return { success: false, reason: 'Permainan sudah berjalan atau sudah selesai' };
    }
    if (!this.players.every(p => p.ready)) {
      return { success: false, reason: 'Semua pemain harus siap sebelum memulai permainan' };
    }

    // FIX: Buat map id → nama untuk diteruskan ke GameState
    const playerIds   = this.players.map(p => p.id);
    const playerNames = {};
    this.players.forEach(p => { playerNames[p.id] = p.name; });

    this.game   = new GameState(playerIds, playerNames, {
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
      code:     this.code,
      status:   this.status,
      hostId:   this.hostId,
      options:  this.options,
      players:  this.players.map(p => ({
        id:        p.id,
        name:      p.name,
        ready:     p.ready,
        connected: p.connected,
        isHost:    p.id === this.hostId
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
    const room = this.rooms.get((code || '').toUpperCase().trim());
    if (room && room.players.length === 0) {
      this.rooms.delete((code || '').toUpperCase().trim());
      return true;
    }
    return false;
  }

  /** Hapus room yang sudah idle terlalu lama */
  cleanupIdleRooms() {
    const now = Date.now();
    let removed = 0;
    for (const [code, room] of this.rooms.entries()) {
      if (now - room.lastActivity > ROOM_IDLE_TIMEOUT) {
        this.rooms.delete(code);
        removed++;
      }
    }
    return removed;
  }

  get totalRooms() { return this.rooms.size; }
}

module.exports = { RoomManager, Room, MAX_PLAYERS, MIN_PLAYERS };
