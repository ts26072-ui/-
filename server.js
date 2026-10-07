'use strict';
// 익명방 서버 (외부 패키지 없이 Node.js 기본 기능만 사용)
//
// - 고정된 방 1개: 코드 없이 모두 같은 방에 들어옵니다. 관리자가 "방 초기화"를 하면 새 방이 열려요.
// - 게시판(디시 스타일), 사진/영상 첨부, 익명 1:1 대화(상대가 수락해야 시작)
// - 닉네임 없음. 작성자 정보는 서버 안에서만 쓰이고 다른 사람에게는 절대 전달되지 않아요.
// - 서로 다른 3명이 신고하면 글/메시지가 자동으로 가려져요.
// - 데이터는 DATA_DIR(기본 ./data)에 저장돼요. Railway에서는 Volume을 /data 에 붙이고 DATA_DIR=/data 로 설정하세요.
// - ADMIN_KEY 환경변수를 설정하면 관리자 기능(삭제/차단/방 초기화/신고 확인)을 쓸 수 있어요.

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const ADMIN_KEY = process.env.ADMIN_KEY || '';
const SCALE = Number(process.env.THROTTLE_SCALE || 1); // 테스트용: 도배 제한 시간 배율
const PUBLIC_DIR = path.join(__dirname, 'public');
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
const DB_FILE = path.join(DATA_DIR, 'data.json');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const REPORT_LIMIT = 3;
const MAX_CHAT = 200;
const MAX_POSTS = 300;
const MAX_COMMENTS = 300;
const MAX_DM = 200;
const BEST_LIKES = 3; // 개념글 기준 추천 수
const MAX_IMG = 10 * 1024 * 1024;
const MAX_VID = 40 * 1024 * 1024;

const UPLOAD_TYPES = {
  'image/jpeg': { ext: 'jpg', max: MAX_IMG },
  'image/png': { ext: 'png', max: MAX_IMG },
  'image/gif': { ext: 'gif', max: MAX_IMG },
  'image/webp': { ext: 'webp', max: MAX_IMG },
  'video/mp4': { ext: 'mp4', max: MAX_VID },
  'video/quicktime': { ext: 'mov', max: MAX_VID },
  'video/webm': { ext: 'webm', max: MAX_VID },
};
const EXT_MIME = {
  jpg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp',
  mp4: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm',
};
const VIDEO_EXT = ['mp4', 'mov', 'webm'];
const STATIC_MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
};

// ───────────── 저장소 ─────────────
function loadJson() {
  try { return JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); } catch { return {}; }
}
const db = Object.assign(
  { epoch: 1, chat: [], posts: [], postNo: 0, threads: [], bans: [], reports: [] },
  loadJson()
);
let saveTimer = null;
function writeNow() {
  const tmp = DB_FILE + '.tmp';
  try {
    fs.writeFileSync(tmp, JSON.stringify(db));
    fs.renameSync(tmp, DB_FILE);
  } catch (e) { console.error('저장 실패:', e.message); }
}
function save() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => { saveTimer = null; writeNow(); }, 400);
}
function shutdown() { writeNow(); process.exit(0); }
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

// ───────────── 유틸 ─────────────
const rid = (n) => crypto.randomBytes(n).toString('hex');
const clean = (t, max) => String(t == null ? '' : t).replace(/\u0000/g, '').trim().slice(0, max);
const bad = (res, msg, status) => json(res, status || 400, { error: msg });

function json(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (c) => {
      data += c;
      if (data.length > 20000) { req.destroy(); resolve(null); }
    });
    req.on('end', () => { try { resolve(JSON.parse(data || '{}')); } catch { resolve(null); } });
    req.on('error', () => resolve(null));
  });
}

const lastAct = new Map();
function tooFast(uid, act, ms) {
  const k = uid + ':' + act, now = Date.now();
  if (now - (lastAct.get(k) || 0) < ms * SCALE) return true;
  lastAct.set(k, now);
  return false;
}
setInterval(() => {
  const cut = Date.now() - 120000;
  for (const [k, t] of lastAct) if (t < cut) lastAct.delete(k);
}, 60000).unref();

const uploadLog = new Map(); // uid -> 최근 1시간 업로드 시각들
function uploadLimited(uid) {
  const now = Date.now();
  const arr = (uploadLog.get(uid) || []).filter((t) => now - t < 3600000);
  if (arr.length >= 30) { uploadLog.set(uid, arr); return true; }
  arr.push(now);
  uploadLog.set(uid, arr);
  return false;
}

function getUid(req, url) {
  const u = String(req.headers['x-uid'] || url.searchParams.get('uid') || '');
  return /^[a-f0-9]{32}$/.test(u) ? u : null;
}
const isBanned = (uid) => db.bans.includes(uid);

// 관리자 인증 (무차별 대입 방지 포함)
const adminFails = new Map();
function adminCheck(req) {
  if (!ADMIN_KEY) return false;
  const ip = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
  const now = Date.now();
  const fails = (adminFails.get(ip) || []).filter((t) => now - t < 600000);
  if (fails.length >= 10) return 'locked';
  let key = '';
  try { key = decodeURIComponent(String(req.headers['x-admin'] || '')); } catch { key = ''; }
  const a = crypto.createHash('sha256').update(key).digest();
  const b = crypto.createHash('sha256').update(ADMIN_KEY).digest();
  if (crypto.timingSafeEqual(a, b)) return true;
  fails.push(now);
  adminFails.set(ip, fails);
  return false;
}

// ───────────── 실시간(SSE) ─────────────
const conns = new Set();
const sendRaw = (c, p) => { try { c.res.write('data: ' + JSON.stringify(p) + '\n\n'); } catch {} };
const broadcast = (p) => { for (const c of conns) sendRaw(c, p); };
const sendTo = (uid, p) => { for (const c of conns) if (c.uid === uid) sendRaw(c, p); };
const onlineCount = () => new Set([...conns].map((c) => c.uid)).size;

// ───────────── 공개용 변환 (작성자 정보는 절대 포함하지 않음) ─────────────
const pubMsg = (m) => ({
  id: m.id, text: m.hidden ? null : m.text, media: m.hidden ? null : (m.media || null),
  hidden: !!m.hidden, ts: m.ts, n: m.n || '',
});
const findPost = (id) => db.posts.find((x) => x.id === id && !x.deleted) || null;
const visibleComments = (po) => po.comments.filter((c) => !c.deleted);

function pubPostItem(po) {
  return {
    id: po.id, no: po.no, title: po.title, ts: po.ts, views: po.views,
    likes: po.likers.length, comments: visibleComments(po).length, media: po.media.length > 0,
  };
}
function pubPost(po, uid) {
  if (po.hidden) return { id: po.id, no: po.no, hidden: true, title: '신고로 가려진 글이에요.' };
  return Object.assign(pubPostItem(po), {
    text: po.text, media: po.media, liked: po.likers.includes(uid), mine: po.author === uid,
    comments: visibleComments(po).map((c) => ({
      id: c.id, ts: c.ts, hidden: !!c.hidden, text: c.hidden ? null : c.text, mine: c.author === uid,
    })),
  });
}

function findItem(kind, id, postId) {
  if (kind === 'chat') return db.chat.find((x) => x.id === id) || null;
  const po = findPost(kind === 'post' ? id : postId);
  if (!po) return null;
  if (kind === 'post') return po;
  if (kind === 'comment') return po.comments.find((c) => c.id === id && !c.deleted) || null;
  return null;
}
function snippetOf(kind, it) {
  const t = kind === 'post' ? it.title : (it.text || '(사진/영상)');
  return String(t).slice(0, 40);
}

function normMedia(x) {
  if (!x || typeof x !== 'object') return null;
  const m = /^\/media\/([a-f0-9]{24}\.(jpg|png|gif|webp|mp4|webm|mov))$/.exec(String(x.url || ''));
  if (!m || !fs.existsSync(path.join(UPLOAD_DIR, m[1]))) return null;
  return { url: '/media/' + m[1], kind: VIDEO_EXT.includes(m[2]) ? 'video' : 'image' };
}

// ───────────── 1:1 대화 ─────────────
const findThread = (x, y) => db.threads.find((t) => (t.a === x && t.b === y) || (t.a === y && t.b === x));
const isMember = (t, uid) => t.a === uid || t.b === uid;
const otherOf = (t, uid) => (t.a === uid ? t.b : t.a);

function viewStatus(t, uid) {
  const iReq = t.requester === uid;
  if (t.status === 'pending' || t.status === 'active') return t.status;
  if (t.status === 'declined') return iReq ? 'pending' : null; // 거절은 요청한 쪽에 알리지 않아요
  if (t.status === 'blocked') {
    if (t.blockedBy === uid) return null;
    return t.wasActive ? 'closed' : (iReq ? 'pending' : null);
  }
  return null;
}
function pubThread(t, uid) {
  const side = t.a === uid ? 'a' : 'b';
  const status = viewStatus(t, uid);
  const last = t.messages.length ? t.messages[t.messages.length - 1].ts : t.ts;
  return {
    id: t.id, status, iRequested: t.requester === uid, snippet: t.snippet, ts: t.ts, last,
    unread: t.messages.filter((m) => m.from !== uid && m.ts > (t['read_' + side] || 0)).length,
    messages: t.messages.map((m) => ({ id: m.id, mine: m.from === uid, text: m.text, media: m.media || null, ts: m.ts })),
  };
}
function notifyThread(t, kind) {
  sendTo(t.a, { type: 'dm', kind: kind || 'update', threadId: t.id });
  sendTo(t.b, { type: 'dm', kind: kind || 'update', threadId: t.id });
}

// ───────────── 업로드 / 미디어 ─────────────
function sniffOk(ext, b) {
  if (b.length < 12) return false;
  switch (ext) {
    case 'jpg': return b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;
    case 'png': return b[0] === 0x89 && b.toString('latin1', 1, 4) === 'PNG';
    case 'gif': return b.toString('latin1', 0, 4) === 'GIF8';
    case 'webp': return b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP';
    case 'mp4': case 'mov': return b.toString('latin1', 4, 8) === 'ftyp';
    case 'webm': return b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3;
    default: return false;
  }
}

function upload(req, res, uid) {
  const fail = (status, msg) => {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', Connection: 'close' });
    res.end(JSON.stringify({ error: msg }));
    res.on('finish', () => req.destroy());
  };
  if (isBanned(uid)) return fail(403, '업로드할 수 없는 상태예요.');
  const type = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
  const spec = UPLOAD_TYPES[type];
  if (!spec) return fail(415, '사진(jpg/png/gif/webp)이나 영상(mp4/mov/webm)만 올릴 수 있어요.');
  if ((Number(req.headers['content-length']) || 0) > spec.max) {
    return fail(413, '파일이 너무 커요. 사진은 10MB, 영상은 40MB까지예요.');
  }
  if (tooFast(uid, 'upload', 3000)) return fail(429, '잠시 후에 다시 올려 주세요.');
  if (uploadLimited(uid)) return fail(429, '업로드는 1시간에 30개까지예요.');

  const name = rid(12) + '.' + spec.ext;
  const file = path.join(UPLOAD_DIR, name);
  const out = fs.createWriteStream(file);
  let size = 0, head = Buffer.alloc(0), checked = false, dead = false;

  const abort = (status, msg) => {
    if (dead) return;
    dead = true;
    req.unpipe(out);
    out.destroy();
    fs.unlink(file, () => {});
    fail(status, msg);
  };

  req.on('data', (chunk) => {
    if (dead) return;
    size += chunk.length;
    if (size > spec.max) return abort(413, '파일이 너무 커요. 사진은 10MB, 영상은 40MB까지예요.');
    if (!checked) {
      head = Buffer.concat([head, chunk]).subarray(0, 32);
      if (head.length >= 12) {
        checked = true;
        if (!sniffOk(spec.ext, head)) return abort(400, '올바른 사진/영상 파일이 아니에요.');
      }
    }
  });
  req.on('error', () => abort(400, '업로드가 중단됐어요.'));
  out.on('finish', () => {
    if (dead) return;
    if (!checked) {
      dead = true;
      fs.unlink(file, () => {});
      return json(res, 400, { error: '올바른 사진/영상 파일이 아니에요.' });
    }
    json(res, 200, { url: '/media/' + name, kind: VIDEO_EXT.includes(spec.ext) ? 'video' : 'image' });
  });
  req.pipe(out);
}

function serveMedia(req, res, name) {
  const m = /^[a-f0-9]{24}\.(jpg|png|gif|webp|mp4|webm|mov)$/.exec(name);
  if (!m) { res.writeHead(404); return res.end('Not found'); }
  const file = path.join(UPLOAD_DIR, name);
  fs.stat(file, (err, st) => {
    if (err) { res.writeHead(404); return res.end('Not found'); }
    const base = {
      'Content-Type': EXT_MIME[m[1]], 'Accept-Ranges': 'bytes',
      'Cache-Control': 'public, max-age=86400', 'Content-Disposition': 'inline',
    };
    const range = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range || ''));
    if (range && (range[1] || range[2])) {
      let start = range[1] ? parseInt(range[1], 10) : st.size - parseInt(range[2], 10);
      let end = range[1] && range[2] ? parseInt(range[2], 10) : st.size - 1;
      start = Math.max(0, start);
      end = Math.min(end, st.size - 1);
      if (start > end || start >= st.size) {
        res.writeHead(416, { 'Content-Range': 'bytes */' + st.size });
        return res.end();
      }
      res.writeHead(206, Object.assign(base, {
        'Content-Range': `bytes ${start}-${end}/${st.size}`, 'Content-Length': end - start + 1,
      }));
      return fs.createReadStream(file, { start, end }).pipe(res);
    }
    res.writeHead(200, Object.assign(base, { 'Content-Length': st.size }));
    fs.createReadStream(file).pipe(res);
  });
}

// 어디에서도 쓰이지 않는 업로드 파일, 오래된 미응답 1:1 요청 정리
function gc() {
  try {
    const used = new Set();
    for (const m of JSON.stringify(db).matchAll(/\/media\/([a-f0-9]{24}\.[a-z0-9]+)/g)) used.add(m[1]);
    for (const f of fs.readdirSync(UPLOAD_DIR)) {
      if (used.has(f)) continue;
      const fp = path.join(UPLOAD_DIR, f);
      try { if (Date.now() - fs.statSync(fp).mtimeMs > 30 * 60 * 1000) fs.unlinkSync(fp); } catch {}
    }
    const cut = Date.now() - 3 * 86400000;
    const before = db.threads.length;
    db.threads = db.threads.filter((t) => !((t.status === 'pending' || t.status === 'declined') && t.ts < cut));
    if (db.threads.length !== before) save();
  } catch (e) { console.error('정리 실패:', e.message); }
}
setInterval(gc, 10 * 60 * 1000).unref();

// ───────────── 정적 파일 ─────────────
const ROOT_OK = new Set(['/index.html', '/manifest.json']); // public 폴더가 없어도 동작하도록
function serveStatic(res, p) {
  let rel = decodeURIComponent(p);
  if (rel === '/') rel = '/index.html';
  const cands = [[PUBLIC_DIR, path.join(PUBLIC_DIR, rel)]];
  if (ROOT_OK.has(rel)) cands.push([__dirname, path.join(__dirname, rel)]);
  (function next(i) {
    if (i >= cands.length) { res.writeHead(404); return res.end('Not found'); }
    const [base, fp0] = cands[i];
    const fp = path.normalize(fp0);
    if (!fp.startsWith(base + path.sep)) return next(i + 1);
    fs.readFile(fp, (err, data) => {
      if (err) return next(i + 1);
      res.writeHead(200, {
        'Content-Type': STATIC_MIME[path.extname(fp)] || 'application/octet-stream',
        'Cache-Control': 'no-cache',
      });
      res.end(data);
    });
  })(0);
}

// ───────────── SSE ─────────────
function events(req, res, uid) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no',
  });
  const c = { res, uid };
  conns.add(c);
  sendRaw(c, {
    type: 'hello', epoch: db.epoch, online: onlineCount(), adminEnabled: !!ADMIN_KEY,
    banned: isBanned(uid), messages: db.chat.map(pubMsg),
    mine: db.chat.filter((m) => m.author === uid).map((m) => m.id),
  });
  broadcast({ type: 'count', count: onlineCount() });
  const ping = setInterval(() => { try { res.write(': ping\n\n'); } catch {} }, 25000);
  req.on('close', () => {
    clearInterval(ping);
    conns.delete(c);
    broadcast({ type: 'count', count: onlineCount() });
  });
}

// ───────────── 라우터 ─────────────
async function route(req, res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  const url = new URL(req.url || '/', 'http://localhost');
  const p = url.pathname;
  const method = req.method;

  if (p.startsWith('/media/')) return serveMedia(req, res, p.slice(7));
  if (!p.startsWith('/api/')) return serveStatic(res, p);

  const uid = getUid(req, url);
  if (!uid) return bad(res, '잘못된 요청이에요.');
  if (method === 'GET' && p === '/api/events') return events(req, res, uid);
  if (method === 'POST' && p === '/api/upload') return upload(req, res, uid);

  if (p.startsWith('/api/admin/')) {
    const a = adminCheck(req);
    if (a === 'locked') return bad(res, '잠시 후에 다시 시도해 주세요.', 429);
    if (!a) return bad(res, '관리자 키가 맞지 않아요.', 403);
  }

  let body = {};
  if (method === 'POST') {
    body = await readBody(req);
    if (!body) return bad(res, '잘못된 요청이에요.');
  }
  const banned = () => isBanned(uid);

  // ── 채팅 ──
  if (method === 'POST' && p === '/api/chat') {
    if (banned()) return bad(res, '글을 쓸 수 없는 상태예요.', 403);
    const text = clean(body.text, 500);
    const media = normMedia(body.media);
    if (!text && !media) return bad(res, '내용을 입력해 주세요.');
    if (tooFast(uid, 'chat', 1200)) return bad(res, '너무 빨라요. 잠시 후에 다시 보내 주세요.', 429);
    const m = {
      id: rid(6), text, media, ts: Date.now(), hidden: false, author: uid, reporters: [],
      n: String(body.n || '').replace(/[^a-f0-9]/g, '').slice(0, 16),
    };
    db.chat.push(m);
    while (db.chat.length > MAX_CHAT) db.chat.shift();
    save();
    broadcast({ type: 'chat', message: pubMsg(m) });
    return json(res, 200, { id: m.id });
  }

  // ── 신고 (채팅/게시글/댓글) ──
  if (method === 'POST' && p === '/api/report') {
    const it = findItem(body.kind, String(body.id || ''), String(body.postId || ''));
    if (!it || it.author === uid) return json(res, 200, { ok: true });
    if (!it.reporters.includes(uid)) it.reporters.push(uid);
    if (!it.hidden && it.reporters.length >= REPORT_LIMIT) {
      it.hidden = true;
      if (body.kind === 'chat') broadcast({ type: 'update', message: pubMsg(it) });
    }
    save();
    return json(res, 200, { ok: true });
  }

  // ── 게시판 ──
  if (method === 'GET' && p === '/api/posts') {
    const page = Math.max(1, parseInt(url.searchParams.get('page'), 10) || 1);
    let list = db.posts.filter((x) => !x.deleted && !x.hidden);
    if (url.searchParams.get('best') === '1') list = list.filter((x) => x.likers.length >= BEST_LIKES);
    list = list.slice().reverse();
    const per = 20, pages = Math.max(1, Math.ceil(list.length / per));
    return json(res, 200, { posts: list.slice((page - 1) * per, page * per).map(pubPostItem), page, pages });
  }
  if (method === 'POST' && p === '/api/posts') {
    if (banned()) return bad(res, '글을 쓸 수 없는 상태예요.', 403);
    const title = clean(body.title, 60);
    const text = clean(body.text, 3000);
    const media = (Array.isArray(body.media) ? body.media : []).slice(0, 4).map(normMedia).filter(Boolean);
    if (!title) return bad(res, '제목을 입력해 주세요.');
    if (!text && !media.length) return bad(res, '내용을 입력해 주세요.');
    if (tooFast(uid, 'post', 20000)) return bad(res, '글은 20초에 한 번만 쓸 수 있어요.', 429);
    const po = {
      id: rid(4), no: ++db.postNo, title, text, media, ts: Date.now(), views: 0,
      author: uid, likers: [], reporters: [], hidden: false, deleted: false, comments: [],
    };
    db.posts.push(po);
    while (db.posts.length > MAX_POSTS) db.posts.shift();
    save();
    return json(res, 200, { id: po.id });
  }
  const pm = /^\/api\/posts\/([a-f0-9]{8})(\/comments|\/like)?$/.exec(p);
  if (pm) {
    const po = findPost(pm[1]);
    if (!po) return bad(res, '없는 글이에요.', 404);
    if (method === 'GET' && !pm[2]) {
      if (!po.hidden) {
        po.viewedBy = po.viewedBy || [];
        if (!po.viewedBy.includes(uid) && po.viewedBy.length < 2000) { po.viewedBy.push(uid); po.views++; save(); }
      }
      return json(res, 200, { post: pubPost(po, uid) });
    }
    if (method === 'POST' && pm[2] === '/like') {
      if (po.hidden) return bad(res, '가려진 글이에요.');
      if (!po.likers.includes(uid)) { po.likers.push(uid); save(); }
      return json(res, 200, { likes: po.likers.length });
    }
    if (method === 'POST' && pm[2] === '/comments') {
      if (banned()) return bad(res, '글을 쓸 수 없는 상태예요.', 403);
      if (po.hidden) return bad(res, '가려진 글이에요.');
      const text = clean(body.text, 300);
      if (!text) return bad(res, '내용을 입력해 주세요.');
      if (tooFast(uid, 'comment', 5000)) return bad(res, '댓글은 5초에 한 번만 쓸 수 있어요.', 429);
      po.comments.push({ id: rid(5), text, ts: Date.now(), author: uid, reporters: [], hidden: false, deleted: false });
      if (po.comments.length > MAX_COMMENTS) po.comments.shift();
      save();
      return json(res, 200, { ok: true });
    }
  }

  // ── 1:1 대화 ──
  if (method === 'GET' && p === '/api/dm/list') {
    const list = db.threads.filter((t) => isMember(t, uid) && viewStatus(t, uid))
      .map((t) => pubThread(t, uid)).sort((x, y) => y.last - x.last);
    return json(res, 200, { threads: list });
  }
  if (method === 'POST' && p === '/api/dm/request') {
    if (banned()) return bad(res, '요청할 수 없는 상태예요.', 403);
    const kind = String(body.kind || '');
    const it = findItem(kind, String(body.id || ''), String(body.postId || ''));
    if (!it) return bad(res, '대상을 찾을 수 없어요.', 404);
    if (it.author === uid) return bad(res, '내 글에는 요청할 수 없어요.');
    if (isBanned(it.author)) return json(res, 200, { ok: true });
    if (findThread(uid, it.author)) return json(res, 200, { ok: true }); // 이미 있거나 거절/차단된 경우도 똑같이 응답
    const open = db.threads.filter((t) => t.requester === uid && (t.status === 'pending' || t.status === 'declined')).length;
    if (open >= 5) return bad(res, '아직 응답이 없는 요청이 많아요. 시간이 지나면 다시 요청할 수 있어요.', 429);
    if (tooFast(uid, 'dmreq', 3000)) return bad(res, '잠시 후에 다시 시도해 주세요.', 429);
    const t = {
      id: rid(6), a: uid, b: it.author, requester: uid, status: 'pending', snippet: snippetOf(kind, it),
      ts: Date.now(), messages: [], read_a: Date.now(), read_b: 0, blockedBy: null, wasActive: false,
    };
    db.threads.push(t);
    save();
    sendTo(t.b, { type: 'dm', kind: 'request', threadId: t.id });
    return json(res, 200, { ok: true });
  }
  if (p.startsWith('/api/dm/') && method === 'POST') {
    const t = db.threads.find((x) => x.id === String(body.threadId || '') && isMember(x, uid));
    if (!t || !viewStatus(t, uid)) return bad(res, '대화를 찾을 수 없어요.', 404);
    const side = t.a === uid ? 'a' : 'b';

    if (p === '/api/dm/respond') {
      if (t.status !== 'pending' || t.requester === uid) return bad(res, '응답할 수 없는 요청이에요.');
      t.status = body.accept ? 'active' : 'declined';
      if (body.accept) { t.wasActive = true; t.ts = Date.now(); }
      save();
      notifyThread(t, 'update');
      return json(res, 200, { ok: true });
    }
    if (p === '/api/dm/send') {
      if (banned()) return bad(res, '메시지를 보낼 수 없는 상태예요.', 403);
      if (t.status !== 'active') return bad(res, '상대가 수락해야 대화할 수 있어요.', 403);
      const text = clean(body.text, 1000);
      const media = normMedia(body.media);
      if (!text && !media) return bad(res, '내용을 입력해 주세요.');
      if (tooFast(uid, 'dm', 800)) return bad(res, '너무 빨라요.', 429);
      t.messages.push({ id: rid(6), from: uid, text, media, ts: Date.now() });
      while (t.messages.length > MAX_DM) t.messages.shift();
      t['read_' + side] = Date.now();
      save();
      notifyThread(t, 'message');
      return json(res, 200, { ok: true });
    }
    if (p === '/api/dm/read') {
      t['read_' + side] = Date.now();
      save();
      return json(res, 200, { ok: true });
    }
    if (p === '/api/dm/block') {
      t.wasActive = t.wasActive || t.status === 'active';
      t.status = 'blocked';
      t.blockedBy = uid;
      save();
      notifyThread(t, 'update');
      return json(res, 200, { ok: true });
    }
    if (p === '/api/dm/report') {
      if (db.reports.length >= 100) db.reports.shift();
      db.reports.push({
        id: rid(5), ts: Date.now(), other: otherOf(t, uid), snippet: t.snippet,
        messages: t.messages.slice(-20).map((m) => ({ who: m.from === uid ? '신고한 사람' : '상대', text: m.text, media: m.media || null, ts: m.ts })),
      });
      save();
      return json(res, 200, { ok: true });
    }
  }

  // ── 관리자 ──
  if (p === '/api/admin/check' && method === 'GET') {
    return json(res, 200, { ok: true, bans: db.bans.length, reports: db.reports.length, epoch: db.epoch });
  }
  if (p === '/api/admin/delete' && method === 'POST') {
    const it = findItem(body.kind, String(body.id || ''), String(body.postId || ''));
    if (!it) return bad(res, '대상을 찾을 수 없어요.', 404);
    if (body.kind === 'chat') {
      it.hidden = true; it.text = ''; it.media = null;
      broadcast({ type: 'update', message: pubMsg(it) });
    } else if (body.kind === 'post') {
      it.deleted = true; it.text = ''; it.media = [];
    } else {
      it.deleted = true; it.text = '';
    }
    save();
    return json(res, 200, { ok: true });
  }
  if (p === '/api/admin/ban' && method === 'POST') {
    const it = findItem(body.kind, String(body.id || ''), String(body.postId || ''));
    if (!it) return bad(res, '대상을 찾을 수 없어요.', 404);
    if (!db.bans.includes(it.author)) db.bans.push(it.author);
    save();
    return json(res, 200, { ok: true, bans: db.bans.length });
  }
  if (p === '/api/admin/reset-room' && method === 'POST') {
    db.chat = [];
    db.epoch++;
    save();
    broadcast({ type: 'room_reset', epoch: db.epoch });
    return json(res, 200, { ok: true, epoch: db.epoch });
  }
  if (p === '/api/admin/reports' && method === 'GET') {
    return json(res, 200, { reports: db.reports.map((r) => ({ id: r.id, ts: r.ts, snippet: r.snippet, messages: r.messages })) });
  }
  if (p === '/api/admin/report' && method === 'POST') {
    const i = db.reports.findIndex((r) => r.id === String(body.id || ''));
    if (i < 0) return bad(res, '신고를 찾을 수 없어요.', 404);
    if (body.action === 'ban' && !db.bans.includes(db.reports[i].other)) db.bans.push(db.reports[i].other);
    db.reports.splice(i, 1);
    save();
    return json(res, 200, { ok: true });
  }

  return bad(res, '없는 요청이에요.', 404);
}

const server = http.createServer((req, res) => {
  route(req, res).catch((e) => {
    console.error(e);
    if (!res.headersSent) json(res, 500, { error: '서버 오류예요.' });
    else res.end();
  });
});

server.listen(PORT, () => {
  console.log(`익명방 서버 실행 중: http://localhost:${PORT}  (데이터: ${DATA_DIR})`);
  if (!ADMIN_KEY) console.log('※ ADMIN_KEY가 설정되지 않아 관리자 기능이 꺼져 있어요.');
});
