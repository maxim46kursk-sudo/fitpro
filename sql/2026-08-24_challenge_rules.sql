-- Согласие с правилами челленджа: public.challenge_rules_consent и
-- challenge_entries.rules_accepted_at.
-- Дополняет sql/2026-08-24_challenge_seasons.sql и _entries_fix.sql.
--
-- ЗАЧЕМ ЭТО НА СЕРВЕРЕ, А НЕ В БРАУЗЕРЕ. Спор о призах упирается ровно в одну
-- фразу — «я не знал правил», — и ответ на неё обязан лежать там, куда участник
-- не дотянется. Галочка в localStorage отвечает на неё ровно до первой очистки
-- кэша и ровно на одном телефоне; человек, прочитавший правила на телефоне и
-- открывший челлендж с компьютера, увидел бы их снова и справедливо решил, что
-- его согласия никто не сохранил.
--
-- ПОЧЕМУ ОТДЕЛЬНАЯ ТАБЛИЦА, А НЕ СТОЛБЕЦ В profiles: согласие даётся КОНКРЕТНОМУ
-- ПОТОКУ (у следующего свои правила, своя цена и свой призовой фонд) и ДО того,
-- как появляется строка участника, — то есть ни в challenge_entries, ни в
-- profiles ему места нет.
--
-- 152-ФЗ: user_id тут есть, значит это данные пользователя. В USER_TABLES
-- (api/_userTables.js) таблица НЕ добавляется — по той же причине, что и
-- challenge_entries: это документ в споре о деньгах, и стирать его вместе с
-- аккаунтом нельзя. Внешний ключ объявлен с ON DELETE SET NULL: ушедший
-- отвязывается, а факт согласия и его время остаются.

create table if not exists public.challenge_rules_consent (
  id          bigint generated always as identity primary key,
  season_id   bigint not null references public.challenge_seasons (id),
  user_id     uuid references auth.users (id) on delete set null,
  accepted_at timestamptz not null default now(),
  -- Согласие даётся один раз на поток. Повторное открытие правил (а их можно
  -- перечитывать свободно) ничего не переписывает: важна ПЕРВАЯ дата — та, что
  -- была до покупки.
  constraint challenge_rules_consent_season_user unique (season_id, user_id)
);

comment on table public.challenge_rules_consent is
  'Согласие с правилами потока, данное ДО покупки билета. Ответ на «я не знал правил» в споре о призах; см. sql/2026-08-24_challenge_rules.sql';

create index if not exists challenge_rules_consent_user_idx
  on public.challenge_rules_consent (user_id);

alter table public.challenge_rules_consent enable row level security;

-- Гранты явные, как у соседей: наследовать старое «GRANT ALL ON ALL TABLES»
-- здесь нечего.
revoke all on table public.challenge_rules_consent from anon, authenticated;
grant select, insert on table public.challenge_rules_consent to authenticated;
grant all on table public.challenge_rules_consent to service_role;

-- Своё согласие человек ВИДИТ и СТАВИТ сам — это его собственное заявление, и
-- гонять его через серверную ручку значило бы городить посредника ради записи
-- «я прочитал».
drop policy if exists challenge_rules_consent_read_own on public.challenge_rules_consent;
create policy challenge_rules_consent_read_own on public.challenge_rules_consent
  for select to authenticated
  using (auth.uid() = user_id);

drop policy if exists challenge_rules_consent_write_own on public.challenge_rules_consent;
create policy challenge_rules_consent_write_own on public.challenge_rules_consent
  for insert to authenticated
  with check (auth.uid() = user_id);

-- ПОЛИТИК НА UPDATE И DELETE НЕТ, И ЭТО ГЛАВНОЕ В ЭТОМ ФАЙЛЕ. Данное согласие
-- нельзя ни переписать задним числом, ни убрать: иначе участник, проигравший
-- спор, просто удалял бы строку и возвращался к «я не знал правил». Ставится
-- один раз и живёт. Исправить может только service_role — то есть человек с
-- ключом, руками и с записью в журнале.

-- ── Согласие в самой записи участника ───────────────────────────────────────
-- Дублируется в challenge_entries намеренно: строка участника — это документ, по
-- которому судят приз, и он должен отвечать на вопрос «согласился ли» сам, без
-- соединения с другой таблицей и без риска, что та когда-нибудь разъедется.
alter table public.challenge_entries
  add column if not exists rules_accepted_at timestamptz;

comment on column public.challenge_entries.rules_accepted_at is
  'Когда участник согласился с правилами потока. Переносится из challenge_rules_consent в момент зачисления; NULL — согласия на тот момент не было.';

-- Перенос в уже существующие записи (сейчас их нет, но файл обязан быть
-- применим и позже).
update public.challenge_entries e
   set rules_accepted_at = c.accepted_at
  from public.challenge_rules_consent c
 where c.season_id = e.season_id
   and c.user_id = e.user_id
   and e.rules_accepted_at is null;

-- ── Зачисление проставляет согласие ─────────────────────────────────────────
-- Всё остальное без изменений: та же блокировка сезона, та же идемпотентность
-- по платежу и по человеку (разбор причин — в sql/2026-08-24_challenge_seasons.sql).
-- Согласие берётся из consent, а НЕ приходит параметром: параметру пришлось бы
-- верить, а здесь верить нельзя — это и есть предмет будущего спора.
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
  v_season   bigint;
  v_no       integer;
  v_accepted timestamptz;
begin
  if p_user_id is null then
    raise exception 'challenge_enroll: не указан пользователь'
      using errcode = 'null_value_not_allowed';
  end if;

  select id into v_season
    from public.challenge_seasons
   where id = p_season_id
   for update;

  if v_season is null then
    raise exception 'challenge_enroll: сезон % не найден', p_season_id
      using errcode = 'no_data_found';
  end if;

  if p_payment_id is not null then
    select participant_no into v_no
      from public.challenge_entries
     where season_id = p_season_id and payment_id = p_payment_id;

    if v_no is not null then
      return v_no;
    end if;
  end if;

  select participant_no into v_no
    from public.challenge_entries
   where season_id = p_season_id and user_id = p_user_id;

  if v_no is not null then
    return v_no;
  end if;

  select coalesce(max(participant_no), 0) + 1 into v_no
    from public.challenge_entries
   where season_id = p_season_id;

  -- Согласия может не быть вовсе: оплату могли провести мимо приложения. Тогда
  -- NULL — и это честный ответ «согласия на момент зачисления не было», а не
  -- повод отказать в зачислении уже оплаченного билета.
  select accepted_at into v_accepted
    from public.challenge_rules_consent
   where season_id = p_season_id and user_id = p_user_id;

  insert into public.challenge_entries
    (season_id, user_id, participant_no, payment_id, paid_at, display_name, rules_accepted_at)
  values (p_season_id, p_user_id, v_no, p_payment_id,
          case when p_payment_id is not null then now() end,
          coalesce(nullif(btrim(p_display_name), ''), 'Участник ' || v_no),
          v_accepted);

  return v_no;
end $function$;

comment on function public.challenge_enroll(bigint, uuid, text, text) is
  'Зачисляет человека в поток, выдаёт следующий номер участника под блокировкой сезона, снимает имя на момент покупки и переносит согласие с правилами. Идемпотентна по payment_id и по user_id.';

-- CREATE OR REPLACE гранты сохраняет, но повторяем их явно: файл должен быть
-- применим и на базе, где функции ещё нет.
revoke execute on function public.challenge_enroll(bigint, uuid, text, text) from public;
revoke execute on function public.challenge_enroll(bigint, uuid, text, text) from anon;
revoke execute on function public.challenge_enroll(bigint, uuid, text, text) from authenticated;
grant  execute on function public.challenge_enroll(bigint, uuid, text, text) to service_role;

notify pgrst, 'reload schema';
