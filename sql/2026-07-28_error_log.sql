-- Журнал ошибок приложения: public.error_log.
--
-- Зачем: сбои у реальных пользователей сейчас видны только в их собственной
-- консоли браузера — то есть не видны никому. Зарубежные сервисы вроде Sentry
-- не подходим (данные должны оставаться в РФ), поэтому пишем в свою же базу.
--
-- Что кладём: только техническую суть — контекст (где упало), текст ошибки,
-- HTTP-статус, имя таблицы/действия. Содержимое переписки с ИИ, названия еды,
-- фото и прочие персональные данные в журнал НЕ попадают (см. src/logError.js,
-- там же это зафиксировано комментарием) — иначе таблица технических логов
-- незаметно превратилась бы во второе хранилище персональных данных.
--
-- 152-ФЗ: user_id тут есть, значит это данные пользователя. Таблица добавлена в
-- USER_TABLES (api/_userTables.js), поэтому удаление и выгрузка аккаунта
-- подхватывают её автоматически. Внешний ключ на auth.users объявлен без
-- ON DELETE (NO ACTION), как и у остальных таблиц: auth.admin.deleteUser()
-- откажется удалять аккаунт, пока тут остаются его строки, — а delete-account.js
-- чистит USER_TABLES до profiles и до удаления auth-пользователя.

create table if not exists public.error_log (
  id          bigint generated always as identity primary key,
  user_id     uuid references auth.users(id),
  created_at  timestamptz not null default now(),
  context     text not null,
  message     text,
  status      int,
  details     jsonb,
  url         text,
  user_agent  text
);

-- Журнал читают только «свежим концом» — разбор вчерашних сбоев, а не выборка
-- по пользователю, поэтому индекс по времени по убыванию.
create index if not exists error_log_created_at_idx on public.error_log (created_at desc);

alter table public.error_log enable row level security;

-- Клиент вправе только ДОБАВИТЬ строку и только про себя. Отдельной политики на
-- SELECT для него нет: своих ошибок в интерфейсе он не читает, а без политики
-- SELECT для него запрещён (RLS по умолчанию deny). UPDATE/DELETE не даём
-- никому из клиентов — журнал должен быть неизменяемым, иначе он бесполезен.
-- with_check с auth.uid() не даёт подписать запись чужим user_id.
drop policy if exists error_log_insert_own on public.error_log;
create policy error_log_insert_own on public.error_log
  for insert to authenticated
  with check (auth.uid() = user_id);

-- Тренер читает журнал целиком — это и есть смысл затеи (увидеть сбой у клиента,
-- который сам о нём не сообщит). is_trainer() — та же функция, что и в остальных
-- тренерских политиках.
drop policy if exists error_log_trainer_reads on public.error_log;
create policy error_log_trainer_reads on public.error_log
  for select to authenticated
  using (public.is_trainer());

-- Гранты. НЕ копируем состояние старых клиентских таблиц (food_diary и соседи
-- до сих пор несут наследие "GRANT ALL ON ALL TABLES": у anon там есть даже
-- DELETE и TRUNCATE, и спасает их только RLS) — заводим новую таблицу сразу
-- правильно, в духе 2026-07-26_privilege_lockdown.sql.
--
-- anon не нужен вовсе: logError пишет только при живой сессии.
-- authenticated: INSERT — для клиента. SELECT — обязателен, иначе тренерская
-- политика выше мертва: тренер заходит под той же ролью authenticated, а права
-- на таблицу проверяются ДО RLS. Фактический доступ на чтение при этом даёт не
-- грант, а политика (is_trainer()), обычный клиент чужого не увидит.
revoke all on table public.error_log from anon, authenticated;
grant insert, select on table public.error_log to authenticated;
grant all on table public.error_log to service_role;
