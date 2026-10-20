-- profiles.plan: разрешить тариф club4 (ZMClub 3+1 — 4 месяца за 9000 ₽, окт 2026).
--
-- Без этого первая же оплата пакета 3+1 повторит сбой test50/club: деньги
-- спишутся, а вебхук упадёт на profiles_plan_check и доступ не выдаст.
-- ПРИМЕНИТЬ НА ПРОД ДО ВЫКЛАДКИ КОДА.

alter table public.profiles
  drop constraint if exists profiles_plan_check;

alter table public.profiles
  add constraint profiles_plan_check
  check (plan = any (array['start'::text, 'base'::text, 'profit'::text, 'premium'::text, 'test50'::text, 'club'::text, 'club4'::text]));
