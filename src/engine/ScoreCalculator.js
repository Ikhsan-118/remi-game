/**
 * ScoreCalculator.js
 * =====================================================
 * Menghitung skor akhir tiap putaran Remi Indonesia.
 *
 * Formula:
 *   Skor = +Σ poin kombinasi di meja  − Σ poin sisa kartu di tangan
 *
 * Aturan khusus:
 *  - Pemain tanpa dasar seri → SEMUA kartu di tangan jadi penalti
 *    (termasuk kembar yang tidak sah tanpa dasar seri)
 *  - Tutup game dengan As     → +150 poin bonus (mode tradisional)
 *  - Tutup game dengan Joker  → +bonus sesuai kartu yang digantikan
 *  - Joker tersisa di tangan  → −20 s.d. −500 poin (sesuai konfigurasi)
 *  - Kesalahan tutup (Pao)    → −150 poin
 */

const { isJoker } = require('./MeldingValidator');

// Penalti joker default jika tersisa di tangan
const JOKER_HAND_PENALTY = -20;

/**
 * Hitung total poin semua kartu dalam sebuah array.
 * Joker menggunakan penalti tetap (negatif jika sisa di tangan).
 *
 * @param {Card[]} cards
 * @param {boolean} isPenalty — true = semua jadi negatif
 * @param {number}  jokerPenalty
 */
function sumCardPoints(cards, isPenalty = false, jokerPenalty = JOKER_HAND_PENALTY) {
  return cards.reduce((total, card) => {
    if (isJoker(card)) {
      return total + (isPenalty ? jokerPenalty : 0);
    }
    const pts = card.points;
    return total + (isPenalty ? -pts : pts);
  }, 0);
}

/**
 * Hitung skor satu pemain pada akhir putaran.
 *
 * @param {object} playerState
 *   @param {Card[][]} playerState.melds      — array of kombinasi di meja
 *   @param {Card[]}   playerState.hand       — sisa kartu di tangan
 *   @param {boolean}  playerState.hasBaseSeries — apakah pemain punya dasar seri
 *   @param {boolean}  playerState.isWinner   — apakah pemain yang menutup game
 *   @param {Card|null} playerState.closingCard — kartu penutup (jika winner)
 *   @param {boolean}  playerState.pao        — apakah terkena penalti Pao
 * @param {string} mode — 'traditional' | 'tournament'
 *
 * @returns {{
 *   tablePoints: number,
 *   handPenalty: number,
 *   bonusPoints: number,
 *   paopenalty: number,
 *   total: number,
 *   breakdown: string[]
 * }}
 */
function calculatePlayerScore(playerState, mode = 'traditional') {
  const {
    melds = [],
    hand = [],
    hasBaseSeries = false,
    isWinner = false,
    closingCard = null,
    pao = false
  } = playerState;

  const breakdown = [];
  let tablePoints = 0;
  let handPenalty = 0;
  let bonusPoints = 0;
  let paoPenalty  = 0;

  // ── 1. Poin kombinasi di meja ──
  if (hasBaseSeries && melds.length > 0) {
    for (const meld of melds) {
      const pts = sumCardPoints(meld, false);
      tablePoints += pts;
      breakdown.push(`Meja [${meld.map(c => c.toString()).join('-')}]: +${pts}`);
    }
  } else if (!hasBaseSeries && melds.length > 0) {
    // Tanpa dasar seri: kombinasi di meja tidak dihitung
    breakdown.push('⚠ Kombinasi meja TIDAK DIHITUNG karena tidak ada dasar seri');
  }

  // ── 2. Penalti sisa kartu di tangan ──
  if (!hasBaseSeries) {
    // Tanpa dasar seri: semua kartu (tangan + meja) jadi penalti
    // Kembar di meja pun tidak sah karena tidak ada dasar seri
    const allCards = [...hand, ...melds.flat()];
    handPenalty = sumCardPoints(allCards, true, JOKER_HAND_PENALTY);
    // Reset tablePoints karena kombinasi meja tidak valid tanpa dasar seri
    tablePoints = 0;
    breakdown.push(`Penalti tangan (tanpa dasar seri, total ${allCards.length} kartu): ${handPenalty}`);
  } else {
    handPenalty = sumCardPoints(hand, true, JOKER_HAND_PENALTY);
    if (handPenalty !== 0) {
      breakdown.push(`Penalti sisa tangan [${hand.map(c => c.toString()).join(', ')}]: ${handPenalty}`);
    }
  }

  // ── 3. Bonus tutup game (mode tradisional) ──
  if (isWinner && closingCard && mode === 'traditional') {
    if (!isJoker(closingCard) && closingCard.isAce) {
      bonusPoints = 150;
      breakdown.push(`Bonus tutup game dengan As: +${bonusPoints}`);
    } else if (isJoker(closingCard)) {
      // Bonus sesuai nilai kartu yang diwakili joker
      bonusPoints = 20; // default; bisa disesuaikan runtime
      breakdown.push(`Bonus tutup game dengan Joker: +${bonusPoints}`);
    }
  }

  // ── 4. Penalti Pao (kesalahan tutup game) ──
  if (pao) {
    paoPenalty = mode === 'traditional' ? -150 : -2;
    breakdown.push(`Penalti Pao: ${paoPenalty}`);
  }

  const total = tablePoints + handPenalty + bonusPoints + paoPenalty;
  breakdown.push(`─────────────────`);
  breakdown.push(`TOTAL: ${total} poin`);

  return { tablePoints, handPenalty, bonusPoints, paoPenalty, total, breakdown };
}

/**
 * Hitung skor seluruh pemain sekaligus.
 *
 * @param {object[]} players — array playerState
 * @param {string}   mode
 * @returns {object[]} — array hasil skor per pemain
 */
function calculateRoundScores(players, mode = 'traditional') {
  return players.map((p, i) => ({
    playerId: p.id || `Player${i + 1}`,
    ...calculatePlayerScore(p, mode)
  }));
}

/**
 * Cek apakah kondisi tutup game valid (Going Out).
 *
 * Syarat:
 *  - Pemain punya ≥1 kombinasi seri di meja
 *  - Sisa tepat 1 kartu di tangan untuk dibuang sebagai penutup
 *  - Kartu penutup harus dari buangan lawan (rule "Tidak Boleh Tutup Sendiri")
 *
 * @param {Card[][]} melds
 * @param {Card[]}   hand
 * @param {boolean}  fromOpponentDiscard — kartu terakhir dari buangan lawan?
 * @param {boolean}  hasBaseSeries
 *
 * @returns {{ canClose: boolean, reason: string }}
 */
function canCloseGame(melds, hand, fromOpponentDiscard = false, hasBaseSeries = false) {
  if (!hasBaseSeries) {
    return { canClose: false, reason: 'Belum memiliki dasar seri' };
  }
  if (hand.length !== 1) {
    return {
      canClose: false,
      reason: `Harus menyisakan tepat 1 kartu penutup, saat ini sisa: ${hand.length} kartu`
    };
  }
  if (!fromOpponentDiscard) {
    return {
      canClose: false,
      reason: 'Aturan "Tidak Boleh Tutup Sendiri": penutup harus dari buangan lawan'
    };
  }
  return { canClose: true, reason: 'Kondisi tutup game terpenuhi' };
}

module.exports = {
  calculatePlayerScore,
  calculateRoundScores,
  canCloseGame,
  sumCardPoints,
  JOKER_HAND_PENALTY
};