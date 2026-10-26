-- ОПЛАТА ПЕРЕВОДОМ НА САЙТЕ (окт 2026) — api/pay-transfer.js, api/_botPay.js,
-- src/PayTransfer.jsx. Применять после 2026-10-26_bot_pay.sql и _bot_pay_auto.sql.
--
-- Покупатель не уходит с сайта: реквизиты → перевод → чек и анкета на той же
-- странице. Чек приходит владельцу в Telegram с кнопками ✅/❌, номер — на почту
-- и на сайт. Telegram покупателю не нужен.
--
-- Режим оплаты (club_settings.pay_mode): 'transfer' — на сайте (эта миграция
-- включает его), 'bot' — через Telegram-бота, 'prodamus' — касса.
-- Переключается командами владельца боту: /сайт, /бот, /касса.

alter table public.club_settings add column if not exists pay_mode text not null default 'prodamus';

-- Заказы с сайта живут в той же таблице, что и заказы из бота.
alter table public.bot_orders add column if not exists source      text not null default 'bot';
alter table public.bot_orders add column if not exists email       text;
alter table public.bot_orders add column if not exists phone       text;
alter table public.bot_orders add column if not exists buyer_name  text;
alter table public.bot_orders add column if not exists birth_date  date;
alter table public.bot_orders add column if not exists consent_at  timestamptz;
alter table public.bot_orders add column if not exists new_account boolean not null default false;

-- Реквизиты (их же видит ИИ, сверяя получателя в чеке) и включение оплаты на сайте.
insert into public.club_settings (id, pay_requisites, pay_mode)
values (1, E'‼️СБП по номеру: +7 9606770009\n💳  Банк: Т-Банк\n👤  Самозанятый: Максим Игоревич Завалишин\n🌎  Оплатить из любой точки мира пиши @maxim_athlete\n📩  email: maxim-46kursk@mail.ru', 'transfer')
on conflict (id) do update set pay_requisites = excluded.pay_requisites, pay_mode = 'transfer', updated_at = now();
