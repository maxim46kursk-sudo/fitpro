-- ПРОВЕРКА ЧЕКОВ ИИ + РЕЖИМ РАБОТЫ (окт 2026) — api/_botPay.js. Применять после
-- sql/2026-10-26_bot_pay.sql.
--
-- ИИ читает чек и пишет менеджеру подсказку (сумма, дата, получатель, повтор
-- чека); подтверждает менеджер. Вне режима работы покупатель видит «подтвердим
-- утром», утром ночные чеки пересылаются менеджеру. Режим /авто — выдача без
-- менеджера, если всё сошлось.

-- По умолчанию чеки подтверждает менеджер (ИИ только подсказывает). /авто — автовыдача.
alter table public.club_settings add column if not exists pay_auto boolean not null default false;
-- Режим работы менеджера, часы по Москве: «9-24» = с 9:00 до 00:00.
alter table public.club_settings add column if not exists pay_hours text not null default '9-24';
-- Ночной автопилот (по умолчанию выключен — ночью номера ждут менеджера). Включается /ночь 0-9.
alter table public.club_settings add column if not exists pay_night text not null default 'off';
-- Смещение опроса отдельного бота оплаты (PAY_BOT_TOKEN).
alter table public.club_settings add column if not exists pay_tg_offset bigint not null default 0;
-- День, когда утром уже пересылали ночные чеки.
alter table public.club_settings add column if not exists pay_reminded_on date;
alter table public.bot_orders add column if not exists receipt_check text;

alter table public.bot_orders add column if not exists receipt_unique_id text;
alter table public.bot_orders add column if not exists receipt_op_id text;
alter table public.bot_orders add column if not exists receipt_ai jsonb;
alter table public.bot_orders add column if not exists auto boolean not null default false;
create index if not exists bot_orders_op_idx on public.bot_orders (receipt_op_id);
create index if not exists bot_orders_file_idx on public.bot_orders (receipt_unique_id);

alter table public.bot_orders drop constraint if exists bot_orders_status_check;
alter table public.bot_orders add constraint bot_orders_status_check
  check (status in ('new', 'receipt', 'confirming', 'confirmed', 'rejected', 'annulled'));
