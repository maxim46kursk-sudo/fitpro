-- Акция «Skoda Octavia» (окт–нояб 2026): номера участников.
--
-- Номер выдаёт САМА БАЗА в момент записи оплаты (api/prodamus-webhook.js →
-- api/_promo.js → promo_issue). Не бот и не приложение: так один номер нельзя
-- выдать двоим, и номера идут подряд без дыр (обычная sequence даёт дыры при
-- откатах — участники спросили бы «где №14?»).
--
-- Каждый номер привязан к платежу (payment_key = ключ идемпотентности вебхука).
-- Повтор уведомления Продамуса вернёт ТЕ ЖЕ номера, а не новые.
-- Тестовые оплаты (служебный тариф test50) получают номера с 9001 и в розыгрыше
-- не участвуют (is_test).

create table if not exists public.promo_tickets (
  number      integer primary key,
  promo       text not null default 'octavia-2026-11',
  payment_key text not null,
  idx         smallint not null,
  user_id     uuid references auth.users(id) on delete set null,
  amount      integer,
  is_test     boolean not null default false,
  created_at  timestamptz not null default now(),
  unique (payment_key, idx)
);
create index if not exists promo_tickets_user_idx on public.promo_tickets (user_id);

-- Анкета участника + ключ входа из письма.
create table if not exists public.promo_participants (
  user_id         uuid primary key references auth.users(id) on delete cascade,
  promo           text not null default 'octavia-2026-11',
  email           text,
  phone           text,
  full_name       text,
  birth_date      date,
  consent_at      timestamptz,
  login_token     text unique,
  login_token_exp timestamptz,
  mail_sent_at    timestamptz,
  mail_error      text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

alter table public.promo_tickets enable row level security;
alter table public.promo_participants enable row level security;
revoke all on public.promo_tickets from anon, authenticated;
revoke all on public.promo_participants from anon, authenticated;

create or replace function public.promo_issue(p_key text, p_count int, p_user uuid, p_amount int, p_test boolean)
returns int[] language plpgsql security definer set search_path = public as $$
declare
  r int[];
  base int;
  i int;
begin
  if p_count is null or p_count < 1 or p_count > 10 then
    raise exception 'promo_issue: неверное количество %', p_count;
  end if;
  -- Одна выдача за раз: номера строго подряд.
  perform pg_advisory_xact_lock(7262011);
  select array_agg(number order by idx) into r from promo_tickets where payment_key = p_key;
  if r is not null then return r; end if;
  if p_test then
    select coalesce(max(number), 9000) into base from promo_tickets where is_test;
  else
    select coalesce(max(number), 0) into base from promo_tickets where not is_test;
  end if;
  for i in 1..p_count loop
    insert into promo_tickets(number, payment_key, idx, user_id, amount, is_test)
    values (base + i, p_key, i, p_user, p_amount, p_test);
  end loop;
  select array_agg(number order by idx) into r from promo_tickets where payment_key = p_key;
  return r;
end $$;
revoke all on function public.promo_issue(text, int, uuid, int, boolean) from public, anon, authenticated;
grant execute on function public.promo_issue(text, int, uuid, int, boolean) to service_role;

-- Таблица для эфира: номер → имя, телефон, почта. Смотреть только из psql / студии.
create or replace view public.promo_board as
  select t.number, t.is_test, t.created_at as paid_at, t.amount,
         p.full_name, p.birth_date, p.phone, p.email,
         (p.full_name is not null and p.birth_date is not null and p.phone is not null and p.consent_at is not null) as anketa_ok
  from promo_tickets t left join promo_participants p on p.user_id = t.user_id
  order by t.number;
revoke all on public.promo_board from anon, authenticated;
