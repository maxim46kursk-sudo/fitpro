-- Посещаемость для тренера (экран «Настройки → Аналитика», блок «Посещаемость»).
-- Читает тот же журнал app_events (sql/2026-08-29_app_events.sql). Всё только
-- тренеру: у остальных функции возвращают пусто.
--
-- «Человек» = anon_id браузера (приложение шлёт его с каждым событием, и до
-- входа, и после), а если его нет (события сервера, например pay_done) —
-- user_id. Сутки — по Москве.

create or replace function public.app_is_trainer() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'trainer');
$$;

-- По дням: сколько людей зашло, из них новых, заходов, регистраций, оплат.
create or replace function public.app_daily(days integer default 14)
returns table (day date, visitors bigint, new_visitors bigint, sessions bigint,
               landing bigint, looked bigint, join_click bigint, plans bigint,
               signups bigint, pay_start bigint, pay_done bigint)
language sql stable security definer set search_path = public as $$
  with ev as (
    select coalesce(e.anon_id, e.user_id::text) as who, e.session_id, e.name, e.props,
           (e.ts at time zone 'Europe/Moscow')::date as d
      from public.app_events e
     where public.app_is_trainer()
       and e.ts > now() - make_interval(days => greatest(1, least(90, days)))
  ),
  first_seen as (
    select coalesce(anon_id, user_id::text) as who, min((ts at time zone 'Europe/Moscow')::date) as d
      from public.app_events where public.app_is_trainer() group by 1
  ),
  reg as (
    select (created_at at time zone 'Europe/Moscow')::date as d, count(*) as n
      from public.profiles
     where public.app_is_trainer() and role is distinct from 'trainer'
       and created_at > now() - make_interval(days => greatest(1, least(90, days)))
     group by 1
  )
  select ev.d,
         count(distinct ev.who),
         count(distinct ev.who) filter (where fs.d = ev.d),
         count(distinct ev.session_id),
         count(distinct ev.who) filter (where ev.name = 'screen' and ev.props->>'name' = 'club_landing'),
         count(distinct ev.who) filter (where ev.name = 'screen' and ev.props->>'name' = 'club_look'),
         count(distinct ev.who) filter (where ev.name = 'screen' and ev.props->>'name' = 'club_join'),
         count(distinct ev.who) filter (where ev.name = 'plans_open'),
         coalesce(max(reg.n), 0),
         count(distinct ev.who) filter (where ev.name = 'pay_start'),
         count(distinct ev.who) filter (where ev.name = 'pay_done')
    from ev
    left join first_seen fs on fs.who = ev.who
    left join reg on reg.d = ev.d
   group by ev.d
   order by ev.d desc;
$$;

-- Где заходы обрываются: последний шаг каждого захода за период.
create or replace function public.app_exits(days integer default 7)
returns table (step text, sessions bigint)
language sql stable security definer set search_path = public as $$
  with last as (
    select distinct on (e.session_id) e.session_id,
           case when e.name = 'screen' then 'screen:' || coalesce(e.props->>'name', '?')
                when e.name = 'paywall' then 'paywall:' || coalesce(e.props->>'where', '?')
                else e.name end as step
      from public.app_events e
     where public.app_is_trainer()
       and e.ts > now() - make_interval(days => greatest(1, least(90, days)))
     order by e.session_id, e.ts desc
  )
  select step, count(*) from last group by step order by 2 desc limit 25;
$$;

-- Куда ходят: сколько РАЗНЫХ людей побывало на каждом экране / нажало кнопку.
create or replace function public.app_screens(days integer default 7)
returns table (step text, people bigint)
language sql stable security definer set search_path = public as $$
  select case when e.name = 'screen' then 'screen:' || coalesce(e.props->>'name', '?')
              when e.name = 'paywall' then 'paywall:' || coalesce(e.props->>'where', '?')
              else e.name end as step,
         count(distinct coalesce(e.anon_id, e.user_id::text))
    from public.app_events e
   where public.app_is_trainer()
     and e.ts > now() - make_interval(days => greatest(1, least(90, days)))
   group by 1 order by 2 desc limit 40;
$$;

-- Последние заходы с признаком «новый человек» (раньше его не было).
create or replace function public.app_visits(days integer default 2, lim integer default 40)
returns table (session_id text, started timestamptz, ended timestamptz, steps bigint,
               last_step text, registered boolean, is_new boolean)
language sql stable security definer set search_path = public as $$
  with s as (
    select e.session_id,
           min(e.ts) as started, max(e.ts) as ended, count(*) as steps,
           (array_agg(case when e.name = 'screen' then 'screen:' || coalesce(e.props->>'name','?')
                           when e.name = 'paywall' then 'paywall:' || coalesce(e.props->>'where','?')
                           else e.name end order by e.ts desc))[1] as last_step,
           bool_or(e.user_id is not null) as registered,
           min(coalesce(e.anon_id, e.user_id::text)) as who
      from public.app_events e
     where public.app_is_trainer()
       and e.ts > now() - make_interval(days => greatest(1, least(30, days)))
     group by e.session_id
  )
  select s.session_id, s.started, s.ended, s.steps, s.last_step, s.registered,
         not exists (select 1 from public.app_events p
                      where coalesce(p.anon_id, p.user_id::text) = s.who and p.ts < s.started - interval '30 minutes')
    from s order by s.started desc limit greatest(1, least(200, lim));
$$;

revoke all on function public.app_is_trainer()               from public, anon;
revoke all on function public.app_daily(integer)             from public, anon;
revoke all on function public.app_exits(integer)             from public, anon;
revoke all on function public.app_screens(integer)           from public, anon;
revoke all on function public.app_visits(integer, integer)   from public, anon;
grant execute on function public.app_is_trainer()             to authenticated;
grant execute on function public.app_daily(integer)           to authenticated;
grant execute on function public.app_exits(integer)           to authenticated;
grant execute on function public.app_screens(integer)         to authenticated;
grant execute on function public.app_visits(integer, integer) to authenticated;

-- Индекс под «первое появление человека».
create index if not exists app_events_anon_ts_idx on public.app_events (anon_id, ts);
