-- Потоки платного челленджа: public.challenge_seasons и public.challenge_entries.
--
-- Зачем: челлендж продаётся потоками — набрали людей, объявили дату старта,
-- прошли тридцать дней, раздали призы, открыли следующий поток. До сих пор
-- ничего этого в базе не было: цена жила в голове, номер участника — в
-- переписке, призовой фонд считался руками. Оплата приходит вебхуком Продамуса,
-- то есть машиной и без человека рядом, поэтому зачисление обязано быть
-- записью в базе, а не строкой в блокноте.
--
-- ДВЕ ТАБЛИЦЫ. Сезон — это условия набора (цена, какая доля сборов уходит в
-- фонд, как фонд делится между тройкой, в каком состоянии поток). Запись — факт
-- участия конкретного человека с его номером и платежом. Условия сезона
-- меняются до старта и одинаковы для всех, участие у каждого своё; свести их в
-- одну таблицу значило бы повторять цену в каждой строке и потерять
-- возможность объявить дату старта уже после начала набора.
--
-- ПОЧЕМУ ДЕНЬГИ ЛЕЖАТ В СЕЗОНЕ, А НЕ В КОДЕ. price_rub, prize_pct и
-- prize_split — это обещание, данное участникам ИМЕННО ЭТОГО потока. Держи их
-- константами в приложении — и к раздаче призов третьего потока никто уже не
-- докажет, на каких условиях покупали первый. Здесь они зафиксированы рядом с
-- записями, которых касаются.
--
-- 152-ФЗ: user_id есть в challenge_entries, значит это данные пользователя.
-- Таблицу нужно добавить в USER_TABLES (api/_userTables.js) вместе с ручками
-- следующего этапа — тогда удаление и выгрузка аккаунта подхватят её сами.
-- Внешние ключи объявлены без ON DELETE (NO ACTION), как у соседей:
-- auth.admin.deleteUser() откажется удалять аккаунт, пока тут остаются строки,
-- а delete-account.js чистит USER_TABLES раньше profiles и раньше самого
-- auth-пользователя. ВНИМАНИЕ на следующий этап: удаление оплаченной записи —
-- это стирание следа платежа, и решать, сносить её или отвязывать, нужно
-- отдельно, а не тем же махом, что дневник питания.

-- ── Сезоны: условия набора ──────────────────────────────────────────────────
create table if not exists public.challenge_seasons (
  id          bigint generated always as identity primary key,
  title       text not null,
  -- NULL — «дата ещё не объявлена». Набор начинается раньше, чем известен день
  -- старта, и это нормальное состояние потока, а не незаполненное поле.
  starts_on   date,
  price_rub   integer not null default 2990,
  -- Доля сборов, уходящая в призовой фонд, в процентах.
  prize_pct   integer not null default 50,
  -- Делёж фонда между первым, вторым и третьим местом, в процентах от фонда.
  -- Массив, а не три колонки: тройка призёров — сегодняшнее правило, а не закон
  -- природы, и поток с пятёркой мест не должен требовать миграции схемы.
  prize_split integer[] not null default '{50,30,20}',
  -- draft    — сезон виден только серверу, набор не открыт;
  -- open     — идёт продажа;
  -- running  — поток стартовал;
  -- finished — призы розданы.
  status      text not null default 'draft'
              check (status in ('draft', 'open', 'running', 'finished')),
  created_at  timestamptz not null default now()
);

comment on table public.challenge_seasons is
  'Потоки платного челленджа: цена, доля сборов в призовой фонд и его делёж между топ-3. Записи — только service_role; см. sql/2026-08-24_challenge_seasons.sql';

-- ── Записи: кто в потоке и под каким номером ────────────────────────────────
create table if not exists public.challenge_entries (
  id             bigint generated always as identity primary key,
  season_id      bigint not null references public.challenge_seasons (id),
  user_id        uuid   not null references auth.users (id),
  -- Номер участника ВНУТРИ потока, начиная с 1. Он попадает людям на глаза
  -- («участник №7»), поэтому выдаётся подряд и без дыр — этим занимается
  -- challenge_enroll ниже, руками его ставить нельзя.
  participant_no integer not null,
  -- id платежа Продамуса. Он же ключ идемпотентности: вебхук приходит повторно
  -- при любой заминке на их стороне.
  payment_id     text,
  paid_at        timestamptz,
  created_at     timestamptz not null default now(),
  -- Один человек — одна запись в потоке. Второй раз купить тот же поток нельзя.
  constraint challenge_entries_season_user unique (season_id, user_id),
  -- Номер в потоке не повторяется. Это последний рубеж под блокировкой в
  -- challenge_enroll: если она однажды окажется снята, две параллельные покупки
  -- получат ошибку, а не общий номер.
  constraint challenge_entries_season_no unique (season_id, participant_no),
  -- Один платёж — одна запись. Повторный вебхук с тем же payment_id упрётся
  -- сюда, даже если проверку внутри функции когда-нибудь обойдут.
  constraint challenge_entries_season_payment unique (season_id, payment_id)
);

comment on table public.challenge_entries is
  'Участники потока челленджа: номер внутри потока и платёж Продамуса. Зачисление — только через challenge_enroll(); см. sql/2026-08-24_challenge_seasons.sql';

-- «Что купил этот человек» — вопрос личного кабинета, и уникальность
-- (season_id, user_id) на него не отвечает: там user_id вторым полем.
create index if not exists challenge_entries_user_idx
  on public.challenge_entries (user_id);

alter table public.challenge_seasons enable row level security;
alter table public.challenge_entries enable row level security;

-- Гранты выдаём явно, не наследуя старое «GRANT ALL ON ALL TABLES IN SCHEMA
-- public»: без revoke от клиентских ключей таблицу закрывала бы одна лишь RLS.
-- Клиенту оставлено только чтение — вся запись идёт через service_role и
-- challenge_enroll, потому что зачисление это деньги, а не пользовательский ввод.
revoke all on table public.challenge_seasons from anon, authenticated;
revoke all on table public.challenge_entries from anon, authenticated;
grant select on table public.challenge_seasons to authenticated;
grant select on table public.challenge_entries to authenticated;
grant all on table public.challenge_seasons to service_role;
grant all on table public.challenge_entries to service_role;

-- Черновик не показывается никому: в нём обкатываются цена и условия, и увидеть
-- их раньше объявления значит увидеть не то, что в итоге объявят.
drop policy if exists challenge_seasons_read on public.challenge_seasons;
create policy challenge_seasons_read on public.challenge_seasons
  for select to authenticated
  using (status <> 'draft');

-- Свою запись человек видит, чужие — нет. Номер участника вместе с фактом
-- оплаты — это чужая покупка, и списка «кто сколько занёс» в приложении быть не
-- должно.
drop policy if exists challenge_entries_own on public.challenge_entries;
create policy challenge_entries_own on public.challenge_entries
  for select to authenticated
  using (auth.uid() = user_id);

-- ── Зачисление ──────────────────────────────────────────────────────────────
-- Возвращает номер участника в потоке — новый или уже выданный раньше.
--
-- ДВЕ ВЕЩИ, РАДИ КОТОРЫХ ЭТО ФУНКЦИЯ, А НЕ INSERT ИЗ ПРИЛОЖЕНИЯ.
--
-- 1. Номер. «Взять max+1» из приложения — это гонка в чистом виде: два платежа,
--    пришедшие в одну секунду, прочитают одинаковый max и оба захотят номер 8.
--    Блокировка строки сезона (select ... for update) выстраивает покупки
--    одного потока в очередь: вторая ждёт, пока первая не запишется, и видит
--    уже новый максимум. Блокируется именно сезон, а не таблица целиком —
--    разные потоки друг другу не мешают.
--
-- 2. Идемпотентность. Вебхук Продамуса стучится повторно, пока не получит
--    внятного ответа, и «повторно» здесь означает в том числе «одновременно».
--    Поэтому проверка «уже зачислен?» стоит ПОСЛЕ взятия блокировки: до неё оба
--    вызова увидели бы пустоту и пошли бы вставлять. Совпадение ищем сперва по
--    платежу, потом по человеку — второе ловит случай, когда та же оплата
--    приехала под новым идентификатором.
--
-- SECURITY DEFINER — таблицы закрыты RLS и грантами, функция работает от
-- владельца (postgres, у него BYPASSRLS). set search_path обязателен: без него
-- вызывающий подставит свою схему впереди public и подменит таблицу, в которую
-- мы пишем.
create or replace function public.challenge_enroll(
  p_season_id  bigint,
  p_user_id    uuid,
  p_payment_id text default null
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

  insert into public.challenge_entries (season_id, user_id, participant_no, payment_id, paid_at)
  values (p_season_id, p_user_id, v_no, p_payment_id,
          case when p_payment_id is not null then now() end);

  return v_no;
end $function$;

comment on function public.challenge_enroll(bigint, uuid, text) is
  'Зачисляет человека в поток и выдаёт следующий номер участника под блокировкой сезона. Идемпотентна по payment_id и по user_id: повторный вебхук возвращает уже выданный номер.';

-- Функция берёт user_id ИЗ ПАРАМЕТРА, то есть кто может её вызвать — тот может
-- зачислить в платный поток кого угодно бесплатно. CREATE FUNCTION по умолчанию
-- выдаёт EXECUTE роли PUBLIC, поэтому revoke ниже обязателен, а не
-- перестраховка: вызывать вправе только серверный код в api/.
revoke execute on function public.challenge_enroll(bigint, uuid, text) from public;
revoke execute on function public.challenge_enroll(bigint, uuid, text) from anon;
revoke execute on function public.challenge_enroll(bigint, uuid, text) from authenticated;
grant  execute on function public.challenge_enroll(bigint, uuid, text) to service_role;

-- ── Сид: первый поток ───────────────────────────────────────────────────────
-- Заводится черновиком и без даты: условия ещё обсуждаются, а дата старта
-- объявляется по итогам набора. Вставка через where not exists, чтобы повторный
-- прогон файла не наплодил вторых «Потоков 1».
insert into public.challenge_seasons (title, status, starts_on)
select 'Поток 1', 'draft', null
 where not exists (
   select 1 from public.challenge_seasons where title = 'Поток 1'
 );
