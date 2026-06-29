const express = require('express');
const router = express.Router();
const db = require('../models/database');
const sse = require('../sse');

// Send message
router.post('/', (req, res) => {
  const { from_id, to_id, content, channel, msg_type } = req.body;
  if (!from_id || !content) return res.status(400).json({ error: 'from_id and content required' });
  const msg = db.saveMessage(from_id, to_id, content, channel, msg_type);

  // Push to specific target
  const payload = { type: 'message', ...msg };
  if (to_id) sse.push(to_id, payload);
  if (channel) {
    const subscribers = db.getChannelSubscribers(channel);
    subscribers.forEach(sub => {
      if (sub.agent_id !== from_id) sse.push(sub.agent_id, payload);
    });
  }

  // 广播给所有客户端（Dashboard 实时更新）
  sse.broadcast(payload);

  res.json({ ok: true, message: msg });
});

// Get messages
router.get('/', (req, res) => {
  const { to, from, channel, since, limit } = req.query;
  const messages = db.getMessages({ to, from, channel, since: since ? parseInt(since) : undefined, limit: limit ? parseInt(limit) : undefined });
  res.json({ messages });
});

module.exports = router;
