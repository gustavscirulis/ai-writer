interface SelectControlProps {
  value: string;
  options: string[];
  onChange: (value: string) => void;
  optionLabel?: (option: string) => string;
  ariaLabel?: string;
  disabled?: boolean;
  className?: string;
}

/** Shared ordinary select used by enum and installed-font settings. */
export function SelectControl({
  value,
  options,
  onChange,
  optionLabel,
  ariaLabel,
  disabled = false,
  className = "",
}: SelectControlProps) {
  return (
    <select
      value={value}
      disabled={disabled}
      aria-label={ariaLabel}
      onChange={(event) => onChange(event.target.value)}
      className={`h-9 min-w-[140px] appearance-none rounded-lg border border-transparent bg-[var(--surface-input)] bg-[image:var(--select-chevron)] bg-[length:12px_12px] bg-[position:right_10px_center] bg-no-repeat pl-3 pr-8 text-[13px] text-[var(--text-secondary)] font-[inherit] outline-none focus:border-[var(--focus-border)] focus-visible:outline-none disabled:opacity-60 ${className}`}
    >
      {options.map((option) => (
        <option key={option} value={option}>
          {optionLabel ? optionLabel(option) : option}
        </option>
      ))}
    </select>
  );
}
