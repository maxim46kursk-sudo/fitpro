-- ДОГОНЯЮЩАЯ миграция: public.workout_templates и public.planned_workouts.
--
-- Обе таблицы давно живут на проде и обе пишутся приложением (см. DiaryView в
-- src/App.jsx: saveTemplate/openTemplatePicker/deleteTemplate и
-- «Запланировать тренировку»), но файла миграции у них не было ни одного —
-- их завели руками. Схема прода и репозиторий из-за этого разошлись: поднять
-- базу с нуля по sql/ означало получить приложение, у которого «Сделать
-- шаблон» и «Запланировать» молча падают на отсутствующей таблице.
--
-- Этот файл НИЧЕГО НЕ МЕНЯЕТ на проде — он записывает то, что там уже есть,
-- один в один (проверено чтением информационной схемы и pg_policies
-- 11.08.2026). Всё идемпотентно: на боевой базе прогон — пустая операция, на
-- чистой — создаёт недостающее. Специально не «улучшено»: любое расхождение
-- с продом здесь опаснее, чем некрасивость, а причёсывать живую схему надо
-- отдельной задачей и осознанно (что именно стоило бы поправить — в самом
-- низу файла).

-- Одной транзакцией: ниже политики пересоздаются парой drop/create, и обрыв
-- между ними оставил бы таблицу с неполным набором прав. DDL в Postgres
-- транзакционен, поэтому либо применяется всё, либо ничего.
begin;

-- ── Шаблоны тренировок пользователя ─────────────────────────────────────
-- Строка = сохранённая «болванка» тренировки: имя + список упражнений в
-- jsonb ([{n,m,eq}, ...], см. saveTemplate). Подходы/веса сюда не попадают —
-- шаблон задаёт только состав.
create table if not exists public.workout_templates (
  id         bigint generated always as identity primary key,
  -- NULL допустим и FK без ON DELETE — ровно как на проде. Каскада нет
  -- сознательно: удаление аккаунта идёт явным списком таблиц
  -- (api/_userTables.js, там обе эти таблицы есть), а не через каскад базы.
  user_id    uuid references auth.users(id),
  name       text  not null,
  exercises  jsonb not null default '[]'::jsonb,
  created_at timestamp without time zone default now()
);

comment on table public.workout_templates is
  'Шаблоны тренировок пользователя (Дневник → Мои тренировки → Сделать шаблон); см. sql/2026-08-11_workout_templates_planned_workouts.sql';

-- ── Запланированные тренировки ──────────────────────────────────────────
-- Строка = «на такую-то дату задумана тренировка с таким-то именем».
-- Ни упражнений, ни подходов: это отметка в списке, а не сама тренировка.
create table if not exists public.planned_workouts (
  id         bigint generated always as identity primary key,
  user_id    uuid references auth.users(id),
  name       text,
  -- date текстом, а не date — как в workouts/workout_sets: приложение всюду
  -- оперирует 'YYYY-MM-DD' строкой из localTodayISO(), и менять тип на живой
  -- таблице ради красоты незачем.
  date       text,
  created_at timestamp without time zone default now()
);

comment on table public.planned_workouts is
  'Запланированные тренировки пользователя (Дневник → Мои тренировки → Запланировать); см. sql/2026-08-11_workout_templates_planned_workouts.sql';

-- ── RLS ─────────────────────────────────────────────────────────────────
-- Обе таблицы читает и пишет сам пользователь своим ключом, поэтому политика
-- одна и та же: строка видна и правится только своим владельцем.
alter table public.workout_templates enable row level security;
alter table public.planned_workouts  enable row level security;

-- На проде у каждой таблицы ПО ДВЕ равнозначные политики: именная (роль
-- public) и own_rows (роль authenticated) — вторая приехала позже общим
-- проходом по всем пользовательским таблицам. Дубль безвреден (политики
-- складываются по ИЛИ, условие у них одинаковое), но воспроизводим обе:
-- задача файла — совпасть с продом, а не переписать его.
drop policy if exists "Users manage own workout templates" on public.workout_templates;
create policy "Users manage own workout templates" on public.workout_templates
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "own_rows" on public.workout_templates;
create policy "own_rows" on public.workout_templates
  for all to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "Users manage own planned workouts" on public.planned_workouts;
create policy "Users manage own planned workouts" on public.planned_workouts
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "own_rows" on public.planned_workouts;
create policy "own_rows" on public.planned_workouts
  for all to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);

commit;

-- ── Что здесь намеренно НЕ исправлено ───────────────────────────────────
-- Файл догоняющий, поэтому он повторяет прод как есть. Отдельной задачей
-- стоило бы обдумать:
--   * user_id допускает NULL — строка-сирота, невидимая ни одному
--     пользователю (auth.uid() = null никогда не истинно), но занимающая
--     место. Напрашивается not null;
--   * по две одинаковые политики на таблицу — лишняя проверка на каждый
--     запрос и лишний повод перепутать, какую править;
--   * нет индекса по user_id: сейчас строк единицы, но оба запроса
--     приложения фильтруют именно по нему.
-- Ни одно из этих изменений не является безопасным «между делом»: они
-- трогают живые данные и права, поэтому здесь их нет.
