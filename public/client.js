/**
 * client.js
 * =====================================================
 * Wrapper WebSocket untuk browser.
 * Menyimpan playerId & roomCode di localStorage agar
 * bisa reconnect otomatis jika koneksi putus / refresh.
 *
 * PERBAIKAN:
 *  ✓ FIX: PRODUCTION_SERVER_URL — tambahkan // setelah wss: (bug typo)
 *  ✓ FIX: Reconnect hanya dilakukan jika ada sesi tersimpan yang valid
 */

const RemiClient = (() => {
  // ── GANTI dengan domain server kamu setelah deploy ke Railway/Render ──
  // FIX: Pastikan format wss:// (dua slash), contoh:
  // 'wss://remi-game.up.railway.app'
  const PRODUCTION_SERVER_URL = 'wss://GANTI-DENGAN-DOMAIN-SERVER-KAMU.up.railway.app';

  const isLocalhost = location.hostname === 'localhost' || location.hostname === '127.0.0.1';
  const SERVER_URL  = isLocalhost
    ? (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.hostname + ':8080'
    : PRODUCTION_SERVER_URL;

  let ws               = null;
  let listeners        = {};
  let reconnectAttempts = 0;
  let manualClose      = false;
  let reconnectTimer   = null;

  function on(type, callback) {
    if (!listeners[type]) listeners[type] = [];
    listeners[type].push(callback);
  }

  function off(type, callback) {
    if (!listeners[type]) return;
    listeners[type] = listeners[type].filter(cb => cb !== callback);
  }

  function emit(type, payload = {}) {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type, ...payload }));
    } else {
      console.warn('WebSocket belum terbuka, pesan tidak terkirim:', type);
    }
  }

  function _dispatch(type, data) {
    (listeners[type]  || []).forEach(cb => cb(data));
    (listeners['*']   || []).forEach(cb => cb(type, data));
  }

  function connect() {
    manualClose = false;

    // Jangan buat koneksi baru jika sudah terhubung
    if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
      return;
    }

    ws = new WebSocket(SERVER_URL);

    ws.onopen = () => {
      reconnectAttempts = 0;
      _dispatch('connected', {});

      // Auto-reconnect ke room sebelumnya jika ada sesi tersimpan
      const saved = getSession();
      if (saved.playerId && saved.roomCode) {
        emit('reconnect', { playerId: saved.playerId, code: saved.roomCode });
      }
    };

    ws.onmessage = (event) => {
      let msg;
      try { msg = JSON.parse(event.data); } catch { return; }

      // Simpan sesi otomatis saat room dibuat/bergabung
      if (msg.type === 'room_created' || msg.type === 'room_joined') {
        saveSession(msg.playerId, msg.code);
      }

      _dispatch(msg.type, msg);
    };

    ws.onclose = () => {
      _dispatch('disconnected', {});
      if (!manualClose) {
        reconnectAttempts++;
        const delay = Math.min(1000 * reconnectAttempts, 5000);
        console.log(`Koneksi terputus, reconnect dalam ${delay}ms (percobaan ${reconnectAttempts})`);
        reconnectTimer = setTimeout(connect, delay);
      }
    };

    ws.onerror = (err) => {
      console.error('WebSocket error:', err);
    };
  }

  function disconnect() {
    manualClose = true;
    if (reconnectTimer) clearTimeout(reconnectTimer);
    if (ws) ws.close();
  }

  // ── Sesi lokal (localStorage) ──
  function saveSession(playerId, roomCode) {
    localStorage.setItem('remi_playerId', playerId);
    localStorage.setItem('remi_roomCode', roomCode);
  }
  function getSession() {
    return {
      playerId: localStorage.getItem('remi_playerId'),
      roomCode: localStorage.getItem('remi_roomCode')
    };
  }
  function clearSession() {
    localStorage.removeItem('remi_playerId');
    localStorage.removeItem('remi_roomCode');
  }

  // ── API aksi tingkat tinggi ──
  function createRoom(name, options = {}) { emit('create_room', { name, options }); }
  function joinRoom(code, name)            { emit('join_room',  { code, name }); }
  function setReady(ready)                 { emit('set_ready',  { ready }); }
  function startGame()                     { emit('start_game'); }
  function drawStock()                     { emit('draw_stock'); }
  function drawDiscard(positionFromTop)    { emit('draw_discard', { positionFromTop }); }
  function placeMeld(cardIds)              { emit('place_meld', { cardIds }); }
  function discardCard(cardId, attemptClose = false) { emit('discard', { cardId, attemptClose }); }
  function leaveRoom()                     { emit('leave_room'); clearSession(); }

  return {
    connect, disconnect, on, off, emit,
    getSession, saveSession, clearSession,
    createRoom, joinRoom, setReady, startGame,
    drawStock, drawDiscard, placeMeld, discardCard, leaveRoom
  };
})();
