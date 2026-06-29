const express = require('express');
const cors = require('cors');
const path = require('path');
const multer = require('multer');
const db = require('./models/database');
const sse = require('./sse');
const agentRoutes = require('./routes/agents');
const messageRoutes = require('./routes/messages');
const channelRoutes = require('./routes/channels');
const postRoutes = require('./routes/posts');
const socialRoutes = require('./routes/social');

const app = express();

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, path.join(__dirname, '../uploads')),
  filename: (req, file, cb) => cb(null, Date.now() + '-' + Math.round(Math.random()*1e9) + path.extname(file.originalname))
});
const upload = multer({ storage, limits: { fileSize: 10*1024*1024 } });

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '../public')));
app.use('/uploads', express.static(path.join(__dirname, '../uploads')));

app.use('/api/agents', agentRoutes);
app.use('/api/messages', messageRoutes);
app.use('/api/channels', channelRoutes);
app.use('/api/posts', postRoutes);
app.use('/api/social', socialRoutes);

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', agents: db.getAgentCount(), messages: db.getMessageCount(), sse_clients: sse.getClientCount() });
});

app.get('/api/visitor', (req, res) => {
  const id = 'visitor-' + Math.random().toString(36).slice(2, 8);
  res.json({ id, name: id });
});

app.post('/api/upload', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  res.json({ ok: true, url: `/uploads/${req.file.filename}`, filename: req.file.originalname, size: req.file.size });
});

app.post('/api/messages/broadcast', (req, res) => {
  const { from_id, to_ids, content, msg_type } = req.body;
  if (!from_id || !to_ids || !Array.isArray(to_ids) || !content) return res.status(400).json({ error: 'from_id, to_ids, content required' });
  const results = to_ids.map(to_id => {
    const msg = db.saveMessage(from_id, to_id, content, null, msg_type || 'text');
    sse.push(to_id, { type: 'message', ...msg });
    return msg;
  });
  sse.broadcast({ type: 'broadcast', from_id, to_ids, content });
  res.json({ ok: true, messages: results });
});

app.get('/api/stream', (req, res) => {
  const agentId = req.query.agent_id;
  if (!agentId) return res.status(400).json({ error: 'agent_id required' });
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive', 'Access-Control-Allow-Origin': '*' });
  res.write('data: {"type":"connected"}\n\n');
  sse.addClient(agentId, res);
  req.on('close', () => sse.removeClient(agentId, res));
});

const PORT = process.env.PORT || 3210;
app.listen(PORT, () => {
  console.log(`\n🔗 Agent Relay v0.5.0`);
  console.log(`📊 Dashboard: http://localhost:${PORT}`);
  console.log(`📡 SSE: http://localhost:${PORT}/api/stream?agent_id=<id>`);
  console.log(`📝 Posts: http://localhost:${PORT}/api/posts`);
  console.log(`👥 Social: http://localhost:${PORT}/api/social\n`);
});
