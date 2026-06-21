const SUITS = ['♠', '♥', '♦', '♣'];
const SUIT_NAMES = { '♠': 'Sekop', '♥': 'Hati', '♦': 'Wajik', '♣': 'Keriting' };
const RANKS = [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14];
const RANK_LABELS = {
  2: '2', 3: '3', 4: '4', 5: '5', 6: '6', 7: '7',
  8: '8', 9: '9', 10: '10', 11: 'J', 12: 'Q', 13: 'K', 14: 'A'
};

class Card {
  constructor(rank, suit) {
    if (!RANKS.includes(rank)) throw new Error(`Rank tidak valid: ${rank}`);
    if (!SUITS.includes(suit)) throw new Error(`Suit tidak valid: ${suit}`);
    this.rank = rank;
    this.suit = suit;
    this.id   = `${RANK_LABELS[rank]}${suit}`;
  }
  get isFaceCard()   { return this.rank >= 11 && this.rank <= 13; }
  get isAce()        { return this.rank === 14; }
  get isNumberCard() { return this.rank <= 10; }
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
    this.points  = 0;
  }
  get isFaceCard()   { return false; }
  get isAce()        { return false; }
  get isNumberCard() { return false; }
  toString()         { return 'JOKER'; }
}

module.exports = { Card, Joker, SUITS, RANKS, RANK_LABELS };
