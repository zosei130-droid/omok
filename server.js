const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3000;
const N = 15;
const PUBLIC = path.join(__dirname, 'public');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml', '.json': 'application/json' };

const server = http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split('?')[0]);
  if (p === '/') p = '/index.html';
  const file = path.join(PUBLIC, path.normalize(p));
  if (!file.startsWith(PUBLIC)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  });
});

const wss = new WebSocketServer({ server });
const rooms = new Map(); // code -> room

function newRoom() {
  let code;
  do { code = String(Math.floor(1000 + Math.random() * 9000)); } while (rooms.has(code));
  const room = { code, players: [null, null], board: emptyBoard(), turn: 1, over: false, last: null, wins: [0, 0] };
  rooms.set(code, room);
  return room;
}
function emptyBoard() { return Array.from({ length: N }, () => Array(N).fill(0)); }

function checkWin(board, x, y) {
  const c = board[y][x];
  for (const [dx, dy] of [[1, 0], [0, 1], [1, 1], [1, -1]]) {
    const line = [[x, y]];
    for (const s of [1, -1]) {
      let nx = x + dx * s, ny = y + dy * s;
      while (nx >= 0 && ny >= 0 && nx < N && ny < N && board[ny][nx] === c) {
        line.push([nx, ny]); nx += dx * s; ny += dy * s;
      }
    }
    if (line.length >= 5) return line;
  }
  return null;
}

function send(ws, msg) { if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg)); }
function broadcast(room, extra = {}) {
  room.players.forEach((ws, i) => {
    send(ws, {
      type: 'state', code: room.code, you: i + 1, board: room.board, turn: room.turn,
      over: room.over, last: room.last, wins: room.wins,
      opponent: !!room.players[1 - i], ...extra,
    });
  });
}

wss.on('connection', (ws) => {
  ws.on('message', (raw) => {
    let m; try { m = JSON.parse(raw); } catch { return; }
    if (m.type === 'create') {
      const room = newRoom();
      room.players[0] = ws; ws.room = room; ws.idx = 0;
      broadcast(room);
    } else if (m.type === 'join') {
      const room = rooms.get(String(m.code));
      if (!room) return send(ws, { type: 'error', message: '방을 찾을 수 없어요.' });
      const slot = room.players.findIndex((p) => !p);
      if (slot < 0) return send(ws, { type: 'error', message: '이미 가득 찬 방이에요.' });
      room.players[slot] = ws; ws.room = room; ws.idx = slot;
      broadcast(room);
    } else if (m.type === 'move') {
      const room = ws.room; if (!room || room.over) return;
      if (!room.players[1]) return;
      if (room.turn !== ws.idx + 1) return;
      const { x, y } = m;
      if (!Number.isInteger(x) || !Number.isInteger(y) || x < 0 || y < 0 || x >= N || y >= N) return;
      if (room.board[y][x]) return;
      room.board[y][x] = room.turn;
      room.last = [x, y];
      const win = checkWin(room.board, x, y);
      if (win) { room.over = true; room.wins[ws.idx]++; broadcast(room, { winner: room.turn, line: win }); return; }
      if (room.board.every((r) => r.every(Boolean))) { room.over = true; broadcast(room, { draw: true }); return; }
      room.turn = 3 - room.turn;
      broadcast(room);
    } else if (m.type === 'rematch') {
      const room = ws.room; if (!room || !room.over) return;
      room.board = emptyBoard(); room.turn = 1; room.over = false; room.last = null;
      room.players.reverse(); // 선후공 교대
      room.wins.reverse();
      room.players.forEach((p, i) => { if (p) p.idx = i; });
      broadcast(room, { rematch: true });
    } else if (m.type === 'undo') {
      // 상대 동의 없는 무르기는 막기 위해 요청/응답 방식
      const room = ws.room; if (!room || room.over || !room.last) return;
      const other = room.players[1 - ws.idx];
      send(other, { type: 'undoRequest' });
    } else if (m.type === 'undoAnswer') {
      const room = ws.room; if (!room) return;
      const other = room.players[1 - ws.idx];
      if (m.ok && room.last && !room.over) {
        const [x, y] = room.last;
        room.board[y][x] = 0; room.turn = 3 - room.turn; room.last = null;
        broadcast(room, { undone: true });
      } else send(other, { type: 'info', message: '무르기가 거절됐어요.' });
    }
  });
  ws.on('close', () => {
    const room = ws.room; if (!room) return;
    room.players[ws.idx] = null;
    const other = room.players[1 - ws.idx];
    if (!other) { rooms.delete(room.code); return; }
    send(other, { type: 'info', message: '상대가 나갔어요.' });
    broadcast(room);
  });
});

server.listen(PORT, '0.0.0.0', () => {
  const ips = Object.values(require('os').networkInterfaces()).flat().filter((i) => i.family === 'IPv4' && !i.internal);
  console.log(`오목 서버 실행 중!\n  내 컴퓨터: http://localhost:${PORT}`);
  ips.forEach((i) => console.log(`  같은 와이파이 폰/친구: http://${i.address}:${PORT}`));
});
