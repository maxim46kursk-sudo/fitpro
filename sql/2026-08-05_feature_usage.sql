-- Посуточный счётчик расхода отдельных ИИ-возможностей: public.feature_usage
-- и функция public.incr_feature_usage(uid, day, kind).
--
-- Зачем: распознавание этикетки по фото (api/chat.js, type:'food_label')
-- считалось той же функцией incr_ai_usage, что и реплики ассистента, — то есть
-- разобрал 10 упаковок и остался с 30 репликами чата вместо 40. Это два разных
-- продукта с разной ценой запроса, и счётчик у них должен быть разный.
--
-- Почему в базе, а не в api/_ratelimit.js. Тот ограничитель держит счётчики В
-- ПАМЯТИ ИНСТАНСА функции: он годится сбить всплеск за минуту-час, но суточную
-- квоту им не удержать — на Vercel инстансы поднимаются и умирают постоянно,
-- и «3 в сутки» превратилось бы в «3 на каждый холодный старт», то есть ни во
-- что. Ровно про это предупреждает шапка _ratelimit.js: лимиты, которые нельзя
-- потерять, живут в Postgres. Здесь квота ещё и защищает наш ключ Anthropic от
-- бесплатных пользователей, так что терять её нельзя тем более.
--
-- Существующие ai_usage и incr_ai_usage НЕ ТРОГАЮТСЯ. Можно было добавить в
-- ai_usage колонку kind, но это смена первичного ключа у таблицы, которую на
-- ходу читает работающий чат, ради экономии одной таблицы. Новая пара
-- «таблица + функция» рядом — дешевле и безопаснее.

create table if not exists public.feature_usage (
  -- ON DELETE CASCADE обязателен. У ai_usage внешнего ключа нет вовсе, и это
  -- давняя недоделка: строки живут после удаления аккаунта. Здесь делаем
  -- сразу правильно — каскад и удалению по 152-ФЗ не мешает (в отличие от
  -- NO ACTION, который заблокировал бы auth.admin.deleteUser), и не оставляет
  -- за собой мусора, если таблицу однажды забудут почистить явно.
  user_id uuid    not null references auth.users(id) on delete cascade,
  day     date    not null,
  -- Что именно считаем. Сейчас единственное значение — 'food_label'.
  -- Текстом, а не enum: добавить вторую считаемую возможность должно стоить
  -- одной строки в коде, а не миграции с ALTER TYPE.
  kind    text    not null,
  count   integer not null default 0,
  -- Ключ из трёх колонок — сутки × возможность × пользователь. Именно на него
  -- опирается ON CONFLICT в функции ниже.
  primary key (user_id, day, kind)
);

comment on table public.feature_usage is
  'Посуточный расход отдельных ИИ-возможностей (kind). Пишется только через incr_feature_usage из api/chat.js; см. sql/2026-08-05_feature_usage.sql';

alter table public.feature_usage enable row level security;

-- Политик для клиентов нет: таблицу трогает только service_role из серверной
-- функции. RLS без единой политики = запрещено всем, кроме него.
-- Гранты выдаём явно, не наследуя старое «GRANT ALL ON ALL TABLES».
revoke all on table public.feature_usage from anon, authenticated;
grant all on table public.feature_usage to service_role;

-- Атомарный инкремент «прочитал и увеличил за один заход». Обычный
-- select-потом-update здесь гонку не переживёт: два параллельных запроса
-- прочитали бы одно и то же значение и оба уложились в квоту.
--
-- SECURITY DEFINER — потому что таблица закрыта RLS и грантами; функция
-- выполняется от владельца (postgres, у него BYPASSRLS).
--
-- set search_path — обязателен для SECURITY DEFINER: без него вызывающий может
-- подсунуть свою схему впереди public и подменить таблицу, в которую мы пишем.
-- У старой incr_ai_usage этого нет — здесь не повторяем.
create or replace function public.incr_feature_usage(uid uuid, d date, k text)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare c int;
begin
  insert into public.feature_usage(user_id, day, kind, count) values (uid, d, k, 1)
    on conflict (user_id, day, kind) do update set count = feature_usage.count + 1
    returning count into c;
  return c;
end $function$;

-- ГЛАВНОЕ ПРО ПРАВА. Функция берёт user_id ИЗ ПАРАМЕТРА, а не из auth.uid(), —
-- то есть тот, кто может её вызвать, может накрутить счётчик ЛЮБОМУ
-- пользователю (или, наоборот, сжечь чужую квоту). Ровно на этом обжигались с
-- incr_ai_usage, см. sql/2026-07-26_privilege_lockdown.sql №1: она была
-- доступна anon, а publishable-ключ по определению лежит в бандле фронта.
--
-- CREATE FUNCTION по умолчанию выдаёт EXECUTE роли PUBLIC, поэтому revoke
-- ниже — не перестраховка, а обязательный шаг. Вызывать вправе только
-- service_role, то есть исключительно серверный код в api/.
revoke execute on function public.incr_feature_usage(uuid, date, text) from public;
revoke execute on function public.incr_feature_usage(uuid, date, text) from anon;
revoke execute on function public.incr_feature_usage(uuid, date, text) from authenticated;
grant  execute on function public.incr_feature_usage(uuid, date, text) to service_role;
