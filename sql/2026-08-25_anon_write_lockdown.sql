-- У АНОНИМА НЕ ДОЛЖНО БЫТЬ ПРАВ ЗАПИСИ НИ НА ОДНУ ТАБЛИЦУ. Находка F-1 аудита.
--
-- Что увидел аудит: DELETE к public.profiles с публичным anon-ключом вернул
-- 204, а не 401. Само по себе это не удаление — 204 говорит лишь, что запрос
-- не отклонили НА УРОВНЕ ПРИВИЛЕГИЙ, а строку не тронули потому, что её не
-- пропустила RLS. То есть сегодня таблицу держит одна политика, и держит она
-- её в одиночку.
--
-- Почему это всё равно чинится. Ровно та же конструкция уже была разобрана в
-- sql/2026-07-26_privilege_lockdown.sql: защита, стоящая на отсутствии или
-- узости ОДНОЙ политики, ломается не атакой, а обычной правкой. Достаточно
-- однажды написать политику пошире («чтобы тренер видел клиента»), забыв, что
-- она распространяется и на DELETE, — и публичный ключ из бандла получает
-- право стирать чужие строки. Грант — это второй рубеж, и он бесплатный.
--
-- ПОЧЕМУ ЭТО НИЧЕГО НЕ СЛОМАЕТ. Весь фронтенд пишет в базу только под сессией,
-- то есть ролью authenticated — её права здесь не трогаются вовсе:
--   • профиль, замеры, тренировки, подходы, дневник еды, цели, планы,
--     программы, шаблоны, чат, связи тренер—клиент, motion_* — все вызовы
--     .insert/.update/.delete в src/ идут после входа;
--   • журнал ошибок (src/logError.js) сам отказывается писать без сессии:
--     «Без сессии писать бессмысленно: RLS требует auth.uid() = user_id»;
--   • гость не пишет в базу вообще — его данные живут в памяти вкладки
--     (src/guestStore.js), в базу они попадают только после регистрации;
--   • анонимные строки motion_log пишет СЕРВЕР служебным ключом
--     (sql/2026-08-26_motion_log_anon.sql), а не браузер.
-- Чтение анониму остаётся полностью: на нём стоят каталоги, которые открывает
-- лендинг до регистрации (program_templates, exercise_videos, video_pool).

-- ── 1. Отзыв прав записи у anon на всё, что уже есть ────────────────────────
revoke insert, update, delete, truncate on all tables in schema public from anon;

-- ── 2. И на всё, что появится дальше ────────────────────────────────────────
-- Без этой строки следующая же созданная таблица получит дефолтные гранты и
-- вернёт дыру на место — ровно так она и появилась в прошлый раз.
alter default privileges in schema public revoke insert, update, delete, truncate on tables from anon;

-- ── 3. Проверка: после выполнения обе выборки должны быть ПУСТЫМИ ───────────

-- 3.1. Права записи, оставшиеся у anon:
select table_name, privilege_type
from information_schema.role_table_grants
where table_schema = 'public'
  and grantee = 'anon'
  and privilege_type in ('INSERT', 'UPDATE', 'DELETE', 'TRUNCATE')
order by table_name;

-- 3.2. Таблицы public без включённой RLS.
-- НЕ включается автоматически: включить RLS на таблице, у которой нет ни одной
-- политики, — это мгновенный deny-all и отвалившийся раздел приложения.
-- Здесь только список; каждую строку из него разбираем отдельно.
select c.relname as table_name
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public'
  and c.relkind = 'r'
  and c.relrowsecurity = false
order by 1;

-- ── 4. Что посмотреть глазами (не правки, а сверка) ─────────────────────────

-- 4.1. Политики без ограничения — USING (true) там, где должен стоять
-- auth.uid(). Именно они и есть настоящая F-1, если она где-то есть.
select tablename, policyname, cmd, roles, qual, with_check
from pg_policies
where schemaname = 'public'
  and (qual = 'true' or with_check = 'true')
order by tablename, cmd;

-- 4.2. RPC челленджа: SECURITY DEFINER выполняется от владельца и RLS не
-- видит — такая функция обязана сама сверять auth.uid().
select p.proname, p.prosecdef as security_definer, pg_get_function_identity_arguments(p.oid) as args
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public' and p.proname like 'challenge%'
order by 1;

-- 4.3. Публичные бакеты Storage: public = true означает, что ссылку на файл
-- откроет кто угодно без ключа. Для motion-assets это норма, для фото людей — нет.
select id, public from storage.buckets order by 1;
