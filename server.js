/**
 * ============================================
 *  真正的聊天 App 服务器
 *  - 注册 / 登录
 *  - 联系人列表
 *  - 点对点私聊
 *  - 消息永久存储 (SQLite)
 *  - 实时推送 (WebSocket)
 * ============================================
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');
const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

// ============================================
// 第 1 步：初始化数据库
// ============================================
const db = new Database('chat.db');
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    password TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    from_user INTEGER NOT NULL,
    to_user INTEGER NOT NULL,
    content TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (from_user) REFERENCES users(id),
    FOREIGN KEY (to_user) REFERENCES users(id)
  );
`);

console.log('✅ 数据库初始化完成');

// ============================================
// 第 2 步：JWT 密钥
// ============================================
const JWT_SECRET = process.env.JWT_SECRET || 'chat-app-secret-key-change-in-production';
const JWT_EXPIRES = '7d';

// ============================================
// 第 3 步：在线用户表（WebSocket 连接）
// ============================================
const onlineUsers = new Map();  // userId → ws

// 辅助函数：解析请求 body
function parseBody(req) {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      try { resolve(JSON.parse(body)); }
      catch { resolve({}); }
    });
  });
}

// 辅助函数：从 header 中提取 JWT 并验证
function auth(req) {
  const authHeader = req.headers['authorization'] || '';
  const token = authHeader.replace('Bearer ', '');
  try {
    return jwt.verify(token, JWT_SECRET);
  } catch {
    return null;
  }
}

// 辅助函数：返回 JSON 响应
function json(res, data, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data));
}

// ============================================
// 第 4 步：HTTP 服务器（API + 静态文件）
// ============================================
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const pathname = url.pathname;
  const method = req.method;

  // ---- 静态文件 ----
  if (method === 'GET' && pathname === '/') {
    const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf-8');
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(html);
  }

  // ---- 注册 ----
  if (method === 'POST' && pathname === '/api/register') {
    const { username, password } = await parseBody(req);

    if (!username || !password) return json(res, { error: '用户名和密码不能为空' }, 400);
    if (username.length < 2) return json(res, { error: '用户名至少2个字符' }, 400);
    if (password.length < 4) return json(res, { error: '密码至少4个字符' }, 400);

    const existing = db.prepare('SELECT id FROM users WHERE username = ?').get(username);
    if (existing) return json(res, { error: '用户名已被注册' }, 409);

    const hash = bcrypt.hashSync(password, 10);
    const result = db.prepare('INSERT INTO users (username, password) VALUES (?, ?)').run(username, hash);
    const user = { id: result.lastInsertRowid, username };

    const token = jwt.sign({ id: user.id, username: user.username }, JWT_SECRET, { expiresIn: JWT_EXPIRES });
    return json(res, { token, user });
  }

  // ---- 登录 ----
  if (method === 'POST' && pathname === '/api/login') {
    const { username, password } = await parseBody(req);

    if (!username || !password) return json(res, { error: '用户名和密码不能为空' }, 400);

    const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
    if (!user) return json(res, { error: '用户名或密码错误' }, 401);

    const valid = bcrypt.compareSync(password, user.password);
    if (!valid) return json(res, { error: '用户名或密码错误' }, 401);

    const token = jwt.sign({ id: user.id, username: user.username }, JWT_SECRET, { expiresIn: JWT_EXPIRES });
    return json(res, { token, user: { id: user.id, username: user.username } });
  }

  // ---- 获取联系人列表（所有其他用户） ----
  if (method === 'GET' && pathname === '/api/contacts') {
    const user = auth(req);
    if (!user) return json(res, { error: '请先登录' }, 401);

    const contacts = db.prepare('SELECT id, username FROM users WHERE id != ? ORDER BY id').all(user.id);
    return json(res, { contacts });
  }

  // ---- 获取和某人的聊天记录 ----
  if (method === 'GET' && pathname.startsWith('/api/messages/')) {
    const user = auth(req);
    if (!user) return json(res, { error: '请先登录' }, 401);

    const peerId = parseInt(pathname.split('/').pop());
    if (!peerId) return json(res, { error: '缺少用户ID' }, 400);

    const messages = db.prepare(`
      SELECT m.*, u.username as from_name
      FROM messages m
      JOIN users u ON m.from_user = u.id
      WHERE (m.from_user = ? AND m.to_user = ?)
         OR (m.from_user = ? AND m.to_user = ?)
      ORDER BY m.created_at ASC
      LIMIT 200
    `).all(user.id, peerId, peerId, user.id);

    return json(res, { messages });
  }

  // 404
  json(res, { error: 'Not found' }, 404);
});

// ============================================
// 第 5 步：WebSocket 服务（实时消息推送）
// ============================================
const wss = new WebSocketServer({ server });

wss.on('connection', (ws) => {
  let userId = null;

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); }
    catch { return; }

    // ---- 认证 ----
    if (msg.type === 'auth') {
      try {
        const user = jwt.verify(msg.token, JWT_SECRET);
        userId = user.id;
        onlineUsers.set(userId, ws);
        console.log(`✅ ${user.username} 上线 (ID:${user.id})，在线人数: ${onlineUsers.size}`);

        // 告诉对方：你登录成功了
        ws.send(JSON.stringify({ type: 'auth_ok', userId: user.id, username: user.username }));

        // 通知联系人上线（可选，这里先不发）
      } catch {
        ws.send(JSON.stringify({ type: 'error', message: '认证失败，请重新登录' }));
      }
      return;
    }

    // ---- 发私聊消息 ----
    if (msg.type === 'private_message') {
      if (!userId) {
        ws.send(JSON.stringify({ type: 'error', message: '请先认证' }));
        return;
      }

      const toUserId = msg.to;
      const content = msg.content;

      if (!toUserId || !content) return;

      // 存入数据库
      const result = db.prepare(
        'INSERT INTO messages (from_user, to_user, content) VALUES (?, ?, ?)'
      ).run(userId, toUserId, content);

      const fromUser = db.prepare('SELECT username FROM users WHERE id = ?').get(userId);
      const msgData = {
        type: 'new_message',
        id: result.lastInsertRowid,
        from: userId,
        fromName: fromUser.username,
        to: toUserId,
        content: content,
        time: new Date().toLocaleTimeString('zh-CN', { hour12: false })
      };

      // 推送给接收方（如果在线）
      const targetWs = onlineUsers.get(toUserId);
      if (targetWs && targetWs.readyState === 1) {
        targetWs.send(JSON.stringify(msgData));
      }

      // 回传给发送方确认（自己也看到消息）
      ws.send(JSON.stringify(msgData));
    }
  });

  // ---- 断线 ----
  ws.on('close', () => {
    if (userId) {
      onlineUsers.delete(userId);
      console.log(`❌ 用户ID:${userId} 下线，在线人数: ${onlineUsers.size}`);
    }
  });
});

// ============================================
// 第 6 步：启动服务器
// ============================================
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log('');
  console.log('╔══════════════════════════════════════════╗');
  console.log('║   💬 聊天 App 服务器启动成功！           ║');
  console.log('║                                          ║');
  console.log(`║   📱 本地: http://localhost:${PORT}           ║`);
  console.log('║   📋 API:                                ║');
  console.log('║      POST /api/register  注册            ║');
  console.log('║      POST /api/login     登录            ║');
  console.log('║      GET  /api/contacts  联系人列表      ║');
  console.log('║      GET  /api/messages  聊天记录        ║');
  console.log('║      WS   /ws           实时消息         ║');
  console.log('╚══════════════════════════════════════════╝');
  console.log('');
});
