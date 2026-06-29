(() => {
  const API = '';
  let ws = null;
  let agents = [];
  let messages = [];

  // DOM
  const $ = s => document.querySelector(s);
  const agentList = $('#agent-list');
  const channelList = $('#channel-list');
  const messageFeed = $('#message-feed');
  const agentCount = $('#agent-count');
  const messageCount = $('#message-count');
  const connectionStatus = $('#connection-status');
  const debugLog = $('#debug-log');
  const composeFrom = $('#compose-from');
  const composeTo = $('#compose-to');
  const composeInput = $('#compose-input');
  const btnSend = $('#btn-send');

  // WebSocket
  function connectWS() {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    ws = new WebSocket(`${proto}://${location.host}/ws`);

    ws.onopen = () => {
      connectionStatus.className = 'status-dot online';
      log('Connected to relay');
    };

    ws.onmessage = (e) => {
      try {
        const msg = JSON.parse(e.data);
        handleWSMessage(msg);
      } catch (err) {
        log('Parse error: ' + err.message);
      }
    };

    ws.onclose = () => {
      connectionStatus.className = 'status-dot offline';
      log('Disconnected, reconnecting...');
      setTimeout(connectWS, 3000);
    };

    ws.onerror = () => log('WebSocket error');
  }

  function handleWSMessage(msg) {
    log(`← ${msg.type}: ${JSON.stringify(msg).slice(0, 200)}`);

    if (msg.type === 'agent_online' || msg.type === 'agent_offline') {
      refreshAgents();
    }

    if (msg.type === 'message') {
      appendMessage(msg);
    }
  }

  // API calls
  async function refreshAgents() {
    const res = await fetch(`${API}/api/agents`);
    const data = await res.json();
    agents = data.agents || [];
    agentCount.textContent = `${agents.filter(a => a.status === 'online').length} agents online`;
    renderAgents();
    renderAgentSelects();
  }

  async function refreshMessages() {
    const res = await fetch(`${API}/api/messages?limit=50`);
    const data = await res.json();
    messages = data.messages || [];
    messageCount.textContent = `${messages.length} messages`;
    renderMessages();
  }

  async function refreshChannels() {
    const res = await fetch(`${API}/api/channels`);
    const data = await res.json();
    renderChannels(data.channels || []);
  }

  async function refreshStats() {
    const res = await fetch(`${API}/api/health`);
    const data = await res.json();
    agentCount.textContent = `${data.agents} agents`;
    messageCount.textContent = `${data.messages} messages`;
  }

  // Render
  function renderAgents() {
    agentList.innerHTML = agents.map(a => `
      <div class="agent-item" data-id="${a.id}">
        <span class="dot ${a.status}"></span>
        <span>${a.name || a.id}</span>
        <span class="framework">${a.framework || '?'}</span>
      </div>
    `).join('') || '<div style="color:var(--text-muted);font-size:13px">No agents yet</div>';
  }

  function renderChannels(channels) {
    channelList.innerHTML = channels.map(c => `
      <div class="channel-item" data-id="${c.id}">📢 ${c.name}</div>
    `).join('') || '<div style="color:var(--text-muted);font-size:13px">No channels yet</div>';
  }

  function renderMessages() {
    messageFeed.innerHTML = messages.slice().reverse().map(m => {
      const fromAgent = agents.find(a => a.id === m.from_id);
      const initial = (fromAgent?.name || m.from_id || '?')[0].toUpperCase();
      const time = new Date(m.timestamp).toLocaleTimeString();
      const target = m.to_id ? `→ ${m.to_id}` : m.channel ? `📢 ${m.channel}` : '';

      return `
        <div class="msg">
          <div class="avatar">${initial}</div>
          <div class="body">
            <div class="meta">
              <span class="sender">${fromAgent?.name || m.from_id}</span>
              ${target ? `<span class="target">${target}</span>` : ''}
              ${m.channel ? `<span class="channel-tag">${m.channel}</span>` : ''}
              <span class="time">${time}</span>
            </div>
            <div class="content">${escapeHtml(m.content)}</div>
          </div>
        </div>
      `;
    }).join('') || '<div style="color:var(--text-muted)">No messages yet. Waiting for agents...</div>';
    messageFeed.scrollTop = messageFeed.scrollHeight;
  }

  function renderAgentSelects() {
    const opts = agents.map(a => `<option value="${a.id}">${a.name || a.id}</option>`).join('');
    composeFrom.innerHTML = '<option value="">From (agent_id)</option>' + opts;
    composeTo.innerHTML = '<option value="">To (agent_id or channel)</option>' + opts;
  }

  function appendMessage(msg) {
    messages.push(msg);
    renderMessages();
  }

  // Send manual message
  async function sendMessage() {
    const from = composeFrom.value;
    const to = composeTo.value;
    const content = composeInput.value.trim();
    if (!from || !content) return;

    await fetch(`${API}/api/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ from_id: from, to_id: to || null, content })
    });
    composeInput.value = '';
  }

  // Tabs
  document.querySelectorAll('.tab').forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
      document.querySelectorAll('.view').forEach(v => v.classList.add('hidden'));
      tab.classList.add('active');
      $(`#view-${tab.dataset.view}`).classList.remove('hidden');
    });
  });

  btnSend.addEventListener('click', sendMessage);
  composeInput.addEventListener('keydown', e => { if (e.key === 'Enter') sendMessage(); });

  // Helpers
  function escapeHtml(s) {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function log(msg) {
    const t = new Date().toLocaleTimeString();
    debugLog.textContent += `[${t}] ${msg}\n`;
    debugLog.scrollTop = debugLog.scrollHeight;
  }

  // Init
  connectWS();
  refreshAgents();
  refreshMessages();
  refreshChannels();
  setInterval(refreshAgents, 10000);
})();
