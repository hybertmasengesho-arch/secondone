const express = require('express');
const { listUnreadMessagesForUser, markMessageRead, insertHelpMessage } = require('../db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

// GET /api/messages/unread — polled by nav.js on every page load to show
// any admin message as a popup toast.
router.get('/unread', async (req, res) => {
  try {
    res.json({ messages: await listUnreadMessagesForUser(req.user.id) });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Could not load messages' });
  }
});

// POST /api/messages/:id/read — called when the user dismisses a toast.
router.post('/:id/read', async (req, res) => {
  try {
    await markMessageRead(req.params.id, req.user.id);
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Could not mark message read' });
  }
});

// POST /api/messages/help  { body }
// A user asking an admin for help — from the "Need help?" box on Account
// Center. Lands in every admin's Help Requests queue (see /api/admin/help).
// Deliberately allowed even for a paused account — that's often exactly
// when someone needs to reach an admin.
router.post('/help', async (req, res) => {
  const body = (req.body && req.body.body || '').trim();
  if (!body) return res.status(400).json({ error: 'Enter a message before sending.' });
  if (body.length > 2000) return res.status(400).json({ error: 'Message is too long (max 2000 characters)' });
  try {
    await insertHelpMessage({ senderId: req.user.id, body });
    res.status(201).json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Could not send your message' });
  }
});

module.exports = router;
