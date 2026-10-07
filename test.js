// 통합 테스트: node test.js
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PORT = 3999;
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'anon-test-'));
const ADMIN = 'test-admin-key';
let server;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
const check = (name, ok, extra) => { console.log((ok ? 'PASS ' : 'FAIL ') + name + (ok ? '' : '  ' + (extra || ''))); if (!ok) failed++; };
const hex32 = () => Array.from({ length: 32 }, () => Math.floor(Math.random() * 16).toString(16)).join('');

function start() {
  server = spawn('node', ['server.js'], {
    env: { ...process.env, PORT, DATA_DIR: DATA, ADMIN_KEY: ADMIN, THROTTLE_SCALE: '0.1' }, stdio: 'ignore',
  });
  return sleep(700);
}
function stop() {
  return new Promise((r) => { server.on('exit', r); server.kill('SIGTERM'); });
}

function call(method, p, { uid, body, admin, raw, type, headers } = {}) {
  return new Promise((resolve) => {
    const h = Object.assign({}, headers);
    if (uid) h['x-uid'] = uid;
    if (admin) h['x-admin'] = encodeURIComponent(admin);
    let payload = null;
    if (raw) { payload = raw; h['Content-Type'] = type; h['Content-Length'] = raw.length; }
    else if (body !== undefined) { payload = JSON.stringify(body); h['Content-Type'] = 'application/json'; }
    const req = http.request({ port: PORT, path: p, method, headers: h }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        let data = null;
        try { data = JSON.parse(buf.toString()); } catch {}
        resolve({ status: res.statusCode, data, buf, headers: res.headers });
      });
    });
    req.on('error', () => resolve({ status: 0, data: null, buf: Buffer.alloc(0), headers: {} }));
    if (payload) req.write(payload);
    req.end();
  });
}

function listen(uid) {
  return new Promise((resolve) => {
    const c = { uid, inbox: [] };
    const req = http.get({ port: PORT, path: '/api/events?uid=' + uid }, (res) => {
      c.status = res.statusCode;
      let buf = '';
      res.on('data', (chunk) => {
        buf += chunk.toString();
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, i); buf = buf.slice(i + 2);
          if (block.startsWith('data: ')) c.inbox.push(JSON.parse(block.slice(6)));
        }
      });
      setTimeout(() => resolve(c), 150);
    });
    c.close = () => req.destroy();
  });
}
const last = (c, type) => [...c.inbox].reverse().find((m) => m.type === type);

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(200, 1)]);
const MP4 = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypmp42'), Buffer.alloc(1000, 2)]);

(async () => {
  await start();
  const A = hex32(), B = hex32(), C = hex32(), D = hex32();

  // ── 고정 방 / 채팅 ──
  const a = await listen(A), b = await listen(B), c = await listen(C);
  check('고정 방: 코드 없이 바로 입장', a.status === 200 && last(a, 'hello').messages.length === 0);
  check('관리자 기능 활성 표시', last(a, 'hello').adminEnabled === true);

  const n1 = 'abcd1234';
  const r1 = await call('POST', '/api/chat', { uid: A, body: { text: '안녕', n: n1 } });
  check('도배 제한(429)', (await call('POST', '/api/chat', { uid: A, body: { text: '연속' } })).status === 429);
  await sleep(200);
  const got = last(b, 'chat');
  check('메시지 전달', r1.status === 200 && got && got.message.text === '안녕');
  check('작성자 정보 없음', Object.keys(got.message).sort().join() === 'hidden,id,media,n,ts,text'.split(',').sort().join());
  check('재접속 시 내 메시지 식별', last(await listen(A), 'hello').mine.includes(r1.data.id));
  check('잘못된 uid 거부', (await call('GET', '/api/posts', { uid: 'xyz' })).status === 400);

  // ── 신고 자동 숨김 ──
  await call('POST', '/api/report', { uid: B, body: { kind: 'chat', id: r1.data.id } });
  await call('POST', '/api/report', { uid: B, body: { kind: 'chat', id: r1.data.id } });
  await sleep(100);
  check('같은 사람의 중복 신고는 1건', !last(b, 'update'));
  await call('POST', '/api/report', { uid: C, body: { kind: 'chat', id: r1.data.id } });
  await call('POST', '/api/report', { uid: D, body: { kind: 'chat', id: r1.data.id } });
  await sleep(150);
  const upd = last(b, 'update');
  check('3명 신고 시 자동 숨김', upd && upd.message.hidden && upd.message.text === null);

  // ── 업로드 ──
  const up = await call('POST', '/api/upload', { uid: A, raw: PNG, type: 'image/png' });
  check('사진 업로드', up.status === 200 && up.data.kind === 'image' && /^\/media\/[a-f0-9]{24}\.png$/.test(up.data.url), JSON.stringify(up.data));
  const got1 = await call('GET', up.data.url);
  check('사진 불러오기', got1.status === 200 && got1.headers['content-type'] === 'image/png' && got1.buf.equals(PNG));
  await sleep(400);
  const upv = await call('POST', '/api/upload', { uid: A, raw: MP4, type: 'video/mp4' });
  check('영상 업로드', upv.status === 200 && upv.data.kind === 'video');
  const rg = await call('GET', upv.data.url, { headers: { Range: 'bytes=0-9' } });
  check('영상 Range(206) 지원', rg.status === 206 && rg.buf.length === 10 && /bytes 0-9\//.test(rg.headers['content-range']));
  await sleep(400);
  check('형식 위조 거부(400)', (await call('POST', '/api/upload', { uid: A, raw: Buffer.alloc(100, 7), type: 'image/png' })).status === 400);
  await sleep(400);
  check('허용 안 된 형식 거부(415)', (await call('POST', '/api/upload', { uid: A, raw: Buffer.from('<svg/>'), type: 'image/svg+xml' })).status === 415);
  await sleep(400);
  const big = await call('POST', '/api/upload', { uid: A, raw: Buffer.alloc(11 * 1024 * 1024, 1), type: 'image/png' });
  check('용량 초과 거부(413)', big.status === 413 || big.status === 0, String(big.status));
  check('경로 조작 차단', (await call('GET', '/media/../data.json')).status === 404);
  await sleep(1300);
  const withMedia = await call('POST', '/api/chat', { uid: A, body: { text: '', media: up.data } });
  check('사진만 채팅 전송', withMedia.status === 200);
  await sleep(150);
  check('채팅에 첨부 표시', last(b, 'chat').message.media.url === up.data.url);
  check('없는 첨부는 무시', (await call('POST', '/api/chat', { uid: B, body: { text: '', media: { url: '/media/' + 'a'.repeat(24) + '.png' } } })).status === 400);

  // ── 게시판 ──
  const w = await call('POST', '/api/posts', { uid: A, body: { title: '첫 글', text: '내용이에요', media: [up.data, upv.data] } });
  check('글 작성', w.status === 200 && w.data.id.length === 8);
  check('글 연속 작성 제한', (await call('POST', '/api/posts', { uid: A, body: { title: 'x', text: 'y' } })).status === 429);
  const list = await call('GET', '/api/posts?page=1', { uid: B });
  check('글 목록(번호/댓글수/추천수)', list.data.posts.length === 1 && list.data.posts[0].no === 1 && list.data.posts[0].comments === 0);
  const det = await call('GET', '/api/posts/' + w.data.id, { uid: B });
  check('글 상세(첨부 2개, 조회수 1)', det.data.post.media.length === 2 && det.data.post.views === 1 && det.data.post.mine === false);
  await call('GET', '/api/posts/' + w.data.id, { uid: B });
  check('같은 사람 조회수 중복 없음', (await call('GET', '/api/posts/' + w.data.id, { uid: B })).data.post.views === 1);
  check('댓글 작성', (await call('POST', '/api/posts/' + w.data.id + '/comments', { uid: B, body: { text: '댓글' } })).status === 200);
  check('댓글 제한', (await call('POST', '/api/posts/' + w.data.id + '/comments', { uid: B, body: { text: '또' } })).status === 429);
  await call('POST', '/api/posts/' + w.data.id + '/like', { uid: B, body: {} });
  await call('POST', '/api/posts/' + w.data.id + '/like', { uid: B, body: {} });
  check('추천은 1인 1회', (await call('POST', '/api/posts/' + w.data.id + '/like', { uid: B, body: {} })).data.likes === 1);
  check('개념글: 추천 부족하면 제외', (await call('GET', '/api/posts?best=1', { uid: A })).data.posts.length === 0);
  await call('POST', '/api/posts/' + w.data.id + '/like', { uid: C, body: {} });
  await call('POST', '/api/posts/' + w.data.id + '/like', { uid: D, body: {} });
  check('개념글: 추천 3개 이상 포함', (await call('GET', '/api/posts?best=1', { uid: A })).data.posts.length === 1);
  const det2 = await call('GET', '/api/posts/' + w.data.id, { uid: C });
  check('댓글에 작성자 정보 없음', Object.keys(det2.data.post.comments[0]).sort().join() === 'hidden,id,mine,text,ts');

  // ── 1:1 대화 ──
  const msgFromB = await call('POST', '/api/chat', { uid: B, body: { text: '저기요' } });
  check('내 글에 1:1 요청 불가', (await call('POST', '/api/dm/request', { uid: B, body: { kind: 'chat', id: msgFromB.data.id } })).status === 400);
  check('1:1 요청 전송', (await call('POST', '/api/dm/request', { uid: A, body: { kind: 'chat', id: msgFromB.data.id } })).status === 200);
  await sleep(150);
  check('상대에게 요청 알림', last(b, 'dm') && last(b, 'dm').kind === 'request');
  let la = (await call('GET', '/api/dm/list', { uid: A })).data.threads;
  let lb = (await call('GET', '/api/dm/list', { uid: B })).data.threads;
  check('요청 전: 요청자는 대기, 받은 쪽은 pending', la[0].status === 'pending' && la[0].iRequested && lb[0].status === 'pending' && !lb[0].iRequested);
  check('요청 전엔 메시지 불가(403)', (await call('POST', '/api/dm/send', { uid: A, body: { threadId: la[0].id, text: '안녕' } })).status === 403);
  check('요청자는 수락 불가', (await call('POST', '/api/dm/respond', { uid: A, body: { threadId: la[0].id, accept: true } })).status === 400);
  check('제3자는 접근 불가', (await call('POST', '/api/dm/send', { uid: C, body: { threadId: la[0].id, text: '끼어들기' } })).status === 404);
  check('상대 식별 정보 없음', !JSON.stringify(la[0]).includes(B) && !JSON.stringify(lb[0]).includes(A));
  const tid = la[0].id;
  await call('POST', '/api/dm/respond', { uid: B, body: { threadId: tid, accept: true } });
  await call('POST', '/api/dm/send', { uid: A, body: { threadId: tid, text: '반가워요' } });
  await sleep(120);
  await call('POST', '/api/dm/send', { uid: B, body: { threadId: tid, text: '네!', media: up.data } });
  await sleep(150);
  la = (await call('GET', '/api/dm/list', { uid: A })).data.threads;
  lb = (await call('GET', '/api/dm/list', { uid: B })).data.threads;
  check('수락 후 양방향 대화', la[0].status === 'active' && la[0].messages.length === 2 && la[0].messages[1].mine === false && lb[0].messages[1].mine === true);
  check('읽지 않음 개수(답장 보낸 쪽은 읽음 처리)', la[0].unread === 1 && lb[0].unread === 0);
  await call('POST', '/api/dm/read', { uid: A, body: { threadId: tid } });
  check('읽음 처리', (await call('GET', '/api/dm/list', { uid: A })).data.threads[0].unread === 0);
  check('1:1 첨부 전달', la[0].messages[1].media && la[0].messages[1].media.url === up.data.url);

  await call('POST', '/api/dm/report', { uid: A, body: { threadId: tid } });
  const rep = await call('GET', '/api/admin/reports', { uid: A, admin: ADMIN });
  check('1:1 신고 → 관리자에게 대화 전달', rep.data.reports.length === 1 && rep.data.reports[0].messages.length === 2);
  check('신고 내용에 사용자 식별값 없음', !JSON.stringify(rep.data).includes(A) && !JSON.stringify(rep.data).includes(B));

  await call('POST', '/api/dm/block', { uid: B, body: { threadId: tid } });
  la = (await call('GET', '/api/dm/list', { uid: A })).data.threads;
  lb = (await call('GET', '/api/dm/list', { uid: B })).data.threads;
  check('차단: 차단한 쪽 목록에서 사라짐, 상대는 "종료"', lb.length === 0 && la[0].status === 'closed');
  check('차단 후 전송 불가', (await call('POST', '/api/dm/send', { uid: A, body: { threadId: tid, text: '?' } })).status === 403);
  check('차단 후 재요청해도 동일 응답(알 수 없음)', (await call('POST', '/api/dm/request', { uid: A, body: { kind: 'chat', id: msgFromB.data.id } })).status === 200);
  check('재요청해도 스레드 안 생김', (await call('GET', '/api/dm/list', { uid: B })).data.threads.length === 0);

  // 거절 시 요청자에게는 "대기"로만 보임
  const msgFromC = await call('POST', '/api/chat', { uid: C, body: { text: 'C의 글' } });
  await call('POST', '/api/dm/request', { uid: D, body: { kind: 'chat', id: msgFromC.data.id } });
  const tC = (await call('GET', '/api/dm/list', { uid: C })).data.threads[0];
  await call('POST', '/api/dm/respond', { uid: C, body: { threadId: tC.id, accept: false } });
  const dAfter = (await call('GET', '/api/dm/list', { uid: D })).data.threads;
  check('거절: 요청자에겐 대기로 표시, 거절한 쪽 목록에서 사라짐', dAfter[0].status === 'pending' && (await call('GET', '/api/dm/list', { uid: C })).data.threads.length === 0);

  // ── 관리자 ──
  check('관리자 키 틀리면 403', (await call('GET', '/api/admin/check', { uid: A, admin: 'wrong' })).status === 403);
  check('관리자 키 맞으면 통과', (await call('GET', '/api/admin/check', { uid: A, admin: ADMIN })).data.ok === true);
  const victim = await call('POST', '/api/chat', { uid: D, body: { text: '나쁜 말' } });
  await call('POST', '/api/admin/delete', { uid: A, admin: ADMIN, body: { kind: 'chat', id: victim.data.id } });
  await sleep(150);
  const del = last(a, 'update');
  check('관리자 삭제', del.message.id === victim.data.id && del.message.hidden && del.message.text === null);
  await call('POST', '/api/admin/ban', { uid: A, admin: ADMIN, body: { kind: 'chat', id: victim.data.id } });
  await sleep(1300);
  check('차단된 사람은 글쓰기 불가(403)', (await call('POST', '/api/chat', { uid: D, body: { text: '다시' } })).status === 403);
  check('차단된 사람은 업로드/게시/1:1 요청 불가', (await call('POST', '/api/upload', { uid: D, raw: PNG, type: 'image/png' })).status === 403
    && (await call('POST', '/api/posts', { uid: D, body: { title: 't', text: 'x' } })).status === 403);
  await call('POST', '/api/admin/report', { uid: A, admin: ADMIN, body: { id: rep.data.reports[0].id, action: 'ban' } });
  check('신고 처리(차단)', (await call('GET', '/api/admin/reports', { uid: A, admin: ADMIN })).data.reports.length === 0
    && (await call('POST', '/api/chat', { uid: B, body: { text: '막힘?' } })).status === 403);
  await call('POST', '/api/admin/delete', { uid: A, admin: ADMIN, body: { kind: 'post', id: w.data.id } });
  check('관리자 글 삭제', (await call('GET', '/api/posts', { uid: A })).data.posts.length === 0 && (await call('GET', '/api/posts/' + w.data.id, { uid: A })).status === 404);

  // ── 재시작 후에도 유지 / 방 초기화 ──
  const w2 = await call('POST', '/api/posts', { uid: C, body: { title: '남는 글', text: '재시작 테스트' } });
  const chatBefore = last(await listen(C), 'hello').messages.length;
  [a, b, c].forEach((x) => x.close());
  await stop();
  await start();
  const c2 = await listen(C);
  const hello = last(c2, 'hello');
  check('서버 재시작 후에도 채팅 유지', hello.messages.length === chatBefore && chatBefore > 0);
  check('서버 재시작 후에도 글 유지', (await call('GET', '/api/posts', { uid: C })).data.posts[0].title === '남는 글');
  check('서버 재시작 후에도 차단 유지', (await call('POST', '/api/chat', { uid: B, body: { text: '여전히 막힘' } })).status === 403);

  const e0 = hello.epoch;
  await call('POST', '/api/admin/reset-room', { uid: C, admin: ADMIN, body: {} });
  await sleep(200);
  check('방 삭제 → 새 방 열림(알림)', last(c2, 'room_reset') && last(c2, 'room_reset').epoch === e0 + 1);
  const fresh = last(await listen(C), 'hello');
  check('새 방은 비어 있고 게시판은 유지', fresh.messages.length === 0 && fresh.epoch === e0 + 1
    && (await call('GET', '/api/posts', { uid: C })).data.posts.length === 1);

  c2.close();
  await stop();
  fs.rmSync(DATA, { recursive: true, force: true });
  console.log(failed ? `\n${failed}개 실패` : '\n모두 통과');
  process.exit(failed ? 1 : 0);
})();
