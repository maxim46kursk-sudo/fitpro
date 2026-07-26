-- Ограничение прав: отклонения №1 и №3 из аудита RLS.
--
-- №1. incr_ai_usage — SECURITY DEFINER от postgres (у него BYPASSRLS), пишет в
-- ai_usage в обход RLS, а user_id берёт ИЗ ПАРАМЕТРА, не из auth.uid(). EXECUTE
-- был выдан PUBLIC, то есть вызвать её мог любой с anon-ключом — а он публичен
-- по определению, лежит в бандле фронта. Отсюда: POST /rest/v1/rpc/incr_ai_usage
-- с чужим uid в цикле сжигал жертве дневной лимит ИИ (api/chat.js отказывает
-- при > 40), плюс на ai_usage нет внешнего ключа на auth.users — можно было
-- лить произвольные uuid и раздувать таблицу.
--
-- !!! Тело функции НЕ трогаем и на auth.uid() НЕ переписываем. Единственный
-- легитимный вызов — api/chat.js под service_role-ключом, где auth.uid() равен
-- NULL (в ключах самохоста нет claim 'sub'). Переписывание сломало бы учёт
-- дневного лимита у платных пользователей. Меняем ТОЛЬКО права: звать функцию
-- вправе лишь service_role, то есть наш сервер.
--
-- №3. payments, ai_usage, notification_log, transcode_jobs — у anon и
-- authenticated стояли полные гранты (включая DELETE и TRUNCATE) со времён
-- дефолтного "GRANT ALL ON ALL TABLES IN SCHEMA public". Сегодня их спасает
-- только то, что RLS включена и НЕТ НИ ОДНОЙ политики (deny-all). Защита,
-- держащаяся на отсутствии политики, слишком хрупкая: одна политика, добавленная
-- «чтобы показать пользователю его платежи», мгновенно открывает таблицу anon
-- на запись и удаление. Отдельно: TRUNCATE вообще не подчиняется RLS — это
-- привилегия, а не операция над строками.
--
-- Образец нужного состояния — login_attempts: грантов у anon/authenticated нет
-- вообще, только postgres / service_role / supabase_auth_admin.
--
-- Клиентский код к этим таблицам не обращается (в src/ упоминаний нет), а все
-- серверные обращения идут под service_role — api/chat.js, api/prodamus-webhook.js,
-- api/create-video-upload.js, api/send-reminders.js, плюс notification_log в
-- USER_TABLES (api/delete-account.js, api/export-data.js). Их права не трогаем.

-- Сверка сигнатуры перед отзывом прав: ожидается (uid uuid, d date).
-- Ошибись в типах — REVOKE молча уйдёт «в никуда» или упадёт.
\df incr_ai_usage

revoke execute on function public.incr_ai_usage(uuid, date) from public;
revoke execute on function public.incr_ai_usage(uuid, date) from anon;
revoke execute on function public.incr_ai_usage(uuid, date) from authenticated;
grant  execute on function public.incr_ai_usage(uuid, date) to service_role;

revoke all on table
  public.payments,
  public.ai_usage,
  public.notification_log,
  public.transcode_jobs
from anon, authenticated;
