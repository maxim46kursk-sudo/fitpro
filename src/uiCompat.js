// Совместимость UI с реальным мобильным окружением: тач-хит-тест и
// Telegram WebView. Оба сюда попавших приёма чинят баги, которые НЕ ловятся
// ни jsdom-тестами, ни проверкой мышью в десктопном браузере — только живым
// тапом на телефоне.

import { useEffect, useRef } from 'react'

// ─────────────────────────────────────────────────────────────────────────
// 1. Закрытие выпадающего меню тапом мимо — без прозрачной плёнки
// ─────────────────────────────────────────────────────────────────────────
// Раньше каждое меню рисовало под собой прозрачный оверлей на весь экран
// (<div style={{position:'fixed',inset:0,zIndex:19}} />), который ловил клик
// «мимо» и закрывал меню. На десктопе это работало, на телефоне — нет: у
// меню, которое лежит в position:fixed-портале внутри скролл-контейнера,
// компоситорный hit-test для касания расходится с порядком отрисовки, и тап
// ПО ПУНКТУ МЕНЮ попадал в оверлей, а не в кнопку. Видимый результат: меню
// закрывается, действие не выполняется — то есть «меню не нажимается».
// Поднятие z-index не помогает: расходится не порядок слоёв, а сам hit-test.
//
// Поэтому плёнки больше нет вообще, а «тап мимо» ловится слушателем на
// document. Ключевое условие — ref должен указывать на обёртку, внутри
// которой лежат И кнопка-триггер, И само меню: тогда тап по триггеру
// считается «своим», хук молчит, и меню закрывает собственный onClick
// кнопки (иначе они дрались бы — закрыли по pointerdown, открыли по click).
//
// pointerdown, а не click: он приходит раньше, до возможной прокрутки и до
// click, и одинаково работает для мыши, пальца и стилуса. Фаза захвата — так
// закрытие нельзя случайно отменить чьим-то stopPropagation по пути; тапы
// внутри меню это не задевает, они отсекаются по contains().
//
// onClose === null|undefined означает «меню закрыто» — слушатель в этом
// случае не вешается вовсе (подписка живёт ровно столько, сколько открыто
// меню). Сама функция при этом может пересоздаваться на каждом рендере:
// она держится в ref, поэтому переподписки от этого не происходит.
export function useCloseOnOutsideTap(ref, onClose) {
  const active = typeof onClose === 'function'
  const cbRef = useRef(onClose)
  useEffect(() => { cbRef.current = onClose })
  useEffect(() => {
    if (!active) return
    const handler = e => {
      const node = ref.current
      // Узла нет — меню уже размонтировано, закрывать нечего.
      if (!node) return
      if (!node.contains(e.target)) cbRef.current?.()
    }
    document.addEventListener('pointerdown', handler, true)
    return () => document.removeEventListener('pointerdown', handler, true)
  }, [active, ref])
}

// ─────────────────────────────────────────────────────────────────────────
// 2. Подтверждение действия — window.confirm не работает в Telegram
// ─────────────────────────────────────────────────────────────────────────
// Внутри Telegram WebView window.confirm заблокирован: он не показывает
// диалог и возвращает false (в части клиентов — молча). Для приложения это
// значит, что каждое «Удалить…?» внутри Telegram просто ничего не делало —
// пользователь жмёт «Удалить», не происходит ничего, и понять почему нельзя.
//
// Telegram даёт свою замену — WebApp.showConfirm(message, callback). Она
// асинхронная, поэтому и обёртка асинхронная: вызывающий код обязан
// дождаться ответа (await askConfirm(...)), логика после подтверждения при
// этом не меняется.
//
// Вне Telegram (обычный браузер, Playwright, десктоп) остаётся привычный
// window.confirm — поведение там ровно прежнее.
export function askConfirm(message) {
  const tg = typeof window !== 'undefined' ? window.Telegram?.WebApp : null
  if (tg && typeof tg.showConfirm === 'function') {
    return new Promise(resolve => {
      let settled = false
      const done = value => { if (!settled) { settled = true; resolve(Boolean(value)) } }
      try {
        // Второй аргумент showConfirm — колбэк с булевым ответом. Часть
        // клиентов зовёт его без аргумента при закрытии окна — это «нет».
        tg.showConfirm(String(message), ok => done(ok))
      } catch (e) {
        // Метод объявлен, но не поддержан версией клиента (Telegram кидает
        // WebAppMethodUnsupported) — падать нельзя, спрашиваем как умеем.
        console.warn('Telegram showConfirm недоступен, откат на window.confirm:', e)
        done(nativeConfirm(message))
      }
    })
  }
  return Promise.resolve(nativeConfirm(message))
}

function nativeConfirm(message) {
  if (typeof window === 'undefined' || typeof window.confirm !== 'function') return false
  return Boolean(window.confirm(message))
}
