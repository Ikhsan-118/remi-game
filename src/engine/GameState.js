/**
 * GameState.js
 * =====================================================
 * State machine untuk satu sesi permainan Remi Indonesia.
 *
 * Flow giliran:
 *   WAITING → DRAW → MELD → (discard/meld loop) → giliran berikutnya
 *                                                → GAME_OVER
 *
 * PERBAIKAN:
 *  ✓ FIX: Pemain pertama dipilih secara acak (bukan selalu index 0)
 *  ✓ FIX: Tracking drewFromDiscard per pemain untuk validasi tutup game
 *  ✓ FIX: Phase state machine yang lebih jelas (DRAW → MELD saja)
 *  ✓ FIX: Nama pemain disertakan dalam snapshot untuk tampilan di client
 *  ✓ FIX: canCloseGame dipanggil dengan drewFromDiscard yang benar
 *  ✓ FIX: Snapshot publik menyertakan map id→nama
 */

const { Deck }                           = require('../models/Deck');
const { validateMeld, validateEat, isJoker } = require('./MeldingValidator');
const { calculateRoundScores, canCloseGame } = require('./ScoreCalculator');

const PHASES = {
  WAITING:   'WAITING',
  DRAW:      'DRAW',
  MELD:      'MELD',
  GAME_OVER: 'GAME_OVER'
};

class GameState {
  /**
   * @param {string[]} playerIds   — array ID pemain (2–4 orang)
   * @param {object}   playerNames — map { id: nama } untuk tampilan
   * @param {object}   options
   *   @param {boolean} options.useJokers     — gunakan joker?
   *   @param {string}  options.mode          — 'traditional' | 'tournament'
   */
  constructor(playerIds, playerNames = {}, options = {}) {
    if (playerIds.length < 2 || playerIds.length > 4) {
      throw new Error('Remi Indonesia dimainkan oleh 2–4 pemain');
    }

    this.useJokers = options.useJokers ?? false;
    this.mode      = options.mode      ?? 'traditional';

    // State utama
    this.phase          = PHASES.WAITING;
    this.round          = 1;
    this.currentTurnIdx = 0;
    this.stockPile      = [];
    this.discardPile    = [];

    // Pemain
    this.players = playerIds.map(id => ({
      id,
      name:            playerNames[id] || id,
      hand:            [],
      melds:           [],
      hasBaseSeries:   false,
      connected:       true,
      disconnectedAt:  null,
      drewFromDiscard: false   // FIX: lacak apakah giliran ini ambil dari buangan
    }));

    this.log    = [];
    this.scores = {};
    playerIds.forEach(id => { this.scores[id] = 0; });
  }

  // ────────────────────────────────────────────────────
  // Setup
  // ────────────────────────────────────────────────────

  /**
   * Mulai putaran: shuffle, deal, pilih pemain pertama secara ACAK.
   * FIX: sebelumnya selalu index 0 (host) — sekarang random.
   */
  startRound() {
    const deck = new Deck(this.useJokers);
    deck.shuffle();

    const hands = deck.deal(this.players.length, 7);
    this.players.forEach((p, i) => {
      p.hand            = hands[i];
      p.melds           = [];
      p.hasBaseSeries   = false;
      p.drewFromDiscard = false;
    });

    // Kartu pertama discard pile
    this.stockPile   = [...deck.cards];
    this.discardPile = [this.stockPile.shift()];

    // FIX: Pemain pertama dipilih acak, bukan selalu index 0
    this.currentTurnIdx = Math.floor(Math.random() * this.players.length);
    this.phase          = PHASES.DRAW;

    this._log('SYSTEM', `Putaran ${this.round} dimulai. Giliran pertama: ${this.currentPlayer.name}`);
    return this.snapshot();
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

  /**
   * Ambil dari stock pile.
   * FIX: Set drewFromDiscard = false (ambil dari stock, TIDAK bisa tutup game)
   */
  drawFromStock(playerId) {
    const check = this._phaseCheck(playerId, PHASES.DRAW);
    if (!check.ok) return { success: false, card: null, reason: check.reason };

    if (this.stockPile.length === 0) {
      return this._triggerStockEmpty();
    }

    const card = this.stockPile.shift();
    this.currentPlayer.hand.push(card);
    this.currentPlayer.drewFromDiscard = false; // FIX: catat ambil dari stock
    this.phase = PHASES.MELD;

    this._log(playerId, `Ambil dari stock: ${card}`);
    return { success: true, card, reason: 'OK' };
  }

  /**
   * Ambil ("makan") kartu dari discard pile.
   * FIX: Set drewFromDiscard = true (bisa tutup game jika syarat lain terpenuhi)
   *
   * @param {string} playerId
   * @param {number} positionFromTop — 0 = kartu paling atas
   * @param {Card[]} intendedMeld    — kombinasi yang langsung akan diletakkan (opsional hint)
   */
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

    // Validasi aturan makan
    const eatCheck = validateEat(
      targetCard,
      positionFromTop,
      player.hand,
      player.hasBaseSeries
    );

    if (!eatCheck.allowed) {
      return { success: false, reason: eatCheck.reason };
    }

    // Ambil kartu target + semua kartu di atasnya ke tangan pemain
    const pickedCards = this.discardPile.splice(targetIdx);
    player.hand.push(...pickedCards);

    player.drewFromDiscard = true; // FIX: catat ambil dari buangan
    this.phase = PHASES.MELD;

    this._log(playerId, `Makan kartu ${targetCard} (posisi ${positionFromTop} dari atas), total ${pickedCards.length} kartu masuk`);
    return { success: true, pickedCards, requiredMeld: eatCheck.requiredMeld, reason: 'OK' };
  }

  // ────────────────────────────────────────────────────
  // Fase MELD
  // ────────────────────────────────────────────────────

  /**
   * Letakkan kombinasi (seri/kembar) di meja.
   * Bisa dipanggil beberapa kali dalam satu giliran (fase MELD).
   *
   * @param {string}   playerId
   * @param {string[]} cardIds — ID kartu yang ingin dikombinasikan
   */
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

    // Pindahkan kartu dari tangan ke meja
    player.melds.push(cards);
    player.hand = player.hand.filter(c => !cardIds.includes(c.id));

    // Tandai dasar seri jika ini seri pertama
    if (!player.hasBaseSeries && (result.type === 'SERI_ANGKA' || result.type === 'SERI_GAMBAR')) {
      player.hasBaseSeries = true;
      this._log(playerId, `✓ Dasar seri terpenuhi: [${cards.map(c => c.toString()).join('-')}]`);
    }

    this._log(playerId, `Letakkan ${result.type}: [${cards.map(c => c.toString()).join('-')}]`);
    return { success: true, type: result.type, cards, reason: 'OK' };
  }

  // ────────────────────────────────────────────────────
  // Buang Kartu (Discard) + Cek Tutup Game
  // ────────────────────────────────────────────────────

  /**
   * Buang satu kartu dari tangan ke discard pile.
   * Jika attemptClose=true, cek kondisi tutup game.
   *
   * FIX: drewFromDiscard dikirim ke canCloseGame (bukan selalu true)
   *
   * @param {string}  playerId
   * @param {string}  cardId
   * @param {boolean} attemptClose — apakah mencoba menutup game?
   */
  discard(playerId, cardId, attemptClose = false) {
    // Harus dalam fase MELD untuk buang kartu
    const check = this._phaseCheck(playerId, PHASES.MELD);
    if (!check.ok) return { success: false, reason: check.reason };

    const player  = this.currentPlayer;
    const cardIdx = player.hand.findIndex(c => c.id === cardId);

    if (cardIdx === -1) {
      return { success: false, reason: `Kartu ${cardId} tidak ada di tangan pemain` };
    }

    const card      = player.hand[cardIdx];
    const afterHand = player.hand.filter((_, i) => i !== cardIdx);

    // ── Cek tutup game ──
    if (attemptClose) {
      // FIX: gunakan drewFromDiscard yang sebenarnya, bukan hardcode true
      const closeCheck = canCloseGame(
        player.melds,
        afterHand,                    // tangan setelah kartu penutup dibuang
        player.drewFromDiscard,       // FIX: apakah dapat dari buangan lawan?
        player.hasBaseSeries
      );

      if (!closeCheck.canClose) {
        return { success: false, reason: closeCheck.reason };
      }

      // Tutup game berhasil
      player.hand = [];
      this.discardPile.push(card);
      this._log(playerId, `🏆 TUTUP GAME dengan kartu: ${card}`);
      return this._endRound(playerId, card);
    }

    // ── Buang biasa ──
    player.hand = afterHand;
    this.discardPile.push(card);
    this._log(playerId, `Buang: ${card}`);

    this._nextTurn();
    return { success: true, card, reason: 'OK' };
  }

  // ────────────────────────────────────────────────────
  // Reconnect
  // ────────────────────────────────────────────────────

  playerDisconnect(playerId) {
    const p = this.players.find(p => p.id === playerId);
    if (p) {
      p.connected       = false;
      p.disconnectedAt  = Date.now();
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
   * Snapshot publik: info yang aman dikirim ke semua pemain.
   * FIX: menyertakan name di setiap player entry.
   */
  snapshot() {
    return {
      phase:           this.phase,
      round:           this.round,
      currentTurn:     this.currentPlayer.id,
      currentTurnName: this.currentPlayer.name,  // FIX: nama untuk display
      stockRemaining:  this.stockPile.length,
      topDiscard:      this.topDiscard?.toString() ?? null,
      discardPileTop3: this.discardPile.slice(-3).map(c => c.toString()),
      players: this.players.map(p => ({
        id:            p.id,
        name:          p.name,          // FIX: sertakan nama
        handCount:     p.hand.length,
        hasBaseSeries: p.hasBaseSeries,
        melds:         p.melds.map(m => m.map(c => c.toString())),
        connected:     p.connected
      }))
    };
  }

  /**
   * Snapshot pribadi: kartu tangan hanya dikirim ke pemain ybs.
   */
  snapshotForPlayer(playerId) {
    const base = this.snapshot();
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
    // Reset drewFromDiscard untuk giliran baru
    this.currentPlayer.drewFromDiscard = false;
    this.phase = PHASES.DRAW;
    this._log('SYSTEM', `Giliran beralih ke: ${this.currentPlayer.name}`);
  }

  _triggerStockEmpty() {
    this._log('SYSTEM', 'Stock pile habis — permainan dihentikan');
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

    const winnerName = winnerId ? (this.players.find(p => p.id === winnerId)?.name || winnerId) : null;
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

  _log(actor, message) {
    this.log.push({ ts: Date.now(), actor, message });
    // Batasi log maksimal 500 entry agar tidak overflow memory
    if (this.log.length > 500) this.log.shift();
  }
}

module.exports = { GameState, PHASES };
