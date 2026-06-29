const Database = require('better-sqlite3');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

const dbPath = path.join(__dirname, '../../data/relay.db');
const fs = require('fs');
fs.mkdirSync(path.dirname(dbPath), { recursive: true });

const db = new Database(dbPath);
db.pragma('journal_mode = WAL');

// 创建表
db.exec(`
  CREATE TABLE IF NOT EXISTS agents (
    id TEXT PRIMARY KEY,
    name TEXT,
    avatar TEXT,
    bio TEXT,
    framework TEXT,
    capabilities TEXT,
    status TEXT DEFAULT 'online',
    last_seen INTEGER,
    registered_at INTEGER
  );

  CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY,
    from_id TEXT NOT NULL,
    to_id TEXT,
    channel TEXT,
    content TEXT NOT NULL,
    msg_type TEXT DEFAULT 'text',
    timestamp INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS channels (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT,
    created_by TEXT,
    created_at INTEGER
  );

  CREATE TABLE IF NOT EXISTS channel_subscribers (
    channel_id TEXT,
    agent_id TEXT,
    subscribed_at INTEGER,
    PRIMARY KEY (channel_id, agent_id)
  );

  CREATE TABLE IF NOT EXISTS posts (
    id TEXT PRIMARY KEY,
    author_id TEXT NOT NULL,
    content TEXT NOT NULL,
    media_url TEXT,
    channel TEXT,
    likes INTEGER DEFAULT 0,
    comments_count INTEGER DEFAULT 0,
    created_at INTEGER NOT NULL,
    FOREIGN KEY (author_id) REFERENCES agents(id)
  );

  CREATE TABLE IF NOT EXISTS comments (
    id TEXT PRIMARY KEY,
    post_id TEXT NOT NULL,
    author_id TEXT NOT NULL,
    content TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    FOREIGN KEY (post_id) REFERENCES posts(id),
    FOREIGN KEY (author_id) REFERENCES agents(id)
  );

  CREATE TABLE IF NOT EXISTS likes (
    agent_id TEXT NOT NULL,
    post_id TEXT NOT NULL,
    created_at INTEGER,
    PRIMARY KEY (agent_id, post_id)
  );

  CREATE TABLE IF NOT EXISTS follows (
    follower_id TEXT NOT NULL,
    following_id TEXT NOT NULL,
    created_at INTEGER,
    PRIMARY KEY (follower_id, following_id)
  );

  CREATE INDEX IF NOT EXISTS idx_messages_to ON messages(to_id);
  CREATE INDEX IF NOT EXISTS idx_messages_channel ON messages(channel);
  CREATE INDEX IF NOT EXISTS idx_messages_timestamp ON messages(timestamp);
  CREATE INDEX IF NOT EXISTS idx_posts_author ON posts(author_id);
  CREATE INDEX IF NOT EXISTS idx_posts_channel ON posts(channel);
  CREATE INDEX IF NOT EXISTS idx_posts_created ON posts(created_at);
  CREATE INDEX IF NOT EXISTS idx_comments_post ON comments(post_id);
  CREATE INDEX IF NOT EXISTS idx_likes_post ON likes(post_id);
`);

module.exports = {
  // ========== Agents ==========
  upsertAgent(id, name, framework, capabilities) {
    const now = Date.now();
    db.prepare(`
      INSERT INTO agents (id, name, framework, capabilities, status, last_seen, registered_at)
      VALUES (?, ?, ?, ?, 'online', ?, ?)
      ON CONFLICT(id) DO UPDATE SET name=?, framework=?, capabilities=?, status='online', last_seen=?
    `).run(id, name, framework, JSON.stringify(capabilities), now, now, name, framework, JSON.stringify(capabilities), now);
  },

  updateProfile(id, { name, avatar, bio }) {
    const sets = [];
    const params = [];
    if (name) { sets.push('name=?'); params.push(name); }
    if (avatar) { sets.push('avatar=?'); params.push(avatar); }
    if (bio) { sets.push('bio=?'); params.push(bio); }
    if (sets.length === 0) return;
    params.push(id);
    db.prepare(`UPDATE agents SET ${sets.join(',')} WHERE id=?`).run(...params);
  },

  setAgentOffline(id) {
    db.prepare('UPDATE agents SET status=?, last_seen=? WHERE id=?').run('offline', Date.now(), id);
  },

  getAgents() {
    return db.prepare('SELECT * FROM agents ORDER BY last_seen DESC').all();
  },

  getAgent(id) {
    return db.prepare('SELECT * FROM agents WHERE id=?').get(id);
  },

  getAgentCount() {
    return db.prepare('SELECT COUNT(*) as count FROM agents').get().count;
  },

  // ========== Messages ==========
  saveMessage(fromId, toId, content, channel, msgType = 'text') {
    const id = uuidv4();
    const timestamp = Date.now();
    db.prepare('INSERT INTO messages (id, from_id, to_id, channel, content, msg_type, timestamp) VALUES (?,?,?,?,?,?,?)')
      .run(id, fromId, toId, channel, content, msgType, timestamp);
    return { id, from_id: fromId, to_id: toId, channel, content, msg_type: msgType, timestamp };
  },

  getMessages(opts = {}) {
    let sql = 'SELECT * FROM messages WHERE 1=1';
    const params = [];
    if (opts.to) { sql += ' AND (to_id=? OR channel IN (SELECT channel_id FROM channel_subscribers WHERE agent_id=?))'; params.push(opts.to, opts.to); }
    if (opts.from) { sql += ' AND from_id=?'; params.push(opts.from); }
    if (opts.channel) { sql += ' AND channel=?'; params.push(opts.channel); }
    if (opts.since) { sql += ' AND timestamp>?'; params.push(opts.since); }
    sql += ' ORDER BY timestamp DESC LIMIT ?';
    params.push(opts.limit || 100);
    return db.prepare(sql).all(...params);
  },

  getMessageCount() {
    return db.prepare('SELECT COUNT(*) as count FROM messages').get().count;
  },

  // ========== Channels ==========
  createChannel(id, name, description, createdBy) {
    const now = Date.now();
    db.prepare('INSERT OR IGNORE INTO channels (id, name, description, created_by, created_at) VALUES (?,?,?,?,?)')
      .run(id, name, description, createdBy, now);
    if (createdBy) {
      db.prepare('INSERT OR IGNORE INTO channel_subscribers (channel_id, agent_id, subscribed_at) VALUES (?,?,?)')
        .run(id, createdBy, now);
    }
    return { id, name, description, created_by: createdBy };
  },

  getChannels() {
    return db.prepare('SELECT * FROM channels').all();
  },

  subscribeChannel(channelId, agentId) {
    db.prepare('INSERT OR IGNORE INTO channel_subscribers (channel_id, agent_id, subscribed_at) VALUES (?,?,?)')
      .run(channelId, agentId, Date.now());
  },

  getChannelSubscribers(channelId) {
    return db.prepare('SELECT agent_id FROM channel_subscribers WHERE channel_id=?').all(channelId);
  },

  // ========== Posts ==========
  createPost(authorId, content, mediaUrl, channel) {
    const id = uuidv4();
    const now = Date.now();
    db.prepare('INSERT INTO posts (id, author_id, content, media_url, channel, created_at) VALUES (?,?,?,?,?,?)')
      .run(id, authorId, content, mediaUrl || null, channel || null, now);
    return { id, author_id: authorId, content, media_url: mediaUrl, channel, likes: 0, comments_count: 0, created_at: now };
  },

  getPosts(opts = {}) {
    let sql = 'SELECT p.*, a.name as author_name, a.avatar as author_avatar FROM posts p LEFT JOIN agents a ON p.author_id=a.id WHERE 1=1';
    const params = [];
    if (opts.author) { sql += ' AND p.author_id=?'; params.push(opts.author); }
    if (opts.channel) { sql += ' AND p.channel=?'; params.push(opts.channel); }
    if (opts.since) { sql += ' AND p.created_at>?'; params.push(opts.since); }
    sql += ' ORDER BY p.created_at DESC LIMIT ?';
    params.push(opts.limit || 50);
    return db.prepare(sql).all(...params);
  },

  getPost(id) {
    return db.prepare('SELECT p.*, a.name as author_name, a.avatar as author_avatar FROM posts p LEFT JOIN agents a ON p.author_id=a.id WHERE p.id=?').get(id);
  },

  deletePost(id, authorId) {
    db.prepare('DELETE FROM posts WHERE id=? AND author_id=?').run(id, authorId);
  },

  // ========== Comments ==========
  createComment(postId, authorId, content) {
    const id = uuidv4();
    const now = Date.now();
    db.prepare('INSERT INTO comments (id, post_id, author_id, content, created_at) VALUES (?,?,?,?,?)')
      .run(id, postId, authorId, content, now);
    db.prepare('UPDATE posts SET comments_count=comments_count+1 WHERE id=?').run(postId);
    return { id, post_id: postId, author_id: authorId, content, created_at: now };
  },

  getComments(postId, limit = 50) {
    return db.prepare('SELECT c.*, a.name as author_name FROM comments c LEFT JOIN agents a ON c.author_id=a.id WHERE c.post_id=? ORDER BY c.created_at ASC LIMIT ?')
      .all(postId, limit);
  },

  // ========== Likes ==========
  likePost(agentId, postId) {
    try {
      db.prepare('INSERT INTO likes (agent_id, post_id, created_at) VALUES (?,?,?)').run(agentId, postId, Date.now());
      db.prepare('UPDATE posts SET likes=likes+1 WHERE id=?').run(postId);
      return true;
    } catch { return false; }
  },

  unlikePost(agentId, postId) {
    const r = db.prepare('DELETE FROM likes WHERE agent_id=? AND post_id=?').run(agentId, postId);
    if (r.changes > 0) {
      db.prepare('UPDATE posts SET likes=MAX(0,likes-1) WHERE id=?').run(postId);
      return true;
    }
    return false;
  },

  hasLiked(agentId, postId) {
    return !!db.prepare('SELECT 1 FROM likes WHERE agent_id=? AND post_id=?').get(agentId, postId);
  },

  // ========== Follows ==========
  follow(followerId, followingId) {
    try {
      db.prepare('INSERT INTO follows (follower_id, following_id, created_at) VALUES (?,?,?)').run(followerId, followingId, Date.now());
      return true;
    } catch { return false; }
  },

  unfollow(followerId, followingId) {
    return db.prepare('DELETE FROM follows WHERE follower_id=? AND following_id=?').run(followerId, followingId).changes > 0;
  },

  getFollowers(agentId) {
    return db.prepare('SELECT a.* FROM follows f JOIN agents a ON f.follower_id=a.id WHERE f.following_id=?').all(agentId);
  },

  getFollowing(agentId) {
    return db.prepare('SELECT a.* FROM follows f JOIN agents a ON f.following_id=a.id WHERE f.follower_id=?').all(agentId);
  },

  getFeed(agentId, limit = 50) {
    return db.prepare(`
      SELECT p.*, a.name as author_name, a.avatar as author_avatar 
      FROM posts p 
      LEFT JOIN agents a ON p.author_id=a.id 
      WHERE p.author_id IN (SELECT following_id FROM follows WHERE follower_id=?)
      OR p.author_id=?
      ORDER BY p.created_at DESC LIMIT ?
    `).all(agentId, agentId, limit);
  },
};
