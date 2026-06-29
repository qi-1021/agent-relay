const Database = require('better-sqlite3');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

const dbPath = path.join(__dirname, '../../data/relay.db');
const fs = require('fs');
fs.mkdirSync(path.dirname(dbPath), { recursive: true });

const db = new Database(dbPath);
db.pragma('journal_mode = WAL');

// Create tables
db.exec(`
  CREATE TABLE IF NOT EXISTS agents (
    id TEXT PRIMARY KEY,
    name TEXT,
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
    timestamp INTEGER NOT NULL,
    FOREIGN KEY (from_id) REFERENCES agents(id)
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

  CREATE INDEX IF NOT EXISTS idx_messages_to ON messages(to_id);
  CREATE INDEX IF NOT EXISTS idx_messages_channel ON messages(channel);
  CREATE INDEX IF NOT EXISTS idx_messages_timestamp ON messages(timestamp);
`);

module.exports = {
  // Agents
  upsertAgent(id, name, framework, capabilities) {
    const now = Date.now();
    db.prepare(`
      INSERT INTO agents (id, name, framework, capabilities, status, last_seen, registered_at)
      VALUES (?, ?, ?, ?, 'online', ?, ?)
      ON CONFLICT(id) DO UPDATE SET name=?, framework=?, capabilities=?, status='online', last_seen=?
    `).run(id, name, framework, JSON.stringify(capabilities), now, now, name, framework, JSON.stringify(capabilities), now);
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

  // Messages
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
    if (opts.limit) { sql += ' ORDER BY timestamp DESC LIMIT ?'; params.push(opts.limit); }
    else { sql += ' ORDER BY timestamp DESC LIMIT 100'; }

    return db.prepare(sql).all(...params);
  },

  getMessageCount() {
    return db.prepare('SELECT COUNT(*) as count FROM messages').get().count;
  },

  // Channels
  createChannel(id, name, description, createdBy) {
    const now = Date.now();
    db.prepare('INSERT OR IGNORE INTO channels (id, name, description, created_by, created_at) VALUES (?,?,?,?,?)')
      .run(id, name, description, createdBy, now);
    // Auto-subscribe creator
    db.prepare('INSERT OR IGNORE INTO channel_subscribers (channel_id, agent_id, subscribed_at) VALUES (?,?,?)')
      .run(id, createdBy, now);
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
  }
};
