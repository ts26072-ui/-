// 통합 테스트: 채팅·신고·업로드·쇼츠·게시판·1:1·관리자·영어사전·화면 제공
const { spawn } = require('child_process');
const http = require('http');
const os = require('os');
const fs = require('fs');
const path = require('path');

const PORT = 3999, MOCK = 3998, KEY = '비밀 key';
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'geumbe-'));
const base = 'http://localhost:' + PORT;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
const check = (name, ok) => { console.log((ok ? 'PASS ' : 'FAIL ') + name); if (!ok) failed++; };
const uid = () => Array.from({ length: 32 }, () => '0123456789abcdef'[Math.floor(Math.random() * 16)]).join('');

// 사전 서비스 흉내 (실제 서비스와 같은 응답 모양)
const mock = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  res.setHeader('Content-Type', 'application/json');
  if (u.pathname.startsWith('/hub/')) { // NEIS 흉내
    const name = u.pathname.slice(5), g = (k) => u.searchParams.get(k);
    if (g('KEY') !== 'k') return res.end(JSON.stringify({ RESULT: { CODE: 'ERROR-290', MESSAGE: '인증키가 유효하지 않습니다.' } }));
    const none = { RESULT: { CODE: 'INFO-200', MESSAGE: '해당하는 데이터가 없습니다.' } };
    let row;
    if (name === 'schoolInfo') row = g('SCHUL_NM') === '대구과학고등학교' && g('ATPT_OFCDC_SC_CODE') === 'D10' ? [{ ATPT_OFCDC_SC_CODE: 'D10', SD_SCHUL_CODE: '7777777', SCHUL_NM: '대구과학고등학교' }] : null;
    else if (g('SD_SCHUL_CODE') !== '7777777') row = null;
    else if (name === 'classInfo') row = g('GRADE') === '1' ? [{ CLASS_NM: '2' }, { CLASS_NM: '1' }] : null;
    else if (name === 'hisTimetable') row = g('GRADE') === '1' && g('CLASS_NM') === '2' ? [{ ALL_TI_YMD: '20261005', PERIO: '1', ITRT_CNTNT: '수학' }] : null;
    else if (name === 'mealServiceDietInfo') row = [{ MMEAL_SC_NM: '중식', DDISH_NM: '잡곡밥<br/>김치찌개 (5.9.13)<br/>제육볶음 5.6.', CAL_INFO: '800.1 Kcal' }];
    return res.end(JSON.stringify(row ? { [name]: [{ head: [] }, { row }] } : none));
  }
  if (u.pathname.startsWith('/entries/')) {
    if (u.pathname.endsWith('/apple')) {
      return res.end(JSON.stringify([{ word: 'apple', phonetic: '/ˈæp.əl/', phonetics: [{ text: '/ˈæp.əl/', audio: '//x/apple.mp3' }],
        meanings: [{ partOfSpeech: 'noun', definitions: [{ definition: 'A round fruit.', example: 'I ate an apple.' }] }] }]));
    }
    res.statusCode = 404; return res.end('{"title":"No Definitions Found"}');
  }
  const q = u.searchParams.get('q'), pair = u.searchParams.get('langpair');
  const t = pair === 'en|ko' ? (q === 'apple' ? '사과' : '') : '사과' === q ? 'Apple' : '';
  res.end(JSON.stringify({ responseData: { translatedText: t }, matches: pair === 'ko|en' ? [{ translation: 'apple' }, { translation: 'apology' }, { translation: 'I like apples a lot, really.' }] : [{ translation: '애플' }] }));
});

const server = spawn('node', ['server.js'], { env: { ...process.env, PORT, DATA_DIR: dataDir, ADMIN_KEY: KEY,
  NEIS_URL: `http://localhost:${MOCK}/hub/`, NEIS_KEY: 'k', DICT_URL: `http://localhost:${MOCK}/entries/`, TRANSLATE_URL: `http://localhost:${MOCK}/get` }, stdio: 'ignore' });

function api(method, p, u, body, extra) {
  return fetch(base + p, { method, headers: { 'Content-Type': 'application/json', 'x-uid': u, ...(extra || {}) }, body: method === 'GET' ? undefined : JSON.stringify(body || {}) })
    .then(async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) }));
}
function listen(u) {
  const c = { inbox: [] };
  http.get(base + '/api/events?uid=' + u, (res) => {
    let buf = '';
    res.on('data', (ch) => { buf += ch; let i; while ((i = buf.indexOf('\n\n')) >= 0) { const b = buf.slice(0, i); buf = buf.slice(i + 2); if (b.startsWith('data: ')) c.inbox.push(JSON.parse(b.slice(6))); } });
    c.close = () => res.destroy();
  });
  c.last = (type) => [...c.inbox].reverse().find((m) => m.type === type);
  return c;
}
async function upload(u, type, buf) {
  const r = await fetch(base + '/api/upload', { method: 'POST', headers: { 'Content-Type': type, 'x-uid': u }, body: buf });
  return { status: r.status, body: await r.json() };
}

(async () => {
  await new Promise((r) => mock.listen(MOCK, r));
  await sleep(700);
  const A = uid(), B = uid(), C = uid(), D = uid(), ADM = { 'x-admin': encodeURIComponent(KEY) };

  // 채팅
  const la = listen(A), lb = listen(B);
  await sleep(200);
  check('입장 시 hello 수신, 관리자 기능 켜짐', la.last('hello') && la.last('hello').adminEnabled === true);
  const n = 'abcd1234';
  await api('POST', '/api/chat', A, { text: '안녕', n });
  await sleep(150);
  const got = lb.last('chat');
  check('다른 사람에게 메시지 전달', got && got.message.text === '안녕');
  check('작성자 정보(uid) 노출 없음', got && !JSON.stringify(got).includes(A));
  check('도배 제한(429)', (await api('POST', '/api/chat', A, { text: '또' })).status === 429);
  const mid = got.message.id;

  // 신고 3명이면 숨김
  await api('POST', '/api/report', A, { kind: 'chat', id: mid }); // 작성자 본인 신고는 무시
  await api('POST', '/api/report', B, { kind: 'chat', id: mid });
  await api('POST', '/api/report', C, { kind: 'chat', id: mid });
  check('2명 신고로는 안 가려짐', !lb.last('update'));
  await api('POST', '/api/report', D, { kind: 'chat', id: mid });
  await sleep(150);
  const upd = lb.last('update');
  check('3명 신고 시 모두에게 가려짐', upd && upd.message.hidden && upd.message.text === null);

  // 업로드 / 쇼츠
  const vid = Buffer.alloc(5000, 7);
  check('지원 안 하는 형식 거부(415)', (await upload(A, 'application/pdf', vid)).status === 415);
  const up = await upload(A, 'video/mp4', vid);
  check('영상 업로드', up.status === 200 && up.body.kind === 'video' && /^\/uploads\/[a-f0-9]{24}\.mp4$/.test(up.body.url));
  const rg = await fetch(base + up.body.url, { headers: { Range: 'bytes=100-199' } });
  check('Range 요청 206 (영상 재생에 필요)', rg.status === 206 && (await rg.arrayBuffer()).byteLength === 100 && rg.headers.get('content-range') === 'bytes 100-199/5000');
  const img = await upload(A, 'image/png', Buffer.alloc(100, 1));
  check('쇼츠에 사진은 거부', (await api('POST', '/api/shorts', A, { caption: 'x', media: img.body })).status === 400);
  const sh = await api('POST', '/api/shorts', A, { caption: '첫 쇼츠', media: up.body });
  check('쇼츠 올리기', sh.status === 200 && sh.body.id);
  const list = (await api('GET', '/api/shorts', B)).body.shorts;
  check('쇼츠 목록에 표시', list.length === 1 && list[0].caption === '첫 쇼츠' && list[0].media.url === up.body.url && list[0].mine === false);
  const lk = await api('POST', '/api/shorts/' + sh.body.id + '/like', B);
  check('쇼츠 좋아요/취소', lk.body.likes === 1 && lk.body.liked === true && (await api('POST', '/api/shorts/' + sh.body.id + '/like', B)).body.likes === 0);

  // 게시판
  const post = await api('POST', '/api/posts', A, { title: '첫 글', text: '내용', media: [img.body] });
  check('글쓰기', post.status === 200);
  const pl = (await api('GET', '/api/posts?page=1', B)).body;
  check('글 목록(번호·사진 표시)', pl.posts.length === 1 && pl.posts[0].no === 1 && pl.posts[0].media === true && pl.pages === 1);
  await api('POST', '/api/posts/' + post.body.id + '/comments', B, { text: '댓글' });
  const det = (await api('GET', '/api/posts/' + post.body.id, B)).body.post;
  check('글 상세·댓글', det.title === '첫 글' && det.comments.length === 1 && det.comments[0].mine === true && det.mine === false);
  for (const u of [A, B, C]) await api('POST', '/api/posts/' + post.body.id + '/like', u);
  check('추천 3개면 개념글', (await api('GET', '/api/posts?best=1', B)).body.posts.length === 1);

  // 1:1
  const req1 = await api('POST', '/api/dm/request', B, { kind: 'chat', id: mid });
  check('1:1 요청', req1.status === 200);
  check('자기 자신에게는 요청 불가', (await api('POST', '/api/dm/request', A, { kind: 'post', id: post.body.id })).status === 400);
  await sleep(150);
  check('상대에게 요청 알림', la.last('dm') && la.last('dm').kind === 'request');
  let ta = (await api('GET', '/api/dm/list', A)).body.threads[0];
  check('받는 쪽은 대기 상태', ta.status === 'pending' && ta.iRequested === false);
  await api('POST', '/api/dm/respond', A, { threadId: ta.id, accept: true });
  await api('POST', '/api/dm/send', B, { threadId: ta.id, text: '안녕하세요' });
  ta = (await api('GET', '/api/dm/list', A)).body.threads[0];
  check('수락 후 대화·안읽음 표시', ta.status === 'active' && ta.messages.length === 1 && ta.unread === 1 && ta.messages[0].mine === false);
  await api('POST', '/api/dm/read', A, { threadId: ta.id });
  check('읽음 처리', (await api('GET', '/api/dm/list', A)).body.threads[0].unread === 0);
  check('제3자는 대화 접근 불가', (await api('POST', '/api/dm/send', C, { threadId: ta.id, text: 'x' })).status === 404);
  await api('POST', '/api/dm/report', A, { threadId: ta.id });

  // 관리자
  check('관리자 키 틀리면 거부', (await api('GET', '/api/admin/check', A, null, { 'x-admin': 'wrong' })).status === 403);
  const chk = await api('GET', '/api/admin/check', A, null, ADM);
  check('관리자 확인(한글·공백 키)', chk.status === 200 && chk.body.reports === 1);
  const reps = (await api('GET', '/api/admin/reports', A, null, ADM)).body.reports;
  check('1:1 신고 내용 전달', reps.length === 1 && reps[0].messages[0].text === '안녕하세요');
  await api('POST', '/api/admin/report', A, { id: reps[0].id, action: 'ban' }, ADM);
  await sleep(1300);
  check('신고로 차단된 사용자는 글쓰기 불가', (await api('POST', '/api/chat', B, { text: '차단?' })).status === 403);
  check('일반 사용자는 관리자 동작 불가', (await api('POST', '/api/admin/delete', A, { kind: 'short', id: sh.body.id })).status === 403);
  await api('POST', '/api/admin/delete', A, { kind: 'short', id: sh.body.id }, ADM);
  check('관리자 삭제 시 쇼츠 목록에서 사라짐', (await api('GET', '/api/shorts', A)).body.shorts.length === 0);
  await api('POST', '/api/admin/reset-room', A, {}, ADM);
  await sleep(150);
  check('방 초기화 알림', !!lb.last('room_reset'));

  // 영어사전
  const en = (await api('GET', '/api/dict?q=Apple', A)).body;
  check('영어 단어 뜻·발음·한글 뜻', en.kind === 'en' && en.entry.word === 'apple' && en.entry.audio === 'https://x/apple.mp3' && en.entry.meanings[0].defs[0].example && en.ko.includes('사과'));
  const ko = (await api('GET', '/api/dict?q=' + encodeURIComponent('사과'), A)).body;
  check('한글 → 영어 단어 목록(문장 제외)', ko.kind === 'ko' && ko.translations.join() === 'apple,apology');
  const none = (await api('GET', '/api/dict?q=asdfgh', A)).body;
  check('없는 단어는 entry null', none.kind === 'en' && none.entry === null);

  // 학교 정보 (대구과학고 1학년)
  check('반 목록(정렬)', (await api('GET', '/api/school/classes', A)).body.classes.join() === '1,2');
  const tt = (await api('GET', '/api/school/timetable?class=2&from=20261005&to=20261009', A)).body;
  check('2반 시간표', tt.rows.length === 1 && tt.rows[0].subject === '수학' && tt.rows[0].period === 1);
  check('다른 반은 빈 시간표', (await api('GET', '/api/school/timetable?class=3&from=20261005&to=20261009', A)).body.rows.length === 0);
  check('시간표 잘못된 요청 400', (await api('GET', '/api/school/timetable?class=x&from=1&to=2', A)).status === 400);
  const ml = (await api('GET', '/api/school/meals?date=20261007', A)).body.meals[0];
  check('급식(알레르기 번호 제거)', ml.type === '중식' && ml.dishes.join() === '잡곡밥,김치찌개,제육볶음' && ml.cal === '800.1 Kcal');

  // 신청 (분임토의실 · LOD · 수강신청)
  check('일반 사용자는 신청 항목 생성 불가', (await api('POST', '/api/admin/apply/create', A, { cat: '분임토의실', title: 'x' })).status === 403);
  const ap = (await api('POST', '/api/admin/apply/create', A, { cat: '분임토의실', title: '토의실 A 19:00', capacity: 1 }, ADM)).body;
  check('관리자가 항목 생성', !!ap.id);
  check('신청', (await api('POST', '/api/apply/' + ap.id + '/join', A)).body.applied === true);
  check('정원 초과 409', (await api('POST', '/api/apply/' + ap.id + '/join', C)).status === 409);
  const li = (await api('GET', '/api/apply/list', C)).body.items[0];
  check('현황 표시(1/1명, 내 신청 아님)', li.count === 1 && li.capacity === 1 && li.applied === false);
  await api('POST', '/api/apply/' + ap.id + '/leave', A);
  check('취소 후 다시 신청 가능', (await api('POST', '/api/apply/' + ap.id + '/join', C)).body.count === 1);
  await api('POST', '/api/admin/apply/toggle', A, { id: ap.id }, ADM);
  check('마감 후 신청 불가', (await api('POST', '/api/apply/' + ap.id + '/join', A)).status === 400);
  await api('POST', '/api/admin/apply/delete', A, { id: ap.id }, ADM);
  check('삭제', (await api('GET', '/api/apply/list', A)).body.items.length === 0);

  // 화면
  const html = await (await fetch(base + '/')).text();
  check('화면 제공 (앱 이름 금베)', html.includes('<title>금베</title>'));
  check('정적 파일 경로 침범 차단', (await fetch(base + '/..%2fserver.js')).status !== 200);

  la.close(); lb.close(); server.kill(); mock.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
  console.log(failed ? `\n${failed}개 실패` : '\n모두 통과');
  process.exit(failed ? 1 : 0);
})();
