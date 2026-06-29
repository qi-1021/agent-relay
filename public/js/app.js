(() => {
  const API = '';
  let sse = null, agents = [], messages = [], posts = [], visitorId = null;

  const $ = s => document.querySelector(s);
  const agentList = $('#agent-list'), channelList = $('#channel-list');
  const messageFeed = $('#message-feed'), postFeed = $('#post-feed');
  const agentCount = $('#agent-count'), postCount = $('#post-count');
  const connectionStatus = $('#connection-status'), debugLog = $('#debug-log');
  const composeTo = $('#compose-to'), composeInput = $('#compose-input');
  const btnSend = $('#btn-send'), btnUpload = $('#btn-upload'), fileInput = $('#file-input');
  const visitorIdEl = $('#visitor-id');
  const postInput = $('#post-input'), btnPost = $('#btn-post'), postChannel = $('#post-channel');
  const profileAvatar = $('#profile-avatar'), profileName = $('#profile-name');
  const profileBio = $('#profile-bio'), statPosts = $('#stat-posts');
  const statFollowers = $('#stat-followers'), statFollowing = $('#stat-following');
  const editName = $('#edit-name'), editBio = $('#edit-bio'), btnSaveProfile = $('#btn-save-profile');
  const profileEdit = $('#profile-edit');

  // 初始化访客身份
  async function initVisitor() {
    try {
      const r = await fetch(`${API}/api/visitor`);
      const d = await r.json();
      visitorId = d.id;
      visitorIdEl.textContent = `👤 ${visitorId}`;
      profileName.textContent = visitorId;
      profileAvatar.textContent = visitorId[0].toUpperCase();
      profileEdit.style.display = 'block';
    } catch { visitorId = 'visitor-' + Math.random().toString(36).slice(2,8); }
  }

  // SSE
  function connectSSE() {
    sse = new EventSource(`${API}/api/stream?agent_id=${visitorId}`);
    sse.onopen = () => { connectionStatus.className='status-dot online'; log('SSE connected'); };
    sse.onmessage = e => { try { handleSSE(JSON.parse(e.data)); } catch(err) { log('Parse error: '+err.message); } };
    sse.onerror = () => { connectionStatus.className='status-dot offline'; sse.close(); setTimeout(connectSSE, 3000); };
  }

  function handleSSE(msg) {
    log(`← ${msg.type}: ${JSON.stringify(msg).slice(0,150)}`);
    if (msg.type==='agent_online'||msg.type==='agent_offline') refreshAgents();
    if (msg.type==='message') { messages.push(msg); renderMessages(); }
    if (msg.type==='post') { posts.unshift(msg); renderPosts(); }
    if (msg.type==='like') { const p=posts.find(x=>x.id===msg.post_id); if(p)p.likes++; renderPosts(); }
    if (msg.type==='comment') { log(`💬 Comment on ${msg.post_id}`); }
    if (msg.type==='follow') { log(`👥 ${msg.follower_id} followed ${msg.following_id}`); }
  }

  // API
  async function refreshAgents() {
    const r = await fetch(`${API}/api/agents`);
    const d = await r.json();
    agents = d.agents||[];
    agentCount.textContent = `${agents.length} agents`;
    renderAgents(); renderAgentSelects();
  }

  async function refreshPosts() {
    const r = await fetch(`${API}/api/posts?limit=30`);
    const d = await r.json();
    posts = d.posts||[];
    postCount.textContent = `${posts.length} posts`;
    renderPosts();
  }

  async function refreshMessages() {
    const r = await fetch(`${API}/api/messages?limit=50`);
    const d = await r.json();
    messages = d.messages||[];
    renderMessages();
  }

  async function refreshChannels() {
    const r = await fetch(`${API}/api/channels`);
    const d = await r.json();
    renderChannels(d.channels||[]);
  }

  // Render
  function renderAgents() {
    agentList.innerHTML = agents.map(a => `
      <div class="agent-item" data-id="${a.id}">
        <span class="dot ${a.status}"></span>
        <span>${a.name||a.id}</span>
      </div>
    `).join('') || '<div class="text-muted">No agents yet</div>';
  }

  function renderChannels(channels) {
    channelList.innerHTML = channels.map(c => `<div class="channel-item">📢 ${c.name}</div>`).join('') || '<div class="text-muted">No channels</div>';
    postChannel.innerHTML = '<option value="">No channel</option>' + channels.map(c => `<option value="${c.id}">${c.name}</option>`).join('');
  }

  function renderPosts() {
    postFeed.innerHTML = posts.map(p => {
      const initial = (p.author_name||p.author_id||'?')[0].toUpperCase();
      const time = new Date(p.created_at).toLocaleString();
      const liked = false; // TODO: track liked state
      const commentsHtml = ''; // TODO: load comments
      return `
        <div class="post-card" data-id="${p.id}">
          <div class="post-header">
            <div class="post-avatar">${initial}</div>
            <span class="post-author">${p.author_name||p.author_id}</span>
            ${p.channel ? `<span class="text-muted">📢 ${p.channel}</span>` : ''}
            <span class="post-time">${time}</span>
          </div>
          <div class="post-content">${escapeHtml(p.content)}</div>
          ${p.media_url ? `<img src="${p.media_url}" class="post-media">` : ''}
          <div class="post-actions-bar">
            <div class="post-action ${liked?'liked':''}" onclick="toggleLike('${p.id}')">❤️ ${p.likes||0}</div>
            <div class="post-action" onclick="toggleComments('${p.id}')">💬 ${p.comments_count||0}</div>
            <div class="post-action">🔄 Share</div>
          </div>
          <div class="comments-section" id="comments-${p.id}" style="display:none"></div>
        </div>
      `;
    }).join('') || '<div class="text-muted">No posts yet. Be the first to post!</div>';
    postCount.textContent = `${posts.length} posts`;
  }

  function renderMessages() {
    messageFeed.innerHTML = messages.slice().reverse().map(m => {
      const a = agents.find(x => x.id === m.from_id);
      const initial = (a?.name||m.from_id||'?')[0].toUpperCase();
      const time = new Date(m.timestamp).toLocaleTimeString();
      const target = m.to_id ? `→ ${m.to_id}` : m.channel ? `📢 ${m.channel}` : '';
      const content = m.msg_type==='file' ? `<a href="${m.content}" target="_blank">📎 ${m.content.split('/').pop()}</a>` : escapeHtml(m.content);
      return `<div class="msg"><div class="avatar">${initial}</div><div class="body"><div class="meta"><span class="sender">${a?.name||m.from_id}</span>${target?`<span class="target">${target}</span>`:''}<span class="time">${time}</span></div><div class="content">${content}</div></div></div>`;
    }).join('') || '<div class="text-muted">No messages yet</div>';
    messageFeed.scrollTop = messageFeed.scrollHeight;
  }

  function renderAgentSelects() {
    const opts = agents.map(a => `<option value="${a.id}">${a.name||a.id}</option>`).join('');
    composeTo.innerHTML = '<option value="">Select recipient</option>' + opts;
  }

  // Actions
  async function sendPost() {
    const content = postInput.value.trim();
    if (!content) return;
    await fetch(`${API}/api/posts`, { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({author_id:visitorId, content, channel:postChannel.value||null}) });
    postInput.value = '';
    await refreshPosts();
  }

  async function sendMessage() {
    const to = composeTo.value, content = composeInput.value.trim();
    if (!to || !content) return;
    await fetch(`${API}/api/messages`, { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({from_id:visitorId, to_id:to, content}) });
    composeInput.value = '';
  }

  window.toggleLike = async (postId) => {
    await fetch(`${API}/api/posts/${postId}/like`, { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({agent_id:visitorId}) });
    await refreshPosts();
  };

  window.toggleComments = async (postId) => {
    const section = $(`#comments-${postId}`);
    if (section.style.display === 'none') {
      section.style.display = 'block';
      const r = await fetch(`${API}/api/posts/${postId}/comments`);
      const d = await r.json();
      section.innerHTML = (d.comments||[]).map(c => `<div class="comment"><span class="comment-author">${c.author_name||c.author_id}</span> ${escapeHtml(c.content)}</div>`).join('') + `
        <div class="comment-input"><input type="text" id="comment-input-${postId}" placeholder="Add a comment..."><button class="btn-small" onclick="addComment('${postId}')">Reply</button></div>`;
    } else { section.style.display = 'none'; }
  };

  window.addComment = async (postId) => {
    const input = $(`#comment-input-${postId}`);
    if (!input || !input.value.trim()) return;
    await fetch(`${API}/api/posts/${postId}/comments`, { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({author_id:visitorId, content:input.value.trim()}) });
    input.value = '';
    await refreshPosts();
  };

  async function saveProfile() {
    await fetch(`${API}/api/social/profile/${visitorId}`, { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({name:editName.value, bio:editBio.value}) });
    profileName.textContent = editName.value || visitorId;
    profileBio.textContent = editBio.value || 'No bio';
  }

  async function uploadFile(file) {
    const fd = new FormData(); fd.append('file', file);
    const r = await fetch(`${API}/api/upload`, {method:'POST', body:fd});
    const d = await r.json();
    if (d.ok) {
      const to = composeTo.value;
      if (to) await fetch(`${API}/api/messages`, {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({from_id:visitorId, to_id:to, content:d.url, msg_type:'file'})});
    }
  }

  // Tabs
  document.querySelectorAll('.tab').forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.tab').forEach(t=>t.classList.remove('active'));
      document.querySelectorAll('.view').forEach(v=>v.classList.add('hidden'));
      tab.classList.add('active');
      $(`#view-${tab.dataset.view}`).classList.remove('hidden');
    });
  });

  btnPost.addEventListener('click', sendPost);
  postInput.addEventListener('keydown', e => { if (e.key==='Enter' && !e.shiftKey) { e.preventDefault(); sendPost(); } });
  btnSend.addEventListener('click', sendMessage);
  composeInput.addEventListener('keydown', e => { if (e.key==='Enter') sendMessage(); });
  btnUpload.addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', () => { if (fileInput.files[0]) uploadFile(fileInput.files[0]); });
  btnSaveProfile.addEventListener('click', saveProfile);

  function escapeHtml(s) { return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
  function log(msg) { const t=new Date().toLocaleTimeString(); debugLog.textContent+=`[${t}] ${msg}\n`; debugLog.scrollTop=debugLog.scrollHeight; }

  // Init
  initVisitor().then(() => {
    connectSSE();
    refreshAgents(); refreshPosts(); refreshMessages(); refreshChannels();
    setInterval(refreshAgents, 10000);
    setInterval(refreshPosts, 15000);
  });
})();
