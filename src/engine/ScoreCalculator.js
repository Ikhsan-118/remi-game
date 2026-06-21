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
 *  - BEBAS dari mana saja (stock atau buangan lawan) — tidak ada batasan
 */

const { isJoker } = require('./MeldingValidator');

const JOKER_HAND_PENALTY = -20;

function sumCardPoints(cards, isPenalty = false, jokerPenalty = JOKER_HAND_PENALTY) {
  return cards.reduce((total, card) => {
    if (isJoker(card)) {
      return total + (isPenalty ? jokerPenalty : 0);
    }
    const pts = card.points;
    return total + (isPenalty ? -pts : pts);
  }, 0);
}

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

  if (hasBaseSeries && melds.length > 0) {
    for (const meld of melds) {
      const pts = sumCardPoints(meld, false);
      tablePoints += pts;
      breakdown.push(`Meja [${meld.map(c => c.toString()).join('-')}]: +${pts}`);
    }
  } else if (!hasBaseSeries && melds.length > 0) {
    breakdown.push('⚠ Kombinasi meja TIDAK DIHITUNG — belum ada dasar seri');
  }

  if (!hasBaseSeries) {
    const allCards = [...hand, ...melds.flat()];
    handPenalty = sumCardPoints(allCards, true, JOKER_HAND_PENALTY);
    tablePoints = 0;
    breakdown.push(`Penalti total (tanpa dasar seri, ${allCards.length} kartu): ${handPenalty}`);
  } else {
    handPenalty = sumCardPoints(hand, true, JOKER_HAND_PENALTY);
    if (hand.length > 0) {
      breakdown.push(`Penalti sisa tangan [${hand.map(c => c.toString()).join(', ')}]: ${handPenalty}`);
    }
  }

  if (isWinner && closingCard && mode === 'traditional') {
    if (!isJoker(closingCard) && closingCard.isAce) {
      bonusPoints = 150;
      breakdown.push(`Bonus tutup dengan As: +${bonusPoints}`);
    } else if (isJoker(closingCard)) {
      bonusPoints = 20;
      breakdown.push(`Bonus tutup dengan Joker: +${bonusPoints}`);
    }
  }

  if (pao) {
    paoPenalty = mode === 'traditional' ? -150 : -2;
    breakdown.push(`Penalti Pao: ${paoPenalty}`);
  }

  const total = tablePoints + handPenalty + bonusPoints + paoPenalty;
  breakdown.push(`─────────────────`);
  breakdown.push(`TOTAL: ${total} poin`);

  return { tablePoints, handPenalty, bonusPoints, paoPenalty, total, breakdown };
}

function calculateRoundScores(players, mode = 'traditional') {
  return players.map((p, i) => ({
    playerId: p.id || `Player${i + 1}`,
    ...calculatePlayerScore(p, mode)
  }));
}

/**
 * Cek apakah kondisi tutup game valid (Going Out).
 * 
 * ATURAN BEBAS: Pemain boleh menutup dengan kartu dari mana saja
 * (stock maupun buangan). Hanya perlu dasar seri + tangan kosong setelah buang.
 */
function canCloseGame(melds, hand, drewFromDiscard = false, hasBaseSeries = false) {
  if (!hasBaseSeries) {
    return { canClose: false, reason: 'Belum memiliki dasar seri — tidak bisa menutup game' };
  }

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
