-- Прогресс челленджа Motion: public.motion_attempts и public.motion_progress.
--
-- Зачем: до сих пор весь челлендж — день, сданные дни, попытки, личные планки,
-- рекорд — жил только в localStorage браузера. Очищенный кэш, новый телефон,
-- другой браузер на том же телефоне — и тридцать дней работы исчезали без
-- следа. Челлендж платный, поэтому цена такой пропажи не «неприятно», а деньги.
--
-- ДВЕ ТАБЛИЦЫ, А НЕ ОДНА, и это не вкусовщина. Попытка — будущий предмет спора
-- («я прошёл, а мне не засчитали»), и её надо уметь СПРОСИТЬ: за какой день,
-- каким уровнем, какой по счёту, с каким результатом. В общем jsonb-комке такой
-- вопрос превращается в разбор чужой структуры руками. Всё остальное — указатель
-- дня, сданные дни, планки, пороги, рекорд — меняется целиком и вопросов к
-- отдельным полям не вызывает, поэтому лежит одним payload.
--
-- ЧТО ОСТАЁТСЯ НА УСТРОЙСТВЕ: выбранная камера, тумблер звука, память отладочной
-- панели. Это свойства ТЕЛЕФОНА, а не человека: переносить их на другой аппарат
-- бессмысленно, а deviceId чужой камеры там просто не существует.
--
-- 152-ФЗ: user_id есть в обеих, значит это данные пользователя. Обе добавлены в
-- USER_TABLES (api/_userTables.js) — удаление и выгрузка аккаунта подхватывают
-- их сами. Внешние ключи объявлены без ON DELETE (NO ACTION), как у соседей:
-- auth.admin.deleteUser() откажется удалять аккаунт, пока тут остаются строки,
-- а delete-account.js чистит USER_TABLES раньше profiles и раньше самого
-- auth-пользователя.

-- ── Попытки: только добавление ──────────────────────────────────────────────
create table if not exists public.motion_attempts (
  id         bigint generated always as identity primary key,
  user_id    uuid not null references auth.users (id),
  day        smallint not null,
  tier       text not null,
  attempt_no smallint not null,
  score      integer not null default 0,
  reps       integer not null default 0,
  hits       integer not null default 0,
  spawned    integer not null default 0,
  react_ms   integer not null default 0,
  at         timestamptz not null default now(),
  -- Один заход — одна строка навсегда. Повторная отправка той же попытки (а она
  -- случится: телефон повторяет отправку, пока не доедет) обязана отброситься, а
  -- не переписать результат.
  constraint motion_attempts_unique unique (user_id, day, tier, attempt_no)
);

create index if not exists motion_attempts_user_day_idx
  on public.motion_attempts (user_id, day);

-- ── Прогресс: одна строка на человека ───────────────────────────────────────
create table if not exists public.motion_progress (
  user_id    uuid primary key references auth.users (id),
  payload    jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

alter table public.motion_attempts enable row level security;
alter table public.motion_progress enable row level security;

-- Пишет и читает человек только своё. Записи идут напрямую из приложения, как у
-- дневника питания, поэтому политика — единственное, что стоит между людьми.
drop policy if exists motion_attempts_own on public.motion_attempts;
create policy motion_attempts_own on public.motion_attempts
  for all to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

drop policy if exists motion_progress_own on public.motion_progress;
create policy motion_progress_own on public.motion_progress
  for all to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- Тренер читает всё: разбирать спор о засчитанном дне — его работа, и без
-- общего доступа он видел бы только собственные тренировки. Только чтение:
-- править чужой результат нельзя и ему.
drop policy if exists motion_attempts_trainer_read on public.motion_attempts;
create policy motion_attempts_trainer_read on public.motion_attempts
  for select to authenticated
  using (exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'trainer'));

drop policy if exists motion_progress_trainer_read on public.motion_progress;
create policy motion_progress_trainer_read on public.motion_progress
  for select to authenticated
  using (exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'trainer'));
