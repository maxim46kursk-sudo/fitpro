-- profiles.plan: разрешить тариф club (ZMClub, 1000 ₽/мес, сент 2026).
--
-- Без этого первая же оплата клуба повторит сбой test50 (см.
-- 2026-08-10_profiles_plan_test50.sql): деньги спишутся, а вебхук упадёт на
-- profiles_plan_check и доступ не выдаст. Применить на прод ДО выкладки кода.
--
-- Старые значения остаются: у купивших раньше в plan лежат base/profit/premium.

alter table public.profiles
  drop constraint if exists profiles_plan_check;

alter table public.profiles
  add constraint profiles_plan_check
  check (plan = any (array['start'::text, 'base'::text, 'profit'::text, 'premium'::text, 'test50'::text, 'club'::text]));
