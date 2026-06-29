// SSE (Server-Sent Events) 管理模块

const sseClients = new Map(); // agentId -> Set<res>

function addClient(agentId, res) {
  if (!sseClients.has(agentId)) sseClients.set(agentId, new Set());
  sseClients.get(agentId).add(res);
  console.log(`[SSE] Client connected: ${agentId} (total: ${sseClients.get(agentId).size})`);
}

function removeClient(agentId, res) {
  const clients = sseClients.get(agentId);
  if (clients) {
    clients.delete(res);
    if (clients.size === 0) sseClients.delete(agentId);
  }
  console.log(`[SSE] Client disconnected: ${agentId}`);
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
