// 금베 서버 (외부 패키지 없이 Node.js 18+ 기본 기능만 사용)
// 채팅 · 게시판 · 쇼츠 · 1:1 · 영어사전 · 업로드 · 관리자
// 받기 = GET /api/events (SSE), 보내기 = POST /api/* (JSON)
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
const PUBLIC_DIR = path.join(__dirname, 'public');
const ADMIN_KEY = process.env.ADMIN_KEY || '';
const DICT_URL = process.env.DICT_URL || 'https://api.dictionaryapi.dev/api/v2/entries/en/';
const TRANSLATE_URL = process.env.TRANSLATE_URL || 'https://api.mymemory.translated.net/get';

const SUBJECTS = ['국어', '수학', '영어', '물리', '화학', '생명과학', '지구과학', '정보', '한국사', '사회', '기타'];
const REPORT_LIMIT = 3, MAX_CHAT = 200, PAGE_SIZE = 20, BEST_LIKES = 3, MAX_LEN = 500;
const DM_EXPIRE_MS = 3 * 24 * 3600 * 1000;
const MAX_VIDEO = 40 * 1024 * 1024, MAX_IMAGE = 10 * 1024 * 1024;

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp',
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime',
};
const UPLOAD_EXT = {
  'image/jpeg': 'jpg', 'image/png': 'png', 'image/gif': 'gif', 'image/webp': 'webp',
  'video/mp4': 'mp4', 'video/webm': 'webm', 'video/quicktime': 'mov',
};

// ───────── 저장소 (data/db.json) ─────────
fs.mkdirSync(UPLOAD_DIR, { recursive: true });
const DB_FILE = path.join(DATA_DIR, 'db.json');
let db = { chat: [], posts: [], shorts: [], threads: [], reports: [], bans: [], blocks: {}, postNo: 0, notes: [], gc: {} };
try { db = { ...db, ...JSON.parse(fs.readFileSync(DB_FILE, 'utf8')) }; } catch { /* 처음 실행 */ }
let saveTimer = null;
function saveNow() {
  clearTimeout(saveTimer); saveTimer = null;
  try { fs.writeFileSync(DB_FILE + '.tmp', JSON.stringify(db)); fs.renameSync(DB_FILE + '.tmp', DB_FILE); }
  catch (e) { console.error('저장 실패:', e.message); }
}
function save() { if (!saveTimer) saveTimer = setTimeout(saveNow, 500); }
['SIGTERM', 'SIGINT'].forEach((s) => process.on(s, () => { saveNow(); process.exit(0); }));

// ───────── 공통 도구 ─────────
const rid = (n) => crypto.randomBytes(n).toString('hex');
const isUid = (u) => /^[a-f0-9]{32}$/.test(u || '');
const clip = (s, n) => String(s == null ? '' : s).trim().slice(0, n);
const lastAct = new Map();
function tooFast(uid, key, ms) {
  const k = key + uid, now = Date.now();
  if (now - (lastAct.get(k) || 0) < ms) return true;
  lastAct.set(k, now);
  return false;
}
function json(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}
function readBody(req, limit = 65536) {
  return new Promise((resolve) => {
    const chunks = []; let size = 0, over = false;
    req.on('data', (c) => { size += c.length; if (size > limit) over = true; else chunks.push(c); });
    req.on('end', () => {
      if (over) return resolve(null);
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); } catch { resolve(null); }
    });
    req.on('error', () => resolve(null));
  });
}
function isAdmin(req) {
  if (!ADMIN_KEY) return false;
  let given = '';
  try { given = decodeURIComponent(req.headers['x-admin'] || ''); } catch { return false; }
  const h = (s) => crypto.createHash('sha256').update(s).digest();
  return crypto.timingSafeEqual(h(given), h(ADMIN_KEY));
}
const isBanned = (uid) => db.bans.includes(uid);
function cleanMedia(m) {
  if (!m || typeof m !== 'object') return null;
  const mm = /^\/uploads\/([a-f0-9]{24}\.(jpg|png|gif|webp|mp4|webm|mov))$/.exec(String(m.url || ''));
  if (!mm || !fs.existsSync(path.join(UPLOAD_DIR, mm[1]))) return null;
  return { kind: /\.(mp4|webm|mov)$/.test(mm[1]) ? 'video' : 'image', url: m.url };
}

// ───────── 실시간 (SSE) ─────────
const clients = new Map(); // cid -> { res, uid }
const sse = (res, payload) => res.write('data: ' + JSON.stringify(payload) + '\n\n');
const onlineCount = () => new Set([...clients.values()].map((c) => c.uid)).size;
function broadcast(payload) { for (const c of clients.values()) sse(c.res, payload); }
function sendTo(uid, payload) { for (const c of clients.values()) if (c.uid === uid) sse(c.res, payload); }

const pubChat = (m) => (m.hidden
  ? { id: m.id, hidden: true, text: null, media: null, ts: m.ts, n: m.n }
  : { id: m.id, hidden: false, text: m.text, media: m.media, ts: m.ts, n: m.n });

function handleEvents(req, res, url) {
  const uid = url.searchParams.get('uid') || '';
  if (!isUid(uid)) return json(res, 400, { error: 'bad uid' });
  res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  const cid = rid(8);
  clients.set(cid, { res, uid });
  sse(res, {
    type: 'hello', adminEnabled: !!ADMIN_KEY, banned: isBanned(uid), online: onlineCount(),
    mine: db.chat.filter((m) => m.uid === uid).map((m) => m.id), messages: db.chat.map(pubChat),
  });
  broadcast({ type: 'count', count: onlineCount() });
  const ping = setInterval(() => res.write(': ping\n\n'), 25000);
  req.on('close', () => { clearInterval(ping); clients.delete(cid); broadcast({ type: 'count', count: onlineCount() }); });
}

// ───────── 글/댓글/쇼츠/채팅 찾기 ─────────
function findItem(kind, id, postId) {
  if (kind === 'chat') return db.chat.find((m) => m.id === id);
  if (kind === 'post') return db.posts.find((p) => p.id === id);
  if (kind === 'short') return db.shorts.find((s) => s.id === id);
  if (kind === 'note') return db.notes.find((n) => n.id === id);
  if (kind === 'comment') { const p = db.posts.find((x) => x.id === postId); return p && p.comments.find((c) => c.id === id); }
  return null;
}
function snippetOf(kind, it) {
  const t = kind === 'post' || kind === 'note' ? it.title : kind === 'short' ? (it.caption || '쇼츠') : it.text;
  return clip(t || '사진/영상', 24);
}
function hide(kind, it) {
  it.hidden = true;
  if (kind === 'chat') broadcast({ type: 'update', message: pubChat(it) });
  save();
}

// ───────── 업로드 / 파일 제공 (Range 지원: 영상 재생에 필요) ─────────
function handleUpload(req, res, uid) {
  if (isBanned(uid)) return json(res, 403, { error: '이 기기는 글쓰기가 제한돼 있어요.' });
  const type = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
  const ext = UPLOAD_EXT[type];
  const max = type.startsWith('video/') ? MAX_VIDEO : MAX_IMAGE;
  const chunks = []; let size = 0, over = false;
  req.on('data', (c) => { size += c.length; if (size > max) over = true; else if (ext) chunks.push(c); });
  req.on('end', () => {
    if (!ext) return json(res, 415, { error: '지원하지 않는 형식이에요. (mp4·webm·mov, jpg·png·gif·webp)' });
    if (over) return json(res, 413, { error: type.startsWith('video/') ? '영상은 40MB까지예요.' : '사진은 10MB까지예요.' });
    if (!size) return json(res, 400, { error: '빈 파일이에요.' });
    const name = rid(12) + '.' + ext;
    fs.writeFile(path.join(UPLOAD_DIR, name), Buffer.concat(chunks), (err) => {
      if (err) return json(res, 500, { error: '저장에 실패했어요.' });
      json(res, 200, { kind: type.startsWith('video/') ? 'video' : 'image', url: '/uploads/' + name });
    });
  });
  req.on('error', () => {});
}
function serveFile(req, res, fp, type, cache) {
  fs.stat(fp, (err, st) => {
    if (err || !st.isFile()) { res.writeHead(404).end('Not found'); return; }
    const h = { 'Content-Type': type, 'Accept-Ranges': 'bytes', 'Cache-Control': cache };
    const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
    if (!m || (m[1] === '' && m[2] === '')) {
      res.writeHead(200, { ...h, 'Content-Length': st.size });
      return req.method === 'HEAD' ? res.end() : fs.createReadStream(fp).pipe(res);
    }
    let start, end;
    if (m[1] === '') { start = Math.max(0, st.size - +m[2]); end = st.size - 1; }
    else { start = +m[1]; end = m[2] === '' ? st.size - 1 : Math.min(+m[2], st.size - 1); }
    if (start > end || start >= st.size) { res.writeHead(416, { 'Content-Range': 'bytes */' + st.size }).end(); return; }
    res.writeHead(206, { ...h, 'Content-Range': `bytes ${start}-${end}/${st.size}`, 'Content-Length': end - start + 1 });
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(fp, { start, end }).pipe(res);
  });
}

// ───────── 영어사전 ─────────
const HANGUL = /[\u3131-\u318e\uac00-\ud7a3]/;
const dictCache = new Map();
async function getJson(url, ms = 7000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    const r = await fetch(url, { signal: ctrl.signal, headers: { 'User-Agent': 'geumbe/1.0' } });
    if (!r.ok) return null;
    return await r.json();
  } finally { clearTimeout(t); }
}
function parseEntry(arr) {
  if (!Array.isArray(arr) || !arr.length) return null;
  const ph = arr.flatMap((e) => e.phonetics || []);
  let audio = (ph.find((p) => p.audio) || {}).audio || '';
  if (audio.startsWith('//')) audio = 'https:' + audio;
  const meanings = arr.flatMap((e) => e.meanings || []).slice(0, 4).map((m) => ({
    pos: m.partOfSpeech || '',
    defs: (m.definitions || []).slice(0, 3).map((d) => ({ def: d.definition, example: d.example || '' })),
  })).filter((m) => m.defs.length);
  if (!meanings.length) return null;
  return {
    word: arr[0].word, meanings, audio: audio || null,
    phonetic: arr[0].phonetic || (ph.find((p) => p.text) || {}).text || '',
  };
}
async function translate(q, from, to) {
  const d = await getJson(`${TRANSLATE_URL}?q=${encodeURIComponent(q)}&langpair=${from}|${to}`);
  if (!d || !d.responseData) return [];
  const list = [d.responseData.translatedText, ...(d.matches || []).map((m) => m.translation)];
  return list.filter((s) => typeof s === 'string' && !/MYMEMORY WARNING/i.test(s)).map((s) => s.trim());
}
const uniq = (a, n) => [...new Set(a)].slice(0, n);
async function dictLookup(q) {
  if (HANGUL.test(q)) {
    const list = await translate(q, 'ko', 'en');
    const words = list.map((s) => s.toLowerCase().replace(/[.!?]+$/, ''))
      .filter((s) => s && s.length <= 30 && /^[a-z][a-z' -]*$/.test(s) && s.split(/\s+/).length <= 3);
    return { kind: 'ko', query: q, translations: uniq(words, 8) };
  }
  const [entry, ko] = await Promise.all([
    getJson(DICT_URL + encodeURIComponent(q.toLowerCase())).then(parseEntry).catch(() => undefined),
    translate(q.toLowerCase(), 'en', 'ko').catch(() => undefined),
  ]);
  if (entry === undefined && ko === undefined) throw new Error('dict unreachable');
  const kos = uniq((ko || []).filter((s) => HANGUL.test(s) && s.length <= 20), 4);
  return { kind: 'en', query: q, entry: entry || null, ko: kos };
}
async function handleDict(res, url) {
  const q = clip(url.searchParams.get('q'), 40);
  if (!q) return json(res, 400, { error: '검색어를 입력해 주세요.' });
  const key = q.toLowerCase(), hit = dictCache.get(key);
  if (hit && Date.now() - hit.t < 3600e3) return json(res, 200, hit.d);
  try {
    const d = await dictLookup(q);
    if (dictCache.size > 500) dictCache.clear();
    dictCache.set(key, { t: Date.now(), d });
    json(res, 200, d);
  } catch { json(res, 502, { error: '사전 서버에 연결하지 못했어요. 잠시 후 다시 시도해 주세요.' }); }
}

// ───────── 1:1 ─────────
const otherOf = (t, uid) => (t.a === uid ? t.b : t.a);
function viewThread(t, uid) {
  const me = t.a === uid;
  return {
    id: t.id, status: t.status, iRequested: me, snippet: t.snippet, unread: me ? t.unreadA : t.unreadB,
    messages: t.messages.map((m) => ({ id: m.id, mine: m.uid === uid, text: m.text, media: m.media, ts: m.ts })),
  };
}
function myThread(id, uid) { return db.threads.find((t) => t.id === id && (t.a === uid || t.b === uid)); }

// ───────── 학교 정보: 대구과학고 1학년 시간표·급식 (NEIS 교육정보 개방 포털) ─────────
const NEIS_URL = process.env.NEIS_URL || 'https://open.neis.go.kr/hub/';
const NEIS_KEY = process.env.NEIS_KEY || '';
const SCHOOL_NAME = '대구과학고등학교', ATPT = 'D10';
let school = process.env.SCHOOL_CODE ? { atpt: ATPT, code: process.env.SCHOOL_CODE } : null;
const neisCache = new Map();
async function neis(name, params) {
  if (!NEIS_KEY) { const e = new Error('nokey'); e.nokey = true; throw e; }
  const qs = new URLSearchParams({ KEY: NEIS_KEY, Type: 'json', pIndex: '1', pSize: '1000', ...params }).toString();
  const hit = neisCache.get(name + qs);
  if (hit && Date.now() - hit.t < 300e3) return hit.rows;
  const d = await getJson(NEIS_URL + name + '?' + qs);
  if (!d) throw new Error('neis unreachable');
  let rows = ((d[name] || []).find((x) => x.row) || {}).row;
  if (!rows) {
    if (d.RESULT && d.RESULT.CODE === 'INFO-200') rows = []; // 해당 기간에 자료 없음
    else throw new Error((d.RESULT && d.RESULT.MESSAGE) || 'neis error');
  }
  if (neisCache.size > 300) neisCache.clear();
  neisCache.set(name + qs, { t: Date.now(), rows });
  return rows;
}
async function schoolCode() {
  if (school) return school;
  const rows = await neis('schoolInfo', { ATPT_OFCDC_SC_CODE: ATPT, SCHUL_NM: SCHOOL_NAME });
  const r = rows.find((x) => x.SCHUL_NM === SCHOOL_NAME);
  if (!r) throw new Error('school not found');
  school = { atpt: r.ATPT_OFCDC_SC_CODE, code: r.SD_SCHUL_CODE };
  return school;
}
function schoolYear() { const k = new Date(Date.now() + 9 * 3600e3); return k.getUTCMonth() >= 2 ? k.getUTCFullYear() : k.getUTCFullYear() - 1; }
async function handleSchool(res, url) {
  const p = url.pathname, g = (k) => url.searchParams.get(k) || '', d8 = /^\d{8}$/;
  try {
    const s = await schoolCode();
    const base = { ATPT_OFCDC_SC_CODE: s.atpt, SD_SCHUL_CODE: s.code };
    if (p === '/api/school/classes') {
      const rows = await neis('classInfo', { ...base, AY: String(schoolYear()), GRADE: '1' });
      return json(res, 200, { classes: [...new Set(rows.map((r) => String(r.CLASS_NM)))].sort((a, b) => a - b) });
    }
    if (p === '/api/school/timetable') {
      if (!/^\d{1,2}$/.test(g('class')) || !d8.test(g('from')) || !d8.test(g('to'))) return json(res, 400, { error: '잘못된 요청이에요.' });
      const rows = await neis('hisTimetable', { ...base, AY: String(schoolYear()), GRADE: '1', CLASS_NM: g('class'), TI_FROM_YMD: g('from'), TI_TO_YMD: g('to') });
      return json(res, 200, { rows: rows.map((r) => ({ date: r.ALL_TI_YMD, period: +r.PERIO, subject: r.ITRT_CNTNT })) });
    }
    if (p === '/api/school/meals') {
      if (!d8.test(g('date'))) return json(res, 400, { error: '잘못된 요청이에요.' });
      const rows = await neis('mealServiceDietInfo', { ...base, MLSV_YMD: g('date') });
      return json(res, 200, { meals: rows.map((r) => ({
        type: r.MMEAL_SC_NM, cal: r.CAL_INFO || '',
        dishes: String(r.DDISH_NM || '').split(/<br\s*\/?>/i).map((x) => x.replace(/\s*\(?[\d.]+\)?\s*$/, '').trim()).filter(Boolean),
      })) });
    }
    return json(res, 404, { error: 'not found' });
  } catch (e) {
    if (e.nokey) return json(res, 503, { error: '서버에 NEIS_KEY가 설정되지 않았어요. (open.neis.go.kr 에서 무료 발급)' });
    console.error('[school]', p, e && e.message);
    json(res, 502, { error: '학교 정보를 가져오지 못했어요 (' + String((e && e.message) || e).slice(0, 80) + ')' });
  }
}

async function handleApi(req, res, url) {
  const p = url.pathname;
  const uid = String(req.headers['x-uid'] || '');
  if (!isUid(uid)) return json(res, 400, { error: '잘못된 요청이에요. 앱을 새로고침해 주세요.' });
  // 실시간 채팅 SSE
  if (p === '/api/events' && req.method === 'GET') return handleEvents(req, res, url);
// ───────── 구글 드라이브 공유 폴더 학습지 (API/OAuth 불필요) ─────────
// 사용자가 "링크가 있는 모든 사용자"로 공유한 금베 폴더를 읽습니다.
const gdShares = new Map();
const SHARE_MAX = 20 * 1024 * 1024;
function driveFolderId(link) {
  const m=String(link||'').match(/\/folders\/([A-Za-z0-9_-]+)/); return m ? m[1] : '';
}
function cleanDriveName(s){return String(s||'').replace(/\\u003c/g,'<').replace(/\\u003e/g,'>').replace(/\\u0026/g,'&').replace(/\\"/g,'"').trim();}
async function publicDriveHtml(id){
  const u='https://drive.google.com/drive/folders/'+encodeURIComponent(id)+'?usp=sharing';
  const r=await fetch(u,{redirect:'follow',headers:{'User-Agent':'Mozilla/5.0'}});
  if(!r.ok) throw new Error('공유 폴더를 열 수 없어요.');
  return await r.text();
}
function parseDriveItems(html){
  const out=new Map();
  // 공개 Drive 폴더 페이지에 포함되는 file/folder ID와 표시명 패턴을 최대한 보수적으로 읽습니다.
  const re=/([\"'])([A-Za-z0-9_-]{20,})(?:\1)\s*[,;:]\s*\1([^\"']{1,180})\1/g; let m;
  while((m=re.exec(html))){const id=m[2],name=cleanDriveName(m[3]); if(name && !/^[A-Za-z0-9_-]{20,}$/.test(name)) out.set(id,{id,name});}
  // fallback: file id followed by HTML escaped name
  const re2=/([A-Za-z0-9_-]{20,})[^]{0,250}?aria-label[=:][\"']([^\"']{1,180})/g;
  while((m=re2.exec(html))){if(!out.has(m[1]))out.set(m[1],{id:m[1],name:cleanDriveName(m[2])});}
  return [...out.values()].filter(x=>x.name && !/^Google Drive$/.test(x.name));
}
async function gdListShare(link){
  const root=driveFolderId(link); if(!root) throw new Error('Google Drive 폴더 링크 형식이 아니에요.');
  const html=await publicDriveHtml(root), items=parseDriveItems(html);
  return {root,items};
}
async function gdFetchPublic(id){
  if(!/^[A-Za-z0-9_-]{20,}$/.test(id)) throw new Error('잘못된 파일이에요.');
  let r=await fetch('https://drive.google.com/uc?export=download&id='+encodeURIComponent(id),{redirect:'follow',headers:{'User-Agent':'Mozilla/5.0'}});
  if(!r.ok) throw new Error('파일을 받을 수 없어요.');
  const ct=r.headers.get('content-type')||'';
  const buf=Buffer.from(await r.arrayBuffer());
  if(buf.length>SHARE_MAX) throw new Error('파일이 너무 커요 (20MB까지).');
  return {buf,ct};
}
async function handleGd(req,res,url,uid){
  const p=url.pathname; const key=String(uid||'');
  if(req.method==='GET'&&p==='/api/gd/status') return json(res,200,{configured:true,linked:!!gdShares.get(key)});
  if(req.method==='POST'&&p==='/api/gd/link'){
    let body={}; try{body=JSON.parse(await readBody(req))}catch{}
    const link=String(body.link||'').trim(); if(!driveFolderId(link)) return json(res,400,{error:'Google Drive 폴더 공유 링크를 입력해 주세요.'});
    try{await gdListShare(link); gdShares.set(key,link); return json(res,200,{ok:true});}catch(e){return json(res,400,{error:e.message||'공유 폴더를 확인하지 못했어요.'});}
  }
  if(req.method==='POST'&&p==='/api/gd/unlink'){gdShares.delete(key);return json(res,200,{ok:true});}
  if(req.method==='GET'&&p==='/api/gd/files'){
    const link=gdShares.get(key); if(!link)return json(res,401,{error:'공유 폴더를 먼저 등록해 주세요.',relink:true});
    try{return json(res,200,await gdListShare(link));}catch(e){return json(res,502,{error:e.message||'공유 폴더를 읽지 못했어요.'});}
  }
  if(req.method==='GET'&&p==='/api/gd/file'){
    try{const id=url.searchParams.get('id')||'';const d=await gdFetchPublic(id);res.writeHead(200,{'Content-Type':d.ct||'application/octet-stream','Content-Length':d.buf.length,'Cache-Control':'private,no-store'});return res.end(d.buf);}catch(e){return json(res,400,{error:e.message||'파일을 받지 못했어요.'});}
  }
  return json(res,404,{error:'not found'});
}
  if (p === '/api/upload' && req.method === 'POST') return handleUpload(req, res, uid);
  if (p.startsWith('/api/gd/')) return handleGd(req, res, url, uid);

  // 사전
  if (req.method === 'GET' && p === '/api/dict') return handleDict(res, url);
  if (req.method === 'GET' && p.startsWith('/api/school/')) return handleSchool(res, url);

  // 관리자 확인 · 목록
  if (p === '/api/admin/check' && req.method === 'GET') {
    if (!isAdmin(req)) return json(res, 403, { error: 'no' });
    return json(res, 200, { bans: db.bans.length, reports: db.reports.length });
  }
  if (p === '/api/admin/reports' && req.method === 'GET') {
    if (!isAdmin(req)) return json(res, 403, { error: 'no' });
    return json(res, 200, { reports: [...db.reports].reverse().map(({ id, ts, snippet, messages }) => ({ id, ts, snippet, messages })) });
  }

  // 게시판 조회
  if (req.method === 'GET' && p === '/api/posts') {
    const best = url.searchParams.get('best') === '1';
    const all = db.posts.filter((x) => !x.hidden && (!best || x.likes.length >= BEST_LIKES)).reverse();
    const pages = Math.max(1, Math.ceil(all.length / PAGE_SIZE));
    const page = Math.min(Math.max(parseInt(url.searchParams.get('page'), 10) || 1, 1), pages);
    const posts = all.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE).map((x) => ({
      id: x.id, no: x.no, title: x.title, media: x.media.length > 0, ts: x.ts, views: x.views,
      likes: x.likes.length, comments: x.comments.filter((c) => !c.hidden).length,
    }));
    return json(res, 200, { posts, page, pages });
  }
  let m = /^\/api\/posts\/([a-f0-9]+)$/.exec(p);
  if (req.method === 'GET' && m) {
    const x = db.posts.find((q) => q.id === m[1]);
    if (!x) return json(res, 404, { error: '없는 글이에요.' });
    if (x.hidden) return json(res, 200, { post: { id: x.id, hidden: true } });
    x.views++; save();
    return json(res, 200, { post: {
      id: x.id, no: x.no, title: x.title, text: x.text, media: x.media, ts: x.ts, views: x.views,
      likes: x.likes.length, mine: x.uid === uid, hidden: false,
      comments: x.comments.map((c) => ({ id: c.id, ts: c.ts, hidden: !!c.hidden, text: c.hidden ? null : c.text, mine: c.uid === uid })),
    } });
  }
  // 과목별 노트 조회
  if (req.method === 'GET' && p === '/api/notes') {
    const sub = url.searchParams.get('subject') || '';
    const all = db.notes.filter((n) => !n.hidden && (!sub || n.subject === sub)).reverse();
    const pages = Math.max(1, Math.ceil(all.length / PAGE_SIZE));
    const page = Math.min(Math.max(parseInt(url.searchParams.get('page'), 10) || 1, 1), pages);
    const notes = all.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE).map((n) => ({ id: n.id, subject: n.subject, title: n.title, media: n.media.length > 0, ts: n.ts, likes: n.likes.length }));
    return json(res, 200, { notes, page, pages });
  }
  m = /^\/api\/notes\/([a-f0-9]+)$/.exec(p);
  if (req.method === 'GET' && m) {
    const n = db.notes.find((q) => q.id === m[1]);
    if (!n) return json(res, 404, { error: '없는 노트예요.' });
    if (n.hidden) return json(res, 200, { note: { id: n.id, hidden: true } });
    return json(res, 200, { note: { id: n.id, subject: n.subject, title: n.title, text: n.text, media: n.media, ts: n.ts, likes: n.likes.length, liked: n.likes.includes(uid), mine: n.uid === uid, hidden: false } });
  }
  // 쇼츠 조회
  if (req.method === 'GET' && p === '/api/shorts') {
    const shorts = db.shorts.filter((s) => !s.hidden).reverse().map((s) => ({
      id: s.id, caption: s.caption, media: s.media, ts: s.ts, likes: s.likes.length, liked: s.likes.includes(uid), mine: s.uid === uid,
    }));
    return json(res, 200, { shorts });
  }
  // 1:1 목록
  if (req.method === 'GET' && p === '/api/dm/list') {
    const now = Date.now();
    const before = db.threads.length;
    db.threads = db.threads.filter((t) => !(t.status === 'pending' && now - t.ts > DM_EXPIRE_MS));
    if (db.threads.length !== before) save();
    const threads = db.threads.filter((t) => t.a === uid || t.b === uid).map((t) => viewThread(t, uid));
    return json(res, 200, { threads });
  }

  if (req.method !== 'POST') return json(res, 405, { error: 'method' });
  const isAdm = isAdmin(req);
  const body = await readBody(req);
  if (!body) return json(res, 400, { error: '요청이 너무 크거나 형식이 잘못됐어요.' });

  // 채팅
  if (p === '/api/chat') {
    if (isBanned(uid)) return json(res, 403, banMsg);
    const text = clip(body.text, MAX_LEN), media = cleanMedia(body.media);
    if (!text && !media) return json(res, 400, { error: '내용이 비었어요.' });
    if (tooFast(uid, 'chat', 1200)) return json(res, 429, { error: '너무 빨라요. 잠시 후에 다시 보내 주세요.' });
    const msg = { id: rid(6), uid, text, media, ts: Date.now(), hidden: false, reporters: [], n: clip(body.n, 16) };
    db.chat.push(msg);
    if (db.chat.length > MAX_CHAT) db.chat.shift();
    save();
    broadcast({ type: 'chat', message: pubChat(msg) });
    return json(res, 200, { ok: true });
  }

  // 신고 (서로 다른 3명이면 자동 숨김)
  if (p === '/api/report') {
    const it = findItem(body.kind, body.id, body.postId);
    if (!it || it.hidden || it.uid === uid) return json(res, 200, { ok: true });
    if (!it.reporters.includes(uid)) it.reporters.push(uid);
    if (it.reporters.length >= REPORT_LIMIT) hide(body.kind, it); else save();
    return json(res, 200, { ok: true });
  }

  // 게시판 쓰기
  if (p === '/api/posts') {
    if (isBanned(uid)) return json(res, 403, banMsg);
    const title = clip(body.title, 60), text = clip(body.text, 3000);
    const media = (Array.isArray(body.media) ? body.media : []).slice(0, 4).map(cleanMedia).filter(Boolean);
    if (!title) return json(res, 400, { error: '제목을 입력해 주세요.' });
    if (tooFast(uid, 'post', 8000)) return json(res, 429, { error: '글은 잠시 후에 다시 올릴 수 있어요.' });
    const x = { id: rid(6), no: ++db.postNo, uid, title, text, media, ts: Date.now(), views: 0, likes: [], reporters: [], hidden: false, comments: [] };
    db.posts.push(x); save();
    return json(res, 200, { id: x.id });
  }
  m = /^\/api\/posts\/([a-f0-9]+)\/(like|comments)$/.exec(p);
  if (m) {
    const x = db.posts.find((q) => q.id === m[1]);
    if (!x || x.hidden) return json(res, 404, { error: '없는 글이에요.' });
    if (m[2] === 'like') {
      if (!x.likes.includes(uid)) { x.likes.push(uid); save(); }
      return json(res, 200, { likes: x.likes.length });
    }
    if (isBanned(uid)) return json(res, 403, banMsg);
    const text = clip(body.text, 300);
    if (!text) return json(res, 400, { error: '내용이 비었어요.' });
    if (tooFast(uid, 'cmt', 2000)) return json(res, 429, { error: '너무 빨라요. 잠시 후에 다시 써 주세요.' });
    const c = { id: rid(6), uid, text, ts: Date.now(), hidden: false, reporters: [] };
    x.comments.push(c); save();
    return json(res, 200, { id: c.id });
  }

  // 과목별 노트 쓰기 / 추천
  if (p === '/api/notes') {
    if (isBanned(uid)) return json(res, 403, banMsg);
    const title = clip(body.title, 60), text = clip(body.text, 5000);
    const media = (Array.isArray(body.media) ? body.media : []).slice(0, 6).map(cleanMedia).filter(Boolean);
    if (!SUBJECTS.includes(body.subject)) return json(res, 400, { error: '과목을 골라 주세요.' });
    if (!title) return json(res, 400, { error: '제목을 입력해 주세요.' });
    if (!text && !media.length) return json(res, 400, { error: '내용이나 사진을 넣어 주세요.' });
    if (tooFast(uid, 'note', 5000)) return json(res, 429, { error: '잠시 후에 다시 올려 주세요.' });
    const n = { id: rid(6), uid, subject: body.subject, title, text, media, ts: Date.now(), likes: [], reporters: [], hidden: false };
    db.notes.push(n); save();
    return json(res, 200, { id: n.id });
  }
  m = /^\/api\/notes\/([a-f0-9]+)\/like$/.exec(p);
  if (m) {
    const n = db.notes.find((q) => q.id === m[1] && !q.hidden);
    if (!n) return json(res, 404, { error: '없는 노트예요.' });
    const i = n.likes.indexOf(uid);
    if (i >= 0) n.likes.splice(i, 1); else n.likes.push(uid);
    save();
    return json(res, 200, { likes: n.likes.length, liked: i < 0 });
  }

  // 쇼츠 쓰기
  if (p === '/api/shorts') {
    if (isBanned(uid)) return json(res, 403, banMsg);
    const media = cleanMedia(body.media);
    if (!media || media.kind !== 'video') return json(res, 400, { error: '쇼츠는 영상만 올릴 수 있어요.' });
    if (tooFast(uid, 'short', 8000)) return json(res, 429, { error: '쇼츠는 잠시 후에 다시 올릴 수 있어요.' });
    const s = { id: rid(6), uid, caption: clip(body.caption, 60), media, ts: Date.now(), likes: [], reporters: [], hidden: false };
    db.shorts.push(s); save();
    return json(res, 200, { id: s.id });
  }
  m = /^\/api\/shorts\/([a-f0-9]+)\/like$/.exec(p);
  if (m) {
    const s = db.shorts.find((q) => q.id === m[1] && !q.hidden);
    if (!s) return json(res, 404, { error: '없는 쇼츠예요.' });
    const i = s.likes.indexOf(uid);
    if (i >= 0) s.likes.splice(i, 1); else s.likes.push(uid);
    save();
    return json(res, 200, { likes: s.likes.length, liked: i < 0 });
  }

  // 1:1
  if (p === '/api/dm/request') {
    if (isBanned(uid)) return json(res, 403, banMsg);
    const it = findItem(body.kind, body.id, body.postId);
    if (!it || !it.uid) return json(res, 404, { error: '대상을 찾을 수 없어요.' });
    if (it.uid === uid) return json(res, 400, { error: '내 글에는 요청할 수 없어요.' });
    if ((db.blocks[uid] || []).includes(it.uid)) return json(res, 400, { error: '차단한 사용자예요.' });
    if ((db.blocks[it.uid] || []).includes(uid)) return json(res, 200, { ok: true }); // 차단당했어도 알리지 않아요
    const dup = db.threads.some((t) => (t.status === 'pending' || t.status === 'active') && ((t.a === uid && t.b === it.uid) || (t.a === it.uid && t.b === uid)));
    if (dup) return json(res, 400, { error: '이미 요청했거나 대화 중인 상대예요.' });
    db.threads.push({ id: rid(6), a: uid, b: it.uid, status: 'pending', snippet: snippetOf(body.kind, it), ts: Date.now(), messages: [], unreadA: 0, unreadB: 0 });
    save();
    sendTo(it.uid, { type: 'dm', kind: 'request' });
    return json(res, 200, { ok: true });
  }
  if (p.startsWith('/api/dm/')) {
    const t = myThread(body.threadId, uid);
    if (!t) return json(res, 404, { error: '대화를 찾을 수 없어요.' });
    const other = otherOf(t, uid);
    if (p === '/api/dm/respond') {
      if (t.status !== 'pending' || t.b !== uid) return json(res, 400, { error: '응답할 수 없는 요청이에요.' });
      if (body.accept) { t.status = 'active'; sendTo(t.a, { type: 'dm', kind: 'accepted' }); }
      else db.threads = db.threads.filter((x) => x !== t); // 거절은 상대에게 알리지 않아요
      save();
      return json(res, 200, { ok: true });
    }
    if (p === '/api/dm/send') {
      if (isBanned(uid)) return json(res, 403, banMsg);
      if (t.status !== 'active') return json(res, 400, { error: '대화를 보낼 수 없는 상태예요.' });
      const text = clip(body.text, 1000), media = cleanMedia(body.media);
      if (!text && !media) return json(res, 400, { error: '내용이 비었어요.' });
      if (tooFast(uid, 'dm', 800)) return json(res, 429, { error: '너무 빨라요.' });
      t.messages.push({ id: rid(6), uid, text, media, ts: Date.now() });
      if (t.messages.length > 500) t.messages.shift();
      if (t.a === other) t.unreadA++; else t.unreadB++;
      save();
      sendTo(other, { type: 'dm', kind: 'message' });
      return json(res, 200, { ok: true });
    }
    if (p === '/api/dm/read') {
      if (t.a === uid) t.unreadA = 0; else t.unreadB = 0;
      save();
      return json(res, 200, { ok: true });
    }
    if (p === '/api/dm/block') {
      (db.blocks[uid] = db.blocks[uid] || []).includes(other) || db.blocks[uid].push(other);
      db.threads = db.threads.filter((x) => x !== t);
      save();
      return json(res, 200, { ok: true });
    }
    if (p === '/api/dm/report') {
      t.status = 'closed';
      db.reports.push({
        id: rid(6), ts: Date.now(), snippet: t.snippet, reporter: uid, reported: other,
        messages: t.messages.slice(-20).map((x) => ({ who: x.uid === uid ? '신고자' : '상대', text: x.text })),
      });
      save();
      return json(res, 200, { ok: true });
    }
  }

  // 관리자 동작
  if (p.startsWith('/api/admin/')) {
    if (!isAdm) return json(res, 403, { error: '관리자만 할 수 있어요.' });
    if (p === '/api/admin/reset-room') {
      db.chat = []; save();
      broadcast({ type: 'room_reset' });
      return json(res, 200, { ok: true });
    }
    if (p === '/api/admin/report') {
      const r = db.reports.find((x) => x.id === body.id);
      if (!r) return json(res, 404, { error: '이미 처리된 신고예요.' });
      if (body.action === 'ban' && !db.bans.includes(r.reported)) db.bans.push(r.reported);
      db.reports = db.reports.filter((x) => x !== r); save();
      return json(res, 200, { ok: true });
    }
    const it = findItem(body.kind, body.id, body.postId);
    if (!it) return json(res, 404, { error: '대상을 찾을 수 없어요.' });
    if (p === '/api/admin/delete') { hide(body.kind, it); return json(res, 200, { ok: true }); }
    if (p === '/api/admin/ban') {
      if (it.uid && !db.bans.includes(it.uid)) { db.bans.push(it.uid); save(); }
      return json(res, 200, { ok: true });
    }
  }
  return json(res, 404, { error: 'not found' });
}


// ───────── 서버 ─────────
const server = http.createServer((req, res) => {
  const url = new URL(req.url || '/', 'http://localhost');
  if (url.pathname.startsWith('/api/')) {
    return handleApi(req, res, url).catch((e) => { console.error(e); if (!res.headersSent) json(res, 500, { error: '서버 오류가 발생했어요.' }); });
  }
  let urlPath;
  try { urlPath = decodeURIComponent(url.pathname); } catch { res.writeHead(400).end('Bad request'); return; }
  const up = /^\/uploads\/([a-f0-9]{24}\.(jpg|png|gif|webp|mp4|webm|mov))$/.exec(urlPath);
  if (up) return serveFile(req, res, path.join(UPLOAD_DIR, up[1]), MIME['.' + up[2]], 'public, max-age=31536000, immutable');
  if (urlPath === '/') urlPath = '/index.html';
  const filePath = path.normalize(path.join(PUBLIC_DIR, urlPath));
  if (!filePath.startsWith(PUBLIC_DIR + path.sep)) { res.writeHead(403).end('Forbidden'); return; }
  serveFile(req, res, filePath, MIME[path.extname(filePath)] || 'application/octet-stream', 'no-cache');
});

if (require.main === module) server.listen(PORT, () => console.log(`금베 서버 실행 중: http://localhost:${PORT}${ADMIN_KEY ? '' : ' (ADMIN_KEY 미설정: 관리자 기능 꺼짐)'}`));
module.exports = { parseEntry };
