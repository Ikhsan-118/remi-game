# 🃏 Remi Indonesia — Multiplayer Web Game

Game kartu Remi Indonesia berbasis web dengan sistem InviteCode untuk main bareng teman.

## 📁 Struktur Project

```
remi-game/
├── src/
│   ├── models/
│   │   ├── Card.js          # Model kartu (rank, suit, poin)
│   │   └── Deck.js          # Dek 52 kartu + shuffle
│   ├── engine/
│   │   ├── MeldingValidator.js  # Validasi seri & kembar
│   │   ├── ScoreCalculator.js   # Hitung skor akhir putaran
│   │   └── GameState.js         # State machine giliran
│   └── server/
│       ├── RoomManager.js   # Kelola room & InviteCode
│       └── server.js        # WebSocket server utama
├── public/
│   ├── lobby.html           # Halaman buat/gabung ruang
│   ├── game.html            # Meja permainan (live, terhubung WebSocket)
│   ├── index.html           # Versi demo statis (tanpa server)
│   └── client.js            # Wrapper WebSocket client
├── test.js                  # 32 test kasus game logic
└── package.json
```

## 🚀 Cara Menjalankan

### 1. Install dependency
```bash
npm install
```

### 2. Jalankan test (opsional, pastikan logic benar)
```bash
npm test
```

### 3. Jalankan WebSocket server (port 8080)
```bash
npm start
```

### 4. Jalankan frontend (port 3000) — di terminal terpisah
```bash
npm run serve-frontend
```

### 5. Buka di browser
```
http://localhost:3000
```

Buka beberapa tab/browser berbeda untuk simulasi multiplayer (2–4 pemain).

## 🌐 Deploy ke Hosting

⚠️ **Netlify hanya bisa hosting frontend (static files)**. WebSocket server butuh koneksi persisten yang TIDAK didukung Netlify Functions (serverless). Jadi arsitekturnya dipisah jadi 2 layanan:

```
Browser pemain
    │
    ├──HTTPS──▶ Netlify (frontend: lobby.html, game.html, client.js)
    │
    └──WSS────▶ Railway / Render (server: src/server/server.js)
```

### Langkah 1 — Deploy server WebSocket ke Railway (gratis)
1. Push project ke GitHub
2. Buka [railway.app](https://railway.app) → login dengan GitHub
3. **New Project** → **Deploy from GitHub repo** → pilih repo ini
4. Set **Start Command**: `node src/server/server.js`
5. Setelah deploy, salin domain publik yang diberikan (contoh: `remi-production.up.railway.app`)

> Railway otomatis inject `process.env.PORT` — server sudah mendukung ini.

Alternatif gratis lain: [render.com](https://render.com) (pilih **Web Service**, environment Node).

### Langkah 2 — Update URL server di frontend
Edit `public/client.js`, baris:
```js
const PRODUCTION_SERVER_URL = 'wss://GANTI-DENGAN-DOMAIN-SERVER-KAMU.up.railway.app';
```
Ganti dengan domain asli dari Railway (pakai `wss://`, bukan `https://`).

### Langkah 3 — Deploy frontend ke Netlify
1. Buka [netlify.app](https://netlify.app) → **Add new site** → **Import an existing project**
2. Hubungkan ke repo GitHub yang sama
3. Netlify otomatis membaca `netlify.toml` (publish dir: `public`, tanpa build command)
4. Klik **Deploy** → dapat domain gratis `nama-acak.netlify.app`

### Langkah 4 — Commit & push perubahan client.js
```bash
git add public/client.js
git commit -m "Update production server URL"
git push
```
Netlify akan auto-redeploy dalam beberapa detik.

### ✅ Selesai
Buka domain Netlify kamu, buat ruang, bagikan link + kode undangan ke teman. Server di Railway tetap berjalan 24/7 menangani semua koneksi WebSocket.

## 🔑 Cara Kerja InviteCode

1. Pemain klik **"Buat Ruang"** → server generate kode 5 karakter (contoh: `T4HVW`), host otomatis masuk lobby.
2. Pemain lain klik **"Gabung Ruang"** → masukkan kode → masuk ke lobby yang sama.
3. Semua pemain klik **"Siap Main"** → host klik **"Mulai Permainan"**.
4. Server membagikan 7 kartu per pemain, game dimulai dengan sinkronisasi real-time via WebSocket.

## 🔄 Reconnect

Jika koneksi putus (refresh halaman, sinyal hilang), `client.js` otomatis menyimpan `playerId` + kode room di `localStorage` dan mencoba reconnect otomatis dalam **60 detik** tanpa kehilangan posisi kartu.

## ✅ Aturan yang Sudah Diimplementasi

- Seri angka & gambar dengan larangan transisi 10→J
- Larangan As dalam seri
- Kembar butuh dasar seri lebih dulu
- Makan Rel vs Makan Tengah
- Joker sebagai wildcard
- Skor meja + penalti tangan + bonus tutup As/Joker + penalti Pao
- Tutup game (Going Out) dengan aturan "Tidak Boleh Tutup Sendiri"
- Stock pile habis → auto game over