// Shared code for host + player screens.
// Transport: PeerJS (WebRTC) by default, so no server/database is needed.
// Add ?local=1 to the URL to use BroadcastChannel instead (all tabs in one browser) for testing.

const PEER_PREFIX = 'cptrivia-v1-';
const LOCAL_MODE = typeof location !== 'undefined' && new URLSearchParams(location.search).has('local');

function makeCode() {
  const letters = 'ABCDEFGHJKLMNPQRSTUVWXYZ'; // no I/O
  let s = '';
  for (let i = 0; i < 4; i++) s += letters[Math.floor(Math.random() * letters.length)];
  return s;
}

function uid() {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
}

// ---------- Host transport ----------
// handlers: { onMessage(connId, msg), onOpen(connId), onClose(connId), onStatus(text, ok) }
function createHostTransport(code, handlers) {
  if (LOCAL_MODE) return localHost(code, handlers);
  const conns = new Map();
  let peer = null;
  let destroyed = false;

  function start(attempt = 0) {
    peer = new Peer(PEER_PREFIX + code, { debug: 0 });
    peer.on('open', () => handlers.onStatus && handlers.onStatus('Online', true));
    peer.on('connection', (conn) => {
      const id = uid();
      conn.on('open', () => {
        conns.set(id, conn);
        handlers.onOpen && handlers.onOpen(id);
      });
      conn.on('data', (d) => handlers.onMessage(id, d));
      const drop = () => {
        if (conns.get(id) === conn) {
          conns.delete(id);
          handlers.onClose && handlers.onClose(id);
        }
      };
      conn.on('close', drop);
      conn.on('error', drop);
    });
    peer.on('disconnected', () => {
      if (destroyed) return;
      handlers.onStatus && handlers.onStatus('Reconnecting…', false);
      setTimeout(() => { try { peer.reconnect(); } catch (e) {} }, 1000);
    });
    peer.on('error', (err) => {
      if (destroyed) return;
      if (err.type === 'unavailable-id') {
        // Usually after a refresh: the old session hasn't timed out on the broker yet.
        handlers.onStatus && handlers.onStatus('Reclaiming room code…', false);
        try { peer.destroy(); } catch (e) {}
        setTimeout(() => start(attempt + 1), Math.min(2000 + attempt * 1000, 8000));
      } else if (['network', 'server-error', 'socket-error', 'socket-closed'].includes(err.type)) {
        handlers.onStatus && handlers.onStatus('Connection problem, retrying…', false);
      }
    });
  }
  start();

  return {
    send(connId, msg) {
      const c = conns.get(connId);
      if (c && c.open) { try { c.send(msg); } catch (e) {} }
    },
    connIds() { return [...conns.keys()]; },
    destroy() { destroyed = true; try { peer.destroy(); } catch (e) {} },
  };
}

function localHost(code, handlers) {
  const ch = new BroadcastChannel(PEER_PREFIX + code);
  const conns = new Set();
  ch.onmessage = (e) => {
    const m = e.data;
    if (m.to !== 'host') return;
    if (m.kind === 'hello') {
      conns.add(m.from);
      handlers.onOpen && handlers.onOpen(m.from);
      ch.postMessage({ to: m.from, kind: 'welcome' });
    } else if (m.kind === 'bye') {
      conns.delete(m.from);
      handlers.onClose && handlers.onClose(m.from);
    } else if (m.kind === 'msg' && conns.has(m.from)) {
      handlers.onMessage(m.from, m.payload);
    }
  };
  setTimeout(() => handlers.onStatus && handlers.onStatus('Online (local test mode)', true), 0);
  // Ask any already-open player tabs to re-introduce themselves (host refresh).
  ch.postMessage({ to: '*', kind: 'host-up' });
  return {
    send(connId, payload) { ch.postMessage({ to: connId, kind: 'msg', payload }); },
    connIds() { return [...conns]; },
    destroy() { ch.close(); },
  };
}

// ---------- Player transport ----------
// handlers: { onMessage(msg), onStatus(state) } state: 'connecting' | 'open' | 'lost'
function createPlayerTransport(code, handlers) {
  if (LOCAL_MODE) return localPlayer(code, handlers);
  let peer = null, conn = null, closed = false, retryTimer = null;

  function connect() {
    if (closed) return;
    handlers.onStatus('connecting');
    if (!peer || peer.destroyed) {
      peer = new Peer({ debug: 0 });
      peer.on('open', () => openConn());
      peer.on('error', (err) => {
        if (err.type === 'peer-unavailable') handlers.onStatus('nohost');
        scheduleRetry();
      });
      peer.on('disconnected', () => { try { peer.reconnect(); } catch (e) {} });
    } else if (peer.open) {
      openConn();
    }
  }
  function openConn() {
    conn = peer.connect(PEER_PREFIX + code, { reliable: true });
    const thisConn = conn;
    conn.on('open', () => handlers.onStatus('open'));
    conn.on('data', (d) => handlers.onMessage(d));
    conn.on('close', () => { if (conn === thisConn) { handlers.onStatus('lost'); scheduleRetry(); } });
    conn.on('error', () => { if (conn === thisConn) { handlers.onStatus('lost'); scheduleRetry(); } });
  }
  function scheduleRetry() {
    if (closed || retryTimer) return;
    retryTimer = setTimeout(() => {
      retryTimer = null;
      if (conn && conn.open) return;
      if (peer && (peer.destroyed || peer.disconnected)) { try { peer.destroy(); } catch (e) {} peer = null; }
      connect();
    }, 2500);
  }
  // Phones sleep / switch apps: reconnect when the page becomes visible again.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && !(conn && conn.open)) {
      if (peer) { try { peer.destroy(); } catch (e) {} peer = null; }
      connect();
    }
  });
  connect();
  return {
    send(msg) {
      if (conn && conn.open) { try { conn.send(msg); return true; } catch (e) {} }
      return false;
    },
    close() { closed = true; try { peer.destroy(); } catch (e) {} },
  };
}

function localPlayer(code, handlers) {
  const ch = new BroadcastChannel(PEER_PREFIX + code);
  const me = 'p-' + uid();
  let open = false;
  handlers.onStatus('connecting');
  ch.onmessage = (e) => {
    const m = e.data;
    if (m.kind === 'host-up') { ch.postMessage({ to: 'host', from: me, kind: 'hello' }); return; }
    if (m.to !== me) return;
    if (m.kind === 'welcome') { open = true; handlers.onStatus('open'); }
    if (m.kind === 'msg') handlers.onMessage(m.payload);
  };
  ch.postMessage({ to: 'host', from: me, kind: 'hello' });
  window.addEventListener('beforeunload', () => ch.postMessage({ to: 'host', from: me, kind: 'bye' }));
  return {
    send(payload) { if (!open) return false; ch.postMessage({ to: 'host', from: me, kind: 'msg', payload }); return true; },
    close() { ch.postMessage({ to: 'host', from: me, kind: 'bye' }); ch.close(); },
  };
}

// ---------- Answer matching ----------
// Lenient: ignores case, accents, punctuation, "the/a/an", spacing, and small typos.
// Numbers must match exactly (so 1968 != 1969).
function normAnswer(s) {
  return String(s || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/\+/g, ' plus ')
    .replace(/[^a-z0-9.\s]/g, ' ')
    .replace(/(^|\s)\.|\.(\s|$)/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^(the|a|an) /, '');
}

function levenshtein(a, b) {
  if (a === b) return 0;
  const m = a.length, n = b.length;
  if (!m) return n; if (!n) return m;
  // Optimal string alignment distance: swapped neighbours ("ie" vs "ei") count as one typo.
  const d = Array.from({ length: m + 1 }, (_, i) => [i, ...Array(n).fill(0)]);
  for (let j = 0; j <= n; j++) d[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
    }
  }
  return d[m][n];
}

function numbersIn(s) { return (s.match(/\d+(\.\d+)?/g) || []).join('|'); }

function matchOne(g, n) {
  if (!g || !n) return false;
  if (g === n) return true;
  if (g.replace(/[\s.]/g, '') === n.replace(/[\s.]/g, '')) return true;
  // Numbers must match exactly.
  const gn = numbersIn(g), nn = numbersIn(n);
  if (nn && gn !== nn) return false;
  const gs = g.replace(/\s/g, ''), ns = n.replace(/\s/g, '');
  // Typo tolerance scales with length: <=4 chars exact, ~1 typo per 5 chars after that.
  const tol = ns.length <= 4 ? 0 : Math.floor(ns.length / 5);
  if (tol && levenshtein(gs, ns) <= tol) return true;
  // Guess contains the answer as whole words ("mount kilimanjaro" vs "kilimanjaro").
  if (ns.length >= 4 && (' ' + g + ' ').includes(' ' + n + ' ')) return true;
  return false;
}

function isCorrect(guess, question) {
  const g = normAnswer(guess);
  if (!g) return false;
  const answers = [question.a, ...(question.accept || [])].map(normAnswer);
  return answers.some((n) => matchOne(g, n));
}

// ---------- Small DOM helpers ----------
function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  if (attrs) for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = v;
    else if (k === 'style') el.style.cssText = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const k of kids.flat()) {
    if (k == null || k === false) continue;
    el.append(k instanceof Node ? k : document.createTextNode(String(k)));
  }
  return el;
}

if (typeof module !== 'undefined') module.exports = { normAnswer, isCorrect, levenshtein };
