const { Card, Joker, SUITS, RANKS } = require('./Card');

class Deck {
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
      const jokerCount = this.deckCount * 2;
      for (let i = 1; i <= jokerCount; i++) {
        this.cards.push(new Joker(i));
      }
    }
  }

  shuffle() {
    const arr = this.cards;
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return this;
  }

  draw() {
    if (this.cards.length === 0) return null;
    return this.cards.shift();
  }

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
