#!/usr/bin/env bash
# ДВИЖОК MOTION — ГОТОВЫМИ СЖАТЫМИ ФАЙЛАМИ, А НЕ СЖАТИЕМ НА КАЖДЫЙ ЗАПРОС.
#
# ЗАЧЕМ. Первый запуск Motion тянет модель и wasm: 17.25 МБ сырыми, 8.28 МБ на
# проводе. Caddy жал их ЗАНОВО каждому человеку — кэша сжатого у него нет.
# Замер 25 августа (qa/load.mjs, сценарий «в»): пятьдесят первых запусков разом
# уводят процессор в потолок (простой 2%), сто — держат его там девять секунд.
#
# Файлы неизменные: имя модели фиксировано, версия wasm стоит в пути, заголовок
# у них `immutable`. Жать неизменное на каждый запрос — это чистая трата.
#
# ЧТО ДЕЛАЕТ. Скачивает объекты из бакета motion-assets на диск ПО ТОМУ ЖЕ ПУТИ,
# что и в адресе, и кладёт рядом .zst и .gz. Caddy раздаёт их напрямую
# (`file_server` с `precompressed`), а чего на диске нет — как и раньше, идёт в
# Kong (`pass_thru`).
#
# ЗЕРКАЛО ЗАСЛОНЯЕТ БАКЕТ, И ЭТО НАДО ПОМНИТЬ. Если файл в бакете заменят, а
# зеркало не обновить, люди получат старый: на диске он есть, и до Kong запрос
# не дойдёт. Поэтому команда одна и лежит здесь — после любой замены файлов
# движка запусти её снова.
#
#   bash scripts/motion-assets-mirror.sh          — обновить зеркало
#   bash scripts/motion-assets-mirror.sh --check  — только показать, что лежит
set -eu

ROOT="${MOTION_MIRROR_ROOT:-/var/www/fitpro-motion}"
PATH_IN_URL="storage/v1/object/public/motion-assets"
SRC="${MOTION_MIRROR_SRC:-https://api.fitproapp.ru/$PATH_IN_URL}"

# Список — тот же, что лежит в бакете. Версия wasm повторяет
# TASKS_VISION_VERSION из src/motion/pose/assets.js: поменяется там — поменять
# и здесь, иначе зеркало будет отдавать прошлую версию мимо бакета.
WASM_VER="${MOTION_WASM_VERSION:-0.10.35}"
FILES=(
  "models/pose_landmarker_lite.task"
  "tasks-vision/$WASM_VER/wasm/vision_wasm_internal.js"
  "tasks-vision/$WASM_VER/wasm/vision_wasm_internal.wasm"
  "tasks-vision/$WASM_VER/wasm/vision_wasm_module_internal.js"
  "tasks-vision/$WASM_VER/wasm/vision_wasm_module_internal.wasm"
  "tasks-vision/$WASM_VER/wasm/vision_wasm_nosimd_internal.js"
  "tasks-vision/$WASM_VER/wasm/vision_wasm_nosimd_internal.wasm"
)

if [ "${1:-}" = "--check" ]; then
  find "$ROOT/$PATH_IN_URL" -type f -printf '%10s  %p\n' 2>/dev/null | sort -k2 || echo "зеркала нет"
  exit 0
fi

for f in "${FILES[@]}"; do
  dst="$ROOT/$PATH_IN_URL/$f"
  mkdir -p "$(dirname "$dst")"
  # Скачиваем СЫРЫМ: identity, иначе на диск ляжет уже сжатое, и Caddy стал бы
  # жать сжатое повторно.
  code=$(curl -sS -H 'Accept-Encoding: identity' -o "$dst.новый" -w '%{http_code}' "$SRC/$f")
  if [ "$code" != "200" ]; then
    echo "!! $f — источник ответил $code, оставляю прежний файл"
    rm -f "$dst.новый"
    continue
  fi
  mv "$dst.новый" "$dst"
  # -19 один раз вместо третьего уровня пятьдесят раз в секунду: платим
  # минутой сборки, получаем файл меньше и процессор свободным навсегда.
  zstd -19 -q -f -o "$dst.zst" "$dst"
  gzip -9 -c "$dst" > "$dst.gz"
  printf '%-52s %8s -> zst %8s / gz %8s\n' "$f" \
    "$(stat -c%s "$dst")" "$(stat -c%s "$dst.zst")" "$(stat -c%s "$dst.gz")"
done

# Читать их будет Caddy — он ходит не под root.
chmod -R a+rX "$ROOT"
echo "зеркало готово: $ROOT/$PATH_IN_URL"
