-- Оплата клуба без аккаунта (api/create-payment.js → prodamus-webhook.js →
-- api/guest-order.js). Заказ = секретный номер, который живёт в браузере
-- покупателя; вебхук привязывает к нему аккаунт по почте из кассы.

create table if not exists public.guest_orders (
  token        text primary key,          -- секрет; по нему приложение входит после оплаты
  plan         text not null,
  created_at   timestamptz not null default now(),
  paid_at      timestamptz,
  user_id      uuid references auth.users(id) on delete cascade,
  email        text,
  phone        text,
  new_account  boolean,                   -- аккаунт заведён этим заказом (только тогда вход по заказу)
  claimed_at   timestamptz                -- ключ входа уже выдан
);
create index if not exists guest_orders_user_idx on public.guest_orders (user_id);

alter table public.guest_orders enable row level security;
revoke all on public.guest_orders from anon, authenticated;

-- Поиск аккаунта по почте для вебхука. Только служебному ключу.
create or replace function public.auth_user_id_by_email(em text)
returns uuid language sql stable security definer set search_path = auth, public as $$
  select id from auth.users where lower(email) = lower(em) limit 1;
$$;
revoke all on function public.auth_user_id_by_email(text) from public, anon, authenticated;
grant execute on function public.auth_user_id_by_email(text) to service_role;
