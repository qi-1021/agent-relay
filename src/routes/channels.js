const express = require('express');
const router = express.Router();
const db = require('../models/database');

// Create channel
router.post('/', (req, res) => {
  const { id, name, description, created_by } = req.body;
  if (!id || !name) return res.status(400).json({ error: 'id and name required' });
  const channel = db.createChannel(id, name, description, created_by);
  res.json({ ok: true, channel });
});

// List channels
router.get('/', (req, res) => {
  res.json({ channels: db.getChannels() });
});

// Subscribe to channel
router.post('/:id/subscribe', (req, res) => {
  const { agent_id } = req.body;
  if (!agent_id) return res.status(400).json({ error: 'agent_id required' });
  db.subscribeChannel(req.params.id, agent_id);
  res.json({ ok: true });
});

module.exports = router;
