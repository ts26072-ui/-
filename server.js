// 익명 채팅 서버 (외부 패키지 없이 Node.js 기본 기능만 사용)
// - 닉네임/계정 없음. 메시지에 작성자 정보가 붙지 않습니다.
// - 메시지는 메모리에만 최근 100개 보관하고, 서버를 재시작하면 모두 사라집니다.
// - 서로 다른 사람 REPORT_LIMIT명 이상이 신고하면 메시지는 모두에게 숨겨집니다.
// - 방을 만든 사람(방장)은 메시지를 삭제할 수 있습니다.
//
// 통신 방식: 받기 = GET /api/events (SSE), 보내기 = POST /api/* (JSON)

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const REPORT_LIMIT = 3;
const MAX_HISTORY = 100;
const MAX_LEN = 500;
const MIN_INTERVAL_MS = 1200;

const PUBLIC_DIR = path.join(__dirname, 'public');
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
};

const rooms = new Map();   // code -> { hostToken, messages, clients:Set<cid> }
const clients = new Map(); // cid  -> { res, code, lastSent }

function rid(bytes) { return crypto.randomBytes(bytes).toString('hex'); }

function newCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code;
  do {
    code = Array.from(crypto.randomBytes(5), (b) => chars[b % chars.length]).join('');
  } while (rooms.has(code));
  return code;
}

function publicMessage(m) {
  return { id: m.id, text: m.hidden ? null : m.text, hidden: m.hidden, ts: m.ts };
}

function sse(res, payload) {
  res.write('data: ' + JSON.stringify(payload) + '\n\n');
}

function broadcast(room, payload) {
  for (const cid of room.clients) {
    const c = clients.get(cid);
    if (c) sse(c.res, payload);
  }
}

function json(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
      if (data.length > 4096) { req.destroy(); resolve(null); }
    });
    req.on('end', () => {
      try { resolve(JSON.parse(data || '{}')); } catch { resolve(null); }
    });
  });
}

function handleEvents(req, res, url) {
  const code = (url.searchParams.get('code') || '').toUpperCase();
  const hostToken = url.searchParams.get('hostToken') || '';
  const room = rooms.get(code);
  if (!room) return json(res, 404, { error: '없는 방이에요. 코드를 다시 확인해 주세요.' });

  const cid = rid(8); // 신고 중복 방지·도배 제한용 임시 번호. 다른 사람에게는 보내지 않아요.
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  clients.set(cid, { res, code, lastSent: 0 });
  room.clients.add(cid);

  const isHost = !!hostToken && hostToken === room.hostToken;
  sse(res, { type: 'joined', cid, code, isHost, messages: room.messages.map(publicMessage) });
  broadcast(room, { type: 'count', count: room.clients.size });

  const ping = setInterval(() => res.write(': ping\n\n'), 25000);
  req.on('close', () => {
    clearInterval(ping);
    clients.delete(cid);
    room.clients.delete(cid);
    broadcast(room, { type: 'count', count: room.clients.size });
    if (room.clients.size === 0) {
      setTimeout(() => {
        const r = rooms.get(code);
        if (r && r.clients.size === 0) rooms.delete(code);
      }, 10 * 60 * 1000); // 비어 있는 방은 10분 뒤 삭제
    }
  });
}

async function handleApi(req, res, url) {
  if (req.method === 'GET' && url.pathname === '/api/events') return handleEvents(req, res, url);
  if (req.method !== 'POST') return json(res, 405, { error: 'method' });

  const body = await readBody(req);
  if (!body) return json(res, 400, { error: 'bad request' });

  if (url.pathname === '/api/create') {
    const code = newCode();
    const hostToken = rid(16);
    rooms.set(code, { hostToken, messages: [], clients: new Set() });
    return json(res, 200, { code, hostToken });
  }

  const client = clients.get(body.cid);
  const room = client && rooms.get(client.code);
  if (!room) return json(res, 403, { error: '연결이 끊겼어요. 나갔다가 다시 입장해 주세요.' });

  if (url.pathname === '/api/chat') {
    const text = String(body.text || '').trim().slice(0, MAX_LEN);
    if (!text) return json(res, 400, { error: '내용이 비었어요.' });
    const now = Date.now();
    if (now - client.lastSent < MIN_INTERVAL_MS) {
      return json(res, 429, { error: '너무 빨라요. 잠시 후에 다시 보내 주세요.' });
    }
    client.lastSent = now;
    const m = { id: rid(6), text, ts: now, hidden: false, reporters: new Set() };
    room.messages.push(m);
    if (room.messages.length > MAX_HISTORY) room.messages.shift();
    broadcast(room, { type: 'chat', message: publicMessage(m) });
    return json(res, 200, { ok: true });
  }

  if (url.pathname === '/api/report') {
    const m = room.messages.find((x) => x.id === body.id);
    if (!m || m.hidden) return json(res, 200, { ok: true });
    m.reporters.add(body.cid);
    if (m.reporters.size >= REPORT_LIMIT) {
      m.hidden = true;
      broadcast(room, { type: 'update', message: publicMessage(m) });
    }
    return json(res, 200, { ok: true });
  }

  if (url.pathname === '/api/delete') {
    if (body.hostToken !== room.hostToken) return json(res, 403, { error: '방장만 삭제할 수 있어요.' });
    const m = room.messages.find((x) => x.id === body.id);
    if (m) {
      m.hidden = true;
      broadcast(room, { type: 'update', message: publicMessage(m) });
    }
    return json(res, 200, { ok: true });
  }

  return json(res, 404, { error: 'not found' });
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url || '/', 'http://localhost');
  if (url.pathname.startsWith('/api/')) return handleApi(req, res, url);

  let urlPath = decodeURIComponent(url.pathname);
  if (urlPath === '/') urlPath = '/index.html';
  const filePath = path.normalize(path.join(PUBLIC_DIR, urlPath));
  if (!filePath.startsWith(PUBLIC_DIR)) { res.writeHead(403).end('Forbidden'); return; }
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404).end('Not found'); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream' });
    res.end(data);
  });
});

server.listen(PORT, () => console.log(`익명 채팅 서버 실행 중: http://localhost:${PORT}`));
