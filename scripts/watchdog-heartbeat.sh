#!/usr/bin/env bash
# СТОРОЖ ЗА СТОРОЖЕМ: не замолчал ли монитор в GitHub Actions.
#
# ЗАЧЕМ. Расписание GitHub — обещание, а не гарантия. Заявлено «каждые десять
# минут», по факту прогоны идут через двадцать и тридцать, а под нагрузкой
# выбрасываются совсем; бывает и так, что Actions перестают запускаться вовсе.
# Сторож, который тихо перестал ходить, неотличим от сторожа, у которого всё
# хорошо, — и это худший из отказов наблюдения: тишина читается как «норма».
#
# КАК. Репозиторий публичный, поэтому список прогонов отдаётся БЕЗ токена.
# Спрашиваем время последнего и, если оно старше порога, пишем в Telegram.
#
# ЧЕГО ЭТОТ СКРИПТ НЕ ЛОВИТ. Он живёт на том же сервере, за которым следит
# монитор: упади сервер целиком — молчать будут оба. Он закрывает ровно одну
# дыру — «монитор перестал ходить», — и не заменяет внешнюю проверку.
#
# Ставится в cron раз в десять минут (см. хвост файла).
set -u

REPO="${WATCHDOG_REPO:-maxim46kursk-sudo/fitpro}"
FLOW="${WATCHDOG_WORKFLOW:-fitpro-monitor.yml}"
# ПОРОГ — ПОЛТОРА ЧАСА, И ЭТО НЕ ЗАПАС «НА ВСЯКИЙ СЛУЧАЙ».
#
# Сорок пять минут оказались внутри обычного разброса GitHub: по журналу
# промежутки в 44 минуты приходят при полностью живом мониторе, и первая же
# настоящая тревога («порог 45») была ложной — расписание просто сдвинулось.
# Ложная тревога дороже пропущенной: сторож, которому не верят, не работает
# вовсе. Полтора часа — это девять подряд пропущенных прогонов из обещанных
# каждые десять минут; столько подряд расписание не теряет, а падение Actions
# держится дольше.
STALE_MIN="${WATCHDOG_STALE_MIN:-90}"
# ПРОВЕРОЧНЫЙ ЗАПУСК НЕ ТРЕВОЖИТ КАНАЛ. Тревога с заниженным порогом, посланная
# «на пробу», в канале неотличима от настоящей — один раз так и вышло, владелец
# получил «порог 1» и пошёл проверять живой монитор. Считаем и печатаем, а в
# Telegram не пишем.
DRY="${WATCHDOG_DRY:-}"
# Не чаще раза в час: молчащий монитор — состояние, а не событие.
QUIET_FILE="${WATCHDOG_QUIET_FILE:-/tmp/fitpro-watchdog-alerted}"
QUIET_MIN="${WATCHDOG_QUIET_MIN:-60}"

ENV_FILE="${WATCHDOG_ENV:-/root/fitpro-app/.env}"
[ -f "$ENV_FILE" ] || ENV_FILE="/root/fitpro-app/.env.local"

need() {
  local key="$1"
  local val="${!key:-}"
  [ -n "$val" ] && { printf '%s' "$val"; return 0; }
  [ -f "$ENV_FILE" ] || return 1
  sed -n "s/^${key}=//p" "$ENV_FILE" | head -1 | tr -d '"'\''' | tr -d '\r'
}

# Канал тревог у сервера уже есть — TG_ALERT_TOKEN/TG_ALERT_CHAT, тот самый,
# которым он сообщает о сбоях. Заводить второй значило бы завести второе место,
# где эти тревоги могут потеряться.
TOKEN="$(need TG_ALERT_TOKEN)"; [ -n "$TOKEN" ] || TOKEN="$(need TELEGRAM_BOT_TOKEN)"
CHAT="$(need TG_ALERT_CHAT)";   [ -n "$CHAT" ]  || CHAT="$(need WATCHDOG_CHAT_ID)"
[ -n "$TOKEN" ] || { echo "watchdog: нет токена Telegram — молчу"; exit 0; }
[ -n "$CHAT" ]  || { echo "watchdog: нет chat_id — молчу"; exit 0; }

API="https://api.github.com/repos/${REPO}/actions/workflows/${FLOW}/runs?per_page=1"
json="$(curl -sS -m 20 -H 'Accept: application/vnd.github+json' "$API" 2>/dev/null)" || {
  # До GitHub не достучались — это не повод кричать про монитор: скорее всего
  # у нас самих отвалилась сеть, и об этом скажут другие каналы.
  echo "watchdog: GitHub не ответил, пропускаю"
  exit 0
}

last="$(printf '%s' "$json" | jq -r '.workflow_runs[0].created_at // empty')"
[ -n "$last" ] || { echo "watchdog: в ответе нет прогонов, пропускаю"; exit 0; }

age_min=$(( ( $(date -u +%s) - $(date -u -d "$last" +%s) ) / 60 ))

if [ "$age_min" -lt "$STALE_MIN" ]; then
  echo "watchdog: монитор ходил $age_min мин назад — норма"
  exit 0
fi

# Не шуметь чаще, чем раз в QUIET_MIN.
if [ -f "$QUIET_FILE" ]; then
  since=$(( ( $(date -u +%s) - $(date -u -r "$QUIET_FILE" +%s) ) / 60 ))
  [ "$since" -lt "$QUIET_MIN" ] && { echo "watchdog: уже кричал $since мин назад"; exit 0; }
fi

text="🟡 Сторож FitPro замолчал: последний прогон монитора был $age_min мин назад (порог $STALE_MIN).
Проверь https://github.com/${REPO}/actions/workflows/${FLOW}
Пока он молчит, падение сайта никто не заметит, кроме людей."

if [ -n "$DRY" ]; then
  echo "watchdog: ПРОВЕРКА, в канал не пишу. Отправил бы:"
  echo "$text"
  exit 0
fi

curl -s -m 20 -X POST "https://api.telegram.org/bot${TOKEN}/sendMessage" \
  -d chat_id="$CHAT" --data-urlencode text="$text" >/dev/null && touch "$QUIET_FILE"
echo "watchdog: тревога отправлена, монитор молчит $age_min мин"

# ── Установка ────────────────────────────────────────────────────────────────
#   scp scripts/watchdog-heartbeat.sh fitpro:/root/fitpro/watchdog-heartbeat.sh
#   ssh fitpro 'chmod +x /root/fitpro/watchdog-heartbeat.sh'
#   (TG_ALERT_TOKEN и TG_ALERT_CHAT в /root/fitpro-app/.env уже есть)
#   в crontab:
#     */10 * * * * /root/fitpro/watchdog-heartbeat.sh >> /root/fitpro/watchdog.log 2>&1
#
#   Проверить, не тревожа канал:
#     WATCHDOG_DRY=1 WATCHDOG_STALE_MIN=1 /root/fitpro/watchdog-heartbeat.sh
