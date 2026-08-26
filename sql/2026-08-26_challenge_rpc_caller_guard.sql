-- ПУСТОЙ ВЫЗЫВАЮЩИЙ — ЭТО НЕ ДОВЕРЕННЫЙ ВЫЗЫВАЮЩИЙ. Ветка убирается.
--
-- Обе функции — SECURITY DEFINER, то есть исполняются от postgres, а у него
-- BYPASSRLS. Значит проверка «кто зовёт» внутри тела — единственное, что
-- отделяет вызов от чужих данных: challenge_standings отдаёт весь поток,
-- challenge_nutrition_facts — тридцать дней питания названного человека.
--
-- До сегодня обе проверки были написаны так:
--     if v_caller is not null and <не свой> then raise ...
-- То есть при auth.uid() = null проверка не выполнялась ВООБЩЕ и данные
-- уходили без вопросов. Задумано это было под служебный вызов: ключи самохоста
-- сгенерированы без claim `sub`, поэтому у service_role auth.uid() пуст, и
-- «пусто» читалось как «зовёт сервер, ему можно».
--
-- СЛУЖЕБНЫХ ВЫЗЫВАЮЩИХ У ЭТИХ ДВУХ ФУНКЦИЙ НЕТ. Сверено по репозиторию:
--   src/challengeSeason.js:249,270 — единственные боевые вызовы, из браузера,
--                        под сессией участника; auth.uid() там всегда заполнен.
--   qa/load.mjs:226      — нагрузочный сценарий, ходит под токеном тестового
--                        пользователя (не служебным ключом) и УЖЕ ждёт отказа.
--   scripts/challenge-shots.mjs:311 — заглушка Playwright, до базы не доходит.
--   api/*                — ни одного вызова: служебным ключом зовутся
--                        challenge_enroll, funnel_bump, incr_feature_usage и
--                        boot_beacons_sweep (см. 2026-08-25_rpc_execute_lockdown.sql),
--                        но не эти две.
--
-- Раз ветка не нужна никому, она остаётся только как способ обойти проверку:
-- любой, кто получит доступ к служебному ключу, читает весь поток и чужое
-- питание, не имея ни строчки в challenge_entries. Поэтому пустой вызывающий
-- теперь не «сервер», а отказ.
--
-- ТЕЛА ФУНКЦИЙ БОЛЬШЕ НИЧЕМ НЕ ОТЛИЧАЮТСЯ от снятых с прода перед правкой:
-- меняется одно условие в каждой. SECURITY DEFINER, search_path и права
-- сохраняются — CREATE OR REPLACE не трогает ACL, но состояние ниже
-- закрепляется явно, чтобы файл давал тот же результат и на пустой базе.

begin;

-- ── 1. challenge_standings: таблицу потока видят его участники ──────────────
CREATE OR REPLACE FUNCTION public.challenge_standings(p_season_id bigint)
 RETURNS TABLE(participant_no integer, display_name text, is_me boolean, days_done integer, day integer, best_score integer, kcal numeric, p numeric, f numeric, c numeric, meals integer, entries integer, norm_kcal numeric, norm_p numeric, norm_f numeric, norm_c numeric)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_caller uuid := auth.uid();
  v_start  date;
begin
  if v_caller is null then
    raise exception 'challenge_standings: нужен вошедший'
      using errcode = 'insufficient_privilege';
  end if;
  if not exists (
    select 1 from public.challenge_entries e
     where e.season_id = p_season_id and e.user_id = v_caller
  ) then
    raise exception 'challenge_standings: таблицу потока видят его участники'
      using errcode = 'insufficient_privilege';
  end if;

  select starts_on into v_start from public.challenge_seasons where id = p_season_id;

  return query
  with entries_ as (
    select e.user_id, e.participant_no, e.display_name,
           e.norm1_kcal, e.norm1_p, e.norm1_f, e.norm1_c,
           e.norm2_kcal, e.norm2_p, e.norm2_f, e.norm2_c, e.norm2_at,
           (e.norm1_at at time zone 'Europe/Moscow')::date as norm_from
      from public.challenge_entries e
     where e.season_id = p_season_id
       and e.user_id is not null
  ),
  days as (
    select gs.n as day from generate_series(1, 30) as gs(n)
  ),
  best as (
    select ma.user_id, ma.day::integer as day, max(ma.score)::integer as score
      from public.motion_attempts ma
      join entries_ en on en.user_id = ma.user_id
     where ma.day between 1 and 30
     group by ma.user_id, ma.day
  ),
  eaten as (
    select fd.user_id, fd.date as d,
           sum(coalesce(fd.kcal, 0)) as kcal,
           sum(coalesce(fd.p, 0))    as p,
           sum(coalesce(fd.f, 0))    as f,
           sum(coalesce(fd.c, 0))    as c,
           count(distinct nullif(btrim(coalesce(fd.meal, '')), '')) as meals,
           count(*) as entries
      from public.food_diary fd
      join entries_ en on en.user_id = fd.user_id
     where v_start is not null
       and fd.date between to_char(v_start, 'YYYY-MM-DD') and to_char(v_start + 29, 'YYYY-MM-DD')
     group by fd.user_id, fd.date
  ),
  progress as (
    select mp.user_id,
           coalesce(jsonb_array_length(mp.payload -> 'challenge' -> 'done'), 0) as done
      from public.motion_progress mp
      join entries_ en on en.user_id = mp.user_id
     where jsonb_typeof(mp.payload -> 'challenge' -> 'done') = 'array'
  )
  select en.participant_no,
         en.display_name,
         (v_caller is not null and en.user_id = v_caller) as is_me,
         coalesce(pr.done, 0)::integer as days_done,
         d.day,
         coalesce(b.score, 0) as best_score,
         coalesce(e.kcal, 0),
         coalesce(e.p, 0),
         coalesce(e.f, 0),
         coalesce(e.c, 0),
         coalesce(e.meals, 0)::integer,
         coalesce(e.entries, 0)::integer,
         case when en.norm_from is null or (v_start + (d.day - 1)) < en.norm_from then null
              when d.day >= 15 and en.norm2_at is not null then en.norm2_kcal else en.norm1_kcal end,
         case when en.norm_from is null or (v_start + (d.day - 1)) < en.norm_from then null
              when d.day >= 15 and en.norm2_at is not null then en.norm2_p    else en.norm1_p    end,
         case when en.norm_from is null or (v_start + (d.day - 1)) < en.norm_from then null
              when d.day >= 15 and en.norm2_at is not null then en.norm2_f    else en.norm1_f    end,
         case when en.norm_from is null or (v_start + (d.day - 1)) < en.norm_from then null
              when d.day >= 15 and en.norm2_at is not null then en.norm2_c    else en.norm1_c    end
    from entries_ en
    cross join days d
    left join best b on b.user_id = en.user_id and b.day = d.day
    left join eaten e on e.user_id = en.user_id
                     and v_start is not null
                     and e.d = to_char(v_start + (d.day - 1), 'YYYY-MM-DD')
    left join progress pr on pr.user_id = en.user_id
   order by en.participant_no, d.day;
end $function$;

-- ── 2. challenge_nutrition_facts: чужие дни не отдаются ─────────────────────
CREATE OR REPLACE FUNCTION public.challenge_nutrition_facts(p_season_id bigint, p_user_id uuid DEFAULT NULL::uuid)
 RETURNS TABLE(day integer, on_date date, kcal numeric, p numeric, f numeric, c numeric, meals integer, entries integer, norm_kcal numeric, norm_p numeric, norm_f numeric, norm_c numeric)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_caller uuid := auth.uid();
  v_user   uuid := coalesce(p_user_id, auth.uid());
  v_start  date;
  v_entry  public.challenge_entries%rowtype;
  v_from   date;
begin
  if v_caller is null then
    raise exception 'challenge_nutrition_facts: нужен вошедший'
      using errcode = 'insufficient_privilege';
  end if;
  if v_user is null then
    raise exception 'challenge_nutrition_facts: не указан пользователь'
      using errcode = 'null_value_not_allowed';
  end if;
  if v_user <> v_caller then
    raise exception 'challenge_nutrition_facts: чужие дни не отдаются'
      using errcode = 'insufficient_privilege';
  end if;

  select starts_on into v_start from public.challenge_seasons where id = p_season_id;
  select * into v_entry
    from public.challenge_entries
   where season_id = p_season_id and user_id = v_user;

  if v_start is null then
    return;
  end if;

  -- С какого дня норма вообще есть. NULL — её нет ни на один день.
  v_from := (v_entry.norm1_at at time zone 'Europe/Moscow')::date;

  return query
  with days as (
    select gs.n as day, (v_start + (gs.n - 1))::date as on_date
      from generate_series(1, 30) as gs(n)
  ),
  eaten as (
    select fd.date as d,
           sum(coalesce(fd.kcal, 0)) as kcal,
           sum(coalesce(fd.p, 0))    as p,
           sum(coalesce(fd.f, 0))    as f,
           sum(coalesce(fd.c, 0))    as c,
           -- РАЗНЫХ приёмов пищи: три строки в одном завтраке — это один приём
           count(distinct nullif(btrim(coalesce(fd.meal, '')), '')) as meals,
           -- и СКОЛЬКО ЗАПИСЕЙ всего: тот самый завтрак из трёх продуктов
           count(*) as entries
      from public.food_diary fd
     where fd.user_id = v_user
       and fd.date between to_char(v_start, 'YYYY-MM-DD')
                       and to_char(v_start + 29, 'YYYY-MM-DD')
     group by fd.date
  ),
  norms as (
    select d.day, d.on_date,
           case when v_from is null or d.on_date < v_from then null
                when d.day >= 15 and v_entry.norm2_at is not null then v_entry.norm2_kcal
                else v_entry.norm1_kcal end as n_kcal,
           case when v_from is null or d.on_date < v_from then null
                when d.day >= 15 and v_entry.norm2_at is not null then v_entry.norm2_p
                else v_entry.norm1_p end as n_p,
           case when v_from is null or d.on_date < v_from then null
                when d.day >= 15 and v_entry.norm2_at is not null then v_entry.norm2_f
                else v_entry.norm1_f end as n_f,
           case when v_from is null or d.on_date < v_from then null
                when d.day >= 15 and v_entry.norm2_at is not null then v_entry.norm2_c
                else v_entry.norm1_c end as n_c
      from days d
  )
  select n.day, n.on_date,
         coalesce(e.kcal, 0), coalesce(e.p, 0), coalesce(e.f, 0), coalesce(e.c, 0),
         coalesce(e.meals, 0)::integer,
         coalesce(e.entries, 0)::integer,
         n.n_kcal, n.n_p, n.n_f, n.n_c
    from norms n
    left join eaten e on e.d = to_char(n.on_date, 'YYYY-MM-DD')
   order by n.day;
end $function$;

-- ── 3. Права как были: PUBLIC не при делах, зовут authenticated и сервер ────
revoke all on function public.challenge_standings(bigint) from public;
revoke all on function public.challenge_nutrition_facts(bigint, uuid) from public;
grant execute on function public.challenge_standings(bigint) to authenticated, service_role;
grant execute on function public.challenge_nutrition_facts(bigint, uuid) to authenticated, service_role;

commit;

-- ── 4. Проверка: SECURITY DEFINER, search_path и права на месте ─────────────
\df+ public.challenge_standings
\df+ public.challenge_nutrition_facts
