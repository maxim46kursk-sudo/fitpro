-- Тренер записывает тренировки в дневник СВОЕГО клиента.
--
-- Зачем: часть клиентов занимается очно и сама в приложение ничего не вносит —
-- тренер ведёт их дневник за них. До сих пор у тренера на workouts/workout_sets
-- был только SELECT (политики trainer_reads_*), писать он не мог вовсе.
--
-- Что здесь: колонка workouts.created_by + шесть политик (INSERT/UPDATE/DELETE
-- на обе таблицы). Существующие политики НЕ трогаются: клиент по-прежнему
-- полностью управляет своими записями (own_rows, «Users manage own …»), тренер
-- по-прежнему их читает (trainer_reads_*). Политики в Postgres складываются по
-- ИЛИ, поэтому новые права добавляются к старым, ничего не отменяя.
--
-- Гранты не выдаём: authenticated уже имеет INSERT/UPDATE/DELETE на обеих
-- таблицах (наследие «GRANT ALL ON ALL TABLES»), и реально доступ ограничивает
-- именно RLS. Дописывать сюда ещё грантов нечего.
--
-- ГРАНИЦА, которую задают политики ниже: тренер может завести запись клиенту и
-- потом править ТОЛЬКО ТО, ЧТО ЗАВЁЛ САМ. Запись, сделанную клиентом
-- (created_by IS NULL), тренер не изменит и не удалит — его правки не должны
-- задним числом переписывать то, что человек записал о себе сам.

-- ── Кто автор записи ────────────────────────────────────────────────────────
-- NULL — запись создал сам клиент (все существующие строки такие и есть, и это
-- верно: до этой миграции писать мог только владелец дневника).
--
-- ON DELETE SET NULL обязателен. Без него внешний ключ не даст удалить аккаунт
-- тренера, пока в чужих дневниках лежат заведённые им тренировки, — и удаление
-- по 152-ФЗ (api/delete-account.js) сломается: чужие строки этот эндпоинт не
-- чистит и чистить не должен, они принадлежат клиенту. На тех же граблях уже
-- стояли с client_access_tokens.trainer_id (sql/2026-08-04_client_access.sql),
-- там решили каскадом; здесь каскад не годится — он снёс бы клиенту тренировки
-- вместе с ушедшим тренером. SET NULL оставляет запись в дневнике клиента и
-- лишь забывает, кто её внёс.
alter table public.workouts
  add column if not exists created_by uuid references auth.users(id) on delete set null;

comment on column public.workouts.created_by is
  'NULL — запись создал владелец дневника; uuid — её внёс тренер (см. sql/2026-08-04_trainer_logs_workouts.sql)';

-- ── workouts: тренер заводит тренировку своему клиенту ──────────────────────
-- Два условия сразу: (1) тренер помечает автором себя — подсунуть чужой
-- created_by или оставить NULL нельзя, иначе запись притворилась бы сделанной
-- клиентом и её же нельзя было бы отличить при разборе; (2) владелец дневника —
-- действительно клиент этого тренера.
drop policy if exists trainer_inserts_client_workouts on public.workouts;
create policy trainer_inserts_client_workouts on public.workouts
  for insert to authenticated
  with check (
    created_by = auth.uid()
    and exists (
      select 1 from public.profiles p
      where p.id = workouts.user_id and p.coach_id = auth.uid()
    )
  );

-- Правка и удаление — только своих записей у своего клиента. created_by в USING
-- проверяется по СТАРОЙ строке (что правим), в WITH CHECK — по НОВОЙ (во что
-- превращаем): вместе это не даёт ни взяться за чужую запись, ни переписать
-- свою на чужого владельца.
drop policy if exists trainer_updates_own_client_workouts on public.workouts;
create policy trainer_updates_own_client_workouts on public.workouts
  for update to authenticated
  using (
    created_by = auth.uid()
    and exists (
      select 1 from public.profiles p
      where p.id = workouts.user_id and p.coach_id = auth.uid()
    )
  )
  with check (
    created_by = auth.uid()
    and exists (
      select 1 from public.profiles p
      where p.id = workouts.user_id and p.coach_id = auth.uid()
    )
  );

drop policy if exists trainer_deletes_own_client_workouts on public.workouts;
create policy trainer_deletes_own_client_workouts on public.workouts
  for delete to authenticated
  using (
    created_by = auth.uid()
    and exists (
      select 1 from public.profiles p
      where p.id = workouts.user_id and p.coach_id = auth.uid()
    )
  );

-- ── workout_sets: подходы внутри заведённой тренером тренировки ─────────────
-- Право на подход выводится ИЗ ТРЕНИРОВКИ, а не проверяется отдельно: подход
-- обязан принадлежать тренировке (workout_id), которую этот же тренер завёл
-- (w.created_by = auth.uid()) своему клиенту (p.coach_id = auth.uid()).
--
-- Дополнительно w.user_id = workout_sets.user_id: в этой таблице владелец
-- продублирован своей колонкой, и разъехавшиеся значения означали бы подход,
-- лежащий в дневнике одного человека внутри тренировки другого. Заодно это
-- закрывает попытку записать подход на себя внутрь клиентской тренировки.
--
-- Подход без workout_id (такие остались от старых версий приложения) под эти
-- политики не подпадает: w.id = NULL не сходится ни с чем, EXISTS пуст. Тренеру
-- он и не нужен — он создаёт тренировку и кладёт подходы в неё.
drop policy if exists trainer_inserts_client_sets on public.workout_sets;
create policy trainer_inserts_client_sets on public.workout_sets
  for insert to authenticated
  with check (
    exists (
      select 1 from public.workouts w
      join public.profiles p on p.id = w.user_id
      where w.id = workout_sets.workout_id
        and w.created_by = auth.uid()
        and p.coach_id = auth.uid()
        and w.user_id = workout_sets.user_id
    )
  );

drop policy if exists trainer_updates_own_client_sets on public.workout_sets;
create policy trainer_updates_own_client_sets on public.workout_sets
  for update to authenticated
  using (
    exists (
      select 1 from public.workouts w
      join public.profiles p on p.id = w.user_id
      where w.id = workout_sets.workout_id
        and w.created_by = auth.uid()
        and p.coach_id = auth.uid()
        and w.user_id = workout_sets.user_id
    )
  )
  with check (
    exists (
      select 1 from public.workouts w
      join public.profiles p on p.id = w.user_id
      where w.id = workout_sets.workout_id
        and w.created_by = auth.uid()
        and p.coach_id = auth.uid()
        and w.user_id = workout_sets.user_id
    )
  );

drop policy if exists trainer_deletes_own_client_sets on public.workout_sets;
create policy trainer_deletes_own_client_sets on public.workout_sets
  for delete to authenticated
  using (
    exists (
      select 1 from public.workouts w
      join public.profiles p on p.id = w.user_id
      where w.id = workout_sets.workout_id
        and w.created_by = auth.uid()
        and p.coach_id = auth.uid()
        and w.user_id = workout_sets.user_id
    )
  );
