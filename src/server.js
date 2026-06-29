const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');
const cors = require('cors');
const path = require('path');
const db = require('./models/database');
const sse = require('./sse');
const agentRoutes = require('./routes/agents');
const messageRoutes = require('./routes/messages');
const channelRoutes = require('./routes/channels');

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

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

// SSE (Server-Sent Events) - 实时推送
app.get('/api/stream', (req, res) => {
  const agentId = req.query.agent_id;
  if (!agentId) return res.status(400).json({ error: 'agent_id required' });

  // SSE headers
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'Access-Control-Allow-Origin': '*'
  });
  res.write('data: {"type":"connected"}\n\n');

  sse.addClient(agentId, res);

  // Cleanup on disconnect
  req.on('close', () => sse.removeClient(agentId, res));
});

// WebSocket connections
const wsClients = new Map(); // agentId -> ws

wss.on('connection', (ws, req) => {
  let agentId = null;

  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data);

      if (msg.type === 'register') {
        agentId = msg.agent_id;
        wsClients.set(agentId, ws);
        db.upsertAgent(agentId, msg.name, msg.framework, msg.capabilities);
        broadcast({ type: 'agent_online', agent_id: agentId, name: msg.name });
        ws.send(JSON.stringify({ type: 'registered', agent_id: agentId }));
        console.log(`[WS] Agent registered: ${agentId}`);
      }

      if (msg.type === 'message' && agentId) {
        const saved = db.saveMessage(agentId, msg.to, msg.content, msg.channel, msg.msg_type);
        const payload = { type: 'message', ...saved };
        
        // Send to target agent via WebSocket
        if (msg.to && wsClients.has(msg.to)) {
          wsClients.get(msg.to).send(JSON.stringify(payload));
        }
        
        // Send to channel subscribers via WebSocket
        if (msg.channel) {
          const subscribers = db.getChannelSubscribers(msg.channel);
          subscribers.forEach(sub => {
            if (sub.agent_id !== agentId && wsClients.has(sub.agent_id)) {
              wsClients.get(sub.agent_id).send(JSON.stringify(payload));
            }
          });
        }

        // Push to SSE clients
        if (msg.to) sse.push(msg.to, payload);
        if (msg.channel) {
          const subscribers = db.getChannelSubscribers(msg.channel);
          subscribers.forEach(sub => {
            if (sub.agent_id !== agentId) sse.push(sub.agent_id, payload);
          });
        }

        // Broadcast to dashboard
        broadcastToDashboard(payload);
      }

      if (msg.type === 'ping') {
        ws.send(JSON.stringify({ type: 'pong', timestamp: Date.now() }));
      }
    } catch (e) {
      console.error('[WS] Error:', e.message);
    }
  });

  ws.on('close', () => {
    if (agentId) {
      wsClients.delete(agentId);
      db.setAgentOffline(agentId);
      broadcast({ type: 'agent_offline', agent_id: agentId });
      console.log(`[WS] Agent disconnected: ${agentId}`);
    }
  });
});

// Dashboard WebSocket
const dashboardClients = new Set();

function broadcastToDashboard(msg) {
  dashboardClients.forEach(ws => {
    if (ws.readyState === 1) {
      ws.send(JSON.stringify(msg));
    }
  });
}

function broadcast(msg) {
  const payload = JSON.stringify(msg);
  wsClients.forEach(ws => {
    if (ws.readyState === 1) ws.send(payload);
  });
  dashboardClients.forEach(ws => {
    if (ws.readyState === 1) ws.send(payload);
  });
}

// Dashboard WS endpoint on same server
wss.on('connection', (ws, req) => {
  if (req.url === '/ws/dashboard') {
    dashboardClients.add(ws);
    ws.on('close', () => dashboardClients.delete(ws));
  }
});

// Start
const PORT = process.env.PORT || 3210;
server.listen(PORT, () => {
  console.log(`\n🔗 Agent Relay running on http://localhost:${PORT}`);
  console.log(`📊 Dashboard: http://localhost:${PORT}`);
  console.log(`🔌 WebSocket: ws://localhost:${PORT}/ws`);
  console.log(`📡 API: http://localhost:${PORT}/api\n`);
});
