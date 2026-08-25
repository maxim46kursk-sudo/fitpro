-- ПРАВКА challenge_standings: сколько дней человек прошёл целиком.
-- Дополняет sql/2026-08-25_challenge_standings.sql, применять после него.
--
-- ЧТО БЫЛО НЕ ТАК. days_done читался как `payload -> 'done'`, а такого ключа в
-- payload нет и не было: прогресс челленджа лежит вложенным,
-- `payload -> 'challenge' -> 'done'` (см. collectProgress в src/motion/sync.js —
-- объект собирается из challenge, attempts, unlocked, best, personal,
-- thresholds). Условие `jsonb_typeof(payload -> 'done') = 'array'` не
-- выполнялось НИ ДЛЯ КОГО, подзапрос всегда возвращал пусто, и days_done у всех
-- был ноль.
--
-- ЧЕМ ЭТО ПЛОХО. Само по себе число на экран не идёт — оно РАЗВОДИТ РАВНЫЕ ОЧКИ
-- в таблице движения (src/challengeStandings.js): при одинаковой сумме выше тот,
-- кто прошёл больше дней целиком. Заходы можно набрать и не доигрывая дни, и
-- именно это правило отличает того, кто честно закрыл день, от того, кто трижды
-- вышел на пятом круге. С нулём у всех оно молча не работало, и спор о призах
-- разрешался бы вторым ключом — местом в движении, — то есть не тем.
--
-- Ошибка лежала спящей, потому что до первого живого потока сравнивать было
-- некого: у единственного участника любое место первое.
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
    -- ВОТ ОНА, ПРАВКА: путь `challenge -> done`, а не `done`. Прогресс
    -- челленджа лежит в payload вложенным — так его складывает collectProgress
    -- (src/motion/sync.js), и так же его разбирает applyProgress обратно.
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

notify pgrst, 'reload schema';

-- Проверка глазами после применения: у того, кто закрывал дни, days_done > 0.
select e.participant_no,
       coalesce(jsonb_array_length(mp.payload -> 'challenge' -> 'done'), 0) as done_в_payload
  from public.challenge_entries e
  left join public.motion_progress mp on mp.user_id = e.user_id
 order by e.participant_no;
