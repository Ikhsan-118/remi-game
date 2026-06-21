/**
 * Deck.js — Dek kartu Remi Indonesia (52 kartu + opsional joker)
 * Shuffle menggunakan Fisher-Yates untuk distribusi acak yang adil.
 *
 * FIX (multi-deck support untuk 5–8 pemain):
 *  ✓ NEW: parameter `deckCount` — jumlah dek 52-kartu yang digabung.
 *         - 2–4 pemain → 1 dek (52 kartu, +2 Joker jika diaktifkan)
 *         - 5–8 pemain → 2 dek (104 kartu, +4 Joker jika diaktifkan)
 *         Jumlah Joker otomatis mengikuti deckCount (2 Joker per dek).
 */

const { Card, Joker, SUITS, RANKS } = require('./Card');

class Deck {
  /**
   * @param {boolean} useJokers  — apakah menyertakan kartu Joker
   * @param {number}  deckCount  — jumlah dek 52-kartu yang digabung (default 1)
   */
  constructor(useJokers = false, deckCount = 1) {
    this.cards     = [];
    this.useJokers = useJokers;
    this.deckCount = Math.max(1, Math.floor(deckCount) || 1);
    this._build();
  }

  _build() {
    this.cards = [];
    for (let d = 0; d < this.deckCount; d++) {
      for (const suit of SUITS) {
        for (const rank of RANKS) {
          this.cards.push(new Card(rank, suit));
        }
      }
    }
    if (this.useJokers) {
      // 2 Joker per dek yang digabungkan (1 dek → 2 Joker, 2 dek → 4 Joker, dst.)
      const jokerCount = this.deckCount * 2;
      for (let i = 1; i <= jokerCount; i++) {
        this.cards.push(new Joker(i));
      }
    }
  }

  /** Fisher-Yates shuffle — aman untuk game engine */
  shuffle() {
    const arr = this.cards;
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return this;
  }

  /** Ambil kartu teratas (shift dari depan array) */
  draw() {
    if (this.cards.length === 0) return null;
    return this.cards.shift();
  }

  /** Bagikan N kartu ke tiap pemain (round-robin) */
  deal(playerCount, cardsPerPlayer = 7) {
    const hands = Array.from({ length: playerCount }, () => []);
    for (let i = 0; i < cardsPerPlayer; i++) {
      for (let p = 0; p < playerCount; p++) {
        const card = this.draw();
        if (card) hands[p].push(card);
      }
    }
    return hands;
  }

  get remaining() { return this.cards.length; }
  get isEmpty()   { return this.cards.length === 0; }
}

module.exports = { Deck };
