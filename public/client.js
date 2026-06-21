/**
 * client.js
 * =====================================================
 * Wrapper WebSocket untuk browser.
 * Menyimpan playerId & roomCode di localStorage agar
 * bisa reconnect otomatis jika koneksi putus / refresh.
 */

const RemiClient = (() => {
  // ── GANTI INI dengan domain server kamu setelah deploy ke Railway/Render ──
  // Contoh: 'wss://remi-production.up.railway.app'
  const PRODUCTION_SERVER_URL = 'wss:remi-game.up.railway.app';

  const isLocalhost = location.hostname === 'localhost' || location.hostname === '127.0.0.1';
  const SERVER_URL = isLocalhost
    ? (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.hostname + ':8080'
    : PRODUCTION_SERVER_URL;

  let ws = null;
  let listeners = {};
  let reconnectAttempts = 0;
  let manualClose = false;

  function on(type, callback) {
    if (!listeners[type]) listeners[type] = [];
    listeners[type].push(callback);
  }

  function emit(type, payload = {}) {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type, ...payload }));
    } else {
      console.warn('WebSocket belum terbuka, pesan ditunda:', type);
    }
  }

  function _dispatch(type, data) {
    (listeners[type] || []).forEach(cb => cb(data));
    (listeners['*'] || []).forEach(cb => cb(type, data));
  }

  function connect() {
    manualClose = false;
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

      // Simpan sesi otomatis saat room dibuat/join/reconnect
      if (msg.type === 'room_created' || msg.type === 'room_joined') {
        saveSession(msg.playerId, msg.code);
      }
      if (msg.type === 'reconnected') {
        // sesi tetap, tidak perlu disimpan ulang
      }

      _dispatch(msg.type, msg);
    };

    ws.onclose = () => {
      _dispatch('disconnected', {});
      if (!manualClose) {
        reconnectAttempts++;
        const delay = Math.min(1000 * reconnectAttempts, 5000);
        setTimeout(connect, delay);
      }
    };

    ws.onerror = (err) => {
      console.error('WebSocket error:', err);
    };
  }

  function disconnect() {
    manualClose = true;
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
  function joinRoom(code, name)            { emit('join_room', { code, name }); }
  function setReady(ready)                 { emit('set_ready', { ready }); }
  function startGame()                     { emit('start_game'); }
  function drawStock()                     { emit('draw_stock'); }
  function drawDiscard(positionFromTop)    { emit('draw_discard', { positionFromTop }); }
  function placeMeld(cardIds)              { emit('place_meld', { cardIds }); }
  function discardCard(cardId, attemptClose=false) { emit('discard', { cardId, attemptClose }); }
  function leaveRoom()                     { emit('leave_room'); clearSession(); }

  return {
    connect, disconnect, on, emit,
    getSession, clearSession,
    createRoom, joinRoom, setReady, startGame,
    drawStock, drawDiscard, placeMeld, discardCard, leaveRoom
  };
})();
