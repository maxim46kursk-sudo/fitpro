-- Телеметрия раздела Motion (тренировка с камерой): public.motion_log.
--
-- Зачем: приложение работает на телефоне, разбор — на компьютере, и между ними
-- нет ничего. Раньше лог Motion уезжал в блоб-хранилище Vercel и упёрся там в
-- лимит бесплатного тарифа; теперь он приезжает в свою же базу, рядом с
-- остальными данными и в том же контуре.
--
-- Что кладём: только техническое — что происходило с камерой (разрешение,
-- частота кадров, фронтальная или тыловая), с распознаванием (fps, задержка,
-- потерянные кадры, режим показа, экономный режим) и со счётом. Метка камеры и
-- её deviceId в журнал НЕ попадают: первая почти всегда содержит модель
-- устройства, второй — его устойчивый отпечаток. Вырезаются дважды — клиентом
-- (logSafeCamera в src/motion/pose/useCamera.js) и приёмником (motionLogLine в
-- api/set-exercise.js), потому что сборки на телефонах живут своей жизнью и
-- старое тело будет приходить ещё долго.
--
-- 152-ФЗ: user_id тут есть, значит это данные пользователя. Таблица добавлена в
-- USER_TABLES (api/_userTables.js), поэтому удаление и выгрузка аккаунта
-- подхватывают её автоматически. Внешний ключ на auth.users объявлен без
-- ON DELETE (NO ACTION), как и у соседей: auth.admin.deleteUser() откажется
-- удалять аккаунт, пока тут остаются его строки, — а delete-account.js чистит
-- USER_TABLES до profiles и до удаления auth-пользователя.

create table if not exists public.motion_log (
  id      bigint generated always as identity primary key,
  user_id uuid not null references auth.users (id),
  -- Имя сессии присваивает телефон сам (session-ГГГГММДД-ЧЧММСС): по нему
  -- строки одной тренировки собираются вместе, даже если приехали порознь.
  session text not null,
  at      timestamptz not null default now(),
  -- Строки лога как есть: {"lines": ["...", "..."]}. jsonb, а не text[], —
  -- состав полей внутри строк меняется от версии к версии, и загонять его в
  -- колонки значило бы менять схему на каждую правку телеметрии.
  payload jsonb not null default '{}'::jsonb
);

-- Разбор всегда начинается с «покажи последнюю тренировку этого человека»:
-- индекс ровно под этот вопрос, свежие сверху.
create index if not exists motion_log_user_at_idx
  on public.motion_log (user_id, at desc);

-- И «собери всю сессию целиком» — строки одной тренировки приезжают десятками
-- посылок, и без этого индекса сборка шла бы перебором всей таблицы.
create index if not exists motion_log_session_idx
  on public.motion_log (session);

alter table public.motion_log enable row level security;

-- Пишет человек только за себя: user_id в строке обязан совпасть с тем, кто
-- пришёл. Приёмник и так подставляет его из токена, но политика — это то, что
-- останется верным, даже если приёмник однажды ошибётся.
drop policy if exists motion_log_insert_own on public.motion_log;
create policy motion_log_insert_own on public.motion_log
  for insert to authenticated
  with check (auth.uid() = user_id);

-- Читает человек тоже только своё.
drop policy if exists motion_log_select_own on public.motion_log;
create policy motion_log_select_own on public.motion_log
  for select to authenticated
  using (auth.uid() = user_id);

-- Тренер читает всё: разбирать жалобы участников — его работа, и без общего
-- доступа он видел бы только собственные тренировки. Роль берётся из profiles
-- того, кто пришёл, а не из тела запроса.
drop policy if exists motion_log_select_trainer on public.motion_log;
create policy motion_log_select_trainer on public.motion_log
  for select to authenticated
  using (
    exists (
      select 1 from public.profiles p
      where p.id = auth.uid() and p.role = 'trainer'
    )
  );
