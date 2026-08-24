-- Питание в зачёт челленджа: замороженная норма и сырьё для судейства.
-- Дополняет sql/2026-08-24_challenge_seasons.sql и _challenge_rules.sql.
--
-- ЗАЧЕМ НОРМУ ЗАМОРАЖИВАТЬ. Зачёт по питанию считается от дневной нормы, а норму
-- человек правит сам в дневнике. Пока она живая, вечером можно подогнать её под
-- съеденное — и весь зачёт превращается в игру с самим собой. Поэтому норма
-- снимается СЛЕПКОМ в момент вступления и лежит в строке участника: правка
-- food_goals посреди потока зачёта больше не касается.
--
-- ПОЧЕМУ СЛЕПКОВ ДВА. Тридцать дней меняют вес, и норма, снятая в первый день,
-- к концу потока становится чужой. Ровно один честный пересчёт — на середине:
-- дни 1–14 судятся по norm1, дни 15–30 по norm2. Не сняли norm2 (человек не
-- заходил на пятнадцатый) — судим по norm1: отсутствие пересчёта не повод
-- обнулять человеку половину потока.
--
-- И ГЛАВНОЕ ПРО РАЗДЕЛЕНИЕ ТРУДА. Здесь НЕТ ни процентов, ни баллов, ни оценок
-- дня. База отдаёт сырьё — сколько съедено и в скольких приёмах пищи, — а
-- считает по нему ровно один судья: src/challengeNutrition.js. Вторая формула,
-- живущая в SQL, разошлась бы с первой на первой же правке коридора, и человек
-- увидел бы в приложении один процент, а в рейтинге другой.

-- ── 1. Слепки нормы в строке участника ──────────────────────────────────────
alter table public.challenge_entries
  add column if not exists norm1_kcal numeric,
  add column if not exists norm1_p    numeric,
  add column if not exists norm1_f    numeric,
  add column if not exists norm1_c    numeric,
  add column if not exists norm1_at   timestamptz,
  add column if not exists norm2_kcal numeric,
  add column if not exists norm2_p    numeric,
  add column if not exists norm2_f    numeric,
  add column if not exists norm2_c    numeric,
  add column if not exists norm2_at   timestamptz;

comment on column public.challenge_entries.norm1_at is
  'Когда снят первый слепок нормы (вступление). NULL — нормы на тот момент не было.';
comment on column public.challenge_entries.norm2_at is
  'Когда снят второй слепок (первый заход на 15-й день потока). NULL — судим по norm1.';

-- ── 2. Зачисление снимает норму ─────────────────────────────────────────────
-- Всё остальное без изменений: та же блокировка сезона, та же идемпотентность,
-- тот же перенос согласия с правилами. Разбор причин — в предыдущих файлах.
create or replace function public.challenge_enroll(
  p_season_id    bigint,
  p_user_id      uuid,
  p_payment_id   text default null,
  p_display_name text default null
)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare
  v_season   bigint;
  v_no       integer;
  v_accepted timestamptz;
  v_goals    public.food_goals%rowtype;
begin
  if p_user_id is null then
    raise exception 'challenge_enroll: не указан пользователь'
      using errcode = 'null_value_not_allowed';
  end if;

  select id into v_season
    from public.challenge_seasons
   where id = p_season_id
   for update;

  if v_season is null then
    raise exception 'challenge_enroll: сезон % не найден', p_season_id
      using errcode = 'no_data_found';
  end if;

  if p_payment_id is not null then
    select participant_no into v_no
      from public.challenge_entries
     where season_id = p_season_id and payment_id = p_payment_id;

    if v_no is not null then
      return v_no;
    end if;
  end if;

  select participant_no into v_no
    from public.challenge_entries
   where season_id = p_season_id and user_id = p_user_id;

  if v_no is not null then
    return v_no;
  end if;

  select coalesce(max(participant_no), 0) + 1 into v_no
    from public.challenge_entries
   where season_id = p_season_id;

  select accepted_at into v_accepted
    from public.challenge_rules_consent
   where season_id = p_season_id and user_id = p_user_id;

  -- СЛЕПОК НОРМЫ ДЕЛАЕТСЯ ЗДЕСЬ, а не первым заходом в челлендж: человек платит
  -- за поток, зная свою норму, и она обязана застыть в ту же секунду. Нормы нет
  -- вовсе (оплата мимо приложения) — norm1_at останется пустым, и это честный
  -- ответ «на момент вступления мерить было нечем».
  select * into v_goals from public.food_goals where user_id = p_user_id;

  insert into public.challenge_entries
    (season_id, user_id, participant_no, payment_id, paid_at, display_name, rules_accepted_at,
     norm1_kcal, norm1_p, norm1_f, norm1_c, norm1_at)
  values (p_season_id, p_user_id, v_no, p_payment_id,
          case when p_payment_id is not null then now() end,
          coalesce(nullif(btrim(p_display_name), ''), 'Участник ' || v_no),
          v_accepted,
          v_goals.kcal, v_goals.p, v_goals.f, v_goals.c,
          case when v_goals.user_id is not null then now() end);

  return v_no;
end $function$;

comment on function public.challenge_enroll(bigint, uuid, text, text) is
  'Зачисляет в поток: номер участника под блокировкой сезона, имя и норма питания слепком на момент вступления, согласие с правилами. Идемпотентна по payment_id и по user_id.';

revoke execute on function public.challenge_enroll(bigint, uuid, text, text) from public;
revoke execute on function public.challenge_enroll(bigint, uuid, text, text) from anon;
revoke execute on function public.challenge_enroll(bigint, uuid, text, text) from authenticated;
grant  execute on function public.challenge_enroll(bigint, uuid, text, text) to service_role;

-- ── 3. Второй слепок — на середине потока ───────────────────────────────────
/*
 * ДЕНЬ СЧИТАЕТ БАЗА, А НЕ КЛИЕНТ. Функция не принимает номер дня вовсе: приди он
 * снаружи, человек назвал бы пятнадцатым тот день, когда ему выгодно, и «один
 * честный пересчёт» превратился бы в «пересчёт по требованию». День выводится
 * из starts_on сезона и сегодняшней даты.
 *
 * Идемпотентна: уже снятый слепок не переписывается никогда — ни вторым
 * вызовом, ни через неделю. Возвращает, что получилось, чтобы приложению не
 * приходилось перечитывать строку ради одного факта.
 */
create or replace function public.challenge_freeze_norm(p_season_id bigint)
returns text
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare
  v_user  uuid := auth.uid();
  v_start date;
  v_day   integer;
  v_entry public.challenge_entries%rowtype;
  v_goals public.food_goals%rowtype;
begin
  if v_user is null then
    raise exception 'challenge_freeze_norm: нет пользователя'
      using errcode = 'insufficient_privilege';
  end if;

  select starts_on into v_start from public.challenge_seasons where id = p_season_id;
  select * into v_entry
    from public.challenge_entries
   where season_id = p_season_id and user_id = v_user
   for update;

  if v_entry.id is null then
    return 'not_participant';
  end if;

  select * into v_goals from public.food_goals where user_id = v_user;
  if v_goals.user_id is null or coalesce(v_goals.kcal, 0) <= 0 then
    return 'no_goals';
  end if;

  -- Первый слепок мог не сняться при вступлении: человек оплатил раньше, чем
  -- заполнил данные о себе. Ставим при первой же возможности — до старта норму
  -- ещё можно менять, и слепок просто догоняет её.
  if v_entry.norm1_at is null then
    update public.challenge_entries
       set norm1_kcal = v_goals.kcal, norm1_p = v_goals.p,
           norm1_f = v_goals.f, norm1_c = v_goals.c, norm1_at = now()
     where id = v_entry.id;
    return 'norm1';
  end if;

  if v_start is null then
    return 'no_start_date';
  end if;

  v_day := (current_date - v_start) + 1;
  if v_day < 15 then
    return 'too_early';
  end if;
  if v_entry.norm2_at is not null then
    return 'already';
  end if;

  update public.challenge_entries
     set norm2_kcal = v_goals.kcal, norm2_p = v_goals.p,
         norm2_f = v_goals.f, norm2_c = v_goals.c, norm2_at = now()
   where id = v_entry.id;
  return 'norm2';
end $function$;

comment on function public.challenge_freeze_norm(bigint) is
  'Замораживает норму питания участника: norm1 (если не снята при вступлении) и norm2 на 15-й день потока и позже. День считает сама, снаружи его не принимает. Идемпотентна.';

revoke execute on function public.challenge_freeze_norm(bigint) from public;
revoke execute on function public.challenge_freeze_norm(bigint) from anon;
grant  execute on function public.challenge_freeze_norm(bigint) to authenticated;
grant  execute on function public.challenge_freeze_norm(bigint) to service_role;

-- ── 4. Сырьё для судейства ──────────────────────────────────────────────────
/*
 * ЧТО ОТДАЁТ И ЧЕГО НЕ ОТДАЁТ. Отдаёт по строке на каждый день потока: дату,
 * сумму съеденного за неё и ЧИСЛО РАЗНЫХ ПРИЁМОВ ПИЩИ с записями — именно оно
 * решает, считается день вообще или нет (минимум три из четырёх). Плюс норму,
 * по которой этот день судится: какой из двух слепков применить — правило
 * данных, а не судейства, и знать его должна база.
 *
 * НЕ ОТДАЁТ процентов, баллов и оценок: их считает src/challengeNutrition.js, и
 * только он. Две формулы разошлись бы на первой же правке коридора.
 *
 * ПУСТЫЕ ДНИ ВОЗВРАЩАЮТСЯ ТОЖЕ, нулями. День без записей — это ноль в зачёте, и
 * пропусти мы его в выдаче, средний процент считался бы по заполненным дням,
 * то есть выигрывал бы тот, кто вёл дневник три дня из тридцати.
 *
 * ЧУЖИЕ ДНИ. p_user_id отличный от своего — только для service_role (у него
 * auth.uid() пуст). Человек, попросивший чужие, получает отказ, а не пустоту:
 * молчаливая пустота читалась бы как «он ничего не ел».
 */
create or replace function public.challenge_nutrition_facts(
  p_season_id bigint,
  p_user_id   uuid default null
)
returns table (
  day        integer,
  on_date    date,
  kcal       numeric,
  p          numeric,
  f          numeric,
  c          numeric,
  meals      integer,
  norm_kcal  numeric,
  norm_p     numeric,
  norm_f     numeric,
  norm_c     numeric
)
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare
  v_caller uuid := auth.uid();
  v_user   uuid := coalesce(p_user_id, auth.uid());
  v_start  date;
  v_entry  public.challenge_entries%rowtype;
begin
  if v_user is null then
    raise exception 'challenge_nutrition_facts: не указан пользователь'
      using errcode = 'null_value_not_allowed';
  end if;
  -- v_caller пуст — зовёт service_role (или миграция): ему можно любого.
  if v_caller is not null and v_user <> v_caller then
    raise exception 'challenge_nutrition_facts: чужие дни не отдаются'
      using errcode = 'insufficient_privilege';
  end if;

  select starts_on into v_start from public.challenge_seasons where id = p_season_id;
  select * into v_entry
    from public.challenge_entries
   where season_id = p_season_id and user_id = v_user;

  -- Даты потока нет — считать не от чего: дни ещё не привязаны к календарю.
  if v_start is null then
    return;
  end if;

  return query
  with days as (
    -- Тридцать дней потока: та же длина, что у плана в src/motion/game/challenge.js.
    select gs.n as day, (v_start + (gs.n - 1))::date as on_date
      from generate_series(1, 30) as gs(n)
  ),
  eaten as (
    select fd.date as d,
           sum(coalesce(fd.kcal, 0)) as kcal,
           sum(coalesce(fd.p, 0))    as p,
           sum(coalesce(fd.f, 0))    as f,
           sum(coalesce(fd.c, 0))    as c,
           -- РАЗНЫХ приёмов пищи, а не записей: три строки в одном завтраке —
           -- это один приём, и днём такой дневник не становится.
           count(distinct nullif(btrim(coalesce(fd.meal, '')), '')) as meals
      from public.food_diary fd
     where fd.user_id = v_user
       and fd.date between to_char(v_start, 'YYYY-MM-DD')
                       and to_char(v_start + 29, 'YYYY-MM-DD')
     group by fd.date
  )
  select d.day,
         d.on_date,
         coalesce(e.kcal, 0),
         coalesce(e.p, 0),
         coalesce(e.f, 0),
         coalesce(e.c, 0),
         coalesce(e.meals, 0)::integer,
         -- Дни 1–14 судятся по первому слепку, 15–30 по второму; второго нет —
         -- остаётся первый.
         case when d.day >= 15 and v_entry.norm2_at is not null
              then v_entry.norm2_kcal else v_entry.norm1_kcal end,
         case when d.day >= 15 and v_entry.norm2_at is not null
              then v_entry.norm2_p else v_entry.norm1_p end,
         case when d.day >= 15 and v_entry.norm2_at is not null
              then v_entry.norm2_f else v_entry.norm1_f end,
         case when d.day >= 15 and v_entry.norm2_at is not null
              then v_entry.norm2_c else v_entry.norm1_c end
    from days d
    left join eaten e on e.d = to_char(d.on_date, 'YYYY-MM-DD')
   order by d.day;
end $function$;

comment on function public.challenge_nutrition_facts(bigint, uuid) is
  'Сырьё для зачёта по питанию: на каждый из 30 дней потока — съеденное за дату, число разных приёмов пищи и норма, по которой день судится. Процентов не считает: это делает src/challengeNutrition.js.';

revoke execute on function public.challenge_nutrition_facts(bigint, uuid) from public;
revoke execute on function public.challenge_nutrition_facts(bigint, uuid) from anon;
grant  execute on function public.challenge_nutrition_facts(bigint, uuid) to authenticated;
grant  execute on function public.challenge_nutrition_facts(bigint, uuid) to service_role;

notify pgrst, 'reload schema';
