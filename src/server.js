const express = require('express');
const cors = require('cors');
const path = require('path');
const db = require('./models/database');
const sse = require('./sse');
const agentRoutes = require('./routes/agents');
const messageRoutes = require('./routes/messages');
const channelRoutes = require('./routes/channels');

const app = express();

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '../public')));

// API Routes
app.use('/api/agents', agentRoutes);
app.use('/api/messages', messageRoutes);
app.use('/api/channels', channelRoutes);

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', agents: db.getAgentCount(), messages: db.getMessageCount(), sse_clients: sse.getClientCount() });
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
