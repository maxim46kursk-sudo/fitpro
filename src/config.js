// Общие константы, которые должны совпадать в нескольких местах приложения —
// один источник правды вместо копирования строк по файлам.

// Telegram тренера Максима — тот же контакт для кнопки "Написать Максиму"
// (AIAssistant.jsx, маркер [CONTACT_MAX]), "Написать тренеру" в Настройках
// (App.jsx, SettingsView) и в модалке завершения программы.
export const MAX_TELEGRAM_URL = 'https://t.me/maxim_athlete'

// Бот, в котором живёт Mini App. Из него собирается ссылка-приглашение
// тренера: https://t.me/<BOT_USERNAME>?startapp=coach_<id тренера>. Параметр
// startapp прилетает в приложение как start_param (см. App.jsx,
// pendingInviteRef) и превращается в привязку через api/link-client.js.
export const BOT_USERNAME = 'fitpro_coach_bot'
