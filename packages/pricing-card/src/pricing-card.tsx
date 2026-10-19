import { useState, type ReactNode } from 'react'

// The Blame Premium pricing card, shared by the website and the desktop app so
// both show exactly the same offer. Styles are Tailwind classes: each host
// lists this package as a Tailwind source.

export const pricingBillingOptions = {
  monthly: { label: 'Monthly', price: '20', suffix: 'USD /month' },
  yearly: { label: 'Yearly', price: '200', suffix: 'USD /year' },
} as const

export type PricingBillingCycle = keyof typeof pricingBillingOptions

const premiumBenefits = [
  'Managed cloud previews',
  'Cloud voice transcription',
  'Hosted file uploads',
  'Existing usage limits apply',
  'Cancel anytime',
] as const

// Matches the website's dark button, so hosts can style their own call to
// action (a link on the website, a checkout button in the app) identically.
export const pricingCardActionClassName =
  'inline-flex min-h-12 w-full items-center justify-center gap-2 whitespace-nowrap rounded-full bg-[#111] px-5 py-3 text-sm font-semibold text-white shadow-none transition duration-200 hover:-translate-y-0.5 hover:bg-[#2a2a2a] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#b3acf3] focus-visible:ring-offset-2 focus-visible:ring-offset-[#050712] disabled:pointer-events-none disabled:opacity-50'

export const pricingLegalLinkClassName =
  'underline underline-offset-2 hover:text-[#111]'

export type PricingCardProps = {
  // Call to action under the price, for the selected billing cycle.
  action: (cycle: PricingBillingCycle) => ReactNode
  // Terms, privacy, refunds and withdrawal links.
  legalLinks: ReactNode
  logo: ReactNode
  // Tighter layout for short windows, such as the desktop app.
  compact?: boolean
  className?: string
  disabled?: boolean
  billingCycle?: PricingBillingCycle
  onBillingCycleChange?: (cycle: PricingBillingCycle) => void
}

export function PricingCard({
  action,
  billingCycle: controlledCycle,
  className,
  compact = false,
  disabled = false,
  legalLinks,
  logo,
  onBillingCycleChange,
}: PricingCardProps) {
  const [localCycle, setLocalCycle] = useState<PricingBillingCycle>('monthly')
  const billingCycle = controlledCycle ?? localCycle
  const selected = pricingBillingOptions[billingCycle]

  function selectCycle(cycle: PricingBillingCycle) {
    setLocalCycle(cycle)
    onBillingCycleChange?.(cycle)
  }

  return (
    <div
      className={cx(
        'relative w-full overflow-hidden border border-white/18 bg-white/[0.08] shadow-[0_34px_120px_rgba(0,0,0,0.42)] backdrop-blur-2xl',
        compact ? 'max-w-[440px] rounded-[1.75rem] p-1.5' : 'max-w-[430px] rounded-[2rem] p-2',
        className,
      )}
    >
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_18%_0%,rgba(255,255,255,0.18),transparent_28%),radial-gradient(circle_at_80%_18%,rgba(179,172,243,0.2),transparent_36%)]" />
      <div
        className={cx(
          'relative border border-white/14 bg-[#f7f7f8]/90 text-[#111] shadow-[inset_0_1px_0_rgba(255,255,255,0.8),0_18px_60px_rgba(0,0,0,0.24)] backdrop-blur-xl',
          compact ? 'rounded-[1.4rem] p-5' : 'rounded-[1.55rem] p-6 sm:p-7',
        )}
      >
        <CardHeader compact={compact} logo={logo} />
        <BillingToggle
          compact={compact}
          disabled={disabled}
          value={billingCycle}
          onChange={selectCycle}
        />
        <div className={cx('flex items-end gap-2', compact ? 'mt-4' : 'mt-7')}>
          <span
            key={selected.price}
            className={cx(
              'animate-in fade-in-0 slide-in-from-bottom-2 font-semibold leading-none tracking-[-0.04em] text-[#111] duration-300',
              compact ? 'text-5xl' : 'text-6xl',
            )}
          >
            {selected.price}
          </span>
          <span className={cx('text-[#111]/54', compact ? 'pb-1 text-base' : 'pb-2 text-lg')}>
            {selected.suffix}
          </span>
        </div>
        <p
          className={cx(
            'font-medium text-[#111]/54',
            compact ? 'mt-1 min-h-4 text-xs' : 'mt-2 min-h-5 text-sm',
            billingCycle === 'yearly' ? 'visible' : 'invisible',
          )}
        >
          Billed once a year.
        </p>
        <div className={compact ? 'mt-4' : 'mt-8'}>{action(billingCycle)}</div>
        <nav
          aria-label="Purchase policies"
          className="mt-3 flex flex-wrap justify-center gap-x-3 gap-y-1 text-xs leading-5 text-[#111]/54"
        >
          {legalLinks}
        </nav>
        <p
          className={cx(
            'text-center text-[#111]/54',
            compact ? 'mt-1 text-[11px] leading-4' : 'mt-3 text-xs leading-5',
          )}
        >
          AI usage is not included and may be billed separately by your
          provider.
        </p>
        <ul
          className={cx(
            'text-[#111]',
            compact
              ? 'mt-4 grid grid-cols-2 gap-x-3 gap-y-1.5 text-[13px] leading-5'
              : 'mt-7 space-y-4 text-base',
          )}
        >
          {premiumBenefits.map((benefit) => (
            <li key={benefit} className={cx('flex items-center', compact ? 'gap-2' : 'gap-3')}>
              <CheckIcon className={cx('shrink-0', compact ? 'h-3.5 w-3.5' : 'h-4 w-4')} />
              <span>{benefit}</span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  )
}

function CardHeader({ compact, logo }: { compact: boolean; logo: ReactNode }) {
  const description =
    'Cloud services hosted and funded by Blame. Local development and your own AI providers remain free.'

  if (compact) {
    return (
      <div className="flex items-start gap-4">
        <div className="shrink-0 [&>*]:h-11 [&>*]:w-11">{logo}</div>
        <div>
          <h2 className="text-xl font-semibold tracking-[-0.04em] text-[#111]">
            Blame Premium
          </h2>
          <p className="mt-1 text-[13px] leading-5 text-[#111]/70">{description}</p>
        </div>
      </div>
    )
  }

  return (
    <>
      <div className="flex items-start justify-between gap-4 [&>*]:h-12 [&>*]:w-12">
        {logo}
      </div>
      <div className="mt-7">
        <h2 className="text-2xl font-semibold tracking-[-0.04em] text-[#111]">
          Blame Premium
        </h2>
        <p className="mt-3 text-base leading-6 text-[#111]/70">{description}</p>
      </div>
    </>
  )
}

function BillingToggle({
  compact,
  disabled,
  onChange,
  value,
}: {
  compact: boolean
  disabled: boolean
  onChange: (cycle: PricingBillingCycle) => void
  value: PricingBillingCycle
}) {
  const cycles = Object.keys(pricingBillingOptions) as PricingBillingCycle[]

  return (
    <div
      className={cx(
        'relative grid grid-cols-2 rounded-full bg-black/[0.06] p-1 text-sm font-semibold',
        compact ? 'mt-4' : 'mt-6',
      )}
    >
      {/* The white pill slides under the selected option. */}
      <span
        aria-hidden="true"
        className={cx(
          'absolute inset-y-1 left-1 w-[calc(50%-0.25rem)] rounded-full bg-white shadow-[0_8px_24px_rgba(0,0,0,0.12)] transition-transform duration-300 ease-[cubic-bezier(0.16,1,0.3,1)] motion-reduce:transition-none',
          value === 'yearly' && 'translate-x-full',
        )}
      />
      {cycles.map((cycle) => {
        const selected = cycle === value
        return (
          <button
            key={cycle}
            type="button"
            disabled={disabled}
            aria-pressed={selected}
            onClick={() => onChange(cycle)}
            className={cx(
              'relative rounded-full px-4 transition-colors duration-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-[#111]/20 disabled:cursor-not-allowed',
              compact ? 'py-2' : 'py-2.5',
              selected ? 'text-[#111]' : 'text-[#111]/54 hover:text-[#111]',
            )}
          >
            {pricingBillingOptions[cycle].label}
          </button>
        )
      })}
    </div>
  )
}

function CheckIcon({ className }: { className?: string }) {
  return (
    <svg
      aria-hidden="true"
      className={className}
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="2"
      viewBox="0 0 24 24"
    >
      <path d="M20 6 9 17l-5-5" />
    </svg>
  )
}

function cx(...classes: Array<string | false | null | undefined>) {
  return classes.filter(Boolean).join(' ')
}
