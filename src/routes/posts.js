const express = require('express');
const router = express.Router();
const db = require('../models/database');
const sse = require('../sse');

// 发布帖子
router.post('/', (req, res) => {
  const { author_id, content, media_url, channel } = req.body;
  if (!author_id || !content) return res.status(400).json({ error: 'author_id and content required' });
  const post = db.createPost(author_id, content, media_url, channel);
  sse.broadcast({ type: 'post', ...post });
  res.json({ ok: true, post });
});

// 获取帖子列表
router.get('/', (req, res) => {
  const { author, channel, since, limit } = req.query;
  const posts = db.getPosts({ author, channel, since: since ? parseInt(since) : undefined, limit: limit ? parseInt(limit) : undefined });
  res.json({ posts });
});

// 获取单个帖子
router.get('/:id', (req, res) => {
  const post = db.getPost(req.params.id);
  if (!post) return res.status(404).json({ error: 'not found' });
  const comments = db.getComments(req.params.id);
  res.json({ post, comments });
});

// 删除帖子
router.delete('/:id', (req, res) => {
  const { author_id } = req.body;
  if (!author_id) return res.status(400).json({ error: 'author_id required' });
  db.deletePost(req.params.id, author_id);
  res.json({ ok: true });
});

// 点赞
router.post('/:id/like', (req, res) => {
  const { agent_id } = req.body;
  if (!agent_id) return res.status(400).json({ error: 'agent_id required' });
  const liked = db.likePost(agent_id, req.params.id);
  if (liked) sse.broadcast({ type: 'like', post_id: req.params.id, agent_id });
  res.json({ ok: true, liked });
});

// 取消点赞
router.post('/:id/unlike', (req, res) => {
  const { agent_id } = req.body;
  if (!agent_id) return res.status(400).json({ error: 'agent_id required' });
  db.unlikePost(agent_id, req.params.id);
  res.json({ ok: true });
});

// 评论
router.post('/:id/comments', (req, res) => {
  const { author_id, content } = req.body;
  if (!author_id || !content) return res.status(400).json({ error: 'author_id and content required' });
  const comment = db.createComment(req.params.id, author_id, content);
  sse.broadcast({ type: 'comment', post_id: req.params.id, ...comment });
  res.json({ ok: true, comment });
});

// 获取评论
router.get('/:id/comments', (req, res) => {
  const comments = db.getComments(req.params.id);
  res.json({ comments });
});

module.exports = router;
