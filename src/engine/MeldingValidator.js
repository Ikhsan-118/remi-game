const { Joker } = require('../models/Card');

function isJoker(card) {
  return card instanceof Joker || card.isJoker === true;
}

function splitJokers(cards) {
  const jokers  = cards.filter(isJoker);
  const normals = cards.filter(c => !isJoker(c));
  return { jokers, normals };
}

function validateSequence(cards) {
  if (cards.length < 3) return { valid: false, reason: 'Seri minimal 3 kartu', type: null };

  const { jokers, normals } = splitJokers(cards);
  const jokerCount = jokers.length;

  if (normals.length === 0) return { valid: false, reason: 'Seri tidak bisa terdiri dari joker semua', type: null };
  if (normals.some(c => c.isAce)) return { valid: false, reason: 'Kartu As tidak boleh digunakan dalam seri', type: null };

  const suits = [...new Set(normals.map(c => c.suit))];
  if (suits.length > 1) return { valid: false, reason: `Seri harus suit sama, ditemukan: ${suits.join(', ')}`, type: null };

  const allNumber = normals.every(c => c.isNumberCard);
  const allFace   = normals.every(c => c.isFaceCard);

  if (!allNumber && !allFace) {
    return { valid: false, reason: 'DILARANG: tidak boleh mencampur kartu angka dan kartu gambar dalam satu seri', type: null };
  }

  if (allFace) {
    const faceRanks = normals.map(c => c.rank).sort((a, b) => a - b);
    if (faceRanks[0] < 11 || faceRanks[faceRanks.length - 1] > 13) return { valid: false, reason: 'Seri gambar hanya boleh J-Q-K', type: null };
    if (cards.length > 3) return { valid: false, reason: 'Seri gambar maksimal 3 kartu (J-Q-K)', type: null };
    const gaps = _countGapsInWindow(faceRanks, cards.length);
    if (gaps > jokerCount) return { valid: false, reason: 'Urutan seri gambar tidak valid bahkan dengan joker', type: null };
    return { valid: true, reason: 'OK', type: 'SERI_GAMBAR' };
  }

  if (allNumber) {
    const sortedRanks = normals.map(c => c.rank).sort((a, b) => a - b);
    const totalLen = cards.length;
    if (sortedRanks[sortedRanks.length - 1] > 10) return { valid: false, reason: 'Kartu angka dalam seri maksimal rank 10', type: null };
    const uniqueRanks = [...new Set(sortedRanks)];
    if (uniqueRanks.length < sortedRanks.length) return { valid: false, reason: 'Tidak boleh ada kartu dengan rank yang sama dalam seri', type: null };

    const minR = sortedRanks[0];
    const maxR = sortedRanks[sortedRanks.length - 1];
    let found = false;
    for (let start = Math.max(2, minR - jokerCount); start <= minR; start++) {
      const end = start + totalLen - 1;
      if (end > 10) break;
      if (end < maxR) continue;
      let gaps = 0;
      for (let r = start; r <= end; r++) { if (!sortedRanks.includes(r)) gaps++; }
      if (gaps <= jokerCount) { found = true; break; }
    }
    if (!found) return { valid: false, reason: `Tidak ada urutan valid untuk kartu [${sortedRanks.join(',')}] dengan ${jokerCount} joker`, type: null };
    return { valid: true, reason: 'OK', type: 'SERI_ANGKA' };
  }

  return { valid: false, reason: 'Kombinasi kartu tidak dikenali sebagai seri', type: null };
}

function _countGapsInWindow(sortedRanks, windowLen) {
  if (sortedRanks.length === 0) return windowLen;
  const min = sortedRanks[0];
  let gaps = 0;
  for (let r = min; r < min + windowLen; r++) { if (!sortedRanks.includes(r)) gaps++; }
  return gaps;
}

function validateSet(cards) {
  if (cards.length < 3 || cards.length > 4) return { valid: false, reason: 'Kembar harus 3 atau 4 kartu', type: null };
  const { normals } = splitJokers(cards);
  if (normals.length === 0) return { valid: false, reason: 'Kembar tidak bisa terdiri dari joker semua', type: null };
  const ranks = [...new Set(normals.map(c => c.rank))];
  if (ranks.length > 1) return { valid: false, reason: `Kembar harus rank sama, ditemukan rank: ${ranks.join(', ')}`, type: null };
  const suits = normals.map(c => c.suit);
  const uniqueSuits = [...new Set(suits)];
  if (uniqueSuits.length < suits.length) return { valid: false, reason: 'Kembar tidak boleh ada suit yang sama dalam satu set', type: null };
  return { valid: true, reason: 'OK', type: 'KEMBAR' };
}

function validateMeld(cards, hasBaseSeries = false) {
  if (!Array.isArray(cards) || cards.length < 3) return { valid: false, reason: 'Minimal 3 kartu untuk kombinasi', type: null, isSet: false };

  const seqResult = validateSequence(cards);
  if (seqResult.valid) return { ...seqResult, isSet: false };

  const setResult = validateSet(cards);
  if (setResult.valid) {
    if (!hasBaseSeries) {
      const { normals } = splitJokers(cards);
      const isAceSet = normals.length > 0 && normals[0].isAce;
      return {
        valid: false,
        reason: isAceSet ? 'Kembar As hanya boleh diletakkan setelah pemain memiliki dasar seri' : 'Kembar hanya boleh diletakkan setelah pemain memiliki dasar seri',
        type: null, isSet: false
      };
    }
    return { ...setResult, isSet: true };
  }

  return { valid: false, reason: `Bukan seri valid (${seqResult.reason}) dan bukan kembar valid (${setResult.reason})`, type: null, isSet: false };
}

function validateEat(targetCard, positionFromTop, handCards, hasBaseSeries, maxPositionFromTop = Infinity) {
  const isMidPile = positionFromTop > 0;
  const targetIsJoker = isJoker(targetCard);

  if (positionFromTop >= maxPositionFromTop) {
    return { allowed: false, reason: `Melebihi batas pengambilan buangan — hanya ${maxPositionFromTop} kartu teratas yang boleh diambil`, requiredMeld: null };
  }

  if (targetIsJoker && isMidPile) return { allowed: false, reason: 'Joker tidak bisa digunakan untuk Makan Tengah', requiredMeld: null };
  if (isMidPile && !hasBaseSeries) return { allowed: false, reason: 'Makan Tengah hanya boleh dilakukan setelah pemain memiliki dasar seri di meja', requiredMeld: null };

  const validMeld = findBestMeld(targetCard, handCards, hasBaseSeries);
  if (!validMeld) return { allowed: false, reason: `Kartu ${targetCard} tidak bisa langsung dikombinasikan dengan kartu di tangan`, requiredMeld: null };

  return { allowed: true, reason: 'OK', requiredMeld: validMeld };
}

function findBestMeld(targetCard, handCards, hasBaseSeries) {
  const n = handCards.length;
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const combo = [targetCard, handCards[i], handCards[j]];
      if (validateMeld(combo, hasBaseSeries).valid) return combo;
    }
  }
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      for (let k = j + 1; k < n; k++) {
        const combo = [targetCard, handCards[i], handCards[j], handCards[k]];
        if (validateMeld(combo, hasBaseSeries).valid) return combo;
      }
    }
  }
  return null;
}

module.exports = { validateMeld, validateSequence, validateSet, validateEat, findBestMeld, isJoker };
