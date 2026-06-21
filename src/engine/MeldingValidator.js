/**
 * MeldingValidator.js
 * =====================================================
 * Mesin validasi kombinasi kartu Remi Indonesia.
 *
 * Aturan yang diimplementasi:
 *  ✓ Seri Angka (2–10, suit sama, min 3 kartu)
 *  ✓ Seri Gambar (J-Q-K, suit sama)
 *  ✓ LARANGAN transisi Angka→Gambar (10-J tidak valid dalam satu seri)
 *  ✓ LARANGAN As dalam seri (As tidak masuk urutan manapun)
 *  ✓ Kembar/Set (3–4 kartu nilai sama, suit berbeda)
 *  ✓ Kembar memerlukan dasar seri lebih dulu
 *  ✓ Kembar As memerlukan dasar seri lebih dulu
 *  ✓ Joker sebagai wildcard dalam seri/kembar
 *  ✓ FIX: Joker gap logic yang lebih akurat (sliding window)
 *  ✓ NEW: validateEat menerima `maxPositionFromTop` — batas kedalaman
 *         pengambilan buangan (lihat aturan jumlah pemain di GameState.js)
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
 *   - Seri angka: rank 2–10, berurutan (tidak harus mulai dari 2)
 *   - Seri gambar: hanya J(11)-Q(12)-K(13), tepat 3 kartu
 *   - DILARANG: transisi 10→J (angka dan gambar tidak bisa dicampur)
 *   - DILARANG: As dalam seri
 *   - Joker mengisi gap dalam urutan
 *
 * FIX: Menggunakan sliding window untuk menemukan posisi joker terbaik.
 *
 * @returns {{ valid: boolean, reason: string, type: string|null }}
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

  // ── 1. As tidak boleh dalam seri ──
  if (normals.some(c => c.isAce)) {
    return { valid: false, reason: 'Kartu As tidak boleh digunakan dalam seri', type: null };
  }

  // ── 2. Semua suit harus sama ──
  const suits = [...new Set(normals.map(c => c.suit))];
  if (suits.length > 1) {
    return { valid: false, reason: `Seri harus suit sama, ditemukan: ${suits.join(', ')}`, type: null };
  }

  // ── 3. Tentukan tipe seri ──
  const allNumber = normals.every(c => c.isNumberCard);   // rank 2–10
  const allFace   = normals.every(c => c.isFaceCard);     // rank 11–13

  if (!allNumber && !allFace) {
    return {
      valid: false,
      reason: 'DILARANG: tidak boleh mencampur kartu angka dan kartu gambar dalam satu seri (contoh: 10-J-Q tidak valid)',
      type: null
    };
  }

  // ── 4. Seri Gambar: hanya J-Q-K, tepat 3 kartu ──
  if (allFace) {
    const faceRanks = normals.map(c => c.rank).sort((a, b) => a - b);
    if (faceRanks[0] < 11 || faceRanks[faceRanks.length - 1] > 13) {
      return { valid: false, reason: 'Seri gambar hanya boleh J-Q-K', type: null };
    }
    if (cards.length > 3) {
      return { valid: false, reason: 'Seri gambar maksimal 3 kartu (J-Q-K)', type: null };
    }
    // Cek urutan dengan joker
    const sortedFace = normals.map(c => c.rank).sort((a, b) => a - b);
    const gaps = _countGapsInWindow(sortedFace, cards.length);
    if (gaps > jokerCount) {
      return { valid: false, reason: 'Urutan seri gambar tidak valid bahkan dengan joker', type: null };
    }
    return { valid: true, reason: 'OK', type: 'SERI_GAMBAR' };
  }

  // ── 5. Seri Angka: rank 2–10, gunakan sliding window ──
  if (allNumber) {
    const sortedRanks = normals.map(c => c.rank).sort((a, b) => a - b);
    const totalLen = cards.length; // termasuk joker

    // Validasi: rank angka maksimal 10
    if (sortedRanks[sortedRanks.length - 1] > 10) {
      return { valid: false, reason: 'Kartu angka dalam seri maksimal rank 10', type: null };
    }

    // Cek duplikat rank (tidak boleh ada rank yang sama dalam seri)
    const uniqueRanks = [...new Set(sortedRanks)];
    if (uniqueRanks.length < sortedRanks.length) {
      return { valid: false, reason: 'Tidak boleh ada kartu dengan rank yang sama dalam seri', type: null };
    }

    // Sliding window: coba semua window ukuran totalLen dalam rentang 2..10
    const minR = sortedRanks[0];
    const maxR = sortedRanks[sortedRanks.length - 1];

    // Window harus mencakup semua kartu normal
    // Coba window mulai dari (minR - jokerCount) sampai minR
    let found = false;
    for (let start = Math.max(2, minR - jokerCount); start <= minR; start++) {
      const end = start + totalLen - 1;
      if (end > 10) break; // keluar dari range angka
      if (end < maxR) continue; // window tidak cukup besar untuk kartu terbesar

      // Hitung berapa gap dalam window [start..end] yang tidak diisi kartu normal
      let gaps = 0;
      for (let r = start; r <= end; r++) {
        if (!sortedRanks.includes(r)) gaps++;
      }

      if (gaps <= jokerCount) {
        found = true;
        break;
      }
    }

    if (!found) {
      return {
        valid: false,
        reason: `Tidak ada urutan valid untuk kartu [${sortedRanks.join(',')}] dengan ${jokerCount} joker dalam range angka (2-10)`,
        type: null
      };
    }

    return { valid: true, reason: 'OK', type: 'SERI_ANGKA' };
  }

  return { valid: false, reason: 'Kombinasi kartu tidak dikenali sebagai seri', type: null };
}

/** Hitung gap dalam array rank yang sudah terurut untuk window ukuran windowLen */
function _countGapsInWindow(sortedRanks, windowLen) {
  if (sortedRanks.length === 0) return windowLen;
  const min = sortedRanks[0];
  let gaps = 0;
  for (let r = min; r < min + windowLen; r++) {
    if (!sortedRanks.includes(r)) gaps++;
  }
  return gaps;
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
 *   - Nilai rank sama (kecuali joker)
 *   - Suit tidak boleh duplikat (kecuali joker tidak punya suit)
 *
 * @returns {{ valid: boolean, reason: string, type: string|null }}
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
    return { valid: false, reason: `Kembar harus rank sama, ditemukan rank: ${ranks.join(', ')}`, type: null };
  }

  // Suit tidak boleh duplikat antar kartu normal
  const suits = normals.map(c => c.suit);
  const uniqueSuits = [...new Set(suits)];
  if (uniqueSuits.length < suits.length) {
    return { valid: false, reason: 'Kembar tidak boleh ada suit yang sama dalam satu set', type: null };
  }

  // Maksimal 4 suit berbeda, jadi maksimal 4 kartu (sudah dicek di atas)
  if (cards.length > 4) {
    return { valid: false, reason: 'Kembar maksimal 4 kartu (satu per suit)', type: null };
  }

  return { valid: true, reason: 'OK', type: 'KEMBAR' };
}

// -------------------------------------------------------
// Validator Utama (detect type otomatis)
// -------------------------------------------------------

/**
 * Validasi kombinasi — deteksi otomatis apakah seri atau kembar.
 *
 * Aturan prioritas:
 *  1. Coba validasi sebagai Seri dulu
 *  2. Jika gagal, coba validasi sebagai Kembar
 *  3. Kembar memerlukan hasBaseSeries = true
 *  4. Kembar As memerlukan hasBaseSeries = true
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
    // Kembar (apapun) butuh dasar seri lebih dulu
    if (!hasBaseSeries) {
      const { normals } = splitJokers(cards);
      const isAceSet = normals.length > 0 && normals[0].isAce;
      return {
        valid: false,
        reason: isAceSet
          ? 'Kembar As hanya boleh diletakkan setelah pemain memiliki dasar seri'
          : 'Kembar hanya boleh diletakkan setelah pemain memiliki dasar seri',
        type: null,
        isSet: false
      };
    }
    return { ...setResult, isSet: true };
  }

  // ── Keduanya gagal ──
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
 *  - "Makan Rel" (positionFromTop=0, kartu paling atas):
 *      Kartu target + min 2 kartu di tangan harus bisa membentuk kombinasi valid
 *      yang LANGSUNG diletakkan.
 *  - "Makan Tengah" (positionFromTop > 0):
 *      Hanya boleh jika sudah punya dasar seri.
 *      Kartu yang dimakan + semua kartu di atasnya masuk ke tangan.
 *      Pemain wajib langsung meletakkan kombinasi yang menyertakan kartu yang dimakan.
 *  - Joker: tidak boleh untuk makan tengah.
 *  - NEW — Batas Kedalaman Pengambilan (maxPositionFromTop):
 *      Pada permainan dengan banyak pemain, jumlah kartu yang bisa "dilihat ke bawah"
 *      dari tumpukan buangan dibatasi (lihat GameState._computeMaxEatDepth).
 *      positionFromTop yang melebihi batas ini selalu ditolak, apa pun isi tangan pemain.
 *
 * @param {Card}    targetCard          — kartu yang ingin dimakan
 * @param {number}  positionFromTop     — 0 = atas (rel), 1+ = tengah
 * @param {Card[]}  handCards           — kartu di tangan pemain saat ini
 * @param {boolean} hasBaseSeries       — sudah punya dasar seri?
 * @param {number}  maxPositionFromTop  — batas kedalaman pengambilan (default: tak terbatas)
 *
 * @returns {{ allowed: boolean, reason: string, requiredMeld: Card[]|null }}
 */
function validateEat(targetCard, positionFromTop, handCards, hasBaseSeries, maxPositionFromTop = Infinity) {
  const isMidPile      = positionFromTop > 0;
  const targetIsJoker  = isJoker(targetCard);

  // NEW: Batas kedalaman pengambilan buangan (berlaku untuk semua posisi,
  // termasuk posisi teratas jika entah bagaimana batasnya 0 — namun secara
  // praktik batas minimum yang masuk akal adalah 1).
  if (positionFromTop >= maxPositionFromTop) {
    return {
      allowed: false,
      reason: `Melebihi batas pengambilan buangan — hanya ${maxPositionFromTop} kartu teratas yang boleh diambil`,
      requiredMeld: null
    };
  }

  // Joker tidak boleh untuk makan tengah
  if (targetIsJoker && isMidPile) {
    return { allowed: false, reason: 'Joker tidak bisa digunakan untuk Makan Tengah', requiredMeld: null };
  }

  // Makan Tengah hanya boleh setelah dasar seri
  if (isMidPile && !hasBaseSeries) {
    return {
      allowed: false,
      reason: 'Makan Tengah hanya boleh dilakukan setelah pemain memiliki dasar seri di meja',
      requiredMeld: null
    };
  }

  // Cek apakah kartu target bisa langsung dikombinasikan dengan kartu di tangan
  const validMeld = findBestMeld(targetCard, handCards, hasBaseSeries);

  if (!validMeld) {
    return {
      allowed: false,
      reason: `Kartu ${targetCard} tidak bisa langsung dikombinasikan dengan kartu di tangan (butuh min 2 kartu pendamping yang cocok)`,
      requiredMeld: null
    };
  }

  return { allowed: true, reason: 'OK', requiredMeld: validMeld };
}

/**
 * Cari kombinasi terbaik yang menyertakan targetCard dari kartu di tangan.
 * Mencoba semua kombinasi 3 dan 4 kartu.
 * Digunakan untuk validasi makan.
 *
 * @param {Card}    targetCard
 * @param {Card[]}  handCards
 * @param {boolean} hasBaseSeries
 * @returns {Card[]|null}
 */
function findBestMeld(targetCard, handCards, hasBaseSeries) {
  const n = handCards.length;

  // Coba kombinasi 3 kartu (targetCard + 2 dari tangan)
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const combo = [targetCard, handCards[i], handCards[j]];
      const result = validateMeld(combo, hasBaseSeries);
      if (result.valid) return combo;
    }
  }

  // Coba kombinasi 4 kartu (targetCard + 3 dari tangan)
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      for (let k = j + 1; k < n; k++) {
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
