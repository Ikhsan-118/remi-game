/**
 * GameState.js
 * =====================================================
 * State machine untuk satu sesi permainan Remi Indonesia.
 *
 * UPDATE v3 — perbaikan bug & fitur baru:
 *
 *  ✓ FIX BUG #1 (Stock habis tidak menghentikan game):
 *    Sebelumnya, game hanya berakhir kalau seorang pemain BENAR-BENAR
 *    mencoba `drawFromStock()` saat stock = 0. Akibatnya jika pemain
 *    berikutnya memilih makan dari discard pile, game terus berjalan
 *    tanpa batas walau stock sudah kosong.
 *    Sekarang: begitu giliran berpindah (`_nextTurn`) dan stock sudah
 *    0 kartu, putaran otomatis diakhiri & skor langsung dihitung —
 *    tidak menunggu aksi draw apa pun dari pemain berikutnya.
 *
 *  ✓ NEW FITUR #2 (Batas kedalaman "Makan Buangan" berdasar jumlah pemain):
 *    - 2–3 pemain  → tidak ada batas (seperti sebelumnya)
 *    - 4 pemain    → maksimal 5 kartu teratas tumpukan buangan
 *    - Setiap +1 pemain di atas 4 → +1 kartu teratas yang boleh diambil
 *      (5 pemain → 6, 6 pemain → 7, 7 pemain → 8, 8 pemain → 9)
 *    Batas ini dihitung sebagai `this.maxEatDepth` dan diteruskan ke
 *    `validateEat()` serta disertakan dalam snapshot publik agar
 *    client bisa menampilkannya di UI.
 *
 *  ✓ NEW FITUR #3 (Dukungan 2–8 pemain & dek ganda):
 *    - 2–4 pemain → 1 dek (52 kartu + 2 Joker jika diaktifkan)
 *    - 5–8 pemain → 2 dek digabung (104 kartu + 4 Joker jika diaktifkan)
 *    Lihat `Deck.js` untuk implementasi penggabungan dek.
 *
 *  (fix versi sebelumnya tetap dipertahankan)
 *  ✓ Pemain pertama dipilih secara acak
 *  ✓ Tracking drewFromDiscard per pemain
 *  ✓ Phase state machine yang lebih jelas
 *  ✓ Nama pemain disertakan dalam snapshot
 *  ✓ canCloseGame dipanggil dengan drewFromDiscard yang benar
 *  ✓ snapshotPublic() menyertakan discardPileFull & discardCount
 */

const { Deck }                               = require('../models/Deck');
const { validateMeld, validateEat, isJoker } = require('./MeldingValidator');
const { calculateRoundScores, canCloseGame } = require('./ScoreCalculator');

const PHASES = {
  WAITING:   'WAITING',
  DRAW:      'DRAW',
  MELD:      'MELD',
  GAME_OVER: 'GAME_OVER'
};

const MIN_PLAYERS = 2;
const MAX_PLAYERS = 8;

class GameState {
  /**
   * @param {string[]} playerIds   — array ID pemain (2–8 orang)
   * @param {object}   playerNames — map { id: nama } untuk tampilan
   * @param {object}   options
   *   @param {boolean} options.useJokers     — gunakan joker?
   *   @param {string}  options.mode          — 'traditional' | 'tournament'
   */
  constructor(playerIds, playerNames = {}, options = {}) {
    if (playerIds.length < MIN_PLAYERS || playerIds.length > MAX_PLAYERS) {
      throw new Error(`Remi Indonesia dimainkan oleh ${MIN_PLAYERS}–${MAX_PLAYERS} pemain`);
    }

    this.useJokers = options.useJokers ?? false;
    this.mode      = options.mode      ?? 'traditional';

    this.phase          = PHASES.WAITING;
    this.round          = 1;
    this.currentTurnIdx = 0;
    this.stockPile      = [];
    this.discardPile    = [];

    this.players = playerIds.map(id => ({
      id,
      name:            playerNames[id] || id,
      hand:            [],
      melds:           [],
      hasBaseSeries:   false,
      connected:       true,
      disconnectedAt:  null,
      drewFromDiscard: false
    }));

    // NEW: jumlah dek 52-kartu yang digabung. >4 pemain butuh lebih banyak
    // kartu daripada yang tersedia di 1 dek (52 kartu), jadi pakai 2 dek
    // (104 kartu + 4 Joker jika diaktifkan).
    this.deckCount = this.players.length > 4 ? 2 : 1;

    // NEW: batas kedalaman pengambilan dari discard pile ("Makan Buangan").
    this.maxEatDepth = this._computeMaxEatDepth(this.players.length);

    this.log    = [];
    this.scores = {};
    playerIds.forEach(id => { this.scores[id] = 0; });
  }

  // ────────────────────────────────────────────────────
  // Setup
  // ────────────────────────────────────────────────────

  /**
   * Hitung batas kedalaman "Makan Buangan" berdasarkan jumlah pemain.
   *   - < 4 pemain  → tidak terbatas
   *   - >= 4 pemain → 5 kartu teratas, +1 per pemain tambahan di atas 4
   */
  _computeMaxEatDepth(playerCount) {
    if (playerCount < 4) return Infinity;
    return 5 + (playerCount - 4);
  }

  startRound() {
    const deck = new Deck(this.useJokers, this.deckCount);
    deck.shuffle();

    const hands = deck.deal(this.players.length, 7);
    this.players.forEach((p, i) => {
      p.hand            = hands[i];
      p.melds           = [];
      p.hasBaseSeries   = false;
      p.drewFromDiscard = false;
    });

    this.stockPile   = [...deck.cards];
    this.discardPile = [this.stockPile.shift()];

    this.currentTurnIdx = Math.floor(Math.random() * this.players.length);
    this.phase          = PHASES.DRAW;

    this._log('SYSTEM', `Putaran ${this.round} dimulai (${this.players.length} pemain, ${this.deckCount} dek). Giliran pertama: ${this.currentPlayer.name}`);
    return this.snapshotPublic();
  }

  // ────────────────────────────────────────────────────
  // Getters
  // ────────────────────────────────────────────────────

  get currentPlayer() { return this.players[this.currentTurnIdx]; }

  get topDiscard() {
    return this.discardPile.length > 0
      ? this.discardPile[this.discardPile.length - 1]
      : null;
  }

  // ────────────────────────────────────────────────────
  // Fase DRAW
  // ────────────────────────────────────────────────────

  drawFromStock(playerId) {
    const check = this._phaseCheck(playerId, PHASES.DRAW);
    if (!check.ok) return { success: false, card: null, reason: check.reason };

    if (this.stockPile.length === 0) {
      return this._triggerStockEmpty();
    }

    const card = this.stockPile.shift();
    this.currentPlayer.hand.push(card);
    this.currentPlayer.drewFromDiscard = false;
    this.phase = PHASES.MELD;

    this._log(playerId, `Ambil dari stock: ${card}`);
    return { success: true, card, reason: 'OK' };
  }

  drawFromDiscard(playerId, positionFromTop, intendedMeld) {
    const check = this._phaseCheck(playerId, PHASES.DRAW);
    if (!check.ok) return { success: false, reason: check.reason };

    const player     = this.currentPlayer;
    const discardLen = this.discardPile.length;

    if (discardLen === 0) {
      return { success: false, reason: 'Discard pile kosong' };
    }
    if (positionFromTop < 0 || positionFromTop >= discardLen) {
      return { success: false, reason: 'Posisi tidak tersedia di discard pile' };
    }

    const targetIdx  = discardLen - 1 - positionFromTop;
    const targetCard = this.discardPile[targetIdx];

    // NEW: validateEat sekarang juga menerima this.maxEatDepth dan akan
    // menolak posisi yang melebihi batas pengambilan buangan berdasarkan
    // jumlah pemain di meja (lihat _computeMaxEatDepth()).
    const eatCheck = validateEat(
      targetCard,
      positionFromTop,
      player.hand,
      player.hasBaseSeries,
      this.maxEatDepth
    );

    if (!eatCheck.allowed) {
      return { success: false, reason: eatCheck.reason };
    }

    const pickedCards = this.discardPile.splice(targetIdx);
    player.hand.push(...pickedCards);

    player.drewFromDiscard = true;
    this.phase = PHASES.MELD;

    this._log(playerId, `Makan kartu ${targetCard} (posisi ${positionFromTop} dari atas), total ${pickedCards.length} kartu masuk`);
    return { success: true, pickedCards, requiredMeld: eatCheck.requiredMeld, reason: 'OK' };
  }

  // ────────────────────────────────────────────────────
  // Fase MELD
  // ────────────────────────────────────────────────────

  placeMeld(playerId, cardIds) {
    const check = this._phaseCheck(playerId, PHASES.MELD);
    if (!check.ok) return { success: false, reason: check.reason };

    const player = this.currentPlayer;
    const cards  = this._extractCardsFromHand(player, cardIds);

    if (!cards) {
      return { success: false, reason: 'Satu atau lebih kartu tidak ditemukan di tangan pemain' };
    }

    const result = validateMeld(cards, player.hasBaseSeries);
    if (!result.valid) {
      return { success: false, reason: result.reason };
    }

    player.melds.push(cards);
    player.hand = player.hand.filter(c => !cardIds.includes(c.id));

    if (!player.hasBaseSeries && (result.type === 'SERI_ANGKA' || result.type === 'SERI_GAMBAR')) {
      player.hasBaseSeries = true;
      this._log(playerId, `✓ Dasar seri terpenuhi: [${cards.map(c => c.toString()).join('-')}]`);
    }

    this._log(playerId, `Letakkan ${result.type}: [${cards.map(c => c.toString()).join('-')}]`);
    return { success: true, type: result.type, cards, reason: 'OK' };
  }

  // ────────────────────────────────────────────────────
  // Buang Kartu + Cek Tutup Game
  // ────────────────────────────────────────────────────

  discard(playerId, cardId, attemptClose = false) {
    const check = this._phaseCheck(playerId, PHASES.MELD);
    if (!check.ok) return { success: false, reason: check.reason };

    const player  = this.currentPlayer;
    const cardIdx = player.hand.findIndex(c => c.id === cardId);

    if (cardIdx === -1) {
      return { success: false, reason: `Kartu ${cardId} tidak ada di tangan pemain` };
    }

    const card      = player.hand[cardIdx];
    const afterHand = player.hand.filter((_, i) => i !== cardIdx);

    if (attemptClose) {
      const closeCheck = canCloseGame(
        player.melds,
        afterHand,
        player.drewFromDiscard,
        player.hasBaseSeries
      );

      if (!closeCheck.canClose) {
        return { success: false, reason: closeCheck.reason };
      }

      player.hand = [];
      this.discardPile.push(card);
      this._log(playerId, `🏆 TUTUP GAME dengan kartu: ${card}`);
      return this._endRound(playerId, card);
    }

    player.hand = afterHand;
    this.discardPile.push(card);
    this._log(playerId, `Buang: ${card}`);

    this._nextTurn();

    // FIX BUG #1: jika stock pile sudah kosong begitu giliran berikutnya
    // dimulai, akhiri putaran SEKARANG — jangan menunggu pemain berikutnya
    // mencoba draw_stock (yang bisa dihindari dengan memilih draw_discard
    // sehingga game berjalan tanpa akhir).
    if (this.stockPile.length === 0) {
      return this._triggerStockEmpty();
    }

    return { success: true, card, reason: 'OK' };
  }

  // ────────────────────────────────────────────────────
  // Reconnect
  // ────────────────────────────────────────────────────

  playerDisconnect(playerId) {
    const p = this.players.find(p => p.id === playerId);
    if (p) {
      p.connected      = false;
      p.disconnectedAt = Date.now();
    }
  }

  playerReconnect(playerId) {
    const p = this.players.find(p => p.id === playerId);
    if (!p) return { success: false, reason: 'Pemain tidak ditemukan' };

    const elapsed = (Date.now() - (p.disconnectedAt || 0)) / 1000;
    if (elapsed > 60) {
      return { success: false, reason: 'Waktu reconnect (60 detik) sudah habis' };
    }

    p.connected      = true;
    p.disconnectedAt = null;
    return { success: true, state: this.snapshotForPlayer(playerId) };
  }

  // ────────────────────────────────────────────────────
  // Snapshot
  // ────────────────────────────────────────────────────

  /**
   * Snapshot publik yang diperluas — dikirim ke semua pemain via state_update.
   *
   * Menyertakan discardPileFull (seluruh tumpukan buangan, urutan bawah→atas)
   * dan discardCount untuk badge pada UI client, serta `maxEatDepth` /
   * `deckCount` agar client dapat menampilkan batas & konteks permainan.
   */
  snapshotPublic() {
    return {
      phase:            this.phase,
      round:            this.round,
      currentTurn:      this.currentPlayer.id,
      currentTurnName:  this.currentPlayer.name,
      stockRemaining:   this.stockPile.length,
      topDiscard:       this.topDiscard?.toString() ?? null,
      // Top 3 untuk preview preview (bottom-to-top order)
      discardPileTop3:  this.discardPile.slice(-3).map(c => c.toString()),
      // Full discard pile (bottom-to-top order) — untuk popup
      discardPileFull:  this.discardPile.map(c => c.toString()),
      discardCount:     this.discardPile.length,
      // NEW: batas kedalaman "Makan Buangan" & jumlah dek yang dipakai
      maxEatDepth:      this.maxEatDepth,
      deckCount:        this.deckCount,
      playerCount:      this.players.length,
      players: this.players.map(p => ({
        id:            p.id,
        name:          p.name,
        handCount:     p.hand.length,
        hasBaseSeries: p.hasBaseSeries,
        melds:         p.melds.map(m => m.map(c => c.toString())),
        connected:     p.connected
      }))
    };
  }

  /**
   * @deprecated Gunakan snapshotPublic() — alias untuk backward compat.
   */
  snapshot() {
    return this.snapshotPublic();
  }

  /**
   * Snapshot pribadi — kartu tangan + full game state untuk pemain ybs.
   */
  snapshotForPlayer(playerId) {
    const base = this.snapshotPublic();
    const p    = this.players.find(p => p.id === playerId);
    if (!p) return base;
    return {
      ...base,
      myHand:          p.hand.map(c => c.toString()),
      myMelds:         p.melds.map(m => m.map(c => c.toString())),
      myHasBaseSeries: p.hasBaseSeries
    };
  }

  // ────────────────────────────────────────────────────
  // Private helpers
  // ────────────────────────────────────────────────────

  _phaseCheck(playerId, expectedPhase) {
    if (this.phase === PHASES.GAME_OVER) {
      return { ok: false, reason: 'Permainan sudah selesai' };
    }
    if (this.currentPlayer.id !== playerId) {
      return { ok: false, reason: `Bukan giliran ${playerId} — sekarang giliran ${this.currentPlayer.name}` };
    }
    if (this.phase !== expectedPhase) {
      const phaseLabels = { DRAW: 'Ambil Kartu', MELD: 'Susun/Buang', GAME_OVER: 'Selesai' };
      return {
        ok: false,
        reason: `Fase tidak tepat. Saat ini: ${phaseLabels[this.phase] || this.phase}, dibutuhkan: ${phaseLabels[expectedPhase] || expectedPhase}`
      };
    }
    return { ok: true };
  }

  _extractCardsFromHand(player, cardIds) {
    const cards = cardIds.map(id => player.hand.find(c => c.id === id));
    if (cards.some(c => !c)) return null;
    return cards;
  }

  _nextTurn() {
    this.currentTurnIdx = (this.currentTurnIdx + 1) % this.players.length;
    this.currentPlayer.drewFromDiscard = false;
    this.phase = PHASES.DRAW;
    this._log('SYSTEM', `Giliran beralih ke: ${this.currentPlayer.name}`);
  }

  _triggerStockEmpty() {
    if (this.phase === PHASES.GAME_OVER) {
      // Sudah berakhir sebelumnya — hindari double-ending.
      return { success: false, reason: 'Permainan sudah selesai' };
    }
    this._log('SYSTEM', 'Stock pile habis — permainan dihentikan otomatis');
    return this._endRound(null, null, true);
  }

  _endRound(winnerId, closingCard, stockEmpty = false) {
    this.phase = PHASES.GAME_OVER;

    const playerStates = this.players.map(p => ({
      id:            p.id,
      melds:         p.melds,
      hand:          p.hand,
      hasBaseSeries: p.hasBaseSeries,
      isWinner:      p.id === winnerId,
      closingCard:   p.id === winnerId ? closingCard : null,
      pao:           false
    }));

    const roundScores = calculateRoundScores(playerStates, this.mode);
    roundScores.forEach(rs => {
      this.scores[rs.playerId] = (this.scores[rs.playerId] || 0) + rs.total;
    });

    const winnerName = winnerId
      ? (this.players.find(p => p.id === winnerId)?.name || winnerId)
      : null;

    this._log('SYSTEM', `Putaran ${this.round} selesai${stockEmpty ? ' (stock habis)' : ` — pemenang: ${winnerName}`}`);
    this.round++;

    return {
      success:     true,
      gameOver:    true,
      winner:      winnerId,
      winnerName,
      stockEmpty,
      roundScores,
      totalScores: this.scores,
      reason:      'OK'
    };
  }

  /**
   * Mulai putaran baru pada GameState yang sudah ada (mis. setelah round_over,
   * host memilih "Main Lagi"). Mengembalikan snapshot publik dari putaran baru.
   * Pemain & skor akumulasi (this.scores) dipertahankan; hanya kartu yang dikocok ulang.
   */
  startNextRound() {
    return this.startRound();
  }

  _log(actor, message) {
    this.log.push({ ts: Date.now(), actor, message });
    if (this.log.length > 500) this.log.shift();
  }
}

module.exports = { GameState, PHASES, MIN_PLAYERS, MAX_PLAYERS };
