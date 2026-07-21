// glassIcons.jsx — единый набор кастомных иконок FitPro в стиле liquid glass.
// Все иконки рисуются inline-SVG с общими градиентами (GlassDefs) и мягким
// цветным свечением. Использование:
//   <GlassDefs/>  — один раз в корне приложения (рендерит скрытые градиенты).
//   <GlassIcon name="dumbbell" size={30}/>  — где угодно.
// Цвет/свечение зашиты в каждую иконку по смыслу. Менять размер — через size.
import React from 'react'

// ── Общие градиенты и фильтры. Смонтировать ОДИН раз в корне App. ──
export function GlassDefs() {
  return (
    <svg aria-hidden="true" width="0" height="0" style={{ position: 'absolute' }}>
      <defs>
        <linearGradient id="gP" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#d6d3ff"/><stop offset=".45" stopColor="#8B88F5"/><stop offset="1" stopColor="#5b54c9"/></linearGradient>
        <linearGradient id="gPl" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#efeeff"/><stop offset="1" stopColor="#a7a1ff"/></linearGradient>
        <linearGradient id="gG" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#b0f7c8"/><stop offset=".45" stopColor="#3BDC66"/><stop offset="1" stopColor="#1c9c41"/></linearGradient>
        <linearGradient id="gB" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#a9d3ff"/><stop offset=".45" stopColor="#2A9BFF"/><stop offset="1" stopColor="#075fbe"/></linearGradient>
        <linearGradient id="gO" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#ffe3b3"/><stop offset=".45" stopColor="#FFAB2E"/><stop offset="1" stopColor="#d97e00"/></linearGradient>
        <linearGradient id="gPk" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#ffc0cf"/><stop offset=".45" stopColor="#FF476B"/><stop offset="1" stopColor="#cc1e45"/></linearGradient>
        <linearGradient id="gK" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#f3d4ff"/><stop offset=".45" stopColor="#CB6DF5"/><stop offset="1" stopColor="#9333cf"/></linearGradient>
        <linearGradient id="gN" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#f2f2f7"/><stop offset="1" stopColor="#b8b8c4"/></linearGradient>
        <linearGradient id="gRed" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#ff9a94"/><stop offset=".5" stopColor="#FF453A"/><stop offset="1" stopColor="#c62a22"/></linearGradient>
        <linearGradient id="sheen" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#fff" stopOpacity=".75"/><stop offset="1" stopColor="#fff" stopOpacity="0"/></linearGradient>
        <filter id="glassSoft"><feGaussianBlur stdDeviation="0.5"/></filter>
      </defs>
    </svg>
  )
}

const S = (o) => <rect {...o} fill="url(#sheen)" opacity={o.opacity ?? 0.6} filter="url(#glassSoft)"/>

// ── Иконки: name → { glow, svg }. glow — цвет мягкого свечения. ──
const IC = {
  // HERO
  dumbbell: { glow: 'rgba(124,122,240,.55)', svg: (<>
    <rect x="2.4" y="9.4" width="2.7" height="5.2" rx="1.35" fill="url(#gPl)"/><rect x="18.9" y="9.4" width="2.7" height="5.2" rx="1.35" fill="url(#gPl)"/>
    <rect x="5.5" y="6.8" width="3.5" height="10.4" rx="1.7" fill="url(#gP)"/><rect x="15" y="6.8" width="3.5" height="10.4" rx="1.7" fill="url(#gP)"/>
    <rect x="8.4" y="10.3" width="7.2" height="3.4" rx="1.7" fill="url(#gPl)"/>
    <rect x="6.2" y="7.4" width="2.1" height="3.4" rx="1.05" fill="url(#sheen)" filter="url(#glassSoft)"/></>) },
  food: { glow: 'rgba(48,209,88,.5)', svg: (<>
    <path d="M12 7.6c-1.3-1.1-3.1-1.3-4.6-.5C5.8 8 4.8 9.9 4.8 12c0 3.7 2.6 7.2 5.2 7.2.9 0 1.4-.4 2-.4s1.1.4 2 .4c2.6 0 5.2-3.5 5.2-7.2 0-2.1-1-4-2.6-4.9-1.5-.8-3.3-.6-4.6.5z" fill="url(#gG)"/>
    <path d="M12 7.6c.1-1.8 1.5-3.3 3.3-3.5.2 1.8-1.2 3.5-3.3 3.5z" fill="#7bec9a"/>
    <ellipse cx="9.2" cy="10.4" rx="1.9" ry="2.6" fill="url(#sheen)" opacity=".7" filter="url(#glassSoft)"/></>) },
  book: { glow: 'rgba(10,132,255,.5)', svg: (<>
    <path d="M5 5.6A1.6 1.6 0 0 1 6.6 4H18.2a.9.9 0 0 1 .9.9v13.1a.9.9 0 0 1-.9.9H6.6A1.6 1.6 0 0 0 5 20.4z" fill="url(#gB)"/>
    <rect x="7.9" y="4" width="1.7" height="15.4" fill="#a9d3ff"/>
    <rect x="11.4" y="8.4" width="5" height="1.6" rx="0.8" fill="#eaf4ff"/><rect x="11.4" y="11.2" width="5" height="1.6" rx="0.8" fill="#eaf4ff"/></>) },
  notebook: { glow: 'rgba(255,159,10,.5)', svg: (<>
    <rect x="4.8" y="3.4" width="14.4" height="17.2" rx="2.4" fill="url(#gO)"/>
    <rect x="7.4" y="3.4" width="1.7" height="17.2" fill="#ffcf82"/>
    <rect x="10.8" y="8" width="5.8" height="1.6" rx="0.8" fill="#fff3de"/><rect x="10.8" y="11.4" width="5.8" height="1.6" rx="0.8" fill="#fff3de"/><rect x="10.8" y="14.8" width="4" height="1.6" rx="0.8" fill="#fff3de"/></>) },
  people: { glow: 'rgba(255,55,95,.5)', svg: (<>
    <circle cx="9" cy="8" r="3.3" fill="url(#gPk)"/><path d="M3.4 20a5.6 5.6 0 0 1 11.2 0z" fill="url(#gPk)"/>
    <circle cx="16.6" cy="8.6" r="2.7" fill="#ff8ea3"/><path d="M14.4 20a5.3 5.3 0 0 1 6.9-5.1c-.5 2.9-1.9 5.1-3.9 5.1z" fill="#ff8ea3"/>
    <circle cx="7.9" cy="6.9" r="1.2" fill="url(#sheen)" opacity=".8" filter="url(#glassSoft)"/></>) },
  flame: { glow: 'rgba(191,90,242,.55)', svg: (<>
    <path d="M12 2.8c.6 3.4 4.2 4.4 4.2 8.4a4.2 4.2 0 0 1-8.4 0c0-1.7.6-2.8 1.6-3.8C11 8.4 12 6 12 2.8z" fill="url(#gK)"/>
    <path d="M12 12.2c.3 1.7 2.1 2.1 2.1 4.2a2.1 2.1 0 0 1-4.2 0c0-1 .5-1.7 1.1-2.3.5-.5 1-1 1-1.9z" fill="#f0c4ff"/></>) },
  grain: { glow: 'rgba(10,132,255,.5)', svg: (<>
    <path d="M12 3v18" stroke="#8fc4ff" strokeWidth="1.8" strokeLinecap="round"/>
    <path d="M12 8c-2-1.6-4.4-1.4-5.6 0 1.6 1.8 4 1.6 5.6 0zM12 8c2-1.6 4.4-1.4 5.6 0-1.6 1.8-4 1.6-5.6 0zM12 13c-2-1.6-4.4-1.4-5.6 0 1.6 1.8 4 1.6 5.6 0zM12 13c2-1.6 4.4-1.4 5.6 0-1.6 1.8-4 1.6-5.6 0z" fill="url(#gB)"/></>) },
  droplet: { glow: 'rgba(255,159,10,.5)', svg: (<>
    <path d="M12 3.5c3.4 4 6 6.3 6 9.5a6 6 0 0 1-12 0c0-3.2 2.6-5.5 6-9.5z" fill="url(#gO)"/>
    <path d="M9.4 12.5c0 1.6 1 3 2.4 3.4-2 .3-3.8-1.1-3.8-3.1 0-1.4.7-2.4 1.6-3.6.2 1.4-.2 2.1-.2 3.3z" fill="url(#sheen)" opacity=".55" filter="url(#glassSoft)"/></>) },
  lightning: { glow: 'rgba(10,132,255,.55)', svg: (<>
    <path d="M13.6 2.4 5 13.2h5l-1.6 8.4L19 10.6h-5z" fill="url(#gB)"/><path d="M13.6 2.4 5 13.2h5z" fill="#9ecdff"/></>) },
  runner: { glow: 'rgba(255,55,95,.5)', svg: (<>
    <circle cx="15.5" cy="5" r="2.1" fill="url(#gPk)"/>
    <path d="M13 8.5l-3 2 2 3-2 5" fill="none" stroke="url(#gPk)" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"/>
    <path d="M13 8.5l3.5 1.4L19 8" fill="none" stroke="url(#gPk)" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"/>
    <path d="M11 12.5l-4-1" fill="none" stroke="#ff8ea3" strokeWidth="2.4" strokeLinecap="round"/></>) },
  house: { glow: 'rgba(48,209,88,.5)', svg: (<>
    <path d="M5.4 10.4v8.8a1 1 0 0 0 1 1h11.2a1 1 0 0 0 1-1v-8.8" fill="url(#gG)"/>
    <path d="M3.4 11.6 12 4.4l8.6 7.2" fill="none" stroke="#7bec9a" strokeWidth="2.1" strokeLinecap="round" strokeLinejoin="round"/>
    <rect x="10" y="14" width="4" height="6" rx="0.7" fill="#0b0b0d" opacity=".45"/></>) },
  plate: { glow: 'rgba(48,209,88,.5)', svg: (<>
    <circle cx="12" cy="12" r="8" fill="url(#gG)"/><circle cx="12" cy="12" r="4" fill="#0b0b0d" opacity=".28"/>
    <circle cx="12" cy="12" r="4" fill="none" stroke="#bff5cd" strokeWidth="0.9"/>
    <ellipse cx="9.4" cy="9" rx="2.2" ry="3" fill="url(#sheen)" opacity=".55" filter="url(#glassSoft)"/></>) },
  sunrise: { glow: 'rgba(255,159,10,.55)', svg: (<>
    <circle cx="12" cy="12.5" r="4" fill="url(#gO)"/>
    <path d="M3.5 17.5h17M12 4v2.5M5.6 6.6l1.6 1.6M18.4 6.6l-1.6 1.6" stroke="#ffd79a" strokeWidth="1.8" strokeLinecap="round"/></>) },
  moon: { glow: 'rgba(124,122,240,.5)', svg: (<>
    <path d="M20 14.5A8 8 0 0 1 9.5 4 8 8 0 1 0 20 14.5z" fill="url(#gP)"/>
    <path d="M9.5 4A8 8 0 0 0 6.5 8.5 8 8 0 0 0 11 18a8 8 0 0 1-1.5-14z" fill="url(#sheen)" opacity=".4" filter="url(#glassSoft)"/></>) },
  robot: { glow: 'rgba(124,122,240,.55)', svg: (<>
    <rect x="4.5" y="7" width="15" height="12" rx="3.5" fill="url(#gP)"/>
    <rect x="7.5" y="10.5" width="3.2" height="3.2" rx="1.1" fill="#0b0b0d" opacity=".55"/><rect x="13.3" y="10.5" width="3.2" height="3.2" rx="1.1" fill="#0b0b0d" opacity=".55"/>
    <path d="M12 3v3M12 3a1.4 1.4 0 1 0 0 .01" stroke="#c3bfff" strokeWidth="1.6" strokeLinecap="round"/>
    <rect x="6.5" y="8" width="4" height="2.5" rx="1.2" fill="url(#sheen)" opacity=".5" filter="url(#glassSoft)"/></>) },
  // РАЗДЕЛЫ / ДЕЙСТВИЯ
  scale: { glow: 'rgba(10,132,255,.5)', svg: (<>
    <rect x="4" y="5.5" width="16" height="13" rx="3" fill="url(#gB)"/>
    <path d="M8 5.5a4 4 0 0 1 8 0" fill="none" stroke="#a9d3ff" strokeWidth="1.7"/>
    <path d="M12 10v3.5M12 13.5l2.5 2" stroke="#eaf4ff" strokeWidth="1.7" strokeLinecap="round"/></>) },
  chart: { glow: 'rgba(48,209,88,.5)', svg: (<>
    <rect x="4" y="12" width="3.4" height="7" rx="1.2" fill="url(#gG)"/><rect x="10.3" y="8" width="3.4" height="11" rx="1.2" fill="url(#gG)"/><rect x="16.6" y="4.5" width="3.4" height="14.5" rx="1.2" fill="url(#gG)"/></>) },
  calculator: { glow: 'rgba(255,159,10,.5)', svg: (<>
    <rect x="5" y="3" width="14" height="18" rx="3" fill="url(#gO)"/>
    <rect x="7.5" y="5.5" width="9" height="3.4" rx="1" fill="#0b0b0d" opacity=".45"/>
    <circle cx="9" cy="12.5" r="1.1" fill="#fff3de"/><circle cx="12" cy="12.5" r="1.1" fill="#fff3de"/><circle cx="15" cy="12.5" r="1.1" fill="#fff3de"/>
    <circle cx="9" cy="16" r="1.1" fill="#fff3de"/><circle cx="12" cy="16" r="1.1" fill="#fff3de"/><circle cx="15" cy="16" r="1.1" fill="#fff3de"/></>) },
  trash: { glow: 'rgba(255,69,58,.5)', svg: (<>
    <path d="M6 7.5h12l-1 11.5a2 2 0 0 1-2 1.8H9a2 2 0 0 1-2-1.8z" fill="url(#gRed)"/>
    <rect x="4.5" y="5" width="15" height="2.6" rx="1.3" fill="#ff9a94"/><rect x="9" y="3" width="6" height="2.4" rx="1.2" fill="#ff9a94"/>
    <path d="M10 11v6M14 11v6" stroke="#0b0b0d" strokeWidth="1.4" strokeLinecap="round" opacity=".35"/></>) },
  pen: { glow: 'rgba(124,122,240,.5)', svg: (<>
    <path d="M16.5 4.5l3 3L9 18l-4 1 1-4z" fill="url(#gP)"/><path d="M14.5 6.5l3 3" stroke="#e3e1ff" strokeWidth="1.4"/></>) },
  copy: { glow: 'rgba(124,122,240,.5)', svg: (<>
    <rect x="8" y="3.5" width="12" height="14" rx="3" fill="url(#gP)"/><rect x="4" y="6.5" width="12" height="14" rx="3" fill="url(#gPl)"/></>) },
  template: { glow: 'rgba(124,122,240,.5)', svg: (<>
    <path d="M3.5 7a2 2 0 0 1 2-2h4l2 2h7a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z" fill="url(#gP)"/>
    <rect x="3.5" y="7.5" width="17" height="3" fill="#c3bfff" opacity=".5"/></>) },
  video: { glow: 'rgba(255,55,95,.5)', svg: (<>
    <rect x="3.5" y="6.5" width="12" height="11" rx="3" fill="url(#gPk)"/><path d="M16 10.5l4.5-2.6v8.2L16 13.5z" fill="url(#gPk)"/>
    <circle cx="7" cy="9.5" r="1.4" fill="#ffd0da"/></>) },
  gear: { glow: 'rgba(124,122,240,.5)', svg: (<>
    <path d="M12 3l1.4 2.1 2.5-.4.5 2.5 2.3 1.1-1 2.3 1 2.3-2.3 1.1-.5 2.5-2.5-.4L12 21l-1.4-2.1-2.5.4-.5-2.5-2.3-1.1 1-2.3-1-2.3 2.3-1.1.5-2.5 2.5.4z" fill="url(#gP)"/>
    <circle cx="12" cy="12" r="3" fill="#0b0b0d" opacity=".45"/><circle cx="12" cy="12" r="3" fill="none" stroke="#c3bfff" strokeWidth="1"/></>) },
  plus: { glow: 'rgba(124,122,240,.5)', svg: (<>
    <circle cx="12" cy="12" r="9" fill="url(#gP)"/><path d="M12 7.5v9M7.5 12h9" stroke="#fff" strokeWidth="2.2" strokeLinecap="round"/></>) },
  play: { glow: 'rgba(48,209,88,.5)', svg: (<>
    <circle cx="12" cy="12" r="9" fill="url(#gG)"/><path d="M10 8.5l6 3.5-6 3.5z" fill="#fff"/></>) },
  check: { glow: 'rgba(48,209,88,.5)', svg: (<>
    <circle cx="12" cy="12" r="9" fill="url(#gG)"/><path d="M8 12.5l2.8 2.8L16.5 9.5" fill="none" stroke="#fff" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"/></>) },
  share: { glow: 'rgba(124,122,240,.5)', svg: (<>
    <circle cx="6" cy="12" r="2.6" fill="url(#gPl)"/><circle cx="17.5" cy="6" r="2.6" fill="url(#gP)"/><circle cx="17.5" cy="18" r="2.6" fill="url(#gP)"/>
    <path d="M8.3 10.8l7-3.6M8.3 13.2l7 3.6" stroke="#9D96FF" strokeWidth="1.8"/></>) },
  chat: { glow: 'rgba(124,122,240,.5)', svg: (<>
    <path d="M4 7a3 3 0 0 1 3-3h10a3 3 0 0 1 3 3v6a3 3 0 0 1-3 3H9l-4 3.5V16a3 3 0 0 1-1-2.2z" fill="url(#gP)"/>
    <circle cx="9" cy="10" r="1.1" fill="#fff"/><circle cx="12" cy="10" r="1.1" fill="#fff"/><circle cx="15" cy="10" r="1.1" fill="#fff"/></>) },
  question: { glow: 'rgba(124,122,240,.5)', svg: (<>
    <circle cx="12" cy="12" r="9" fill="url(#gP)"/>
    <path d="M9.4 9.2a2.7 2.7 0 0 1 5.2 1c0 1.8-2.6 1.8-2.6 3.6" fill="none" stroke="#fff" strokeWidth="1.9" strokeLinecap="round"/><circle cx="12" cy="16.6" r="1.2" fill="#fff"/></>) },
  close: { glow: 'rgba(235,235,245,.25)', svg: (<>
    <circle cx="12" cy="12" r="9" fill="url(#gN)"/><path d="M8.5 8.5l7 7M15.5 8.5l-7 7" stroke="#3a3a40" strokeWidth="2.1" strokeLinecap="round"/></>) },
  back: { glow: 'rgba(235,235,245,.2)', svg: (<>
    <path d="M14.5 5l-7 7 7 7" fill="none" stroke="url(#gN)" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round"/></>) },
  timer: { glow: 'rgba(124,122,240,.5)', svg: (<>
    <circle cx="12" cy="13.5" r="7.5" fill="url(#gP)"/><rect x="9.5" y="2" width="5" height="2.4" rx="1.2" fill="#c3bfff"/><rect x="11" y="3.5" width="2" height="2.5" fill="#c3bfff"/>
    <path d="M12 9.5v4.5h3.5" stroke="#fff" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"/></>) },
  calendar: { glow: 'rgba(10,132,255,.5)', svg: (<>
    <rect x="3.5" y="5" width="17" height="15" rx="3" fill="url(#gB)"/><rect x="3.5" y="5" width="17" height="4" fill="#075fbe"/>
    <rect x="7" y="3" width="2" height="4" rx="1" fill="#a9d3ff"/><rect x="15" y="3" width="2" height="4" rx="1" fill="#a9d3ff"/>
    <circle cx="8" cy="13" r="1.2" fill="#eaf4ff"/><circle cx="12" cy="13" r="1.2" fill="#eaf4ff"/><circle cx="16" cy="13" r="1.2" fill="#eaf4ff"/><circle cx="8" cy="16.5" r="1.2" fill="#eaf4ff"/><circle cx="12" cy="16.5" r="1.2" fill="#eaf4ff"/></>) },
  target: { glow: 'rgba(255,55,95,.5)', svg: (<>
    <circle cx="12" cy="12" r="8.5" fill="url(#gPk)"/><circle cx="12" cy="12" r="5" fill="#0b0b0d" opacity=".25"/><circle cx="12" cy="12" r="5" fill="none" stroke="#ffd0da" strokeWidth="1.2"/><circle cx="12" cy="12" r="1.9" fill="#fff"/></>) },
  ruler: { glow: 'rgba(10,132,255,.5)', svg: (<>
    <rect x="3" y="8" width="18" height="8" rx="2" fill="url(#gB)" transform="rotate(-45 12 12)"/>
    <path d="M9 9l1.4 1.4M12 6l1.4 1.4M15 9l1.4 1.4" stroke="#eaf4ff" strokeWidth="1.4" strokeLinecap="round"/></>) },
  bulb: { glow: 'rgba(255,159,10,.55)', svg: (<>
    <path d="M12 3a6 6 0 0 1 3.6 10.8c-.7.5-1.1 1-1.1 1.7v.5h-5v-.5c0-.7-.4-1.2-1.1-1.7A6 6 0 0 1 12 3z" fill="url(#gO)"/>
    <rect x="9.5" y="16.5" width="5" height="1.8" rx="0.9" fill="#ffcf82"/><rect x="10" y="19" width="4" height="1.8" rx="0.9" fill="#ffcf82"/></>) },
  trophy: { glow: 'rgba(255,159,10,.55)', svg: (<>
    <path d="M7 4h10v4a5 5 0 0 1-10 0z" fill="url(#gO)"/>
    <path d="M7 5H4.5v1.5A2.5 2.5 0 0 0 7 9M17 5h2.5v1.5A2.5 2.5 0 0 1 17 9" fill="none" stroke="#ffd79a" strokeWidth="1.6"/>
    <rect x="10.5" y="12.5" width="3" height="4" fill="#cf7d00"/><rect x="8" y="17" width="8" height="2.6" rx="1.3" fill="#ffcf82"/></>) },
  danger: { glow: 'rgba(255,69,58,.5)', svg: (<>
    <path d="M12 3.5l9 15.5H3z" fill="url(#gRed)"/><path d="M12 9v4.5" stroke="#fff" strokeWidth="2" strokeLinecap="round"/><circle cx="12" cy="16.4" r="1.2" fill="#fff"/></>) },
  download: { glow: 'rgba(10,132,255,.5)', svg: (<>
    <rect x="3.5" y="15" width="17" height="5" rx="2.4" fill="url(#gB)"/><path d="M12 4v9M8 9.5l4 4 4-4" fill="none" stroke="#a9d3ff" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"/></>) },
}

export function GlassIcon({ name, size = 24, className, style, title }) {
  const ic = IC[name]
  if (!ic) return null
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} className={className}
      role="img" aria-label={title || name}
      style={{ filter: `drop-shadow(0 4px 11px ${ic.glow})`, flexShrink: 0, ...style }}>
      {ic.svg}
    </svg>
  )
}

export const GLASS_ICON_NAMES = Object.keys(IC)
