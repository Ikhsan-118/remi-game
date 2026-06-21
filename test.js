/**
 * test.js — Test suite Remi Indonesia Game Logic
 * Jalankan: node test.js
 */

const { Card, Joker } = require('./src/models/Card');
const { Deck } = require('./src/models/Deck');
const { validateMeld, validateSequence, validateSet, validateEat } = require('./src/engine/MeldingValidator');
const { calculatePlayerScore, canCloseGame } = require('./src/engine/ScoreCalculator');
const { GameState } = require('./src/engine/GameState');

let passed = 0;
let failed = 0;

function test(label, fn) {
  try {
    fn();
    console.log(`  ✅ ${label}`);
    passed++;
  } catch (e) {
    console.log(`  ❌ ${label}`);
    console.log(`     → ${e.message}`);
    failed++;
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'Assertion failed');
}

// ─────────────────────────────────────────────────────────
// 1. Model Kartu
// ─────────────────────────────────────────────────────────
console.log('\n📦 Model Kartu');

test('Kartu angka punya 5 poin', () => {
  const c = new Card(7, '♠');
  assert(c.points === 5, `Expected 5, got ${c.points}`);
});
test('Kartu gambar (J/Q/K) punya 10 poin', () => {
  assert(new Card(11, '♥').points === 10);
  assert(new Card(12, '♦').points === 10);
  assert(new Card(13, '♣').points === 10);
});
test('As punya 15 poin', () => {
  assert(new Card(14, '♠').points === 15);
});
test('Deck standar berisi 52 kartu', () => {
  const d = new Deck();
  assert(d.cards.length === 52, `Expected 52, got ${d.cards.length}`);
});
test('Deck dengan joker berisi 54 kartu', () => {
  const d = new Deck(true);
  assert(d.cards.length === 54, `Expected 54, got ${d.cards.length}`);
});

// ─────────────────────────────────────────────────────────
// 2. Validasi Seri
// ─────────────────────────────────────────────────────────
console.log('\n🃏 Validasi Seri (Sequence)');

test('Seri angka valid: 5♠-6♠-7♠', () => {
  const r = validateSequence([new Card(5,'♠'), new Card(6,'♠'), new Card(7,'♠')]);
  assert(r.valid, r.reason);
  assert(r.type === 'SERI_ANGKA');
});
test('Seri angka valid 4 kartu: 3♦-4♦-5♦-6♦', () => {
  const r = validateSequence([3,4,5,6].map(n => new Card(n,'♦')));
  assert(r.valid, r.reason);
});
test('Seri gambar valid: J♥-Q♥-K♥', () => {
  const r = validateSequence([new Card(11,'♥'), new Card(12,'♥'), new Card(13,'♥')]);
  assert(r.valid, r.reason);
  assert(r.type === 'SERI_GAMBAR');
});
test('INVALID: 10♣-J♣-Q♣ (transisi angka→gambar)', () => {
  const r = validateSequence([new Card(10,'♣'), new Card(11,'♣'), new Card(12,'♣')]);
  assert(!r.valid, 'Seharusnya INVALID');
});
test('INVALID: 9♠-10♠-J♠ (transisi angka→gambar)', () => {
  const r = validateSequence([new Card(9,'♠'), new Card(10,'♠'), new Card(11,'♠')]);
  assert(!r.valid, 'Seharusnya INVALID');
});
test('INVALID: A♠-2♠-3♠ (As dalam seri)', () => {
  const r = validateSequence([new Card(14,'♠'), new Card(2,'♠'), new Card(3,'♠')]);
  assert(!r.valid, 'Seharusnya INVALID');
});
test('INVALID: Q♦-K♦-A♦ (As dalam seri)', () => {
  const r = validateSequence([new Card(12,'♦'), new Card(13,'♦'), new Card(14,'♦')]);
  assert(!r.valid, 'Seharusnya INVALID');
});
test('INVALID: seri beda suit (5♠-6♥-7♠)', () => {
  const r = validateSequence([new Card(5,'♠'), new Card(6,'♥'), new Card(7,'♠')]);
  assert(!r.valid, 'Seharusnya INVALID');
});
test('Seri dengan Joker wildcard: 5♠-JOKER-7♠', () => {
  const r = validateSequence([new Card(5,'♠'), new Joker(1), new Card(7,'♠')]);
  assert(r.valid, r.reason);
});

// ─────────────────────────────────────────────────────────
// 3. Validasi Kembar
// ─────────────────────────────────────────────────────────
console.log('\n👥 Validasi Kembar (Set)');

test('Kembar 3 kartu valid: 7♥-7♦-7♠', () => {
  const r = validateSet([new Card(7,'♥'), new Card(7,'♦'), new Card(7,'♠')]);
  assert(r.valid, r.reason);
});
test('Kembar 4 kartu valid: K♣-K♠-K♥-K♦', () => {
  const r = validateSet([13,13,13,13].map((n,i) => new Card(n, ['♣','♠','♥','♦'][i])));
  assert(r.valid, r.reason);
});
test('INVALID kembar: suit duplikat (7♠-7♠-7♦)', () => {
  const r = validateSet([new Card(7,'♠'), new Card(7,'♠'), new Card(7,'♦')]);
  assert(!r.valid, 'Seharusnya INVALID');
});

// ─────────────────────────────────────────────────────────
// 4. Aturan Dasar Seri
// ─────────────────────────────────────────────────────────
console.log('\n🏗 Aturan Dasar Seri');

test('Kembar TIDAK boleh tanpa dasar seri', () => {
  const r = validateMeld(
    [new Card(7,'♥'), new Card(7,'♦'), new Card(7,'♠')],
    false  // hasBaseSeries = false
  );
  assert(!r.valid, 'Seharusnya INVALID tanpa dasar seri');
});
test('Kembar BOLEH setelah ada dasar seri', () => {
  const r = validateMeld(
    [new Card(7,'♥'), new Card(7,'♦'), new Card(7,'♠')],
    true   // hasBaseSeries = true
  );
  assert(r.valid, r.reason);
});
test('Kembar As TIDAK boleh tanpa dasar seri', () => {
  const r = validateMeld(
    [new Card(14,'♠'), new Card(14,'♥'), new Card(14,'♦')],
    false
  );
  assert(!r.valid, 'Seharusnya INVALID');
});
test('Seri bisa diletakkan tanpa dasar seri (untuk jadi dasar)', () => {
  const r = validateMeld(
    [new Card(3,'♣'), new Card(4,'♣'), new Card(5,'♣')],
    false
  );
  assert(r.valid, r.reason);
});

// ─────────────────────────────────────────────────────────
// 5. Skor
// ─────────────────────────────────────────────────────────
console.log('\n💯 Perhitungan Skor');

test('Skenario A: meja +20, tangan -30 = -10', () => {
  const r = calculatePlayerScore({
    melds:         [[3,4,5,6].map(n => new Card(n,'♣'))],
    hand:          [new Card(11,'♣'), new Card(11,'♦'), new Card(12,'♣')],
    hasBaseSeries: true,
    isWinner:      false,
    closingCard:   null,
    pao:           false
  });
  assert(r.total === -10, `Expected -10, got ${r.total}`);
});
test('Skenario B: tanpa dasar seri = semua kartu jadi penalti', () => {
  const cards = [
    new Card(3,'♥'), new Card(3,'♠'), new Card(4,'♠'), new Card(5,'♥'),
    new Card(12,'♥'), new Card(12,'♠'), new Card(12,'♦')
  ];
  const r = calculatePlayerScore({
    melds: [], hand: cards, hasBaseSeries: false,
    isWinner: false, closingCard: null, pao: false
  });
  // 4 kartu angka × 5 poin = 20, 3 kartu Q × 10 poin = 30 → total penalti = -50
  assert(r.total === -50, `Expected -50, got ${r.total}`);
});
test('Tutup game dengan As mendapat +150 bonus', () => {
  const r = calculatePlayerScore({
    melds:         [[3,4,5,6].map(n => new Card(n,'♠'))],
    hand:          [],
    hasBaseSeries: true,
    isWinner:      true,
    closingCard:   new Card(14,'♠'),
    pao:           false
  }, 'traditional');
  assert(r.bonusPoints === 150, `Expected 150 bonus, got ${r.bonusPoints}`);
});
test('Penalti Pao = -150 poin', () => {
  const r = calculatePlayerScore({
    melds: [], hand: [], hasBaseSeries: false,
    isWinner: false, closingCard: null, pao: true
  }, 'traditional');
  assert(r.paoPenalty === -150, `Expected -150, got ${r.paoPenalty}`);
});

// ─────────────────────────────────────────────────────────
// 6. Tutup Game (canCloseGame)
// ─────────────────────────────────────────────────────────
console.log('\n🏁 Tutup Game');

test('Tutup game valid: punya dasar seri + 1 kartu tersisa', () => {
  const r = canCloseGame(
    [[new Card(3,'♠'), new Card(4,'♠'), new Card(5,'♠')]],
    [new Card(7,'♥')],
    true, true
  );
  assert(r.canClose, r.reason);
});
test('INVALID tutup game: belum punya dasar seri', () => {
  const r = canCloseGame([], [new Card(7,'♥')], true, false);
  assert(!r.canClose, 'Seharusnya tidak bisa tutup');
});
test('INVALID tutup sendiri (dari stock pile)', () => {
  const r = canCloseGame(
    [[new Card(3,'♠'), new Card(4,'♠'), new Card(5,'♠')]],
    [new Card(7,'♥')],
    false, // bukan dari buangan lawan
    true
  );
  assert(!r.canClose, 'Seharusnya tidak bisa tutup sendiri');
});

// ─────────────────────────────────────────────────────────
// 7. GameState (integrasi)
// ─────────────────────────────────────────────────────────
console.log('\n🎮 GameState Integrasi');

test('Game dimulai dengan 7 kartu per pemain', () => {
  const g = new GameState(['A', 'B'], { useJokers: false });
  g.startRound();
  assert(g.players[0].hand.length === 7, `P1 punya ${g.players[0].hand.length} kartu`);
  assert(g.players[1].hand.length === 7, `P2 punya ${g.players[1].hand.length} kartu`);
});
test('Stock pile berisi 37 kartu setelah deal (52 - 14 - 1 discard)', () => {
  const g = new GameState(['A', 'B']);
  g.startRound();
  assert(g.stockPile.length === 37, `Expected 37, got ${g.stockPile.length}`);
});
test('Draw dari stock menambah 1 kartu ke tangan', () => {
  const g = new GameState(['A', 'B']);
  g.startRound();
  const before = g.players[0].hand.length;
  const result = g.drawFromStock('A');
  assert(result.success, result.reason);
  assert(g.players[0].hand.length === before + 1);
});
test('Bukan giliran pemain lain tidak boleh draw', () => {
  const g = new GameState(['A', 'B']);
  g.startRound();
  const result = g.drawFromStock('B');
  assert(!result.success, 'Seharusnya gagal');
});

// ─────────────────────────────────────────────────────────
// Hasil
// ─────────────────────────────────────────────────────────
console.log(`\n${'─'.repeat(50)}`);
console.log(`Hasil: ${passed} lulus ✅  |  ${failed} gagal ❌`);
if (failed > 0) process.exit(1);