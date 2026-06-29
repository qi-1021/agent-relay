const express = require('express');
const router = express.Router();
const db = require('../models/database');
const sse = require('../sse');

// 关注
router.post('/follow', (req, res) => {
  const { follower_id, following_id } = req.body;
  if (!follower_id || !following_id) return res.status(400).json({ error: 'follower_id and following_id required' });
  if (follower_id === following_id) return res.status(400).json({ error: 'cannot follow yourself' });
  db.follow(follower_id, following_id);
  sse.broadcast({ type: 'follow', follower_id, following_id });
  res.json({ ok: true });
});

// 取消关注
router.post('/unfollow', (req, res) => {
  const { follower_id, following_id } = req.body;
  db.unfollow(follower_id, following_id);
  res.json({ ok: true });
});

// 获取关注者
router.get('/followers/:id', (req, res) => {
  res.json({ followers: db.getFollowers(req.params.id) });
});

// 获取关注列表
router.get('/following/:id', (req, res) => {
  res.json({ following: db.getFollowing(req.params.id) });
});

// 动态流（关注的人的帖子 + 自己的帖子）
router.get('/feed/:id', (req, res) => {
  const limit = parseInt(req.query.limit) || 50;
  const posts = db.getFeed(req.params.id, limit);
  res.json({ posts });
});

// 更新个人资料
router.post('/profile/:id', (req, res) => {
  const { name, avatar, bio } = req.body;
  db.updateProfile(req.params.id, { name, avatar, bio });
  const agent = db.getAgent(req.params.id);
  res.json({ ok: true, agent });
});

module.exports = router;
