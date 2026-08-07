-- profiles.tg_id — постоянный ключ связи аккаунта FitPro с аккаунтом Telegram.
--
-- ЗАЧЕМ. Сегодня телеграм-пользователь опознаётся по СИНТЕТИЧЕСКОЙ почте
-- tg<id>@telegram.fitpro, которую api/telegram-auth.js собирает из tgUser.id и
-- скармливает createUser/generateLink. То есть идентичностью служит строка,
-- которая:
--   * лежит в auth.users.email — колонке, которую человек в принципе вправе
--     сменить (и тогда связь с Telegram рвётся молча, а следующий вход заводит
--     ДУБЛЬ аккаунта — с чистой историей вместо своей);
--   * не даёт связать один Telegram с уже существующим email-аккаунтом: почта
--     у строки одна, а «войти телеграмом в свой обычный аккаунт» — это ровно
--     два идентификатора у одного пользователя;
--   * заставляет разбирать регулярку по email везде, где нужен chat_id
--     (api/send-reminders.js extractChatId, src/config.js telegramChatIdOf).
--
-- tg_id снимает всё это: связь становится отдельным полем, а синтетическая
-- почта остаётся тем, чем и должна быть, — техническим значением, нужным
-- только чтобы GoTrue выдал сессию при СОЗДАНИИ аккаунта.
--
-- ПОРЯДОК ПРИМЕНЕНИЯ ВАЖЕН: этот файл накатывается ДО деплоя кода. Новый
-- api/telegram-auth.js первым делом ищет профиль по tg_id — без колонки запрос
-- вернёт ошибку. Обратная совместимость в коде есть (legacy-путь по
-- синтетической почте отработает и при пустом tg_id), но колонка обязана
-- существовать.
--
-- Файл идемпотентен целиком — повторный прогон ничего не сломает и не перезапишет.

-- ── 1. Колонка ───────────────────────────────────────────────────────────────
alter table public.profiles add column if not exists tg_id bigint;

comment on column public.profiles.tg_id is
  'Telegram user id. Постоянный ключ связи аккаунта с Telegram, основной способ опознать пользователя в api/telegram-auth.js. Пишется ТОЛЬКО с service_role (см. триггер guard_profile_tg_id). См. sql/2026-08-07_profiles_tg_id.sql';

-- Уникальный индекс. Он же и есть «индекс» для поиска: отдельный btree по той
-- же колонке был бы полным дублем — уникальный индекс обслуживает
-- `where tg_id = $1` ровно так же, а второй индекс только замедлял бы запись.
--
-- Уникальность здесь — не украшение, а защита: один аккаунт Telegram обязан
-- вести в один аккаунт FitPro. Без неё рассинхрон (две строки с одним tg_id)
-- превратился бы в «вход отдаёт то один аккаунт, то другой».
--
-- NULL'ы уникальности не мешают: в Postgres NULL <> NULL, поэтому у всех
-- аккаунтов без Telegram (обычная регистрация по почте) колонка спокойно
-- остаётся пустой.
create unique index if not exists profiles_tg_id_key on public.profiles (tg_id);

-- ── 2. Бэкфилл существующих аккаунтов ───────────────────────────────────────
-- Два источника, оба уже есть в auth.users, — те же, что разбирает
-- extractChatId() в api/send-reminders.js:
--   1) raw_user_meta_data->>'telegram_id' — пишется при создании аккаунта;
--   2) email вида tg<цифры>@telegram.fitpro — если метаданных нет.
-- Приоритет у метаданных: почту человек мог сменить, метаданные — нет.
--
-- Числа берём с защитой: '\D' вычищает пробелы и возможные кавычки, если
-- telegram_id лёг в JSON строкой, а не числом. Пустой результат → NULL, а не
-- падение на ''::bigint.
--
-- ДЕДУПЛИКАЦИЯ обязательна. Один и тот же tg_id теоретически может отыскаться
-- у двух auth-пользователей (например, человек однажды завёл дубль). Уникальный
-- индекс на такой паре уронил бы весь UPDATE и, значит, всю миграцию. Поэтому
-- при совпадении tg_id выигрывает САМЫЙ РАННИЙ аккаунт (created_at, при равенстве
-- — id): у него больше шансов быть настоящим, с историей. Проигравшие остаются
-- с tg_id = NULL и попадают в отчёт ниже — их надо разобрать руками.
--
-- `p.tg_id is null` — повторный прогон не перезаписывает уже проставленное.
with candidates as (
  select
    u.id,
    u.created_at,
    nullif(
      coalesce(
        nullif(regexp_replace(coalesce(u.raw_user_meta_data->>'telegram_id', ''), '\D', '', 'g'), ''),
        substring(u.email from '^tg(\d+)@telegram\.fitpro$')
      ),
      ''
    )::bigint as tg
  from auth.users u
),
ranked as (
  select id, tg, row_number() over (partition by tg order by created_at, id) as rn
  from candidates
  where tg is not null
)
update public.profiles p
   set tg_id = r.tg
  from ranked r
 where p.id = r.id
   and r.rn = 1
   and p.tg_id is null;

-- ── 3. Защита колонки от записи с фронта ────────────────────────────────────
-- БЕЗ ЭТОГО НОВАЯ КОЛОНКА — ДЫРА. RLS на profiles разрешает пользователю
-- обновлять СВОЮ строку целиком ("Users see own profile" ... using auth.uid() = id),
-- а tg_id существующему триггеру guard_profile_privileged неизвестен. То есть
-- любой авторизованный мог бы записать себе чужой (ещё не занятый) tg_id — и
-- когда владелец этого Telegram зайдёт в приложение, поиск по tg_id приведёт
-- его в ЧУЖОЙ аккаунт. Уникальный индекс от этого не спасает: он запрещает
-- занять tg_id повторно, но не запрещает занять его первым.
--
-- Схема защиты — ровно та же, что у coach_id: смотрим на auth.uid(). У
-- обычного пользователя он не пуст, и тогда значение колонки просто
-- возвращается к прежнему (на INSERT — обнуляется). У service_role, то есть у
-- нашего серверного кода в api/, auth.uid() пуст — он пишет свободно. Отдельным
-- триггером, а не правкой guard_profile_privileged: та функция живёт только на
-- проде (в репозитории её тела нет), и переписывать её вслепую нельзя.
create or replace function public.guard_profile_tg_id()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
begin
  -- Пустой auth.uid() = вызов не от имени вошедшего пользователя (service_role,
  -- миграции, psql под postgres). Только такому коду можно писать tg_id.
  if auth.uid() is null then
    return new;
  end if;

  if tg_op = 'INSERT' then
    new.tg_id := null;
  else
    new.tg_id := old.tg_id;
  end if;
  return new;
end
$function$;

drop trigger if exists guard_profile_tg_id on public.profiles;
create trigger guard_profile_tg_id
  before insert or update on public.profiles
  for each row execute function public.guard_profile_tg_id();

-- ── 4. Отчёт о бэкфилле ─────────────────────────────────────────────────────
-- Печатается прямо в вывод psql. Смотреть на него обязательно: строка
-- "без tg_id" — это люди, которые после деплоя пойдут по legacy-пути (он
-- рабочий), но связь у них ещё не зафиксирована.
select
  count(*)                                                         as profiles_total,
  count(tg_id)                                                     as with_tg_id,
  count(*) filter (where tg_id is null)                            as without_tg_id
from public.profiles;

-- Разбор тех, кто остался без tg_id, по причинам. Ожидаемая и нормальная
-- причина одна — 'обычный email-аккаунт, Telegram не привязан'. Всё остальное
-- требует ручного разбора.
select
  case
    when u.email ~ '^tg\d+@telegram\.fitpro$'                then 'ДУБЛЬ tg_id — разобрать руками'
    when u.raw_user_meta_data->>'telegram_id' is not null    then 'ДУБЛЬ tg_id (по метаданным) — разобрать руками'
    when u.email like '%@clients.fitproapp.ru'               then 'клиент заведён тренером, Telegram не привязан'
    else                                                          'обычный email-аккаунт, Telegram не привязан'
  end as reason,
  count(*) as accounts
from public.profiles p
join auth.users u on u.id = p.id
where p.tg_id is null
group by 1
order by 2 desc;
