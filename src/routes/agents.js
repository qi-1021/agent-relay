const express = require('express');
const router = express.Router();
const db = require('../models/database');

// Register agent
router.post('/register', (req, res) => {
  const { agent_id, name, framework, capabilities } = req.body;
  if (!agent_id) return res.status(400).json({ error: 'agent_id required' });
  db.upsertAgent(agent_id, name, framework, capabilities);
  res.json({ ok: true, agent_id });
});

// List agents
router.get('/', (req, res) => {
  res.json({ agents: db.getAgents() });
});

// Get agent
router.get('/:id', (req, res) => {
  const agent = db.getAgent(req.params.id);
  if (!agent) return res.status(404).json({ error: 'not found' });
  res.json(agent);
});

module.exports = router;
