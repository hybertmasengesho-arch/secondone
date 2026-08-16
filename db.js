// db.js — Supabase (Postgres + Storage) data layer.
//
// Replaces the old better-sqlite3 + local-disk version. Run supabase/schema.sql
// once in the Supabase SQL Editor before starting the server, and create a
// Storage bucket named "documents" (Storage → New bucket → name it exactly
// "documents", keep it Private) before using file uploads.
require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  console.warn('[warn] SUPABASE_URL / SUPABASE_SERVICE_KEY are not set — the app cannot reach the database.');
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
  auth: { persistSession: false }
});

const FILES_BUCKET = 'documents';

/* ---------------- users ---------------- */

async function getUserByEmail(email) {
  const { data, error } = await supabase.from('users').select('*').eq('email', email).maybeSingle();
  if (error) throw error;
  return data;
}

async function getUserById(id) {
  const { data, error } = await supabase
    .from('users')
    .select('id, email, name, role, suspended, max_files, phone, instagram, contact_email, whatsapp')
    .eq('id', id)
    .maybeSingle();
  if (error) throw error;
  return data;
}

async function insertUser({ email, passwordHash, name, role }) {
  const { data, error } = await supabase
    .from('users')
    .insert({ email, password_hash: passwordHash, name, role })
    .select()
    .single();
  if (error) throw error;
  return data;
}

async function listUsers() {
  const { data, error } = await supabase
    .from('users')
    .select('id, email, name, role, suspended, max_files, created_at')
    .order('created_at', { ascending: true });
  if (error) throw error;
  return data;
}

async function updateUserMaxFiles(id, maxFiles) {
  const { data, error } = await supabase.from('users').update({ max_files: maxFiles }).eq('id', id).select();
  if (error) throw error;
  return data && data[0];
}

async function countFilesForOwner(ownerId) {
  const { count, error } = await supabase
    .from('files').select('id', { count: 'exact', head: true }).eq('owner_id', ownerId);
  if (error) throw error;
  return count || 0;
}

async function updateUserRole(id, role) {
  const { data, error } = await supabase.from('users').update({ role }).eq('id', id).select();
  if (error) throw error;
  return data && data[0];
}

// Suspended accounts can still log in (so they see a clear "your account is
// paused" message) but every write action — saving progress, uploading or
// posting files — is blocked. See middleware/auth.js and routes/kv.js / files.js.
async function setUserSuspended(id, suspended) {
  const { data, error } = await supabase.from('users').update({ suspended: !!suspended }).eq('id', id).select();
  if (error) throw error;
  return data && data[0];
}

// A user editing their own account-center info — name, phone, Instagram,
// public contact email, and whether the phone number above is on WhatsApp.
// All optional; pass null/'' to clear a field.
async function updateUserProfile(id, { name, phone, instagram, contactEmail, whatsapp }) {
  const { data, error } = await supabase
    .from('users')
    .update({
      name: name || null,
      phone: phone || null,
      instagram: instagram || null,
      contact_email: contactEmail || null,
      whatsapp: !!whatsapp
    })
    .eq('id', id)
    .select('id, email, name, role, phone, instagram, contact_email, whatsapp')
    .single();
  if (error) throw error;
  return data;
}

// Public view of another user's account-center info — used when someone
// clicks an uploader's name on Public Files. Deliberately excludes the
// login email and everything else private; contact_email is the separate,
// opt-in public email the user typed into Account Center.
async function getUserPublicProfile(id) {
  const { data, error } = await supabase
    .from('users')
    .select('id, name, phone, instagram, contact_email, whatsapp')
    .eq('id', id)
    .maybeSingle();
  if (error) throw error;
  return data;
}

async function updateUserPassword(id, passwordHash) {
  const { data, error } = await supabase.from('users').update({ password_hash: passwordHash }).eq('id', id).select();
  if (error) throw error;
  return data && data[0];
}

// Deletes the account, all their kv rows, and all their files (both the
// database rows and the actual files in Storage). users.id → files.owner_id
// has ON DELETE CASCADE, so we only need to manually clean up Storage itself.
async function deleteUser(id) {
  const { data: userFiles, error: filesErr } = await supabase.from('files').select('storage_path').eq('owner_id', id);
  if (filesErr) throw filesErr;
  if (userFiles && userFiles.length) {
    await supabase.storage.from(FILES_BUCKET).remove(userFiles.map(f => f.storage_path));
  }
  const { error } = await supabase.from('users').delete().eq('id', id);
  if (error) throw error;
}

/* ---------------- kv (generic key/value store) ---------------- */

async function kvGet(scopeUserId, app, key) {
  const { data, error } = await supabase
    .from('kv').select('value').eq('scope_user_id', scopeUserId).eq('app', app).eq('key', key).maybeSingle();
  if (error) throw error;
  return data ? data.value : null;
}

async function kvSet(scopeUserId, app, key, value) {
  const { error } = await supabase.from('kv').upsert(
    { scope_user_id: scopeUserId, app, key, value, updated_at: new Date().toISOString() },
    { onConflict: 'scope_user_id,app,key' }
  );
  if (error) throw error;
}

async function kvDelete(scopeUserId, app, key) {
  const { error } = await supabase.from('kv').delete().eq('scope_user_id', scopeUserId).eq('app', app).eq('key', key);
  if (error) throw error;
}

async function kvList(scopeUserId, app, prefix) {
  const { data, error } = await supabase
    .from('kv').select('key').eq('scope_user_id', scopeUserId).eq('app', app).like('key', `${prefix}%`).order('key', { ascending: true });
  if (error) throw error;
  return data.map(r => r.key);
}

async function kvCountByPrefix(app, prefix) {
  const { data, error } = await supabase
    .from('kv').select('scope_user_id').neq('scope_user_id', 0).eq('app', app).like('key', `${prefix}%`);
  if (error) throw error;
  const counts = {};
  data.forEach(row => { counts[row.scope_user_id] = (counts[row.scope_user_id] || 0) + 1; });
  return counts;
}

async function kvRowsForAppKey(app, key) {
  const { data, error } = await supabase
    .from('kv').select('scope_user_id, value').neq('scope_user_id', 0).eq('app', app).eq('key', key);
  if (error) throw error;
  return data;
}

// Deletes every kv row (progress) for a user in one app, or every app if
// appFilter is omitted. Used by the admin "delete this user's documents /
// progress" action without deleting the account itself.
async function kvDeleteAllForUser(scopeUserId, appFilter) {
  let query = supabase.from('kv').delete().eq('scope_user_id', scopeUserId);
  if (appFilter) query = query.eq('app', appFilter);
  const { error } = await query;
  if (error) throw error;
}

/* ---------------- files (Supabase Storage) ---------------- */

async function insertFileRecord({ ownerId, originalName, storagePath, mimeType, sizeBytes, isPublic, description }) {
  const { data, error } = await supabase
    .from('files')
    .insert({
      owner_id: ownerId, original_name: originalName, storage_path: storagePath, mime_type: mimeType,
      size_bytes: sizeBytes, is_public: !!isPublic, description: description || null
    })
    .select()
    .single();
  if (error) throw error;
  return data;
}

async function getFileById(id) {
  const { data, error } = await supabase.from('files').select('*').eq('id', id).maybeSingle();
  if (error) throw error;
  return data;
}

async function listFilesForOwner(ownerId) {
  const { data, error } = await supabase
    .from('files').select('id, original_name, mime_type, size_bytes, is_public, description, created_at')
    .eq('owner_id', ownerId).order('created_at', { ascending: false });
  if (error) throw error;
  return data;
}

async function listPublicFiles() {
  const { data, error } = await supabase
    .from('files')
    .select('id, original_name, mime_type, size_bytes, description, created_at, owner_id, users!files_owner_id_fkey(email, name)')
    .eq('is_public', true)
    .order('created_at', { ascending: false });
  if (error) throw error;
  return (data || []).map(f => ({
    id: f.id, original_name: f.original_name, mime_type: f.mime_type,
    size_bytes: f.size_bytes, description: f.description, created_at: f.created_at,
    owner_id: f.owner_id, uploader_email: f.users ? f.users.email : null, uploader_name: f.users ? f.users.name : null
  }));
}

// Every file any user has ever uploaded — used by the admin dashboard so an
// admin can find and delete a specific user's documents.
async function listAllFiles() {
  const { data, error } = await supabase
    .from('files')
    .select('id, original_name, mime_type, size_bytes, is_public, created_at, owner_id, users!files_owner_id_fkey(email, name)')
    .order('created_at', { ascending: false });
  if (error) throw error;
  return (data || []).map(f => ({
    id: f.id, original_name: f.original_name, mime_type: f.mime_type, size_bytes: f.size_bytes,
    is_public: f.is_public, created_at: f.created_at, owner_id: f.owner_id,
    owner_email: f.users ? f.users.email : null, owner_name: f.users ? f.users.name : null
  }));
}

async function updateFilePublic(id, isPublic) {
  const { error } = await supabase.from('files').update({ is_public: !!isPublic }).eq('id', id);
  if (error) throw error;
}

async function deleteFileRecord(id, storagePath) {
  await supabase.storage.from(FILES_BUCKET).remove([storagePath]);
  const { error } = await supabase.from('files').delete().eq('id', id);
  if (error) throw error;
}

async function uploadFileToStorage(storagePath, buffer, mimeType) {
  const { error } = await supabase.storage.from(FILES_BUCKET).upload(storagePath, buffer, { contentType: mimeType, upsert: false });
  if (error) throw error;
}

// Signed URL, expires in 5 minutes — used instead of a permanently public
// link, so private files stay actually private even though Storage buckets
// are otherwise all-or-nothing.
async function getFileSignedUrl(storagePath) {
  const { data, error } = await supabase.storage.from(FILES_BUCKET).createSignedUrl(storagePath, 300);
  if (error) throw error;
  return data.signedUrl;
}

/* ---------------- messages (admin → user popup notifications) ---------------- */

async function insertMessage({ recipientId, senderId, body }) {
  const { data, error } = await supabase
    .from('messages').insert({ recipient_id: recipientId, sender_id: senderId, body }).select().single();
  if (error) throw error;
  return data;
}

async function listUnreadMessagesForUser(userId) {
  const { data, error } = await supabase
    .from('messages').select('id, body, created_at').eq('recipient_id', userId).is('read_at', null).order('created_at', { ascending: true });
  if (error) throw error;
  return data;
}

async function markMessageRead(id, userId) {
  // Scoped to recipient_id so a user can only mark their own messages read.
  const { error } = await supabase.from('messages').update({ read_at: new Date().toISOString() }).eq('id', id).eq('recipient_id', userId);
  if (error) throw error;
}

/* ---------------- help_messages (user → admin help requests) ---------------- */

async function insertHelpMessage({ senderId, body }) {
  const { data, error } = await supabase
    .from('help_messages').insert({ sender_id: senderId, body }).select().single();
  if (error) throw error;
  return data;
}

// Every admin's queue — open ones first (newest first), then resolved ones.
async function listHelpMessages() {
  const { data, error } = await supabase
    .from('help_messages')
    .select('id, body, created_at, resolved_at, sender_id, users!help_messages_sender_id_fkey(email, name)')
    .order('resolved_at', { ascending: true, nullsFirst: true })
    .order('created_at', { ascending: false });
  if (error) throw error;
  return (data || []).map(r => ({
    id: r.id, body: r.body, created_at: r.created_at, resolved_at: r.resolved_at,
    sender_id: r.sender_id, sender_email: r.users && r.users.email, sender_name: r.users && r.users.name
  }));
}

async function setHelpMessageResolved(id, resolved) {
  const { data, error } = await supabase
    .from('help_messages')
    .update({ resolved_at: resolved ? new Date().toISOString() : null })
    .eq('id', id).select().maybeSingle();
  if (error) throw error;
  return data;
}

module.exports = {
  supabase,
  getUserByEmail, getUserById, insertUser, listUsers, updateUserRole,
  setUserSuspended, updateUserPassword, deleteUser, updateUserMaxFiles, countFilesForOwner,
  updateUserProfile, getUserPublicProfile,
  kvGet, kvSet, kvDelete, kvList, kvCountByPrefix, kvRowsForAppKey, kvDeleteAllForUser,
  insertFileRecord, getFileById, listFilesForOwner, listPublicFiles, listAllFiles,
  updateFilePublic, deleteFileRecord, uploadFileToStorage, getFileSignedUrl,
  insertMessage, listUnreadMessagesForUser, markMessageRead,
  insertHelpMessage, listHelpMessages, setHelpMessageResolved
};
