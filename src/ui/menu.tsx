import { cloneElement, useEffect, useRef, useState, type ReactElement } from 'react'

import { Icon, type IconName } from './icons'

export interface MenuItem {
  icon?: IconName
  label: string
  danger?: boolean
  disabled?: boolean
  onSelect: () => void
}

export function Menu({ trigger, items, align = 'end' }: { trigger: ReactElement<any>; items: (MenuItem | 'sep')[]; align?: 'end' | 'start' }) {
  const [open, setOpen] = useState(false)
  const box = useRef<HTMLSpanElement | null>(null)

  useEffect(() => {
    if (!open) {
      return
    }

    const close = (event: MouseEvent) => {
      if (!box.current?.contains(event.target as Node)) {
        setOpen(false)
      }
    }

    const esc = (event: KeyboardEvent) => event.key === 'Escape' && setOpen(false)
    window.addEventListener('mousedown', close)
    window.addEventListener('keydown', esc)

    return () => {
      window.removeEventListener('mousedown', close)
      window.removeEventListener('keydown', esc)
    }
  }, [open])

  return (
    <span className="menu-wrap" ref={box}>
      {cloneElement(trigger, { onClick: () => setOpen(v => !v), 'data-open': open || undefined })}
      {open ? (
        <div className="menu" data-align={align}>
          {items.map((item, index) =>
            item === 'sep' ? (
              <div className="menu-sep" key={`s${index}`} />
            ) : (
              <button
                className="menu-item"
                data-danger={item.danger || undefined}
                disabled={item.disabled}
                key={item.label}
                onClick={() => {
                  setOpen(false)
                  item.onSelect()
                }}
                type="button"
              >
                {item.icon ? <Icon name={item.icon} size={16} /> : null}
                <span>{item.label}</span>
              </button>
            )
          )}
        </div>
      ) : null}
    </span>
  )
}
