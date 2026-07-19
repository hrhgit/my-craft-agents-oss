interface MortiseSymbolProps {
  className?: string
}

/** Mortise's modular M symbol. Uses the surrounding text color. */
export function MortiseSymbol({ className }: MortiseSymbolProps) {
  return (
    <svg
      viewBox="72 72 368 368"
      className={className}
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
    >
      <g fill="currentColor">
        <rect x="90" y="92" width="60" height="60" />
        <rect x="362" y="92" width="60" height="60" />
        <rect x="90" y="160" width="60" height="60" />
        <rect x="158" y="160" width="60" height="60" />
        <rect x="294" y="160" width="60" height="60" />
        <rect x="362" y="160" width="60" height="60" />
        <rect x="90" y="228" width="60" height="60" />
        <rect x="226" y="228" width="60" height="60" />
        <rect x="362" y="228" width="60" height="60" />
        <rect x="90" y="296" width="60" height="60" />
        <rect x="362" y="296" width="60" height="60" />
        <rect x="90" y="364" width="60" height="60" />
        <rect x="362" y="364" width="60" height="60" />
      </g>
    </svg>
  )
}
