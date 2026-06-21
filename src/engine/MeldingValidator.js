/**
 * MeldingValidator.js
 * =====================================================
 * Mesin validasi kombinasi kartu Remi Indonesia.
 *
 * Aturan yang diimplementasi:
 *  ✓ Seri Angka (2–10, suit sama, min 3 kartu)
 *  ✓ Seri Gambar (J-Q-K, suit sama)
 *  ✓ LARANGAN transisi Angka→Gambar (10-J tidak valid)
 *  ✓ LARANGAN As dalam seri
 *  ✓ Kembar/Set (3–4 kartu nilai sama, suit berbeda)
 *  ✓ Kembar As (hanya boleh jika sudah ada dasar seri)
 *  ✓ No Laying Off (tidak bisa menempel ke kombinasi lama)
 *  ✓ Joker sebagai wildcard dalam seri/kembar
 */

const { Joker } = require('../models/Card');

// -------------------------------------------------------
// Helper
// -------------------------------------------------------

function isJoker(card) {
  return card instanceof Joker || card.isJoker === true;
}

/** Pisahkan joker dari kartu biasa dalam sebuah array */
function splitJokers(cards) {
  const jokers  = cards.filter(isJoker);
  const normals = cards.filter(c => !isJoker(c));
  return { jokers, normals };
}

// -------------------------------------------------------
// Validasi Seri (Sequence)
// -------------------------------------------------------

/**
 * Cek apakah array kartu membentuk seri valid.
 * Mendukung joker sebagai wildcard.
 *
 * Aturan seri:
 *   - Min 3 kartu
 *   - Semua suit sama (kecuali joker)
 *   - Seri angka: rank 2–10, berurutan
 *   - Seri gambar: hanya J(11)-Q(12)-K(13)
 *   - DILARANG: transisi 10→J, As dalam seri
 *
 * @returns {{ valid: boolean, reason: string, type: string }}
 */
function validateSequence(cards) {
  if (cards.length < 3) {
    return { valid: false, reason: 'Seri minimal 3 kartu', type: null };
  }

  const { jokers, normals } = splitJokers(cards);
  const jokerCount = jokers.length;

  if (normals.length === 0) {
    return { valid: false, reason: 'Seri tidak bisa terdiri dari joker semua', type: null };
  }

  // ── 1. Semua suit harus sama (diabaikan untuk joker) ──
  const suits = [...new Set(normals.map(c => c.suit))];
  if (suits.length > 1) {
    return { valid: false, reason: `Seri harus suit sama, ditemukan: ${suits.join(', ')}`, type: null };
  }

  // ── 2. As tidak boleh dalam seri ──
  if (normals.some(c => c.isAce)) {
    return { valid: false, reason: 'Kartu As tidak boleh digunakan dalam kombinasi seri', type: null };
  }

  // ── 3. Tentukan tipe seri (angka / gambar) ──
  const ranks = normals.map(c => c.rank).sort((a, b) => a - b);
  const minRank = ranks[0];
  const maxRank = ranks[ranks.length - 1];

  const allNumber = normals.every(c => c.isNumberCard);
  const allFace   = normals.every(c => c.isFaceCard);

  if (!allNumber && !allFace) {
    return {
      valid: false,
      reason: 'DILARANG: tidak boleh mencampur kartu angka dan kartu gambar dalam satu seri (mis: 10-J-Q)',
      type: null
    };
  }

  // ── 4. Urutan harus berurutan tanpa gap (kecuali diisi joker) ──
  const sortedRanks = normals.map(c => c.rank).sort((a, b) => a - b);
  const expectedLength = cards.length; // termasuk joker

  // Posisi terendah yang mungkin: minRank sampai minRank + expectedLength - 1
  // Hitung berapa gap yang ada → gap harus ≤ jumlah joker
  let gaps = 0;
  const fullRange = [];
  for (let r = sortedRanks[0]; r <= sortedRanks[0] + expectedLength - 1; r++) {
    fullRange.push(r);
  }

  // Cek apakah semua kartu normal masuk ke range
  for (const r of sortedRanks) {
    if (!fullRange.includes(r)) {
      return { valid: false, reason: `Rank ${r} di luar jangkauan seri`, type: null };
    }
  }

  // Hitung gap dalam range
  for (const r of fullRange) {
    if (!sortedRanks.includes(r)) gaps++;
  }

  if (gaps > jokerCount) {
    return {
      valid: false,
      reason: `Ada ${gaps} gap dalam urutan tapi hanya ${jokerCount} joker tersedia`,
      type: null
    };
  }

  // ── 5. Batas atas seri angka & gambar ──
  if (allFace) {
    // Seri gambar hanya boleh J-Q-K (11,12,13)
    if (minRank < 11 || maxRank > 13) {
      return { valid: false, reason: 'Seri gambar hanya boleh J-Q-K', type: null };
    }
    if (expectedLength > 3) {
      return { valid: false, reason: 'Seri gambar maksimal 3 kartu (J-Q-K)', type: null };
    }
  }

  if (allNumber) {
    // Rank angka maksimal 10
    if (maxRank > 10) {
      return { valid: false, reason: 'Kartu angka maksimal 10', type: null };
    }
  }

  const type = allFace ? 'SERI_GAMBAR' : 'SERI_ANGKA';
  return { valid: true, reason: 'OK', type };
}

// -------------------------------------------------------
// Validasi Kembar (Set)
// -------------------------------------------------------

/**
 * Cek apakah array kartu membentuk kembar (set) valid.
 * Mendukung joker sebagai wildcard.
 *
 * Aturan kembar:
 *   - 3 atau 4 kartu
 *   - Nilai rank sama
 *   - Suit berbeda (tidak boleh ada duplikat suit kecuali joker)
 *
 * @returns {{ valid: boolean, reason: string, type: string }}
 */
function validateSet(cards) {
  if (cards.length < 3 || cards.length > 4) {
    return { valid: false, reason: 'Kembar harus 3 atau 4 kartu', type: null };
  }

  const { jokers, normals } = splitJokers(cards);

  if (normals.length === 0) {
    return { valid: false, reason: 'Kembar tidak bisa terdiri dari joker semua', type: null };
  }

  // Semua rank harus sama
  const ranks = [...new Set(normals.map(c => c.rank))];
  if (ranks.length > 1) {
    return { valid: false, reason: `Kembar harus rank sama, ditemukan: ${ranks.join(', ')}`, type: null };
  }

  // Suit tidak boleh duplikat
  const suits = normals.map(c => c.suit);
  const uniqueSuits = [...new Set(suits)];
  if (uniqueSuits.length < suits.length) {
    return { valid: false, reason: 'Kembar tidak boleh ada suit yang sama', type: null };
  }

  return { valid: true, reason: 'OK', type: 'KEMBAR' };
}

// -------------------------------------------------------
// Validator Utama (detect type otomatis)
// -------------------------------------------------------

/**
 * Validasi kombinasi — deteksi otomatis apakah seri atau kembar.
 *
 * @param {Card[]} cards           — kartu yang ingin diletakkan
 * @param {boolean} hasBaseSeries  — apakah pemain sudah punya dasar seri di meja
 *
 * @returns {{
 *   valid: boolean,
 *   reason: string,
 *   type: 'SERI_ANGKA'|'SERI_GAMBAR'|'KEMBAR'|null,
 *   isSet: boolean
 * }}
 */
function validateMeld(cards, hasBaseSeries = false) {
  if (!Array.isArray(cards) || cards.length < 3) {
    return { valid: false, reason: 'Minimal 3 kartu untuk kombinasi', type: null, isSet: false };
  }

  // ── Coba seri dulu ──
  const seqResult = validateSequence(cards);
  if (seqResult.valid) {
    return { ...seqResult, isSet: false };
  }

  // ── Coba kembar ──
  const setResult = validateSet(cards);
  if (setResult.valid) {
    // Kembar As butuh dasar seri lebih dulu
    const { normals } = splitJokers(cards);
    if (normals.length > 0 && normals[0].isAce && !hasBaseSeries) {
      return {
        valid: false,
        reason: 'Kembar As hanya boleh diletakkan setelah pemain memiliki dasar seri aktif',
        type: null,
        isSet: false
      };
    }
    // Kembar non-seri butuh dasar seri juga
    if (!hasBaseSeries) {
      return {
        valid: false,
        reason: 'Kembar hanya boleh diletakkan setelah pemain memiliki dasar seri aktif',
        type: null,
        isSet: false
      };
    }
    return { ...setResult, isSet: true };
  }

  // ── Keduanya gagal: berikan alasan yang paling relevan ──
  return {
    valid: false,
    reason: `Bukan seri valid (${seqResult.reason}) dan bukan kembar valid (${setResult.reason})`,
    type: null,
    isSet: false
  };
}

// -------------------------------------------------------
// Validasi Makan (Draw from Discard Pile)
// -------------------------------------------------------

/**
 * Cek apakah pemain boleh "memakan" kartu dari discard pile.
 *
 * Aturan:
 *  - "Makan Rel" (kartu paling atas): kartu target + min 2 kartu di tangan
 *    harus bisa membentuk kombinasi valid yang LANGSUNG diletakkan.
 *  - "Makan Tengah" (kartu di bawah teratas): hanya boleh jika sudah punya
 *    dasar seri.
 *  - Joker: bisa dimakan untuk dasar seri, tapi TIDAK boleh untuk makan tengah.
 *
 * @param {Card}    targetCard     — kartu yang ingin dimakan
 * @param {number}  positionFromTop — 0 = atas (rel), 1+ = tengah
 * @param {Card[]}  handCards      — kartu di tangan pemain
 * @param {boolean} hasBaseSeries  — sudah punya dasar seri?
 *
 * @returns {{ allowed: boolean, reason: string, requiredMeld: Card[]|null }}
 */
function validateEat(targetCard, positionFromTop, handCards, hasBaseSeries) {
  const isMidPile = positionFromTop > 0;
  const targetIsJoker = isJoker(targetCard);

  // ── Joker tidak boleh untuk makan tengah ──
  if (targetIsJoker && isMidPile) {
    return { allowed: false, reason: 'Joker tidak bisa digunakan untuk Makan Tengah', requiredMeld: null };
  }

  // ── Makan Tengah hanya boleh setelah dasar seri ──
  if (isMidPile && !hasBaseSeries) {
    return {
      allowed: false,
      reason: 'Makan Tengah dilarang sebelum pemain memiliki dasar seri',
      requiredMeld: null
    };
  }

  // ── Cek apakah target bisa digabung dengan min 2 kartu di tangan ──
  // untuk membentuk kombinasi seri/kembar yang langsung diletakkan
  const candidateCards = [targetCard, ...handCards];
  const validMeld = findBestMeld(targetCard, handCards, hasBaseSeries);

  if (!validMeld) {
    return {
      allowed: false,
      reason: `Kartu ${targetCard} tidak bisa langsung dikombinasikan dengan kartu di tangan`,
      requiredMeld: null
    };
  }

  return { allowed: true, reason: 'OK', requiredMeld: validMeld };
}

/**
 * Cari kombinasi terbaik yang menyertakan targetCard dari kartu di tangan.
 * Digunakan untuk validasi makan.
 */
function findBestMeld(targetCard, handCards, hasBaseSeries) {
  // Coba semua kombinasi 3 kartu yang menyertakan targetCard
  for (let i = 0; i < handCards.length; i++) {
    for (let j = i + 1; j < handCards.length; j++) {
      const combo = [targetCard, handCards[i], handCards[j]];
      const result = validateMeld(combo, hasBaseSeries);
      if (result.valid) return combo;
    }
  }
  // Coba kombinasi 4 kartu
  for (let i = 0; i < handCards.length; i++) {
    for (let j = i + 1; j < handCards.length; j++) {
      for (let k = j + 1; k < handCards.length; k++) {
        const combo = [targetCard, handCards[i], handCards[j], handCards[k]];
        const result = validateMeld(combo, hasBaseSeries);
        if (result.valid) return combo;
      }
    }
  }
  return null;
}

module.exports = {
  validateMeld,
  validateSequence,
  validateSet,
  validateEat,
  findBestMeld,
  isJoker
};