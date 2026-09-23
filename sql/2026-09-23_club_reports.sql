-- Видео-отчёты тренеру из тренировки (ZMClub, api/club-chat.js action=report).

-- Тема группы, куда бот публикует отчёты (ставится командой /reports в теме).
alter table public.club_settings add column if not exists reports_thread_id bigint;

-- Отчёт = пост бота в группе. По tg_message_id узнаём, на какой отчёт ответил
-- тренер (reply), и показываем ответ участнику в «Прогресс → Мои отчёты».
create table if not exists public.club_reports (
  id            bigserial primary key,
  user_id       uuid not null references auth.users(id) on delete cascade,
  chat_id       bigint not null,
  tg_message_id bigint not null,
  exercise      text not null,
  set_info      text,
  note          text,
  created_at    timestamptz not null default now(),
  answered_at   timestamptz,
  reply_text    text,
  seen_at       timestamptz
);
create index if not exists club_reports_user_idx on public.club_reports (user_id, created_at desc);
create unique index if not exists club_reports_msg_idx on public.club_reports (chat_id, tg_message_id);

alter table public.club_reports enable row level security;
revoke all on public.club_reports from anon, authenticated;
-- Человек видит свои отчёты и может отметить ответ прочитанным — больше ничего.
grant select on public.club_reports to authenticated;
grant update (seen_at) on public.club_reports to authenticated;
drop policy if exists club_reports_own_select on public.club_reports;
create policy club_reports_own_select on public.club_reports for select to authenticated using (user_id = auth.uid());
drop policy if exists club_reports_own_seen on public.club_reports;
create policy club_reports_own_seen on public.club_reports for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());

-- Хранилище: приватный бакет, 50 МБ (потолок Telegram для ботов), только видео.
-- Файл лежит там секунды — сервер забирает его в Телеграм и удаляет.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('club-reports', 'club-reports', false, 52428800, array['video/*'])
on conflict (id) do update set file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;

-- Загружать можно только в свою папку (<user_id>/...). Читает и удаляет сервер
-- служебным ключом.
drop policy if exists club_reports_upload_own on storage.objects;
create policy club_reports_upload_own on storage.objects for insert to authenticated
  with check (bucket_id = 'club-reports' and (storage.foldername(name))[1] = auth.uid()::text);
