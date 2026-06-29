const express = require('express');
const cors = require('cors');
const path = require('path');
const multer = require('multer');
const db = require('./models/database');
const sse = require('./sse');
const agentRoutes = require('./routes/agents');
const messageRoutes = require('./routes/messages');
const channelRoutes = require('./routes/channels');

const app = express();

// 文件上传配置
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, path.join(__dirname, '../uploads')),
  filename: (req, file, cb) => {
    const unique = Date.now() + '-' + Math.round(Math.random() * 1e9);
    cb(null, unique + path.extname(file.originalname));
  }
});
const upload = multer({ storage, limits: { fileSize: 10 * 1024 * 1024 } }); // 10MB

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '../public')));
app.use('/uploads', express.static(path.join(__dirname, '../uploads')));

// API Routes
app.use('/api/agents', agentRoutes);
app.use('/api/messages', messageRoutes);
app.use('/api/channels', channelRoutes);

// 健康检查
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', agents: db.getAgentCount(), messages: db.getMessageCount(), sse_clients: sse.getClientCount() });
});

// 访客身份生成
app.get('/api/visitor', (req, res) => {
  const id = 'visitor-' + Math.random().toString(36).slice(2, 8);
  res.json({ id, name: id });
});

// 文件上传
app.post('/api/upload', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  const url = `/uploads/${req.file.filename}`;
  res.json({ ok: true, url, filename: req.file.originalname, size: req.file.size });
});

// 群发消息
app.post('/api/messages/broadcast', (req, res) => {
  const { from_id, to_ids, content, msg_type } = req.body;
  if (!from_id || !to_ids || !Array.isArray(to_ids) || !content) {
    return res.status(400).json({ error: 'from_id, to_ids (array), and content required' });
  }
  const results = [];
  to_ids.forEach(to_id => {
    const msg = db.saveMessage(from_id, to_id, content, null, msg_type || 'text');
    sse.push(to_id, { type: 'message', ...msg });
    results.push(msg);
  });
  // 广播给 Dashboard
  sse.broadcast({ type: 'broadcast', from_id, to_ids, content });
  res.json({ ok: true, messages: results });
});

// SSE - 实时推送
app.get('/api/stream', (req, res) => {
  const agentId = req.query.agent_id;
  if (!agentId) return res.status(400).json({ error: 'agent_id required' });

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'Access-Control-Allow-Origin': '*'
  });
  res.write('data: {"type":"connected"}\n\n');

  sse.addClient(agentId, res);
  req.on('close', () => sse.removeClient(agentId, res));
});

// Start
const PORT = process.env.PORT || 3210;
app.listen(PORT, () => {
  console.log(`\n🔗 Agent Relay running on http://localhost:${PORT}`);
  console.log(`📊 Dashboard: http://localhost:${PORT}`);
  console.log(`📡 SSE: http://localhost:${PORT}/api/stream?agent_id=<id>\n`);
});
