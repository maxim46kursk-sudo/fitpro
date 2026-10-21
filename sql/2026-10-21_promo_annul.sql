-- Акция «Skoda Octavia»: аннулирование номеров при возврате оплаты (окт 2026).
--
-- Номер не удаляется, а помечается: видно, кто и когда вернул деньги, а
-- нумерация не сбивается (promo_issue берёт max(number), и следующий номер
-- идёт дальше). Аннулированный номер не входит ни в лимит 600, ни в итоги.
-- Аннулирует сервер: по уведомлению Продамуса о возврате (api/prodamus-webhook.js)
-- или по команде владельца боту «/возврат <номер заказа или №участника>».

alter table public.promo_tickets add column if not exists annulled_at timestamptz;
alter table public.promo_tickets add column if not exists annul_reason text;

-- Таблица для эфира: только действующие номера.
create or replace view public.promo_board as
  select t.number, t.is_test, t.created_at as paid_at, t.amount,
         p.full_name, p.birth_date, p.phone, p.email,
         (p.full_name is not null and p.birth_date is not null and p.phone is not null and p.consent_at is not null) as anketa_ok
  from promo_tickets t left join promo_participants p on p.user_id = t.user_id
  where t.annulled_at is null
  order by t.number;
revoke all on public.promo_board from anon, authenticated;
