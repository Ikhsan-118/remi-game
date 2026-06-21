/**
 * Card.js — Model kartu tunggal untuk Remi Indonesia
 */

const SUITS = ['♠', '♥', '♦', '♣'];
const SUIT_NAMES = { '♠': 'Sekop', '♥': 'Hati', '♦': 'Wajik', '♣': 'Keriting' };

// Rank number internal (2–14, dimana 14 = As)
const RANKS = [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14]; // 11=J, 12=Q, 13=K, 14=A
const RANK_LABELS = {
  2: '2', 3: '3', 4: '4', 5: '5', 6: '6', 7: '7',
  8: '8', 9: '9', 10: '10', 11: 'J', 12: 'Q', 13: 'K', 14: 'A'
};

class Card {
  /**
   * @param {number} rank  — 2–10 angka, 11=J, 12=Q, 13=K, 14=A
   * @param {string} suit  — '♠' | '♥' | '♦' | '♣'
   */
  constructor(rank, suit) {
    if (!RANKS.includes(rank)) throw new Error(`Rank tidak valid: ${rank}`);
    if (!SUITS.includes(suit)) throw new Error(`Suit tidak valid: ${suit}`);
    this.rank = rank;
    this.suit = suit;
    this.id   = `${RANK_LABELS[rank]}${suit}`;   // contoh: "7♠", "K♥", "A♦"
  }

  /** Apakah kartu ini kartu gambar (J/Q/K)? */
  get isFaceCard() { return this.rank >= 11 && this.rank <= 13; }

  /** Apakah kartu ini As? */
  get isAce() { return this.rank === 14; }

  /** Apakah kartu ini kartu angka (2–10)? */
  get isNumberCard() { return this.rank <= 10; }

  /**
   * Nilai poin kartu sesuai aturan Remi Indonesia:
   *   Angka 2–10 → 5 poin
   *   J / Q / K  → 10 poin
   *   As         → 15 poin
   */
  get points() {
    if (this.isAce)      return 15;
    if (this.isFaceCard) return 10;
    return 5;
  }

  get label()     { return `${RANK_LABELS[this.rank]}${this.suit}`; }
  get rankLabel() { return RANK_LABELS[this.rank]; }
  get suitName()  { return SUIT_NAMES[this.suit]; }

  toString() { return this.label; }
}

class Joker {
  constructor(id = 1) {
    this.rank    = 0;
    this.suit    = null;
    this.id      = `JOKER_${id}`;
    this.isJoker = true;
    this.points  = 0; // poin joker dinamis, dihitung saat scoring
  }
  get isFaceCard()   { return false; }
  get isAce()        { return false; }
  get isNumberCard() { return false; }
  toString()         { return 'JOKER'; }
}

module.exports = { Card, Joker, SUITS, RANKS, RANK_LABELS };
