-- ЗВАТЬ ФУНКЦИЮ ВПРАВЕ ТОЛЬКО ТОТ, КОМУ ОНА НУЖНА. Раздел 4.2 отчёта.
--
-- Все четыре challenge_* — SECURITY DEFINER. Такая функция выполняется от
-- владельца, а у владельца BYPASSRLS: политики строк её не касаются вовсе.
-- Значит единственное, что стоит между публичным ключом из бандла и её телом, —
-- это право EXECUTE. По умолчанию Postgres выдаёт его PUBLIC, то есть всем.
--
-- Это ровно та конструкция, которая уже стоила разбора в июле:
-- sql/2026-07-26_privilege_lockdown.sql, функция incr_ai_usage — SECURITY
-- DEFINER, user_id из параметра, EXECUTE у PUBLIC, и любой желающий сжигал
-- жертве дневной лимит ИИ. Лечилось не переписыванием тела, а правами.
--
-- КТО КОГО ЗОВЁТ НА САМОМ ДЕЛЕ (сверено по src/ и по собранному dist/):
--   challenge_enroll     — только api/prodamus-webhook.js, служебным ключом.
--                          Из браузера не зовётся НИКОГДА. Она заводит участие
--                          в потоке по p_user_id и p_payment_id из параметров —
--                          то есть открытый EXECUTE означает участие в
--                          челлендже без оплаты, за чужой личностью.
--   funnel_bump,
--   incr_feature_usage,
--   boot_beacons_sweep   — только api/, служебным ключом. В бандле их нет.
--   challenge_standings,
--   challenge_nutrition_facts,
--   challenge_freeze_norm — ЗОВЁТСЯ ИЗ БРАУЗЕРА (src/challengeSeason.js,
--                          строки 249, 270, 288), под сессией участника.
--                          Обе точки входа — src/motion/index.jsx, строки 474
--                          и 504 — стоят за проверкой membership.entry, то есть
--                          за оплаченным участием. Лендинг и гость их не зовут
--                          НИКОГДА. Поэтому anon и PUBLIC им не нужны, а
--                          authenticated нужен — см. раздел 2.

-- ── 1. Серверные функции: EXECUTE только служебной роли ────────────────────
-- Сигнатуры сверяются перед отзывом: ошибись в типах — REVOKE молча уйдёт в
-- никуда, и отчёт «применено» будет неправдой.
\df challenge_enroll
\df funnel_bump
\df incr_feature_usage
\df boot_beacons_sweep

do $$
declare f record;
begin
  for f in
    select p.oid::regprocedure as sig
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname in ('challenge_enroll', 'funnel_bump', 'incr_feature_usage', 'boot_beacons_sweep')
  loop
    execute format('revoke execute on function %s from public, anon, authenticated', f.sig);
    execute format('grant  execute on function %s to service_role', f.sig);
    raise notice 'закрыто: %', f.sig;
  end loop;
end $$;

-- ── 2. Три функции, которые зовёт браузер ──────────────────────────────────
--
-- Право звать оставляем ровно тому, кто зовёт: вошедшему человеку. У анонима и
-- у PUBLIC его быть не должно — публичный ключ лежит в бандле, и всякий, кто
-- его достал, сейчас может звать эти функции в обход RLS (они SECURITY DEFINER).
--
-- ЭТО НЕ ЗАМЕНЯЕТ ПРОВЕРКИ ВНУТРИ ТЕЛА. authenticated — это КАЖДЫЙ вошедший, а
-- не участник этого потока. Если challenge_nutrition_facts не сверяет
-- auth.uid(), то любой зарегистрированный человек прочитает питание всех
-- участников, зная только p_season_id — а он у потока один на всех. Тела
-- поэтому выводятся ниже и читаются глазами.

do $$
declare f record;
begin
  for f in
    select p.oid::regprocedure as sig
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname in ('challenge_standings', 'challenge_nutrition_facts', 'challenge_freeze_norm')
  loop
    execute format('revoke execute on function %s from public, anon', f.sig);
    execute format('grant  execute on function %s to authenticated, service_role', f.sig);
    raise notice 'оставлено вошедшим: %', f.sig;
  end loop;
end $$;

-- 2.1. Кто имеет право звать. Пустой acl = «по умолчанию», то есть PUBLIC.
select p.proname,
       p.prosecdef as security_definer,
       coalesce(p.proconfig::text, '(search_path НЕ зафиксирован)') as config,
       coalesce(array_to_string(p.proacl, ' | '), '(по умолчанию: PUBLIC — зовёт кто угодно)') as acl
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.proname in ('challenge_standings', 'challenge_nutrition_facts', 'challenge_freeze_norm')
order by 1;

-- 2.2. Тела целиком. Смотрим одно: сверяется ли внутри auth.uid() и
-- принадлежность потоку — или функция отдаёт данные любому, кто знает
-- p_season_id (а он один и тот же для всех участников).
select pg_get_functiondef(p.oid) as definition
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.proname in ('challenge_standings', 'challenge_nutrition_facts', 'challenge_freeze_norm')
order by p.proname;

-- ── 3. Проверка раздела 1: у PUBLIC/anon/authenticated прав остаться не должно ──
select p.proname, coalesce(array_to_string(p.proacl, ' | '), '(по умолчанию: PUBLIC)') as acl
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.proname in ('challenge_enroll', 'funnel_bump', 'incr_feature_usage', 'boot_beacons_sweep',
                    'challenge_standings', 'challenge_nutrition_facts', 'challenge_freeze_norm')
order by 1;

-- ── 4. Горизонтальный доступ между тренерами (пункт 5.3 аудита) ────────────
--
-- Второго тренера в системе пока нет, живьём проверить не на ком — но политики
-- существуют уже сейчас, и прочитать их можно. Смотрим одно: у каждого правила
-- на «клиентских» таблицах условие обязано упираться либо в auth.uid(), либо в
-- принадлежность через trainer_clients. Правило, где нет ни того ни другого, —
-- это доступ тренера A к людям тренера B, и найти его надо ДО того, как в
-- системе появится второй тренер.
select tablename, policyname, cmd, roles,
       coalesce(qual, '') as using_условие,
       coalesce(with_check, '') as with_check_условие
from pg_policies
where schemaname = 'public'
  and tablename in ('profiles', 'trainer_clients', 'chat_messages', 'measurements',
                    'workouts', 'workout_sets', 'planned_workouts', 'assigned_programs',
                    'food_diary', 'food_goals', 'motion_progress', 'motion_attempts')
order by tablename, cmd;
