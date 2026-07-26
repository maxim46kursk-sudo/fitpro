-- Защита от перебора паролей через Auth Hook «password verification attempt».
--
-- Хук вызывает сам GoTrue внутри базы при КАЖДОЙ проверке пароля — в том числе
-- при запросах к /auth/v1/token напрямую, в обход нашего фронта. Поэтому лимит
-- нельзя обойти, просто перестав пользоваться приложением (в отличие от
-- лимитера в api/_ratelimit.js, который живёт в памяти инстанса Vercel).
--
-- Правило: 5 неудачных попыток на аккаунт за 15 минут. Дальше до конца окна
-- отказ ДАЖЕ ПРИ ВЕРНОМ ПАРОЛЕ — иначе перебор просто продолжался бы до успеха.
-- Окно фиксированное и отсчитывается от ПЕРВОЙ неудачи (first_failed_at).
--
-- Чего хук НЕ трогает (эти способы входа пароль не проверяют):
--   • вход через Telegram — magiclink/OTP, см. api/telegram-auth.js;
--   • сброс пароля по почте (resetPasswordForEmail).
--
-- Включается на стороне GoTrue переменными окружения (docker-compose, сервис auth):
--   GOTRUE_HOOK_PASSWORD_VERIFICATION_ATTEMPT_ENABLED: "true"
--   GOTRUE_HOOK_PASSWORD_VERIFICATION_ATTEMPT_URI: "pg-functions://postgres/public/hook_password_verification_attempt"
-- Откат при любых проблемах со входом: ENABLED: "false" + docker compose up -d auth.

-- ── Счётчик неудачных попыток. Одна строка на аккаунт; при успешном входе
--    строка удаляется, так что таблица хранит только «подозрительные» аккаунты.
create table if not exists public.login_attempts (
  user_id uuid primary key references auth.users(id) on delete cascade,
  failed_count int not null default 0,
  first_failed_at timestamptz,
  updated_at timestamptz not null default now()
);

-- RLS включена, политик НЕТ намеренно: читать и писать эту таблицу должна
-- только hook-функция (SECURITY DEFINER, владелец postgres). Для клиентских
-- ролей таблица закрыта полностью — иначе по ней было бы видно, какие аккаунты
-- сейчас под перебором, и сколько попыток осталось.
alter table public.login_attempts enable row level security;

revoke all on public.login_attempts from anon, authenticated;
grant all on public.login_attempts to supabase_auth_admin;

-- ── Сам хук. GoTrue передаёт event с полями user_id и valid (результат сверки
--    пароля) и ждёт обратно {'decision':'continue'} либо
--    {'decision':'reject','message':...}.
create or replace function public.hook_password_verification_attempt(event jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  uid uuid;
  is_valid boolean;
  v_failed int;
  v_first timestamptz;
  v_found boolean;
begin
  uid := (event->>'user_id')::uuid;
  is_valid := coalesce((event->>'valid')::boolean, false);

  -- Без user_id считать нечего. Пропускаем, а не отказываем: ошибка в хуке не
  -- должна превращаться в невозможность войти вообще никому.
  if uid is null then
    return jsonb_build_object('decision', 'continue');
  end if;

  -- FOR UPDATE: параллельные попытки по одному аккаунту (а перебор — это
  -- именно параллельные попытки) обязаны считаться по очереди, иначе счётчик
  -- растёт медленнее, чем идут запросы.
  select failed_count, first_failed_at into v_failed, v_first
  from public.login_attempts
  where user_id = uid
  for update;
  v_found := found;

  -- Окно истекло — начинаем счёт заново. Строку не удаляем: её тут же займёт
  -- ветка ниже, если попытка снова неудачная.
  if v_found and v_first is not null and v_first < now() - interval '15 minutes' then
    update public.login_attempts
      set failed_count = 0, first_failed_at = null, updated_at = now()
      where user_id = uid;
    v_failed := 0;
    v_first := null;
  end if;

  -- Лимит выбран — отказ до конца окна, даже если пароль верный. Счётчик здесь
  -- НЕ увеличиваем: иначе продолжающийся перебор бесконечно продлевал бы
  -- блокировку и превратился бы в способ держать чужой аккаунт закрытым.
  if v_found and v_failed >= 5 then
    return jsonb_build_object(
      'decision', 'reject',
      'message', 'Слишком много попыток входа. Попробуй снова через 15 минут.'
    );
  end if;

  -- Верный пароль в пределах лимита — счётчик сбрасываем полностью.
  if is_valid then
    delete from public.login_attempts where user_id = uid;
    return jsonb_build_object('decision', 'continue');
  end if;

  -- Неудачная попытка. first_failed_at ставим только на первой из серии
  -- (coalesce старого значения) — окно отсчитывается от неё, а не от последней
  -- попытки, иначе перебор сам себе бесконечно двигал бы конец окна.
  insert into public.login_attempts as la (user_id, failed_count, first_failed_at, updated_at)
  values (uid, 1, now(), now())
  on conflict (user_id) do update
    set failed_count = la.failed_count + 1,
        first_failed_at = coalesce(la.first_failed_at, now()),
        updated_at = now();

  -- 'continue' — отказ по неверному паролю отдаёт сам GoTrue своим обычным
  -- ответом. Наш reject нужен только для превышения лимита.
  return jsonb_build_object('decision', 'continue');
end;
$$;

-- Выполнять хук может только GoTrue. Для остальных ролей закрыто: иначе любой
-- авторизованный мог бы дёргать функцию с чужим user_id и накручивать
-- блокировку чужому аккаунту.
grant execute on function public.hook_password_verification_attempt(jsonb) to supabase_auth_admin;
revoke execute on function public.hook_password_verification_attempt(jsonb) from public, anon, authenticated;
