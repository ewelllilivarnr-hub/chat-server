/**
 * 手搓聊天服务器
 *
 * 这就是一个"服务器"——它是一段程序，运行在一台电脑上，
 * 24小时监听 3000 号端口，等着客户端来连接。
 *
 * 你可以在你现在的电脑上运行它，它就是你自己的"云服务器"。
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');

// ============================================
// 第 1 步：创建一个 HTTP 服务器
// 作用：当你在浏览器输入 http://localhost:3000 时，
//       返回 index.html 这个网页
// ============================================
const server = http.createServer((req, res) => {
    if (req.url === '/') {
        const htmlPath = path.join(__dirname, 'index.html');
        const html = fs.readFileSync(htmlPath, 'utf-8');
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(html);
    }
});

// ============================================
// 第 2 步：在 HTTP 服务器上挂载 WebSocket 服务
// WebSocket = 长连接，让服务器能主动推消息给客户端
// （普通的 HTTP 只能客户端问 → 服务器答，服务器不能主动找你）
// ============================================
const wss = new WebSocketServer({ server });

// 存所有在线用户
const clients = new Map(); // key: WebSocket连接, value: 用户名
let userCount = 0;

wss.on('connection', (ws) => {
    // 新用户来了，给他一个名字
    userCount++;
    const username = `用户${userCount}`;
    clients.set(ws, username);

    console.log(`✅ ${username} 上线了！当前在线：${clients.size} 人`);

    // 告诉所有人：有人进来了
    broadcast({
        type: 'system',
        text: `🎉 ${username} 加入了聊天室`,
        online: clients.size
    });

    // 单独告诉新用户：你是谁
    send(ws, {
        type: 'system',
        text: `👋 欢迎！你的名字是【${username}】`,
        online: clients.size,
        selfName: username
    });

    // ============================================
    // 第 3 步：收到消息 → 广播给所有人
    // 这就是聊天最核心的逻辑！
    // ============================================
    ws.on('message', (raw) => {
        const msg = JSON.parse(raw.toString());
        const sender = clients.get(ws);

        console.log(`💬 ${sender} 说：${msg.text}`);

        // 群发给所有在线的人
        broadcast({
            type: 'chat',
            from: sender,
            text: msg.text,
            time: new Date().toLocaleTimeString('zh-CN', { hour12: false })
        });
    });

    // 用户断开连接
    ws.on('close', () => {
        const name = clients.get(ws);
        clients.delete(ws);

        console.log(`❌ ${name} 下线了！当前在线：${clients.size} 人`);

        broadcast({
            type: 'system',
            text: `👋 ${name} 离开了聊天室`,
            online: clients.size
        });
    });
});

// 广播消息给所有在线客户端
function broadcast(data) {
    const json = JSON.stringify(data);
    clients.forEach((_, ws) => {
        if (ws.readyState === 1) { // 1 = OPEN
            ws.send(json);
        }
    });
}

// 发消息给某一个客户端
function send(ws, data) {
    if (ws.readyState === 1) {
        ws.send(JSON.stringify(data));
    }
}

// ============================================
// 第 4 步：启动！监听 3000 端口
// 从此这台电脑就是一台"聊天服务器"了
// ============================================
const PORT = process.env.PORT || 3000;  // 云平台会通过环境变量给定端口
server.listen(PORT, () => {
    console.log('╔══════════════════════════════════════╗');
    console.log('║   🚀 聊天服务器启动成功！             ║');
    console.log('║                                    ║');
    console.log(`║   📱 端口: ${PORT}                      ║`);
    console.log('║                                    ║');
    console.log('║   打开两个浏览器窗口，开始聊天吧！    ║');
    console.log('║   按 Ctrl+C 停止服务器              ║');
    console.log('╚══════════════════════════════════════╝');
});
