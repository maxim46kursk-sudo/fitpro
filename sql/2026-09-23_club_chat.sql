-- Чат клуба ZMClub: Телеграм-группа, куда бот сам пускает оплативших и откуда
-- сам убирает тех, у кого закончился доступ (api/club-chat.js).
--
-- Доступ ко всем трём таблицам — только служебным ключом с сервера: RLS
-- включён, политик нет, у anon и authenticated прав нет.

-- Какая группа — чат клуба. Одна строка (id = 1). Заполняется сама, когда
-- владелец делает бота админом группы.
create table if not exists public.club_settings (
  id          int primary key default 1 check (id = 1),
  chat_id     bigint,
  chat_title  text,
  updated_at  timestamptz not null default now()
);

-- Личные ссылки-заявки. Одна ссылка = один человек, срабатывает один раз.
create table if not exists public.club_chat_invites (
  invite_link text primary key,
  user_id     uuid not null references auth.users(id) on delete cascade,
  chat_id     bigint not null,
  created_at  timestamptz not null default now(),
  expires_at  timestamptz not null,
  used_at     timestamptz,
  tg_user_id  bigint
);
create index if not exists club_chat_invites_user_idx on public.club_chat_invites (user_id, created_at desc);

-- Кто из пользователей приложения сейчас в группе и под каким Telegram-id.
create table if not exists public.club_chat_members (
  user_id     uuid primary key references auth.users(id) on delete cascade,
  tg_user_id  bigint not null,
  chat_id     bigint not null,
  joined_at   timestamptz not null default now(),
  removed_at  timestamptz
);

alter table public.club_settings     enable row level security;
alter table public.club_chat_invites enable row level security;
alter table public.club_chat_members enable row level security;

revoke all on public.club_settings, public.club_chat_invites, public.club_chat_members from anon, authenticated;
