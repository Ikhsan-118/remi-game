/**
 * GameState.js
 * =====================================================
 * State machine untuk satu sesi permainan Remi Indonesia.
 *
 * Flow giliran:
 *   WAITING → DEALING → DRAW → MELD → DISCARD → (giliran berikutnya)
 *                                             → GAME_OVER
 *
 * Fitur:
 *  ✓ State machine fase giliran
 *  ✓ Stock pile & discard pile management
 *  ✓ Tracking dasar seri per pemain
 *  ✓ Kondisi akhir: stock pile habis
 *  ✓ Snapshot state untuk reconnect
 */

const { Deck } = require('../models/Deck');
const { validateMeld, validateEat, isJoker } = require('./MeldingValidator');
const { calculateRoundScores, canCloseGame } = require('./ScoreCalculator');

const PHASES = {
  WAITING:   'WAITING',
  DEALING:   'DEALING',
  DRAW:      'DRAW',
  MELD:      'MELD',
  DISCARD:   'DISCARD',
  GAME_OVER: 'GAME_OVER'
};

class GameState {
  /**
   * @param {string[]} playerIds  — array ID pemain (2–4 orang)
   * @param {object}   options
   *   @param {boolean} options.useJokers    — gunakan joker?
   *   @param {string}  options.mode         — 'traditional' | 'tournament'
   *   @param {boolean} options.allowSelfClose — izinkan tutup sendiri?
   */
  constructor(playerIds, options = {}) {
    if (playerIds.length < 2 || playerIds.length > 4) {
      throw new Error('Remi Indonesia dimainkan oleh 2–4 pemain');
    }

    this.useJokers      = options.useJokers ?? false;
    this.mode           = options.mode ?? 'traditional';
    this.allowSelfClose = options.allowSelfClose ?? false;

    // State
    this.phase          = PHASES.WAITING;
    this.round          = 1;
    this.currentTurnIdx = 0;
    this.stockPile      = [];
    this.discardPile    = [];

    // Pemain
    this.players = playerIds.map(id => ({
      id,
      hand:          [],   // kartu di tangan
      melds:         [],   // array of kombinasi di meja [[...], [...]]
      hasBaseSeries: false,
      connected:     true,
      disconnectedAt: null
    }));

    this.log = [];          // history aksi
    this.scores = {};       // akumulasi skor antar putaran
    playerIds.forEach(id => { this.scores[id] = 0; });
  }

  // ────────────────────────────────────────────────────
  // Setup
  // ────────────────────────────────────────────────────

  /** Mulai permainan: shuffle & bagikan kartu */
  startRound() {
    const deck = new Deck(this.useJokers);
    deck.shuffle();

    const hands = deck.deal(this.players.length, 7);
    this.players.forEach((p, i) => {
      p.hand          = hands[i];
      p.melds         = [];
      p.hasBaseSeries = false;
    });

    // Kartu pertama discard pile (balik 1 kartu)
    this.stockPile   = [...deck.cards];
    this.discardPile = [this.stockPile.shift()];

    this.currentTurnIdx = 0;
    this.phase          = PHASES.DRAW;
    this._log('SYSTEM', `Putaran ${this.round} dimulai. Giliran: ${this.currentPlayer.id}`);
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
   * @returns {{ success: boolean, card: Card|null, reason: string }}
   */
  drawFromStock(playerId) {
    const check = this._phaseCheck(playerId, PHASES.DRAW);
    if (!check.ok) return { success: false, card: null, reason: check.reason };

    if (this.stockPile.length === 0) {
      // Stock pile habis → game over
      return this._triggerStockEmpty();
    }

    const card = this.stockPile.shift();
    this.currentPlayer.hand.push(card);
    this.phase = PHASES.MELD;
    this._log(playerId, `Ambil dari stock: ${card}`);
    return { success: true, card, reason: 'OK' };
  }

  /**
   * Ambil ("makan") kartu dari discard pile.
   *
   * @param {string} playerId
   * @param {number} positionFromTop — 0 = kartu paling atas (rel)
   * @param {Card[]} intendedMeld    — kombinasi yang langsung akan diletakkan
   */
  drawFromDiscard(playerId, positionFromTop, intendedMeld) {
    const check = this._phaseCheck(playerId, PHASES.DRAW);
    if (!check.ok) return { success: false, reason: check.reason };

    const player = this.currentPlayer;
    const discardLen = this.discardPile.length;

    if (discardLen === 0) {
      return { success: false, reason: 'Discard pile kosong' };
    }
    if (positionFromTop >= discardLen) {
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

    this.phase = PHASES.MELD;
    this._log(playerId, `Makan kartu ${targetCard} (posisi ${positionFromTop} dari atas)`);
    return { success: true, pickedCards, intendedMeld: eatCheck.requiredMeld, reason: 'OK' };
  }

  // ────────────────────────────────────────────────────
  // Fase MELD
  // ────────────────────────────────────────────────────

  /**
   * Letakkan kombinasi di meja.
   *
   * @param {string} playerId
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
      this._log(playerId, `Dasar seri terpenuhi dengan: ${cards.map(c => c.toString()).join('-')}`);
    }

    this._log(playerId, `Letakkan ${result.type}: [${cards.map(c => c.toString()).join('-')}]`);
    return { success: true, type: result.type, cards, reason: 'OK' };
  }

  // ────────────────────────────────────────────────────
  // Fase DISCARD
  // ────────────────────────────────────────────────────

  /**
   * Buang satu kartu dari tangan.
   * Jika hanya tersisa 1 kartu setelah buang → cek tutup game.
   */
  discard(playerId, cardId, attemptClose = false) {
    const check = this._phaseCheck(playerId, PHASES.MELD);
    if (!check.ok) {
      // Juga boleh di fase MELD (pemain tidak meletakkan kombinasi, langsung buang)
      const check2 = this._phaseCheck(playerId, PHASES.DISCARD);
      if (!check2.ok) return { success: false, reason: check.reason };
    }

    const player = this.currentPlayer;
    const cardIdx = player.hand.findIndex(c => c.id === cardId);

    if (cardIdx === -1) {
      return { success: false, reason: `Kartu ${cardId} tidak ada di tangan` };
    }

    const card = player.hand[cardIdx];

    // ── Cek tutup game ──
    if (attemptClose) {
      // Setelah kartu ini dibuang, tangan harus kosong (sudah semua di meja)
      // Artinya sekarang tangan pemain punya tepat 1 kartu (yang akan dibuang)
      const afterHand = player.hand.filter((_, i) => i !== cardIdx);
      const closeCheck = canCloseGame(
        player.melds,
        [card], // kartu penutup
        true,   // anggap dari lawan (validasi lebih lanjut di layer atas)
        player.hasBaseSeries
      );
      if (closeCheck.canClose && afterHand.length === 0) {
        // Buang kartu & tutup permainan
        player.hand = [];
        this.discardPile.push(card);
        this._log(playerId, `TUTUP GAME dengan kartu penutup: ${card}`);
        return this._endRound(playerId, card);
      } else {
        return { success: false, reason: closeCheck.reason };
      }
    }

    // Buang biasa
    player.hand.splice(cardIdx, 1);
    this.discardPile.push(card);
    this._log(playerId, `Buang: ${card}`);

    // Pindah giliran
    this._nextTurn();
    return { success: true, card, reason: 'OK' };
  }

  // ────────────────────────────────────────────────────
  // Reconnect
  // ────────────────────────────────────────────────────

  playerDisconnect(playerId) {
    const p = this.players.find(p => p.id === playerId);
    if (p) { p.connected = false; p.disconnectedAt = Date.now(); }
  }

  playerReconnect(playerId) {
    const p = this.players.find(p => p.id === playerId);
    if (!p) return { success: false, reason: 'Pemain tidak ditemukan' };
    const elapsed = (Date.now() - (p.disconnectedAt || 0)) / 1000;
    if (elapsed > 60) return { success: false, reason: 'Waktu reconnect (60 detik) sudah habis' };
    p.connected = true;
    p.disconnectedAt = null;
    return { success: true, state: this.snapshotForPlayer(playerId) };
  }

  // ────────────────────────────────────────────────────
  // Snapshot (untuk pengiriman ke client)
  // ────────────────────────────────────────────────────

  snapshot() {
    return {
      phase:          this.phase,
      round:          this.round,
      currentTurn:    this.currentPlayer.id,
      stockRemaining: this.stockPile.length,
      topDiscard:     this.topDiscard?.toString() ?? null,
      discardPileTop3: this.discardPile.slice(-3).map(c => c.toString()),
      players: this.players.map(p => ({
        id:            p.id,
        handCount:     p.hand.length,
        hasBaseSeries: p.hasBaseSeries,
        melds:         p.melds.map(m => m.map(c => c.toString())),
        connected:     p.connected
      }))
    };
  }

  /** Snapshot dengan kartu tangan (hanya untuk pemain itu sendiri) */
  snapshotForPlayer(playerId) {
    const base = this.snapshot();
    const p = this.players.find(p => p.id === playerId);
    if (!p) return base;
    return {
      ...base,
      myHand: p.hand.map(c => c.toString()),
      myMelds: p.melds.map(m => m.map(c => c.toString()))
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
      return { ok: false, reason: `Bukan giliran ${playerId}` };
    }
    if (this.phase !== expectedPhase && !(expectedPhase === PHASES.DISCARD && this.phase === PHASES.MELD)) {
      return { ok: false, reason: `Fase tidak tepat. Saat ini: ${this.phase}, dibutuhkan: ${expectedPhase}` };
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
    this.phase = PHASES.DRAW;
    this._log('SYSTEM', `Giliran beralih ke: ${this.currentPlayer.id}`);
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

    this._log('SYSTEM', `Putaran ${this.round} selesai${stockEmpty ? ' (stock habis)' : ` — pemenang: ${winnerId}`}`);
    this.round++;

    return {
      success:     true,
      gameOver:    true,
      winner:      winnerId,
      stockEmpty,
      roundScores,
      totalScores: this.scores,
      reason:      'OK'
    };
  }

  _log(actor, message) {
    this.log.push({ ts: Date.now(), actor, message });
  }
}

module.exports = { GameState, PHASES };