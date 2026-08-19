/**
 * Ставит git-хуки проекта из .githooks — сам, после npm install (prepare).
 *
 * Хуки не ездят в клоне: .git/hooks остаётся местным. Хук pre-push, который
 * держит обязательный прогон в WebKit, при таком порядке терялся бы у каждого
 * нового клона и на каждой чужой машине — то есть ровно там, где он и нужен.
 * core.hooksPath переводит git на папку в самом репозитории, и хук уезжает
 * вместе с кодом.
 *
 * Молча выходит там, где ставить нечего или некуда: установка зависимостей не
 * должна падать из-за хуков (архив без .git, CI, установка пакетом).
 */
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'

if (!existsSync('.git') || !existsSync('.githooks')) process.exit(0)

try {
  execFileSync('git', ['config', 'core.hooksPath', '.githooks'], { stdio: 'ignore' })
  console.log('git-хуки: .githooks (pre-push гоняет WebKit)')
} catch {
  // git недоступен — не повод валить npm install
}
