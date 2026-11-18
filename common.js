// Shared code for host + player screens.
// Transport: public MQTT relay over secure WebSockets (no server or account of our own needed).
// Add ?local=1 to the URL to use BroadcastChannel instead (all tabs in one browser) for testing.

const PEER_PREFIX = 'cptrivia-v1-'; // BroadcastChannel name prefix for local test mode
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

// ---------- Relay (MQTT over secure WebSockets) ----------
// Everyone connects out to public MQTT brokers, so it works on any Wi-Fi or cellular network.
// We connect to two brokers at once and send through both; duplicates are dropped by id, stale ones by seq.
const BROKERS = (() => {
  const p = typeof location !== 'undefined' && new URLSearchParams(location.search).get('broker');
  return p ? p.split(',') : ['wss://broker.emqx.io:8084/mqtt', 'wss://broker.hivemq.com:8884/mqtt'];
})();
const TOPIC = (code) => 'cptrivia/v2/' + code;
let seqCounter = 0;
const nextSeq = () => Date.now() * 1000 + (seqCounter = (seqCounter + 1) % 1000);

function createRelay(name, subs, onMsg, onState, will) {
  const seen = new Set(), seenQ = [], lastSeq = {};
  const clients = BROKERS.map((url) => {
    const c = mqtt.connect(url, {
      clientId: 'cpt-' + name + '-' + Math.random().toString(36).slice(2, 8),
      clean: true, keepalive: 20, reconnectPeriod: 2000, connectTimeout: 8000,
      will: will ? { topic: will.topic, payload: JSON.stringify(will.msg), qos: 1 } : undefined,
    });
    c.on('connect', () => { c.subscribe(subs, { qos: 1 }); onState(); });
    c.on('close', onState);
    c.on('offline', onState);
    c.on('error', () => {});
    c.on('message', (topic, buf) => {
      let m; try { m = JSON.parse(buf.toString()); } catch (e) { return; }
      if (!m || !m.id || seen.has(m.id)) return;
      seen.add(m.id); seenQ.push(m.id); if (seenQ.length > 2000) seen.delete(seenQ.shift());
      if (m.kind === 'msg' && m.seq) {
        const k = m.from || '?';
        if (lastSeq[k] && m.seq <= lastSeq[k]) return; // older than something we already handled
        lastSeq[k] = m.seq;
      }
      onMsg(topic, m);
    });
    return c;
  });
  return {
    publish(topic, m) {
      m.id = m.id || uid(); m.seq = nextSeq();
      const s = JSON.stringify(m); let ok = false;
      for (const c of clients) if (c.connected) { c.publish(topic, s, { qos: 1 }); ok = true; }
      return ok;
    },
    connected() { return clients.some((c) => c.connected); },
    end() { for (const c of clients) { try { c.end(true); } catch (e) {} } },
  };
}

// ---------- Host transport ----------
// handlers: { onMessage(connId, msg), onOpen(connId), onClose(connId), onStatus(text, ok) }
function createHostTransport(code, handlers) {
  if (LOCAL_MODE) return localHost(code, handlers);
  const T = TOPIC(code);
  const conns = new Map(); // playerId -> last heard (ms)
  let relay = null;
  const status = () => {
    if (!relay) return;
    const ok = relay.connected();
    handlers.onStatus && handlers.onStatus(ok ? 'Online' : 'Connecting…', ok);
    if (ok) relay.publish(T + '/all', { from: 'host', kind: 'host-up' }); // players re-introduce themselves
  };
  relay = createRelay('h' + code, [T + '/host'], (topic, m) => {
    const from = m.from; if (!from || from === 'host') return;
    if (m.kind === 'bye') { if (conns.delete(from)) handlers.onClose && handlers.onClose(from); return; }
    const isNew = !conns.has(from);
    conns.set(from, Date.now());
    if (m.kind === 'hello') {
      relay.publish(T + '/p/' + from, { from: 'host', kind: 'welcome' });
      handlers.onOpen && handlers.onOpen(from);
      return;
    }
    if (isNew) handlers.onOpen && handlers.onOpen(from);
    if (m.kind === 'msg') handlers.onMessage(from, m.payload);
  }, () => setTimeout(status, 0));
  const prune = setInterval(() => {
    const now = Date.now();
    for (const [id, t] of conns) if (now - t > 30000) { conns.delete(id); handlers.onClose && handlers.onClose(id); }
  }, 5000);
  return {
    send(connId, msg) { relay.publish(T + '/p/' + connId, { from: 'host', kind: 'msg', payload: msg }); },
    connIds() { return [...conns.keys()]; },
    destroy() { clearInterval(prune); relay.end(); },
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
// handlers: { onMessage(msg), onStatus(state) } state: 'connecting' | 'open' | 'nohost'
function createPlayerTransport(code, handlers) {
  if (LOCAL_MODE) return localPlayer(code, handlers);
  const T = TOPIC(code);
  const me = 'p' + uid();
  let open = false, tries = 0, relay = null;
  const setOpen = () => { tries = 0; if (!open) { open = true; handlers.onStatus('open'); } };
  const sayHello = () => relay && relay.publish(T + '/host', { from: me, kind: 'hello' });
  const onState = () => {
    if (!relay) return;
    if (!relay.connected()) { if (open) { open = false; } handlers.onStatus('connecting'); }
    else if (!open) sayHello();
  };
  handlers.onStatus('connecting');
  relay = createRelay(me, [T + '/p/' + me, T + '/all'], (topic, m) => {
    if (m.kind === 'host-up') { open = false; sayHello(); return; }
    if (m.kind === 'welcome') { setOpen(); return; }
    if (m.kind === 'msg') { setOpen(); handlers.onMessage(m.payload); }
  }, () => setTimeout(onState, 0), { topic: T + '/host', msg: { id: 'bye-' + me, from: me, kind: 'bye' } });
  const iv = setInterval(() => {
    if (!relay.connected()) return;
    if (!open) { sayHello(); if (++tries >= 2) handlers.onStatus('nohost'); }
    else relay.publish(T + '/host', { from: me, kind: 'ping' });
  }, 5000);
  return {
    send(msg) { if (!open) return false; return relay.publish(T + '/host', { from: me, kind: 'msg', payload: msg }); },
    close() { clearInterval(iv); relay.publish(T + '/host', { from: me, kind: 'bye' }); relay.end(); },
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
