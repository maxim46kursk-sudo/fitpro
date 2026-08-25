-- НОРМА ЗАМОРАЖИВАЕТСЯ В ДЕНЬ СТАРТА, А НЕ ПРИ ВСТУПЛЕНИИ.
-- Дополняет sql/2026-08-25_challenge_nutrition.sql, применять после него.
--
-- ЧТО ИЗМЕНИЛОСЬ СНАРУЖИ. Анкету перед оплатой убрали: форма между человеком и
-- кнопкой «Участвовать» убивала продажу вернее любой цены. Данные о себе теперь
-- спрашивают ПОСЛЕ оплаты, в комнате. Значит на момент вступления нормы может
-- не быть вовсе — и старое правило «снять слепок при вступлении» перестало
-- иметь смысл: снимать было бы нечего.
--
-- НОВОЕ ПРАВИЛО, и оно честнее прежнего:
--   norm1 снимается В ДЕНЬ СТАРТА ПОТОКА — той нормой, что есть у человека на
--   этот день; если на старте нормы нет — в тот момент, когда он её впервые
--   получил. Дни ДО появления нормы считаются нулём: мерить их было нечем, и
--   задним числом подставлять сегодняшнюю норму нельзя — это открыло бы дверь
--   «подогнать норму под съеденное».
--   norm2 на 15-й день — как было.
--
-- ПОЧЕМУ НЕ «ЛЮБАЯ НОРМА В ЛЮБОЙ МОМЕНТ ДО СТАРТА». До старта норму можно
-- менять сколько угодно — поток ещё не идёт, и застывать ей рано. Заморозка
-- ровно на старте и означает «с этого дня считаем по тому, что ты объявил».

-- ── 1. Зачисление больше не снимает норму ───────────────────────────────────
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
begin
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

  -- Копия согласия с правилами на момент зачисления: строка участника должна
  -- отвечать на «согласился ли» сама, не заглядывая в соседнюю таблицу.
  select accepted_at into v_accepted
    from public.challenge_rules_consent
   where season_id = p_season_id and user_id = p_user_id;

  -- НОРМЫ ЗДЕСЬ БОЛЬШЕ НЕТ. Её снимает challenge_freeze_norm в день старта:
  -- на момент оплаты человек может ещё не заполнить данные о себе, и слепок с
  -- пустоты — это не слепок.
  insert into public.challenge_entries
    (season_id, user_id, participant_no, payment_id, paid_at, display_name, rules_accepted_at)
  values (p_season_id, p_user_id, v_no, p_payment_id,
          case when p_payment_id is not null then now() end,
          coalesce(nullif(btrim(p_display_name), ''), 'Участник ' || v_no),
          v_accepted);

  return v_no;
end $function$;

comment on function public.challenge_enroll(bigint, uuid, text, text) is
  'Зачисляет в поток: номер участника под блокировкой сезона, имя и согласие с правилами. Норму НЕ снимает — это делает challenge_freeze_norm в день старта. Идемпотентна по payment_id и по user_id.';

revoke execute on function public.challenge_enroll(bigint, uuid, text, text) from public;
revoke execute on function public.challenge_enroll(bigint, uuid, text, text) from anon;
revoke execute on function public.challenge_enroll(bigint, uuid, text, text) from authenticated;
grant  execute on function public.challenge_enroll(bigint, uuid, text, text) to service_role;

-- ── 2. Заморозка: не раньше старта ──────────────────────────────────────────
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

  if v_start is null then
    return 'no_start_date';
  end if;

  -- ДЕНЬ ПОТОКА — ПО МОСКВЕ, как его считает приложение
  -- (src/motion/game/challenge.js, moscowDate). База живёт в UTC, и с полуночи
  -- до трёх ночи по Москве это разные даты: заморозь мы по UTC — человек,
  -- заполнивший данные в час ночи первого дня, получил бы слепок «вчерашним»
  -- числом и день, посчитанный нулём ни за что.
  v_day := ((now() at time zone 'Europe/Moscow')::date - v_start) + 1;

  -- ДО СТАРТА НЕ МОРОЗИМ. Поток ещё не идёт, норму можно править сколько
  -- угодно, и застывать ей рано. Заморозка ровно на старте и означает «с этого
  -- дня считаем по тому, что ты объявил».
  if v_day < 1 then
    return 'before_start';
  end if;

  -- ПЕРВЫЙ СЛЕПОК: в день старта — или в тот день, когда норма впервые
  -- появилась, если на старте её ещё не было. Дни до этого момента остаются
  -- без нормы и считаются нулём (см. challenge_nutrition_facts ниже).
  if v_entry.norm1_at is null then
    update public.challenge_entries
       set norm1_kcal = v_goals.kcal, norm1_p = v_goals.p,
           norm1_f = v_goals.f, norm1_c = v_goals.c, norm1_at = now()
     where id = v_entry.id;
    return 'norm1';
  end if;

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
  'Замораживает норму питания участника: norm1 в день старта потока (или в день, когда норма впервые появилась), norm2 на 15-й день и позже. День считает сама, снаружи его не принимает. Идемпотентна.';

revoke execute on function public.challenge_freeze_norm(bigint) from public;
revoke execute on function public.challenge_freeze_norm(bigint) from anon;
grant  execute on function public.challenge_freeze_norm(bigint) to authenticated;
grant  execute on function public.challenge_freeze_norm(bigint) to service_role;

notify pgrst, 'reload schema';

-- ── 3. Дни ДО появления нормы считаются нулём ───────────────────────────────
--
-- Раньше вопрос не стоял: слепок снимался при вступлении, то есть до первого
-- дня потока, и норма была у всех дней одна. Теперь норма может появиться на
-- пятый день — и подставить её первым четырём значило бы судить их тем, чего в
-- те дни не существовало. Хуже того, это открыло бы дверь «подогнать норму под
-- уже съеденное»: заполнил данные в конце недели — и вся неделя пересчиталась
-- по удобным цифрам.
--
-- Поэтому день, наступивший ДО заморозки, отдаётся БЕЗ НОРМЫ. Судья это
-- понимает буквально: нормы нет → accuracy возвращает null → день не засчитан
-- → ноль (src/challengeNutrition.js). Никакого отдельного правила в приложении
-- заводить не потребовалось.
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
  v_from   date;
begin
  if v_user is null then
    raise exception 'challenge_nutrition_facts: не указан пользователь'
      using errcode = 'null_value_not_allowed';
  end if;
  if v_caller is not null and v_user <> v_caller then
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
           count(distinct nullif(btrim(coalesce(fd.meal, '')), '')) as meals
      from public.food_diary fd
     where fd.user_id = v_user
       and fd.date between to_char(v_start, 'YYYY-MM-DD')
                       and to_char(v_start + 29, 'YYYY-MM-DD')
     group by fd.date
  ),
  norms as (
    -- Норма дня одной строкой: до заморозки её нет вовсе, дальше первый слепок,
    -- с пятнадцатого дня второй (если он снят).
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
         n.n_kcal, n.n_p, n.n_f, n.n_c
    from norms n
    left join eaten e on e.d = to_char(n.on_date, 'YYYY-MM-DD')
   order by n.day;
end $function$;

comment on function public.challenge_nutrition_facts(bigint, uuid) is
  'Сырьё для зачёта по питанию: на каждый из 30 дней потока — съеденное за дату, число разных приёмов пищи и норма, по которой день судится. Дни до заморозки нормы отдаются без неё и считаются нулём. Процентов не считает: это делает src/challengeNutrition.js.';

revoke execute on function public.challenge_nutrition_facts(bigint, uuid) from public;
revoke execute on function public.challenge_nutrition_facts(bigint, uuid) from anon;
grant  execute on function public.challenge_nutrition_facts(bigint, uuid) to authenticated;
grant  execute on function public.challenge_nutrition_facts(bigint, uuid) to service_role;

-- ── 4. То же правило в таблице потока ───────────────────────────────────────
-- Судья один на приложение и на таблицу, и норма дня обязана быть одинаковой в
-- обоих: разойдись они — человек увидел бы у себя в комнате один процент, а в
-- таблице другой.
create or replace function public.challenge_standings(p_season_id bigint)
returns table (
  participant_no integer,
  display_name   text,
  is_me          boolean,
  days_done      integer,
  day            integer,
  best_score     integer,
  kcal           numeric,
  p              numeric,
  f              numeric,
  c              numeric,
  meals          integer,
  norm_kcal      numeric,
  norm_p         numeric,
  norm_f         numeric,
  norm_c         numeric
)
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare
  v_caller uuid := auth.uid();
  v_start  date;
begin
  if v_caller is not null and not exists (
    select 1 from public.challenge_entries e
     where e.season_id = p_season_id and e.user_id = v_caller
  ) then
    raise exception 'challenge_standings: таблицу потока видят его участники'
      using errcode = 'insufficient_privilege';
  end if;

  select starts_on into v_start from public.challenge_seasons where id = p_season_id;

  return query
  with entries as (
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
      join entries en on en.user_id = ma.user_id
     where ma.day between 1 and 30
     group by ma.user_id, ma.day
  ),
  eaten as (
    select fd.user_id, fd.date as d,
           sum(coalesce(fd.kcal, 0)) as kcal,
           sum(coalesce(fd.p, 0))    as p,
           sum(coalesce(fd.f, 0))    as f,
           sum(coalesce(fd.c, 0))    as c,
           count(distinct nullif(btrim(coalesce(fd.meal, '')), '')) as meals
      from public.food_diary fd
      join entries en on en.user_id = fd.user_id
     where v_start is not null
       and fd.date between to_char(v_start, 'YYYY-MM-DD') and to_char(v_start + 29, 'YYYY-MM-DD')
     group by fd.user_id, fd.date
  ),
  progress as (
    select mp.user_id,
           coalesce(jsonb_array_length(mp.payload -> 'challenge' -> 'done'), 0) as done
      from public.motion_progress mp
      join entries en on en.user_id = mp.user_id
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
         case when en.norm_from is null or (v_start + (d.day - 1)) < en.norm_from then null
              when d.day >= 15 and en.norm2_at is not null then en.norm2_kcal else en.norm1_kcal end,
         case when en.norm_from is null or (v_start + (d.day - 1)) < en.norm_from then null
              when d.day >= 15 and en.norm2_at is not null then en.norm2_p    else en.norm1_p    end,
         case when en.norm_from is null or (v_start + (d.day - 1)) < en.norm_from then null
              when d.day >= 15 and en.norm2_at is not null then en.norm2_f    else en.norm1_f    end,
         case when en.norm_from is null or (v_start + (d.day - 1)) < en.norm_from then null
              when d.day >= 15 and en.norm2_at is not null then en.norm2_c    else en.norm1_c    end
    from entries en
    cross join days d
    left join best b on b.user_id = en.user_id and b.day = d.day
    left join eaten e on e.user_id = en.user_id
                     and v_start is not null
                     and e.d = to_char(v_start + (d.day - 1), 'YYYY-MM-DD')
    left join progress pr on pr.user_id = en.user_id
   order by en.participant_no, d.day;
end $function$;

comment on function public.challenge_standings(bigint) is
  'Сырьё таблицы потока: на каждого участника и каждый день — лучший заход, съеденное, число приёмов пищи и норма дня (до заморозки нормы её нет, и день считается нулём). Мест и процентов не считает: это делает src/challengeStandings.js.';

revoke execute on function public.challenge_standings(bigint) from public;
revoke execute on function public.challenge_standings(bigint) from anon;
grant  execute on function public.challenge_standings(bigint) to authenticated;
grant  execute on function public.challenge_standings(bigint) to service_role;

notify pgrst, 'reload schema';
