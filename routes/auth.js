const express = require('express');
const bcrypt = require('bcryptjs');
const { getUserByEmail, insertUser, updateUserRole, updateUserProfile, getUserPublicProfile } = require('../db');
const { signToken, requireAuth, blockIfSuspended } = require('../middleware/auth');

const router = express.Router();

function adminEmailSet() {
  return (process.env.ADMIN_EMAILS || '').split(',').map(e => e.trim().toLowerCase()).filter(Boolean);
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

router.post('/register', async (req, res) => {
  const { email, password, name } = req.body || {};
  if (!email || !EMAIL_RE.test(email)) return res.status(400).json({ error: 'Enter a valid email address' });
  if (!password || password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });

  const normalizedEmail = String(email).trim().toLowerCase();
  try {
    const existing = await getUserByEmail(normalizedEmail);
    if (existing) return res.status(409).json({ error: 'An account with that email already exists' });

    const role = adminEmailSet().includes(normalizedEmail) ? 'admin' : 'user';
    const passwordHash = bcrypt.hashSync(password, 10);
    const user = await insertUser({ email: normalizedEmail, passwordHash, name: name ? String(name).trim() : null, role });

    const publicUser = { id: user.id, email: user.email, name: user.name, role: user.role };
    const token = signToken(publicUser);
    res.status(201).json({ token, user: publicUser });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Could not create account' });
  }
});

router.post('/login', async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: 'Email and password are required' });

  const normalizedEmail = String(email).trim().toLowerCase();
  try {
    const user = await getUserByEmail(normalizedEmail);
    if (!user || !bcrypt.compareSync(password, user.password_hash)) {
      return res.status(401).json({ error: 'Incorrect email or password' });
    }

    // Suspended accounts are told clearly, rather than getting a confusing
    // generic error — but they ARE allowed to log in and see their data,
    // just not create/change anything (enforced by blockIfSuspended).
    if (user.suspended) {
      const publicUser = { id: user.id, email: user.email, name: user.name, role: user.role, suspended: true };
      const token = signToken(publicUser);
      return res.json({ token, user: publicUser, notice: 'Your account has been paused by an admin.' });
    }

    const shouldBeAdmin = adminEmailSet().includes(normalizedEmail);
    if (shouldBeAdmin && user.role !== 'admin') {
      await updateUserRole(user.id, 'admin');
      user.role = 'admin';
    }

    const publicUser = { id: user.id, email: user.email, name: user.name, role: user.role };
    const token = signToken(publicUser);
    res.json({ token, user: publicUser });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Could not log in' });
  }
});

router.get('/me', requireAuth, (req, res) => {
  res.json({ user: req.user });
});

// PATCH /api/auth/profile  { name, phone, instagram, contactEmail, whatsapp }
// A user editing their own Account Center info. All fields optional except
// that contactEmail, if provided, must look like an email address.
router.patch('/profile', requireAuth, blockIfSuspended, async (req, res) => {
  const { name, phone, instagram, contactEmail, whatsapp } = req.body || {};
  if (phone && String(phone).length > 40) return res.status(400).json({ error: 'Phone number is too long.' });
  if (instagram && String(instagram).length > 100) return res.status(400).json({ error: 'Instagram value is too long.' });
  if (contactEmail && String(contactEmail).length > 150) return res.status(400).json({ error: 'Email is too long.' });
  if (contactEmail && !EMAIL_RE.test(String(contactEmail).trim())) return res.status(400).json({ error: 'Enter a valid email address.' });
  try {
    const updated = await updateUserProfile(req.user.id, {
      name: name ? String(name).trim() : null,
      phone: phone ? String(phone).trim() : null,
      instagram: instagram ? String(instagram).trim() : null,
      contactEmail: contactEmail ? String(contactEmail).trim().toLowerCase() : null,
      whatsapp: !!whatsapp
    });
    res.json({ user: updated });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Could not update profile' });
  }
});

// GET /api/auth/users/:id — public-facing profile (name + whatever contact
// info that user chose to fill in). Requires login, but not ownership —
// this is what a click on a Public Files uploader's name resolves to.
router.get('/users/:id', requireAuth, async (req, res) => {
  try {
    const profile = await getUserPublicProfile(req.params.id);
    if (!profile) return res.status(404).json({ error: 'User not found' });
    res.json({ profile });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Could not load profile' });
  }
});

module.exports = router;
