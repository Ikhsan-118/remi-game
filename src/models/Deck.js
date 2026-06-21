/**
 * Deck.js — Dek kartu Remi Indonesia (52 kartu + opsional joker)
 * Shuffle menggunakan Fisher-Yates untuk distribusi acak yang adil.
 */

const { Card, Joker, SUITS, RANKS } = require('./Card');

class Deck {
  /**
   * @param {boolean} useJokers — apakah menyertakan 2 kartu Joker
   */
  constructor(useJokers = false) {
    this.cards     = [];
    this.useJokers = useJokers;
    this._build();
  }

  _build() {
    this.cards = [];
    for (const suit of SUITS) {
      for (const rank of RANKS) {
        this.cards.push(new Card(rank, suit));
      }
    }
    if (this.useJokers) {
      this.cards.push(new Joker(1));
      this.cards.push(new Joker(2));
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
