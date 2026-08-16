const express = require('express');
const crypto = require('crypto');
const path = require('path');
const multer = require('multer');
const {
  insertFileRecord, getFileById, listFilesForOwner, listPublicFiles,
  updateFilePublic, deleteFileRecord, uploadFileToStorage, getFileSignedUrl, countFilesForOwner
} = require('../db');
const { requireAuth, blockIfSuspended } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

// Documents, plain text, and now photos — still no video/audio.
const ALLOWED_MIME = new Set([
  'application/pdf', 'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.oasis.opendocument.text', 'text/plain', 'text/markdown', 'text/csv', 'application/rtf',
  'image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/heic', 'image/heif'
]);
const ALLOWED_EXT = new Set(['.pdf', '.doc', '.docx', '.odt', '.txt', '.md', '.csv', '.rtf', '.jpg', '.jpeg', '.png', '.webp', '.gif', '.heic', '.heif']);
// NOTE: this runs behind Netlify Functions in production (see netlify.toml),
// which invoke synchronously and cap the total request body around 6MB.
// Netlify also base64-encodes binary request bodies before handing them to
// the function, which inflates size by ~33% — so the actual raw file needs
// to stay well under 6MB, not just under it. 4MB leaves a safe margin.
const MAX_SIZE = 4 * 1024 * 1024; // 4MB — safe under Netlify's ~6MB cap

// Uploads land in memory (not disk — no persistent disk exists on Netlify),
// then get streamed straight into the Supabase Storage bucket.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_SIZE },
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (ALLOWED_MIME.has(file.mimetype) || ALLOWED_EXT.has(ext)) return cb(null, true);
    cb(new Error('Only PDF, Word, ODT, RTF, TXT, MD, CSV, or photo (JPG, PNG, WEBP, GIF, HEIC) files are allowed.'));
  }
});

// POST /api/files/upload  (multipart: field "file", optional field "isPublic")
router.post('/upload', blockIfSuspended, async (req, res) => {
  // Check the admin-set cap before touching the multipart body at all —
  // cheap, and avoids wasting a Storage upload that would just get rejected.
  try {
    const current = await countFilesForOwner(req.user.id);
    const limit = req.user.max_files == null ? 10 : req.user.max_files;
    if (current >= limit) {
      return res.status(403).json({ error: `You've reached your saved-document limit (${limit}). Delete one first, or ask an admin to raise your limit.` });
    }
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'Could not check your document limit.' });
  }

  upload.single('file')(req, res, async (err) => {
    if (err) return res.status(400).json({ error: err.message || 'Upload failed' });
    if (!req.file) return res.status(400).json({ error: 'No file received' });

    const isPublic = req.body.isPublic === 'true' || req.body.isPublic === '1';
    const description = (req.body.description || '').trim().slice(0, 500); // 500-char cap, plenty for a short note
    const random = crypto.randomBytes(16).toString('hex');
    const storagePath = `${req.user.id}/${random}${path.extname(req.file.originalname).toLowerCase()}`;

    try {
      await uploadFileToStorage(storagePath, req.file.buffer, req.file.mimetype || 'application/octet-stream');
      const record = await insertFileRecord({
        ownerId: req.user.id, originalName: req.file.originalname, storagePath,
        mimeType: req.file.mimetype || 'application/octet-stream', sizeBytes: req.file.size, isPublic,
        description: description || null
      });
      res.status(201).json({ id: record.id });
    } catch (e) {
      console.error(e);
      res.status(500).json({ error: 'Upload failed — could not save to storage' });
    }
  });
});

router.get('/mine', async (req, res) => {
  try {
    const files = await listFilesForOwner(req.user.id);
    const limit = req.user.max_files == null ? 10 : req.user.max_files;
    res.json({ files, limit, used: files.length });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Could not load your files' });
  }
});

router.get('/public', async (req, res) => {
  try {
    res.json({ files: await listPublicFiles() });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Could not load public files' });
  }
});

// GET /api/files/:id/download — owner, admin, or (if public) any signed-in user.
// Redirects to a short-lived signed Storage URL rather than streaming the
// file through this function.
router.get('/:id/download', async (req, res) => {
  try {
    const file = await getFileById(req.params.id);
    if (!file) return res.status(404).json({ error: 'File not found' });
    const isOwner = file.owner_id === req.user.id;
    const isAdmin = req.user.role === 'admin';
    if (!isOwner && !isAdmin && !file.is_public) {
      return res.status(403).json({ error: 'This file is private' });
    }
    const url = await getFileSignedUrl(file.storage_path);
    res.redirect(url);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Could not generate download link' });
  }
});

// PATCH /api/files/:id  { isPublic: true|false } — owner or admin
router.patch('/:id', blockIfSuspended, async (req, res) => {
  try {
    const file = await getFileById(req.params.id);
    if (!file) return res.status(404).json({ error: 'File not found' });
    if (file.owner_id !== req.user.id && req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Not your file' });
    }
    await updateFilePublic(file.id, !!req.body.isPublic);
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Could not update file' });
  }
});

// DELETE /api/files/:id — owner or admin (admins use this to remove any
// user's document, e.g. from the admin dashboard's file list).
router.delete('/:id', async (req, res) => {
  try {
    const file = await getFileById(req.params.id);
    if (!file) return res.status(404).json({ error: 'File not found' });
    if (file.owner_id !== req.user.id && req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Not your file' });
    }
    await deleteFileRecord(file.id, file.storage_path);
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Could not delete file' });
  }
});

module.exports = router;
