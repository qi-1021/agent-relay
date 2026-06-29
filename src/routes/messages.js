const express = require('express');
const router = express.Router();
const db = require('../models/database');

// Send message
router.post('/', (req, res) => {
  const { from_id, to_id, content, channel, msg_type } = req.body;
  if (!from_id || !content) return res.status(400).json({ error: 'from_id and content required' });
  const msg = db.saveMessage(from_id, to_id, content, channel, msg_type);
  res.json({ ok: true, message: msg });
});

// Get messages
router.get('/', (req, res) => {
  const { to, from, channel, since, limit } = req.query;
  const messages = db.getMessages({ to, from, channel, since: since ? parseInt(since) : undefined, limit: limit ? parseInt(limit) : undefined });
  res.json({ messages });
});

module.exports = router;
