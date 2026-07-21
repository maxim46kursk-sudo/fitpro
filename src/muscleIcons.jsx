// muscleIcons.jsx — анатомические иконки групп мышц для FitPro (liquid glass).
// Один силуэт-манекен, подсвечивается рабочая мышца. Плюс сердце для кардио.
// Использование:
//   import { MuscleDefs, MuscleIcon } from './muscleIcons'
//   <MuscleDefs/>                        // смонтировать ОДИН раз в корне приложения
//   <MuscleIcon group="chest" size={44}/> // group: chest|back|legs|shoulders|arms|abs|cardio
//
// Соотношение viewBox 40x58 (фигура в рост). preserveAspectRatio центрирует,
// поэтому size задаёт габаритный квадрат без искажения.

import React from 'react'

const DIM = 'url(#muBody)'
const HI  = 'url(#muHi)'
const GLOW = 'drop-shadow(0 0 4px rgba(139,136,245,.95))'

// ---- базовые части тела (вид спереди) ----
const P = {
  head:     '<circle cx="20" cy="6.4" r="4.1"/>',
  neck:     '<path d="M17.6 9.6h4.8v3.2c0 1-.8 1.7-2.4 1.7s-2.4-.7-2.4-1.7z"/>',
  traps:    '<path d="M13.5 14.2q6.5-3 13 0l-1.4 2.2q-5.1-1.7-10.2 0z"/>',
  deltL:    '<path d="M13.4 15q-4.6.2-6.2 4.1c-.8 2-.3 3.6 1.3 3.9 1.6.3 3-.8 3.6-2.6.5-1.6 1-3.5 1.7-4.8z"/>',
  deltR:    '<path d="M26.6 15q4.6.2 6.2 4.1c.8 2 .3 3.6-1.3 3.9-1.6.3-3-.8-3.6-2.6-.5-1.6-1-3.5-1.7-4.8z"/>',
  pecL:     '<path d="M19.5 17.2q-3.9-1.1-6 .6c-1.6 1.3-1.7 3.6-.1 5 1.4 1.2 3.6 1.3 5.3.3.9-.5.9-1.3.9-2.4z"/>',
  pecR:     '<path d="M20.5 17.2q3.9-1.1 6 .6c1.6 1.3 1.7 3.6.1 5-1.4 1.2-3.6 1.3-5.3.3-.9-.5-.9-1.3-.9-2.4z"/>',
  abs:      '<path d="M14.9 24.2h10.2c.5 3.4.1 7.2-1 10.4-.7 2-1.9 3.1-4.1 3.1s-3.4-1.1-4.1-3.1c-1.1-3.2-1.5-7-1-10.4z"/>',
  bicepL:   '<path d="M7.3 19.6c-1.9.7-3 2.6-3.2 5-.2 2.4.3 4.7 1.4 6.7l2.5-1c-.7-2-1-4-.7-6 .2-1.6.8-3 1.8-4z"/>',
  bicepR:   '<path d="M32.7 19.6c1.9.7 3 2.6 3.2 5 .2 2.4-.3 4.7-1.4 6.7l-2.5-1c.7-2 1-4 .7-6-.2-1.6-.8-3-1.8-4z"/>',
  forearmL: '<path d="M5.5 31.3c-.9 2-1.2 4.2-.9 6.5.2 1.7.7 3.3 1.4 4.8l2.2-.9c-.6-1.6-1-3.2-1.1-4.9-.1-1.9.2-3.7.9-5.4z"/>',
  forearmR: '<path d="M34.5 31.3c.9 2 1.2 4.2.9 6.5-.2 1.7-.7 3.3-1.4 4.8l-2.2-.9c.6-1.6 1-3.2 1.1-4.9.1-1.9-.2-3.7-.9-5.4z"/>',
  quadL:    '<path d="M19.4 37.6q-3.8.3-5.1 3.6c-1 2.6-.8 5.6.1 8.4.4 1.3.9 2.5 1.4 3.7l2.6-.6c-.5-2.6-.6-5.2-.2-7.8.3-2.2.8-4.4 1.2-7.3z"/>',
  quadR:    '<path d="M20.6 37.6q3.8.3 5.1 3.6c1 2.6.8 5.6-.1 8.4-.4 1.3-.9 2.5-1.4 3.7l-2.6-.6c.5-2.6.6-5.2.2-7.8-.3-2.2-.8-4.4-1.2-7.3z"/>',
}

const HI_MAP = {
  chest:     ['pecL', 'pecR'],
  shoulders: ['deltL', 'deltR'],
  arms:      ['bicepL', 'bicepR', 'forearmL', 'forearmR'],
  legs:      ['quadL', 'quadR'],
  abs:       ['abs'],
}
const LINES = {
  abs:      '<path d="M20 24.6v12.4" stroke="#0b0b0d" stroke-width=".7" opacity=".28"/><path d="M15.4 28.4h9.2M15.7 31.6h8.6M16.3 34.6h7.4" stroke="#0b0b0d" stroke-width=".6" opacity=".24"/>',
  chest:    '<path d="M14 18.6q3 1.4 5.4.4M26 18.6q-3 1.4-5.4.4" stroke="#fff" stroke-width=".7" opacity=".45" fill="none" stroke-linecap="round"/>',
  shoulders:'<path d="M8.2 17.4q2.4-1 4.4-.2M31.8 17.4q-2.4-1-4.4-.2" stroke="#fff" stroke-width=".7" opacity=".45" fill="none" stroke-linecap="round"/>',
  arms:     '<path d="M5.4 22.6q1.6-1 3.2-.2M34.6 22.6q-1.6-1-3.2-.2" stroke="#fff" stroke-width=".7" opacity=".45" fill="none" stroke-linecap="round"/>',
  legs:     '<path d="M14.6 41q2.2-1 4-.2M25.4 41q-2.2-1-4-.2" stroke="#fff" stroke-width=".7" opacity=".4" fill="none" stroke-linecap="round"/>',
}
const FRONT_ORDER = ['head','neck','traps','deltL','deltR','pecL','pecR','abs','bicepL','bicepR','forearmL','forearmR','quadL','quadR']

function frontFig(hi) {
  const on = new Set(HI_MAP[hi] || [])
  let s = FRONT_ORDER.map(k => {
    const fill = on.has(k) ? HI : DIM
    const style = on.has(k) ? ` style="filter:${GLOW}"` : ''
    return P[k].replace(/^<(circle|path)/, `<$1 fill="${fill}"${style}`)
  }).join('')
  if (LINES[hi]) s += LINES[hi]
  return s
}

// ---- вид сзади (для «спина») ----
function backFig() {
  const B = {
    head:  '<circle cx="20" cy="6.4" r="4.1"/>',
    neck:  '<path d="M17.6 9.6h4.8v3.2c0 1-.8 1.7-2.4 1.7s-2.4-.7-2.4-1.7z"/>',
    traps: '<path d="M12.8 14q7.2-3.2 14.4 0l-1.8 3.4q-5.4-2-10.8 0z"/>',
    deltL: P.deltL, deltR: P.deltR,
    lats:  '<path d="M13.6 17.2h12.8c1 2.6 1.2 5.6.6 8.4-.5 2.4-1.4 4.6-2.6 6.6-1 1.7-2.4 2.6-4 2.6s-3-.9-4-2.6c-1.2-2-2.1-4.2-2.6-6.6-.6-2.8-.4-5.8.6-8.4z"/>',
    bicepL: P.bicepL, bicepR: P.bicepR, forearmL: P.forearmL, forearmR: P.forearmR,
    hamL:  '<path d="M19.4 34.6q-3.8.3-5.1 3.6c-1 2.6-.8 5.6.1 8.4.4 1.3.9 2.5 1.4 3.7l2.6-.6c-.5-2.6-.6-5.2-.2-7.8.3-2.2.8-4.4 1.2-7.3z"/>',
    hamR:  '<path d="M20.6 34.6q3.8.3 5.1 3.6c1 2.6.8 5.6-.1 8.4-.4 1.3-.9 2.5-1.4 3.7l-2.6-.6c.5-2.6.6-5.2.2-7.8-.3-2.2-.8-4.4-1.2-7.3z"/>',
  }
  const order = ['head','neck','traps','deltL','deltR','lats','bicepL','bicepR','forearmL','forearmR','hamL','hamR']
  let s = order.map(k => {
    const isHi = k === 'lats'
    const style = isHi ? ` style="filter:${GLOW}"` : ''
    return B[k].replace(/^<(circle|path)/, `<$1 fill="${isHi ? HI : DIM}"${style}`)
  }).join('')
  s += '<path d="M20 17.6v16" stroke="#0b0b0d" stroke-width=".7" opacity=".3"/>'
  s += '<path d="M15 20q5-1.6 10 0" stroke="#fff" stroke-width=".7" opacity=".4" fill="none" stroke-linecap="round"/>'
  return s
}

function heartFig() {
  return '<g transform="translate(3 14) scale(1.5)"><path d="M12 20c-.4 0-.8-.15-1.1-.42C7 16.3 4 13.6 4 10.2 4 7.6 6 5.6 8.5 5.6c1.4 0 2.7.65 3.5 1.7.8-1.05 2.1-1.7 3.5-1.7C21.9 5.6 20 7.6 20 10.2c0 3.4-3 6.1-6.9 9.38-.3.27-.7.42-1.1.42z" fill="url(#muHeart)"/><path d="M8.5 7c-1.2 0-2.2.5-2.9 1.3.9-.5 2-.6 3.1 0 .5.3.8.9.5 1.4-.3.5-.9.5-1.3.2-1-.7-2-.2-2.3.7 0-1.9 1.3-3.4 2.9-3.6z" fill="#fff" opacity=".55"/></g>'
}

// Определения градиентов — смонтировать ОДИН раз в корне приложения.
export function MuscleDefs() {
  return (
    <svg width="0" height="0" style={{ position: 'absolute' }} aria-hidden="true">
      <defs>
        <linearGradient id="muBody" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#3d3d47" />
          <stop offset="1" stopColor="#25252c" />
        </linearGradient>
        <linearGradient id="muHi" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#d6d3ff" />
          <stop offset=".45" stopColor="#8B88F5" />
          <stop offset="1" stopColor="#5b54c9" />
        </linearGradient>
        <linearGradient id="muHeart" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#ffc0cf" />
          <stop offset=".45" stopColor="#FF476B" />
          <stop offset="1" stopColor="#cc1e45" />
        </linearGradient>
      </defs>
    </svg>
  )
}

const RENDER = {
  chest: () => frontFig('chest'),
  back: () => backFig(),
  legs: () => frontFig('legs'),
  shoulders: () => frontFig('shoulders'),
  arms: () => frontFig('arms'),
  abs: () => frontFig('abs'),
  cardio: () => heartFig(),
}

export const MUSCLE_GROUPS = ['chest', 'back', 'legs', 'shoulders', 'arms', 'abs', 'cardio']

export function MuscleIcon({ group, size = 44, style, title }) {
  const build = RENDER[group] || (() => frontFig(null)) // fallback: нейтральный силуэт
  return (
    <svg
      viewBox="0 0 40 58"
      width={size}
      height={size}
      preserveAspectRatio="xMidYMid meet"
      style={style}
      role="img"
      aria-label={title || group || 'muscle'}
      dangerouslySetInnerHTML={{ __html: (title ? `<title>${title}</title>` : '') + build() }}
    />
  )
}
