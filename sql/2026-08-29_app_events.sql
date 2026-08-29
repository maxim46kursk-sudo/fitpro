-- Журнал событий приложения — своя продуктовая аналитика.
--
-- Зачем. Про поведение людей сейчас не известно ничего: src/funnel.js считает
-- одиннадцать анонимных посуточных счётчиков по челленджу и не знает, кто что
-- сделал, а логи Caddy у одностраничного приложения не видят ни экранов, ни
-- нажатий. Отсюда нельзя ответить на главный вопрос: люди заходят — где именно
-- они уходят.
--
-- Ничего наружу не уходит: приёмник свой, таблица своя.

create table if not exists public.app_events (
  id         bigserial   primary key,
  -- Кто. Для гостя null — он ещё не завёлся; связать его события между собой
  -- позволяет anon_id. ON DELETE CASCADE обязателен: удаление аккаунта по
  -- 152-ФЗ не должно спотыкаться о журнал и не должно оставлять хвостов.
  user_id    uuid        references auth.users(id) on delete cascade,
  -- Случайный идентификатор браузера из localStorage. Не персональные данные:
  -- он не переживает очистку хранилища и ни с чем, кроме этой таблицы, не
  -- связан. Нужен, чтобы склеить путь гостя до регистрации.
  anon_id    text,
  -- Одна вкладка = одна сессия. По ней и собирается «дорожная карта» захода.
  session_id text        not null,
  ts         timestamptz not null default now(),
  -- Имя события. Список — в src/track.js, приёмник незнакомые отбрасывает.
  -- Текстом, а не enum: добавить событие должно стоить строки в коде, а не
  -- миграции с ALTER TYPE.
  name       text        not null,
  -- Экран, на котором это случилось.
  path       text,
  -- Короткие значения: ключ программы, номер тренировки, название тарифа.
  -- Свободного текста человека здесь быть не должно никогда — барьер стоит и
  -- на клиенте (sanitizeProps), и на сервере.
  props      jsonb
);

comment on table public.app_events is
  'Путь человека по приложению: экраны, нажатия, отвалы. Пишется только через api/set-exercise.js?action=events; см. sql/2026-08-29_app_events.sql';

-- Запросы бывают трёх видов, под них и индексы: лента за период, всё по
-- человеку, и целиком один заход.
create index if not exists app_events_ts_idx      on public.app_events (ts desc);
create index if not exists app_events_user_ts_idx on public.app_events (user_id, ts desc);
create index if not exists app_events_sess_idx    on public.app_events (session_id, ts);
create index if not exists app_events_name_ts_idx on public.app_events (name, ts desc);

alter table public.app_events enable row level security;

-- Политик для клиентов нет вовсе: пишет сюда только service_role из серверной
-- ручки, читает тренер через RPC ниже. Прямого доступа с клиента быть не
-- должно — иначе журнал можно засорить или вычитать чужой путь.
revoke all on public.app_events from anon, authenticated;

-- ── Чтение тренером ─────────────────────────────────────────────────────
-- Воронка за период: сколько РАЗНЫХ людей дошло до каждого шага. Считаем
-- людей, а не нажатия: продажа — решение, которое человек принимает один раз,
-- и второй заход на тот же экран не делает его вторым покупателем.
create or replace function public.app_funnel(days integer default 30)
returns table (name text, people bigint, events bigint)
language sql
security definer
set search_path = public
as $$
  select e.name,
         count(distinct coalesce(e.user_id::text, e.anon_id)) as people,
         count(*)                                             as events
    from public.app_events e
   where e.ts > now() - make_interval(days => greatest(1, least(365, days)))
     and exists (select 1 from public.profiles p
                  where p.id = auth.uid() and p.role = 'trainer')
   group by e.name
   order by people desc;
$$;

-- Один заход целиком, по порядку: что человек делал от входа до ухода.
create or replace function public.app_session(sess text)
returns table (ts timestamptz, name text, path text, props jsonb)
language sql
security definer
set search_path = public
as $$
  select e.ts, e.name, e.path, e.props
    from public.app_events e
   where e.session_id = sess
     and exists (select 1 from public.profiles p
                  where p.id = auth.uid() and p.role = 'trainer')
   order by e.ts;
$$;

-- Последние заходы: по каждому — сколько шагов, когда начался, чем кончился.
create or replace function public.app_sessions(days integer default 7, lim integer default 50)
returns table (session_id text, started timestamptz, steps bigint, last_name text, registered boolean)
language sql
security definer
set search_path = public
as $$
  select e.session_id,
         min(e.ts)                                    as started,
         count(*)                                     as steps,
         (array_agg(e.name order by e.ts desc))[1]    as last_name,
         bool_or(e.user_id is not null)               as registered
    from public.app_events e
   where e.ts > now() - make_interval(days => greatest(1, least(365, days)))
     and exists (select 1 from public.profiles p
                  where p.id = auth.uid() and p.role = 'trainer')
   group by e.session_id
   order by min(e.ts) desc
   limit greatest(1, least(500, lim));
$$;

revoke all on function public.app_funnel(integer)          from public, anon;
revoke all on function public.app_session(text)            from public, anon;
revoke all on function public.app_sessions(integer,integer) from public, anon;
grant execute on function public.app_funnel(integer)          to authenticated;
grant execute on function public.app_session(text)            to authenticated;
grant execute on function public.app_sessions(integer,integer) to authenticated;

-- Проверка: тренер видит воронку, клиент получает пустоту.
-- select * from public.app_funnel(30);
