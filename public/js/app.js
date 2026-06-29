(() => {
  const API = '';
  let sse = null;
  let agents = [];
  let messages = [];
  let visitorId = null;

  // DOM
  const $ = s => document.querySelector(s);
  const agentList = $('#agent-list');
  const channelList = $('#channel-list');
  const messageFeed = $('#message-feed');
  const agentCount = $('#agent-count');
  const messageCount = $('#message-count');
  const connectionStatus = $('#connection-status');
  const debugLog = $('#debug-log');
  const composeTo = $('#compose-to');
  const composeInput = $('#compose-input');
  const btnSend = $('#btn-send');
  const btnUpload = $('#btn-upload');
  const fileInput = $('#file-input');
  const visitorIdEl = $('#visitor-id');

  // 获取访客身份
  async function initVisitor() {
    try {
      const res = await fetch(`${API}/api/visitor`);
      const data = await res.json();
      visitorId = data.id;
      visitorIdEl.textContent = `👤 ${visitorId}`;
      log(`Visitor identity: ${visitorId}`);
    } catch (e) {
      visitorId = 'visitor-' + Math.random().toString(36).slice(2, 8);
      visitorIdEl.textContent = `👤 ${visitorId}`;
    }
  }

  // SSE 连接
  function connectSSE() {
    sse = new EventSource(`${API}/api/stream?agent_id=${visitorId}`);

    sse.onopen = () => {
      connectionStatus.className = 'status-dot online';
      log('SSE connected');
    };

    sse.onmessage = (e) => {
      try {
        const msg = JSON.parse(e.data);
        handleSSEMessage(msg);
      } catch (err) {
        log('Parse error: ' + err.message);
      }
    };

    sse.onerror = () => {
      connectionStatus.className = 'status-dot offline';
      log('SSE disconnected, reconnecting...');
      sse.close();
      setTimeout(connectSSE, 3000);
    };
  }

  function handleSSEMessage(msg) {
    log(`← ${msg.type}: ${JSON.stringify(msg).slice(0, 200)}`);

    if (msg.type === 'agent_online' || msg.type === 'agent_offline') {
      refreshAgents();
    }

    if (msg.type === 'message') {
      appendMessage(msg);
    }

    if (msg.type === 'broadcast') {
      log(`📢 Broadcast from ${msg.from_id}: ${msg.content}`);
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
      const isFile = m.msg_type === 'file';
      const content = isFile
        ? `<a href="${m.content}" target="_blank" class="file-link">📎 ${m.content.split('/').pop()}</a>`
        : escapeHtml(m.content);

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
            <div class="content">${content}</div>
          </div>
        </div>
      `;
    }).join('') || '<div style="color:var(--text-muted)">No messages yet. Waiting for agents...</div>';
    messageFeed.scrollTop = messageFeed.scrollHeight;
  }

  function renderAgentSelects() {
    const opts = agents.map(a => `<option value="${a.id}">${a.name || a.id}</option>`).join('');
    composeTo.innerHTML = '<option value="">Select recipient(s)</option>' + opts;
  }

  function appendMessage(msg) {
    messages.push(msg);
    renderMessages();
  }

  // 发送消息（支持群发）
  async function sendMessage() {
    const selected = Array.from(composeTo.selectedOptions).map(o => o.value).filter(Boolean);
    const content = composeInput.value.trim();
    if (!content || selected.length === 0) return;

    if (selected.length === 1) {
      // 单发
      await fetch(`${API}/api/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ from_id: visitorId, to_id: selected[0], content })
      });
    } else {
      // 群发
      await fetch(`${API}/api/messages/broadcast`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ from_id: visitorId, to_ids: selected, content })
      });
    }
    composeInput.value = '';
  }

  // 文件上传
  async function uploadFile(file) {
    const formData = new FormData();
    formData.append('file', file);
    try {
      const res = await fetch(`${API}/api/upload`, { method: 'POST', body: formData });
      const data = await res.json();
      if (data.ok) {
        // 发送文件消息
        const selected = Array.from(composeTo.selectedOptions).map(o => o.value).filter(Boolean);
        if (selected.length > 0) {
          await fetch(`${API}/api/messages`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ from_id: visitorId, to_id: selected[0], content: data.url, msg_type: 'file' })
          });
        }
      }
    } catch (e) {
      log('Upload error: ' + e.message);
    }
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
  btnUpload.addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', () => {
    if (fileInput.files[0]) uploadFile(fileInput.files[0]);
  });

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
  initVisitor().then(() => {
    connectSSE();
    refreshAgents();
    refreshMessages();
    refreshChannels();
    setInterval(refreshAgents, 10000);
  });
})();
