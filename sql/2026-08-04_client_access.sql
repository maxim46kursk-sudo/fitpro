-- Клиенты без регистрации: public.client_access_tokens.
--
-- Зачем: тренер заводит клиента сам (api/link-client.js, action='create_client')
-- и отдаёт ему одну ссылку. Клиент открывает её и попадает в приложение обычным
-- пользователем — без пароля, почты и формы регистрации. Ссылка обменивается на
-- сессию в api/telegram-auth.js (action='redeem_access') тем же способом, что и
-- вход из Telegram: generateLink + email_otp.
--
-- Открытый токен в базе НЕ хранится — только sha256-хэш. Утечка дампа таблицы
-- не даёт войти ни за кого: восстановить 32 случайных байта из хэша нельзя.
-- Открытое значение существует ровно один раз — в ответе на create_client,
-- дальше оно живёт только в ссылке у тренера и клиента.
--
-- Ссылка МНОГОРАЗОВАЯ до истечения срока (7 дней). Одноразовая тут не годится:
-- мессенджеры открывают ссылки во встроенном браузере, первое открытие сожгло бы
-- токен, и клиент остался бы без доступа. used_at пишем при первом использовании
-- — это история, а не защёлка.
--
-- 152-ФЗ: user_id есть, значит это данные пользователя. Таблица добавлена в
-- USER_TABLES (api/_userTables.js), удаление и выгрузка аккаунта подхватывают её
-- сами.
--
-- ОБА внешних ключа — ON DELETE CASCADE, и это осознанное отступление от
-- привычного для проекта NO ACTION. По user_id всё как обычно: без пользователя
-- его ссылки доступа бессмысленны. По trainer_id NO ACTION оставлять НЕЛЬЗЯ:
-- строка клиента ссылается на тренера, но по столбцу user_id она тренеру не
-- принадлежит, — значит delete-account.js её не вычистит, и удаление аккаунта
-- ТРЕНЕРА упёрлось бы в этот ключ (а удаление аккаунта по 152-ФЗ обязано
-- проходить). Каскад тут честен по смыслу: тренер уходит — выданные им ссылки
-- перестают существовать вместе со связью (delete-account.js в том же месте
-- обнуляет клиентам coach_id).

create table if not exists public.client_access_tokens (
  id          bigint generated always as identity primary key,
  user_id     uuid not null references auth.users(id) on delete cascade,
  trainer_id  uuid not null references auth.users(id) on delete cascade,
  token_hash  text not null unique,
  created_at  timestamptz not null default now(),
  expires_at  timestamptz not null,
  used_at     timestamptz
);

-- Догоняющая часть для баз, где таблица уже создана прежней редакцией миграции
-- (там trainer_id был NO ACTION). На чистой базе это no-op: пересоздаём тот же
-- ключ с нужным поведением.
alter table public.client_access_tokens
  drop constraint if exists client_access_tokens_trainer_id_fkey;
alter table public.client_access_tokens
  add constraint client_access_tokens_trainer_id_fkey
  foreign key (trainer_id) references auth.users(id) on delete cascade;

-- Единственный сценарий чтения — «найти строку по хэшу предъявленного токена».
-- unique выше уже даёт индекс, но объявляем явно: имя и намерение видны в схеме,
-- а create index if not exists на уже покрытом столбце ничего не ломает.
create index if not exists client_access_tokens_token_hash_idx
  on public.client_access_tokens (token_hash);

-- RLS включён, политик нет НАМЕРЕННО: deny-all для anon и authenticated.
-- С таблицей работает только service_role (он RLS обходит) из двух серверных
-- ручек. Ни клиенту, ни тренеру видеть чужие хэши и сроки незачем.
alter table public.client_access_tokens enable row level security;

-- Гранты в духе 2026-07-26_privilege_lockdown.sql и 2026-07-28_error_log.sql:
-- новую таблицу заводим сразу правильно, не наследуя старое "GRANT ALL ON ALL
-- TABLES". anon и authenticated не получают ничего — права проверяются ДО RLS,
-- так что отсутствие гранта это вторая линия поверх отсутствия политик.
revoke all on table public.client_access_tokens from anon, authenticated;
grant all on table public.client_access_tokens to service_role;
