-- Чат клуба: бот забирает обновления сам (getUpdates) вместо вебхука —
-- входящие соединения Telegram до сервера не доходят. Здесь хранится смещение,
-- чтобы одно обновление не обработать дважды (api/club-chat.js, action=poll).
alter table public.club_settings add column if not exists tg_offset bigint not null default 0;
