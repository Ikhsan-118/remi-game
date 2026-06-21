/**
 * RoomManager.js
 * =====================================================
 * Mengelola siklus hidup "Ruang Permainan" (Room).
 *
 * UPDATE v3:
 *  ✓ NEW: MAX_PLAYERS dinaikkan dari 4 → 8 (mendukung dek ganda di GameState/Deck)
 *  ✓ NEW: options.maxPlayers dari client kini di-clamp ke [MIN_PLAYERS, MAX_PLAYERS]
 *  ✓ NEW: startGame() bisa melanjutkan match yang sama (skor akumulasi tetap)
 *         jika daftar pemain belum berubah sejak putaran sebelumnya — ini yang
 *         membuat "game bisa mulai lagi" setelah round_over, bukan hanya berhenti.
 *         Jika daftar pemain berubah (ada yang keluar/masuk), match baru dibuat
 *         dan skor akumulasi di-reset.
 *
 * (fix versi sebelumnya tetap dipertahankan)
 *  ✓ Reset ready semua pemain saat pemain baru bergabung
 *  ✓ startGame() meneruskan map nama pemain ke GameState
 *  ✓ canStart tidak bisa true jika ada pemain yang belum siap (strict check)
 *  ✓ Lebih jelas tracking status koneksi saat game berlangsung
 */

const { GameState, MIN_PLAYERS: ENGINE_MIN_PLAYERS, MAX_PLAYERS: ENGINE_MAX_PLAYERS } = require('../engine/GameState');

// Karakter InviteCode — hindari 0/O dan 1/I yang membingungkan
const CODE_CHARS        = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CODE_LENGTH       = 5;
const MAX_PLAYERS       = ENGINE_MAX_PLAYERS || 8; // mendukung 2-8 pemain (dek ganda otomatis di atas 4 pemain)
const MIN_PLAYERS       = ENGINE_MIN_PLAYERS || 2;
const ROOM_IDLE_TIMEOUT = 30 * 60 * 1000; // 30 menit → dihapus

class Room {
  constructor(code, hostId, hostName, options = {}) {
    this.code     = code;
    this.hostId   = hostId;
    this.status   = 'LOBBY';   // 'LOBBY' | 'PLAYING' | 'FINISHED'
    this.options  = {
      useJokers:  options.useJokers  ?? false,
      mode:       options.mode       ?? 'traditional',
      // Clamp ke rentang yang didukung engine (2-8 pemain)
      maxPlayers: Math.min(Math.max(Number(options.maxPlayers) || 4, MIN_PLAYERS), MAX_PLAYERS)
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

    // Reset ready semua pemain saat ada pemain baru bergabung
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

    // Reset ready semua pemain yang tersisa saat ada yang keluar
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
   * Apakah daftar pemain (set of id) masih sama persis dengan saat
   * `this.game` terakhir dibuat? Dipakai untuk menentukan apakah putaran
   * baru bisa melanjutkan match yang sama (skor akumulasi) atau harus
   * membuat GameState baru (skor reset).
   */
  _sameRosterAsGame() {
    if (!this.game) return false;
    const currentIds = this.players.map(p => p.id).sort();
    const gameIds     = this.game.players.map(p => p.id).sort();
    if (currentIds.length !== gameIds.length) return false;
    return currentIds.every((id, i) => id === gameIds[i]);
  }

  /**
   * Mulai (atau lanjutkan) permainan.
   *
   *  - Jika belum pernah ada game di room ini, ATAU daftar pemain sudah
   *    berubah sejak putaran terakhir → buat GameState baru (skor reset).
   *  - Jika game sebelumnya sudah GAME_OVER dan daftar pemain masih sama
   *    persis → lanjutkan match yang sama dengan `startNextRound()`,
   *    sehingga skor akumulasi (this.game.scores) tetap terbawa.
   *
   *  Ini yang memungkinkan "game bisa mulai lagi" setelah stock habis /
   *  ada pemenang, alih-alih room menjadi permanen tidak bisa dipakai lagi.
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

    const canContinueMatch = this.game && this._sameRosterAsGame();

    if (canContinueMatch) {
      this.status = 'PLAYING';
      this.touch();
      return { success: true, snapshot: this.game.startNextRound(), continued: true };
    }

    // Match baru (pertama kali, atau roster berubah → skor reset)
    const playerIds   = this.players.map(p => p.id);
    const playerNames = {};
    this.players.forEach(p => { playerNames[p.id] = p.name; });

    this.game   = new GameState(playerIds, playerNames, {
      useJokers: this.options.useJokers,
      mode:      this.options.mode
    });
    this.status = 'PLAYING';
    this.touch();

    return { success: true, snapshot: this.game.startRound(), continued: false };
  }

  /**
   * Dipanggil saat sebuah putaran berakhir (round_over). Mengembalikan room
   * ke status LOBBY dan mereset status "siap" semua pemain, sehingga host
   * bisa memilih untuk memulai putaran baru (lanjut) atau membiarkan room
   * berakhir begitu saja (pemain keluar satu-satu / room idle dihapus).
   */
  returnToLobbyAfterRound() {
    this.status = 'LOBBY';
    this.players.forEach(p => { p.ready = false; });
    this.touch();
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
