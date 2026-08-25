-- МАЯЧКИ НЕВЗЛЕТЕВШЕЙ ЗАГРУЗКИ: public.boot_beacons.
--
-- ЗАЧЕМ. Белый экран воспроизводится редко и не у нас. Человек его видит,
-- закрывает вкладку — и не остаётся НИЧЕГО: ни ошибки, ни строчки в журнале.
-- Приложение при этом не запускается вовсе, значит рассказать о падении оно
-- может только тем, что живёт ДО бандла — кодом в самом index.html.
--
-- ЧТО ЗДЕСЬ ЛЕЖИТ И ЧЕГО НЕТ. Стадия, на которой встали, сколько прошло
-- миллисекунд, тип соединения, User-Agent и список НЕДОГРУЖЕННЫХ файлов. Ни
-- личности, ни адреса: маячок шлёт человек, которого мы не знаем (приложение не
-- поднялось, войти он не успел), и знать не должны. IP не пишем сознательно —
-- по нему считается только лимит запросов, и он остаётся в памяти процесса.
--
-- ПОЧЕМУ ОТДЕЛЬНАЯ ТАБЛИЦА, А НЕ error_log. error_log — это ошибки РАБОТАЮЩЕГО
-- приложения, у них есть user_id и контекст. Здесь всё наоборот: приложения нет,
-- человека нет, а поля — про сеть и устройство. Свалить их в одну таблицу
-- значило бы сделать оба журнала нечитаемыми.

create table if not exists public.boot_beacons (
  id         bigint generated always as identity primary key,
  created_at timestamptz not null default now(),
  -- До какой стадии дошла загрузка: 'html' | 'bundle' | 'react' | 'data'.
  -- 'react' и 'data' сюда не попадают по построению — маячок шлётся, только
  -- если до 'react' не дошло, — но колонка их допускает: пусть данные говорят
  -- сами за себя, а не через наше знание о том, кто их пишет.
  stage      text not null,
  -- Сколько миллисекунд прошло от начала разбора страницы до маячка.
  ms         integer not null default 0,
  -- Какой это по счёту маячок этого захода: первый (8 с) или второй (20 с).
  attempt    smallint not null default 1,
  -- Тип соединения по navigator.connection: '4g', '3g', 'slow-2g'…
  conn       text,
  ua         text,
  -- Файлы, которые к этому моменту не догрузились: [{name, ms}].
  pending    jsonb not null default '[]'::jsonb
);

comment on table public.boot_beacons is
  'Маячки невзлетевшей загрузки: приложение не дошло до монтирования за 8 секунд. Пишет код из index.html через sendBeacon, до всякого бандла. Личности и адреса не хранит; см. sql/2026-08-25_boot_beacons.sql';

-- Все запросы к таблице — «сколько за последний час/сутки»: индекс ровно под них.
create index if not exists boot_beacons_created_idx
  on public.boot_beacons (created_at desc);

alter table public.boot_beacons enable row level security;

-- Ни anon, ни authenticated: пишет СЕРВЕРНАЯ ветка (api/set-exercise.js,
-- action=boot) своим service-role-ключом, читает та же сводка наблюдателя.
-- Публичная запись прямо из браузера означала бы открытую свалку, которую любой
-- может залить чем угодно.
revoke all on table public.boot_beacons from anon, authenticated;
grant all on table public.boot_beacons to service_role;

-- Политик для клиентских ролей НЕТ намеренно: без грантов и без политик таблица
-- для них не существует вовсе.

/**
 * УБОРКА. Маячки — оперативный сигнал, а не история: смотрят их за час и за
 * сутки, старше недели они не нужны никому. Чистится тем же движением, что и
 * пишется: перед вставкой ветка зовёт эту функцию раз в сутки.
 *
 * SECURITY DEFINER + отобранные права: чистка доступна только service_role.
 */
create or replace function public.boot_beacons_sweep()
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare
  v_gone integer;
begin
  delete from public.boot_beacons where created_at < now() - interval '7 days';
  get diagnostics v_gone = row_count;
  return v_gone;
end $function$;

revoke execute on function public.boot_beacons_sweep() from public;
revoke execute on function public.boot_beacons_sweep() from anon;
revoke execute on function public.boot_beacons_sweep() from authenticated;
grant  execute on function public.boot_beacons_sweep() to service_role;

notify pgrst, 'reload schema';

select count(*) as маячков from public.boot_beacons;
