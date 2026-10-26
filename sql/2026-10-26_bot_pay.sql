-- ОПЛАТА ПЕРЕВОДОМ ЧЕРЕЗ БОТА (окт 2026) — api/_botPay.js.
--
-- Зачем: Продамус на рассрочке удерживал ~40%, плюс ~4% с каждого платежа.
-- Теперь кнопка «Вступить» ведёт в бота @maxim_fitpro_bot: реквизиты → человек
-- переводит → присылает чек → владелец одной кнопкой подтверждает → бот
-- начисляет клуб и выдаёт номер(а) акции.
--
-- Переключатель: club_settings.pay_via_bot. Включается командой владельца
-- боту «/реквизиты …», выключается «/касса» (снова Продамус) — без деплоя.

alter table public.club_settings add column if not exists pay_requisites text;
alter table public.club_settings add column if not exists pay_via_bot boolean not null default false;

-- Заказы через бота. id — короткий номер, его видит владелец («Заказ #57»).
create table if not exists public.bot_orders (
  id              bigserial primary key,
  token           text unique,                 -- из ссылки t.me/<бот>?start=o_<token>
  plan            text not null check (plan in ('club', 'club4')),
  amount          integer not null,
  user_id         uuid references auth.users(id) on delete set null,  -- если платил вошедший в приложение
  tg_user_id      bigint,
  tg_name         text,
  status          text not null default 'new'
                  check (status in ('new', 'receipt', 'confirming', 'confirmed', 'rejected')),
  receipt_file_id text,
  receipt_type    text,
  owner_msg_id    bigint,
  numbers         int[],
  created_at      timestamptz not null default now(),
  receipt_at      timestamptz,
  decided_at      timestamptz
);
create index if not exists bot_orders_tg_idx on public.bot_orders (tg_user_id, created_at desc);

-- Анкета, собранная в боте, пока владелец проверяет чек. После подтверждения
-- копируется в promo_participants.
create table if not exists public.bot_buyers (
  tg_user_id  bigint primary key,
  chat_id     bigint,
  step        text,            -- phone | name | birth | consent | null
  phone       text,
  full_name   text,
  birth_date  date,
  consent_at  timestamptz,
  updated_at  timestamptz not null default now()
);

alter table public.bot_orders enable row level security;
alter table public.bot_buyers enable row level security;
revoke all on public.bot_orders, public.bot_buyers from anon, authenticated;
