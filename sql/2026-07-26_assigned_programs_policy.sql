-- Ужесточение записи в public.assigned_programs.
--
-- Было: политика trainer_manages_programs (cmd ALL, роль authenticated) на
-- запись проверяла ТОЛЬКО trainer_id = auth.uid(). Достаточно записать себя в
-- trainer_id — и можно вставить строку с ЛЮБЫМ client_id. Жертва читает её
-- своей политикой client_reads_own_program и видит чужой контент как
-- «персональную программу от тренера». Плюс UNIQUE (client_id): заняв слот
-- постороннего клиента, атакующий не даёт настоящему тренеру назначить
-- программу — его INSERT падает на уникальности.
--
-- Стало: writer обязан быть тренером ИМЕННО ЭТОГО клиента (profiles.coach_id).
-- Легитимный путь под это подходит без изменений: редактор программы
-- (ProgramEditor в src/App.jsx) получает клиента из списка, который грузится
-- запросом profiles ... .eq('coach_id', userId) — то есть у каждого клиента в
-- редакторе coach_id уже равен тренеру. Сохранение идёт upsert'ом с
-- onConflict:'client_id'; WITH CHECK применяется и к INSERT, и к UPDATE-ветке.
--
-- USING НЕ трогаем (trainer_id = auth.uid()): тренер должен продолжать видеть
-- и обновлять уже созданные им строки, даже если клиент позже отвязался.
-- Политику client_reads_own_program не трогаем вообще.
--
-- coach_id как основание доверять записи защищён триггером
-- guard_profile_privileged: обычный authenticated не может проставить его сам
-- (new.coach_id := old.coach_id), это делает только api/link-client.js на
-- service_role после проверки приглашения.

alter policy trainer_manages_programs on public.assigned_programs
  using (trainer_id = auth.uid())
  with check (
    trainer_id = auth.uid()
    and exists (
      select 1 from public.profiles p
      where p.id = assigned_programs.client_id
        and p.coach_id = auth.uid()
    )
  );
