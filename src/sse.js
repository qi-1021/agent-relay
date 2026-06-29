// SSE (Server-Sent Events) 管理模块

const sseClients = new Map(); // agentId -> Set<res>
const HEARTBEAT_INTERVAL = 15000; // 15 秒

function addClient(agentId, res) {
  if (!sseClients.has(agentId)) sseClients.set(agentId, new Set());
  sseClients.get(agentId).add(res);
  console.log(`[SSE] Client connected: ${agentId} (total: ${sseClients.get(agentId).size})`);

  // 启动心跳
  startHeartbeat(agentId, res);
}

function removeClient(agentId, res) {
  const clients = sseClients.get(agentId);
  if (clients) {
    clients.delete(res);
    if (clients.size === 0) sseClients.delete(agentId);
  }
  console.log(`[SSE] Client disconnected: ${agentId}`);
}

function startHeartbeat(agentId, res) {
  const interval = setInterval(() => {
    try {
      res.write(': heartbeat\n\n');
    } catch (e) {
      // 连接已死，清理
      clearInterval(interval);
      removeClient(agentId, res);
    }
  }, HEARTBEAT_INTERVAL);

  // 连接关闭时清理
  res.on('close', () => {
    clearInterval(interval);
  });
}

function push(agentId, data) {
  const clients = sseClients.get(agentId);
  if (!clients || clients.size === 0) return;
  const payload = `data: ${JSON.stringify(data)}\n\n`;
  clients.forEach(res => {
    try { res.write(payload); } catch (e) { /* client gone */ }
  });
}

function getClientCount() {
  let total = 0;
  sseClients.forEach(clients => total += clients.size);
  return total;
}

module.exports = { addClient, removeClient, push, getClientCount };
