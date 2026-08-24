-- Правка challenge_entries: запись об оплате переживает удаление аккаунта.
-- Дополняет sql/2026-08-24_challenge_seasons.sql, применять после него.
--
-- ЧТО БЫЛО НЕ ТАК. user_id стоял NOT NULL, а внешний ключ — без ON DELETE, как
-- у соседних таблиц. Для дневника питания это правильно: ушёл человек — ушли
-- его данные. Здесь же строка — не данные, а ФИНАНСОВЫЙ ДОКУМЕНТ: человек
-- заплатил за поток, получил номер участника и вправе претендовать на приз.
-- Удалить её вместе с аккаунтом значит стереть след денег и сломать спор о
-- призах задним числом; оставить как есть — значит, что удаление аккаунта по
-- 152-ФЗ просто откажет, упершись в внешний ключ.
--
-- ЧТО ДЕЛАЕМ. user_id становится необязательным, а ключ — ON DELETE SET NULL.
-- Уходя, человек ОТВЯЗЫВАЕТСЯ от записи: персональной связи больше нет, а
-- номер участника, сумма и платёж остаются. Именно поэтому challenge_entries
-- НЕ добавлена в USER_TABLES (api/_userTables.js) — там строки удаляются, а
-- здесь их удалять нельзя; отвязку делает сама база.
--
-- И ПОЧЕМУ ПОЯВЛЯЕТСЯ display_name. Рейтинг потока показывает имена, а имя до
-- сих пор бралось бы из profiles — то есть исчезло бы вместе с аккаунтом, и
-- строка в таблице результатов стала бы безымянной. Имя снимается В МОМЕНТ
-- ПОКУПКИ и хранится здесь же: это часть документа, а не текущее состояние
-- профиля. Побочно это верно и для тех, кто останется: переименовался человек
-- после потока — итоги прошлого потока не переписываются.

-- ── 1. user_id: отвязка вместо удаления ─────────────────────────────────────
alter table public.challenge_entries
  alter column user_id drop not null;

alter table public.challenge_entries
  drop constraint if exists challenge_entries_user_id_fkey;

alter table public.challenge_entries
  add constraint challenge_entries_user_id_fkey
  foreign key (user_id) references auth.users (id) on delete set null;

-- UNIQUE (season_id, user_id) остаётся как был: в Postgres NULL не равен NULL,
-- поэтому отвязанных строк в одном потоке может быть сколько угодно, а вот
-- второй раз купить поток живой человек по-прежнему не может.

comment on column public.challenge_entries.user_id is
  'Покупатель. NULL — аккаунт удалён (ON DELETE SET NULL): запись об оплате остаётся, персональная связь снимается.';

-- ── 2. Имя на момент покупки ────────────────────────────────────────────────
-- В два шага, а не одним NOT NULL: колонка добавляется пустой, заполняется, и
-- только потом закрывается. Так файл переживает повторный прогон и не упадёт
-- на таблице, в которой уже есть строки.
alter table public.challenge_entries
  add column if not exists display_name text;

update public.challenge_entries
   set display_name = 'Участник ' || participant_no
 where display_name is null or btrim(display_name) = '';

alter table public.challenge_entries
  alter column display_name set not null;

comment on column public.challenge_entries.display_name is
  'Имя участника, снятое из profiles.name в момент покупки. Хранится здесь, а не читается из профиля: после удаления аккаунта строка рейтинга не должна становиться безымянной.';

-- ── 3. Зачисление пишет имя ─────────────────────────────────────────────────
-- Старую трёхаргументную версию именно УДАЛЯЕМ, а не оставляем рядом: у новой
-- p_display_name с умолчанием, и вызов с тремя аргументами подошёл бы обеим —
-- Postgres ответил бы «function is not unique» вместо зачисления.
drop function if exists public.challenge_enroll(bigint, uuid, text);

-- Остальное без изменений — та же блокировка сезона и та же идемпотентность,
-- разбор причин в sql/2026-08-24_challenge_seasons.sql. Имя на идемпотентность
-- не влияет: повторный вебхук возвращает уже выданный номер и НЕ переписывает
-- снятое при покупке имя (документ не задним числом правится).
create or replace function public.challenge_enroll(
  p_season_id    bigint,
  p_user_id      uuid,
  p_payment_id   text default null,
  p_display_name text default null
)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare
  v_season bigint;
  v_no     integer;
begin
  if p_user_id is null then
    raise exception 'challenge_enroll: не указан пользователь'
      using errcode = 'null_value_not_allowed';
  end if;

  -- Заодно проверяем, что сезон вообще существует: зачислить в несуществующий
  -- поток — значит молча потерять оплату.
  select id into v_season
    from public.challenge_seasons
   where id = p_season_id
   for update;

  if v_season is null then
    raise exception 'challenge_enroll: сезон % не найден', p_season_id
      using errcode = 'no_data_found';
  end if;

  -- Тот же платёж уже проведён — отдаём выданный номер и ничего не трогаем.
  if p_payment_id is not null then
    select participant_no into v_no
      from public.challenge_entries
     where season_id = p_season_id and payment_id = p_payment_id;

    if v_no is not null then
      return v_no;
    end if;
  end if;

  -- Тот же человек уже в потоке — тоже отдаём его номер. Повторная оплата того
  -- же потока вторым номером не награждается.
  select participant_no into v_no
    from public.challenge_entries
   where season_id = p_season_id and user_id = p_user_id;

  if v_no is not null then
    return v_no;
  end if;

  select coalesce(max(participant_no), 0) + 1 into v_no
    from public.challenge_entries
   where season_id = p_season_id;

  -- Пустое имя не должно превращаться в пустую строку в рейтинге: у профиля
  -- имя может быть не заполнено вовсе, и тогда человек — «Участник N».
  insert into public.challenge_entries (season_id, user_id, participant_no, payment_id, paid_at, display_name)
  values (p_season_id, p_user_id, v_no, p_payment_id,
          case when p_payment_id is not null then now() end,
          coalesce(nullif(btrim(p_display_name), ''), 'Участник ' || v_no));

  return v_no;
end $function$;

comment on function public.challenge_enroll(bigint, uuid, text, text) is
  'Зачисляет человека в поток, выдаёт следующий номер участника под блокировкой сезона и снимает имя на момент покупки. Идемпотентна по payment_id и по user_id: повторный вебхук возвращает уже выданный номер и не переписывает имя.';

-- Права те же, что были у трёхаргументной версии: вызывать вправе только
-- серверный код в api/. DROP снёс и старые гранты, поэтому выдаём заново — без
-- этого revoke/grant функция осталась бы доступна роли PUBLIC по умолчанию.
revoke execute on function public.challenge_enroll(bigint, uuid, text, text) from public;
revoke execute on function public.challenge_enroll(bigint, uuid, text, text) from anon;
revoke execute on function public.challenge_enroll(bigint, uuid, text, text) from authenticated;
grant  execute on function public.challenge_enroll(bigint, uuid, text, text) to service_role;

-- PostgREST держит схему в памяти: без этого вызов rpc('challenge_enroll') из
-- api/prodamus-webhook.js ответил бы «function not found» на живой оплате.
notify pgrst, 'reload schema';
