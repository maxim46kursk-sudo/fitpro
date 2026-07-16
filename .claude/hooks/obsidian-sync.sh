#!/bin/bash
# PostToolUse-хук (Bash) — после git commit/push зеркалит git-отслеживаемые
# файлы в Obsidian vault и добавляет механическую строку в лог коммитов.
# Не трогает "Журнал изменений.md" — там ручные заметки с объяснением "почему",
# это остаётся зоной автора заметок, не автоматики (см. FitPro.md в vault).
set -e

INPUT=$(cat)
# jq не гарантирован в окружении — парсим через node (уже есть в проекте).
CMD=$(printf '%s' "$INPUT" | node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{try{const j=JSON.parse(d);process.stdout.write(j.tool_input&&j.tool_input.command||'')}catch(e){}})")

case "$CMD" in
  *"git commit"*|*"git push"*) ;;
  *) exit 0 ;;
esac

REPO="c:/Users/maxim/Desktop/fitpro"
VAULT_FITPRO="D:/обсидиан/максим/FitPro"
DEST="$VAULT_FITPRO/_src-mirror"
LOG="$VAULT_FITPRO/Коммиты (авто).md"

cd "$REPO" || exit 0

# Зеркало исходников — только то, что реально закоммичено (git ls-files
# уважает .gitignore и текущий индекс), собираем во временную папку и
# атомарно подменяем, чтобы не оставить наполовину скопированное состояние.
NEW_DEST="${DEST}.new"
rm -rf "$NEW_DEST"
mkdir -p "$NEW_DEST"
git ls-files | while IFS= read -r f; do
  mkdir -p "$NEW_DEST/$(dirname "$f")"
  cp "$f" "$NEW_DEST/$f"
done
rm -rf "$DEST"
mv "$NEW_DEST" "$DEST"

# Механическая строка в отдельный авто-лог (не путать с ручным "Журнал
# изменений.md") — хеш, дата, тема коммита, изменённые файлы.
if [ ! -f "$LOG" ]; then
  printf -- '---\ntags: [fitpro, авто]\n---\n\n# Коммиты FitPro (авто-лог)\n\n← [[FitPro]]\n\nМеханический лог от хука после каждого git commit/push — только факты (хеш, файлы). Разбор "почему" и "к чему пришли" — по-прежнему вручную в [[Журнал изменений]].\n\n' > "$LOG"
fi

HASH=$(git log -1 --format=%h 2>/dev/null || echo '?')
SUBJECT=$(git log -1 --format=%s 2>/dev/null || echo '?')
DATE=$(date '+%Y-%m-%d %H:%M')
FILES=$(git show --name-only --format='' HEAD 2>/dev/null | sed 's/^/- /')

{
  printf '\n## %s — `%s`\n\n%s\n\n%s\n' "$DATE" "$HASH" "$SUBJECT" "$FILES"
} >> "$LOG"

exit 0
