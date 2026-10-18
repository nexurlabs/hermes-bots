/** Small form controls shared by the dialogs and the settings sheet. */

export function Seg<T extends string>({ onChange, options, value }: { onChange: (v: T) => void; options: [T, string][]; value: T }) {
  return (
    <div className="seg" role="radiogroup">
      {options.map(([id, label]) => (
        <button aria-checked={value === id} data-on={value === id || undefined} key={id} onClick={() => onChange(id)} role="radio" type="button">
          {label}
        </button>
      ))}
    </div>
  )
}

export function Switch({ checked, disabled, label, onChange, small }: { checked: boolean; disabled?: boolean; label: string; onChange: (next: boolean) => void; small?: boolean }) {
  return (
    <button
      aria-checked={checked}
      aria-label={label}
      className={small ? 'switch sm' : 'switch'}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      role="switch"
      type="button"
    />
  )
}
