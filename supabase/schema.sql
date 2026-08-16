-- Reasoning Hub — Supabase (Postgres) schema
-- Run this once in Supabase → SQL Editor → New Query → Run.

create table if not exists users (
  id            bigint generated always as identity primary key,
  email         text not null unique,
  password_hash text not null,
  name          text,
  role          text not null default 'user' check (role in ('user', 'admin')),
  suspended     boolean not null default false,   -- admin can pause an account without deleting it
  max_files     integer not null default 10,      -- admin-adjustable cap on this user's saved documents
  created_at    timestamptz not null default now()
);

-- Safe to re-run against a database that predates max_files:
alter table users add column if not exists max_files integer not null default 10;

-- Public-profile fields — shown when someone clicks a Public Files uploader's
-- name. All optional; a user fills in what they want visible.
alter table users add column if not exists phone text;
alter table users add column if not exists instagram text;
alter table users add column if not exists tiktok text;          -- legacy, no longer editable from the UI
alter table users add column if not exists contact_email text;   -- public contact email, separate from login email
alter table users add column if not exists whatsapp boolean not null default false; -- user confirmed the phone number above is on WhatsApp

create table if not exists kv (
  scope_user_id bigint not null,   -- 0 = shared/global scope, otherwise a users.id
  app           text not null,     -- 'matrix' | 'reasoning' | 'prep30' | ...
  key           text not null,
  value         text not null,
  updated_at    timestamptz not null default now(),
  primary key (scope_user_id, app, key)
);

create index if not exists idx_kv_app_key on kv (app, key);

-- Files are now stored in Supabase Storage (a bucket called "documents"),
-- not on local disk — local disk doesn't persist on Netlify. This table
-- just tracks metadata; storage_path points at the actual file in the bucket.
create table if not exists files (
  id            bigint generated always as identity primary key,
  owner_id      bigint not null references users(id) on delete cascade,
  original_name text not null,
  storage_path  text not null unique,   -- path inside the "documents" bucket
  mime_type     text not null,
  size_bytes    bigint not null,
  is_public     boolean not null default false,
  description   text,
  created_at    timestamptz not null default now()
);

alter table files add column if not exists description text;

create index if not exists idx_files_owner on files (owner_id);
create index if not exists idx_files_public on files (is_public);

-- Admin-to-user messages, shown as a popup toast the next time that user
-- loads any page. read_at is set once the user dismisses it.
create table if not exists messages (
  id            bigint generated always as identity primary key,
  recipient_id  bigint not null references users(id) on delete cascade,
  sender_id     bigint references users(id) on delete set null,
  body          text not null,
  created_at    timestamptz not null default now(),
  read_at       timestamptz
);

create index if not exists idx_messages_recipient_unread on messages (recipient_id) where read_at is null;

-- User-to-admin help requests. A user types a message from Account Center;
-- any admin can see the queue and mark it resolved once handled. Separate
-- from `messages` above, which only flows admin → user.
create table if not exists help_messages (
  id            bigint generated always as identity primary key,
  sender_id     bigint not null references users(id) on delete cascade,
  body          text not null,
  created_at    timestamptz not null default now(),
  resolved_at   timestamptz
);

create index if not exists idx_help_messages_open on help_messages (created_at) where resolved_at is null;

-- Backend uses the SERVICE ROLE key, which bypasses RLS entirely — this is
-- a safety net against the anon/public key ever touching these tables.
alter table users enable row level security;
alter table kv enable row level security;
alter table files enable row level security;
alter table messages enable row level security;
alter table help_messages enable row level security;
