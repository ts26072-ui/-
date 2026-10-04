// 통합 테스트: 방 생성/입장, 채팅, 작성자 정보 없음, 도배 제한, 신고 자동 숨김, 방장 삭제
const { spawn } = require('child_process');
const http = require('http');

const PORT = 3999;
const server = spawn('node', ['server.js'], { env: { ...process.env, PORT }, stdio: 'ignore' });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
const check = (name, ok) => { console.log((ok ? 'PASS ' : 'FAIL ') + name); if (!ok) failed++; };

function post(path, body) {
  return new Promise((resolve) => {
    const data = JSON.stringify(body);
    const req = http.request({ port: PORT, path, method: 'POST', headers: { 'Content-Type': 'application/json' } }, (res) => {
      let out = '';
      res.on('data', (c) => (out += c));
      res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(out || '{}') }));
    });
    req.end(data);
  });
}

function listen(code, hostToken) {
  return new Promise((resolve) => {
    const c = { inbox: [], status: 0 };
    const req = http.get({ port: PORT, path: `/api/events?code=${code}&hostToken=${hostToken || ''}` }, (res) => {
      c.status = res.statusCode;
      let buf = '';
      res.on('data', (chunk) => {
        buf += chunk.toString();
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, i); buf = buf.slice(i + 2);
          if (block.startsWith('data: ')) {
            const m = JSON.parse(block.slice(6));
            c.inbox.push(m);
            if (m.type === 'joined') c.cid = m.cid;
          }
        }
      });
      setTimeout(() => resolve(c), 150);
    });
    c.close = () => req.destroy();
  });
}
const last = (c, type) => [...c.inbox].reverse().find((m) => m.type === type);

(async () => {
  await sleep(600);
  const room = (await post('/api/create', {})).body;
  check('방 생성', room.code && room.code.length === 5 && room.hostToken);

  const host = await listen(room.code, room.hostToken);
  check('방장 입장', last(host, 'joined').isHost === true);

  const users = [];
  for (let i = 0; i < 3; i++) users.push(await listen(room.code));
  check('참여자 입장 (방장 아님)', users.every((u) => last(u, 'joined').isHost === false));
  await sleep(100);
  check('접속자 수 갱신', last(host, 'count').count === 4);

  await post('/api/chat', { cid: users[0].cid, text: '안녕' });
  await sleep(150);
  const chat = last(host, 'chat');
  check('메시지 전달', chat && chat.message.text === '안녕');
  check('작성자 정보 없음', Object.keys(chat.message).sort().join() === 'hidden,id,text,ts');

  const spam = await post('/api/chat', { cid: users[0].cid, text: '연속' });
  check('도배 제한(429)', spam.status === 429);

  await post('/api/report', { cid: users[0].cid, id: chat.message.id });
  await post('/api/report', { cid: users[0].cid, id: chat.message.id }); // 같은 사람 중복 신고
  await sleep(100);
  check('같은 사람 중복 신고는 1건으로 계산', !last(host, 'update'));
  await post('/api/report', { cid: users[1].cid, id: chat.message.id });
  await post('/api/report', { cid: users[2].cid, id: chat.message.id });
  await sleep(150);
  const upd = last(host, 'update');
  check('서로 다른 3명 신고 시 자동 숨김', upd && upd.message.hidden && upd.message.text === null);

  await sleep(1300);
  await post('/api/chat', { cid: users[1].cid, text: '지워질 글' });
  await sleep(150);
  const target = last(host, 'chat').message;
  const denied = await post('/api/delete', { cid: users[2].cid, id: target.id, hostToken: 'wrong' });
  check('방장이 아니면 삭제 불가(403)', denied.status === 403);
  await post('/api/delete', { cid: host.cid, id: target.id, hostToken: room.hostToken });
  await sleep(150);
  check('방장 삭제', last(host, 'update').message.id === target.id && last(host, 'update').message.hidden);

  const late = await listen(room.code);
  const hist = last(late, 'joined').messages;
  check('늦게 들어온 사람에게 숨김 처리 유지', hist.every((m) => m.hidden && m.text === null));

  const bad = await listen('ZZZZZ');
  check('없는 방 입장 거부(404)', bad.status === 404);

  [host, late, ...users].forEach((c) => c.close());
  server.kill();
  process.exit(failed ? 1 : 0);
})();
