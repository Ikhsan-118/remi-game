/**
 * ScoreCalculator.js
 * =====================================================
 * Menghitung skor akhir tiap putaran Remi Indonesia.
 *
 * Formula skor pemain:
 *   Skor = (+Σ poin kombinasi di meja)  − (Σ poin sisa kartu di tangan)
 *
 * Aturan khusus:
 *  - Pemain tanpa dasar seri → SEMUA kartu (tangan + meja) jadi penalti negatif
 *  - Tutup game dengan As     → +150 poin bonus (mode tradisional)
 *  - Tutup game dengan Joker  → +20 poin bonus
 *  - Joker tersisa di tangan  → −20 poin penalti per joker
 *  - Penalti Pao (salah tutup) → −150 poin
 *
 * Syarat tutup game (Going Out):
 *  - Pemain sudah punya dasar seri di meja
 *  - Sisa tepat 1 kartu di tangan (kartu penutup)
 *
 * UPDATE: Aturan "Tidak Boleh Tutup Sendiri" DIHAPUS atas permintaan
 * pemain — game terasa terlalu kaku jika kartu penutup wajib berasal
 * dari buangan lawan. Sekarang pemain boleh menutup game dengan kartu
 * penutup dari mana saja (termasuk hasil draw dari stock pile sendiri),
 * selama sudah punya dasar seri dan tangan tersisa tepat 1 kartu.
 *
 * CATATAN IMPLEMENTASI:
 *  - attemptClose=true dalam aksi discard → pemain buang kartu terakhirnya sebagai penutup
 *  - Parameter `drewFromDiscard` masih diterima untuk kompatibilitas /
 *    keperluan statistik, tapi TIDAK LAGI memengaruhi hasil canClose.
 */

const { isJoker } = require('./MeldingValidator');

// Penalti joker jika tersisa di tangan
const JOKER_HAND_PENALTY = -20;

/**
 * Hitung total poin semua kartu dalam sebuah array.
 *
 * @param {Card[]} cards
 * @param {boolean} isPenalty — true = semua poin jadi negatif
 * @param {number}  jokerPenalty — poin joker saat penalti
 * @returns {number}
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
 *   @param {Card[][]} playerState.melds         — array of kombinasi di meja
 *   @param {Card[]}   playerState.hand          — sisa kartu di tangan
 *   @param {boolean}  playerState.hasBaseSeries — apakah pemain punya dasar seri
 *   @param {boolean}  playerState.isWinner      — apakah pemain yang menutup game
 *   @param {Card|null} playerState.closingCard  — kartu penutup (jika winner)
 *   @param {boolean}  playerState.pao           — terkena penalti Pao?
 * @param {string} mode — 'traditional' | 'tournament'
 *
 * @returns {{
 *   tablePoints: number,
 *   handPenalty: number,
 *   bonusPoints: number,
 *   paoPenalty:  number,
 *   total:       number,
 *   breakdown:   string[]
 * }}
 */
function calculatePlayerScore(playerState, mode = 'traditional') {
  const {
    melds          = [],
    hand           = [],
    hasBaseSeries  = false,
    isWinner       = false,
    closingCard    = null,
    pao            = false
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
    // Tanpa dasar seri: kombinasi di meja tidak dihitung sebagai poin positif
    breakdown.push('⚠ Kombinasi meja TIDAK DIHITUNG — belum ada dasar seri');
  }

  // ── 2. Penalti sisa kartu di tangan ──
  if (!hasBaseSeries) {
    // Tanpa dasar seri: SEMUA kartu (tangan + meja) jadi penalti
    const allCards = [...hand, ...melds.flat()];
    handPenalty = sumCardPoints(allCards, true, JOKER_HAND_PENALTY);
    tablePoints = 0; // override: meja tidak dihitung
    breakdown.push(`Penalti total (tanpa dasar seri, ${allCards.length} kartu): ${handPenalty}`);
  } else {
    handPenalty = sumCardPoints(hand, true, JOKER_HAND_PENALTY);
    if (hand.length > 0) {
      breakdown.push(`Penalti sisa tangan [${hand.map(c => c.toString()).join(', ')}]: ${handPenalty}`);
    }
  }

  // ── 3. Bonus tutup game (mode tradisional) ──
  if (isWinner && closingCard && mode === 'traditional') {
    if (!isJoker(closingCard) && closingCard.isAce) {
      bonusPoints = 150;
      breakdown.push(`Bonus tutup dengan As: +${bonusPoints}`);
    } else if (isJoker(closingCard)) {
      bonusPoints = 20;
      breakdown.push(`Bonus tutup dengan Joker: +${bonusPoints}`);
    }
  }

  // ── 4. Penalti Pao ──
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
 * Hitung skor seluruh pemain sekaligus pada akhir putaran.
 *
 * @param {object[]} players — array playerState
 * @param {string}   mode
 * @returns {object[]} — array hasil skor per pemain dengan playerId
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
 * UPDATE: Aturan "Tidak Boleh Tutup Sendiri" sudah DIHAPUS. Sekarang
 * pemain boleh menutup game dengan kartu penutup dari mana saja —
 * baik hasil draw dari stock pile sendiri maupun makan buangan lawan.
 * Syarat yang tersisa hanya:
 *   1. Pemain sudah memiliki dasar seri di meja
 *   2. Setelah kartu penutup dibuang, tangan harus benar-benar kosong
 *
 * @param {Card[][]} melds
 * @param {Card[]}   hand                — sisa kartu (setelah dibuang, harus kosong)
 * @param {boolean}  drewFromDiscard     — (diabaikan, dipertahankan untuk kompatibilitas signature)
 * @param {boolean}  hasBaseSeries
 *
 * @returns {{ canClose: boolean, reason: string }}
 */
function canCloseGame(melds, hand, drewFromDiscard = false, hasBaseSeries = false) {
  if (!hasBaseSeries) {
    return { canClose: false, reason: 'Belum memiliki dasar seri — tidak bisa menutup game' };
  }

  // Setelah melempar kartu penutup, tangan harus kosong
  // (hand yang dikirim ke sini adalah tangan SETELAH dikurangi kartu penutup)
  if (hand.length !== 0) {
    return {
      canClose: false,
      reason: `Masih ada ${hand.length} kartu di tangan selain kartu penutup`
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
