alter table public.club_chat_members
  add column if not exists expiry_notified_for timestamptz;
