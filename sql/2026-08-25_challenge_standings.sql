-- Таблица потока: сырьё по всем участникам сезона.
-- Дополняет sql/2026-08-25_challenge_nutrition.sql.
--
-- ЧТО ОТДАЁТ. По строке на каждого участника и каждый день потока: лучший заход
-- дня (максимум по motion_attempts — заход, а не сумма уровней: правило дня
-- именно такое), съеденное за этот день, число разных приёмов пищи и норму, по
-- которой день судится. Плюс на каждого — сколько дней он прошёл ЦЕЛИКОМ: это
-- разводит равные очки в таблице движения.
--
-- ЧЕГО НЕ ОТДАЁТ: мест, сумм, процентов и порядка. Считает их
-- src/challengeStandings.js поверх src/challengeNutrition.js — один судья на
-- приложение, тесты и будущий рейтинг. Появись здесь второй, он разошёлся бы с
-- первым на первой же правке коридора, и человек увидел бы на экране одно место,
-- а в итогах другое.
--
-- КТО ЧИТАЕТ. Таблица потока общая — её видят все, кто в этом потоке: сравнение
-- с остальными и есть половина мотивации. Посторонний не читает ничего: не
-- пустоту, а отказ, потому что пустая таблица читалась бы как «в потоке никого».
-- service_role (у него auth.uid() пуст) читает любой сезон — на нём будущие
-- итоги и разбор споров.
--
-- ЧУЖОГО user_id В ВЫДАЧЕ НЕТ. Участнику нужно узнать в таблице СЕБЯ, а не
-- получить список идентификаторов соседей: своя строка помечена флагом is_me,
-- посчитанным здесь же. Имя и номер участника — то, что человек и так согласился
-- показывать, вступая в поток.
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
           e.norm2_kcal, e.norm2_p, e.norm2_f, e.norm2_c, e.norm2_at
      from public.challenge_entries e
     where e.season_id = p_season_id
       -- ушедший из приложения остаётся в таблице (его результат — документ),
       -- но собирать по нему заходы и еду больше не по кому
       and e.user_id is not null
  ),
  days as (
    -- Тридцать дней потока: та же длина, что у плана в src/motion/game/challenge.js.
    select gs.n as day from generate_series(1, 30) as gs(n)
  ),
  best as (
    -- ЛУЧШИЙ ЗАХОД ДНЯ, а не сумма по уровням: заходов три на день, и в зачёт
    -- идёт один (src/motion/game/day.js).
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
           -- разных приёмов пищи, а не записей: три строки в одном завтраке —
           -- это один приём, и днём такой дневник не становится
           count(distinct nullif(btrim(coalesce(fd.meal, '')), '')) as meals
      from public.food_diary fd
      join entries en on en.user_id = fd.user_id
     where v_start is not null
       and fd.date between to_char(v_start, 'YYYY-MM-DD') and to_char(v_start + 29, 'YYYY-MM-DD')
     group by fd.user_id, fd.date
  ),
  progress as (
    -- Сколько дней человек прошёл ЦЕЛИКОМ. Лежит в том же payload, которым
    -- живёт прогресс челленджа (sql/2026-08-18_motion_progress.sql): день
    -- попадает в done только когда сделаны все круги.
    select mp.user_id,
           coalesce(jsonb_array_length(mp.payload -> 'done'), 0) as done
      from public.motion_progress mp
      join entries en on en.user_id = mp.user_id
     where jsonb_typeof(mp.payload -> 'done') = 'array'
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
         -- дни 1–14 судятся по первому слепку нормы, 15–30 по второму;
         -- второго нет — остаётся первый
         case when d.day >= 15 and en.norm2_at is not null then en.norm2_kcal else en.norm1_kcal end,
         case when d.day >= 15 and en.norm2_at is not null then en.norm2_p    else en.norm1_p    end,
         case when d.day >= 15 and en.norm2_at is not null then en.norm2_f    else en.norm1_f    end,
         case when d.day >= 15 and en.norm2_at is not null then en.norm2_c    else en.norm1_c    end
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
  'Сырьё таблицы потока: на каждого участника и каждый день — лучший заход, съеденное, число приёмов пищи и норма дня. Мест и процентов не считает: это делает src/challengeStandings.js.';

revoke execute on function public.challenge_standings(bigint) from public;
revoke execute on function public.challenge_standings(bigint) from anon;
grant  execute on function public.challenge_standings(bigint) to authenticated;
grant  execute on function public.challenge_standings(bigint) to service_role;

notify pgrst, 'reload schema';
