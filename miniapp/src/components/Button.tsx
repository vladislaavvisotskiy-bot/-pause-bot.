import { ArrowRight } from 'lucide-react'
import type { ButtonHTMLAttributes } from 'react'
import { haptic } from '../lib/telegram'

type Variant = 'primary' | 'secondary' | 'outline' | 'chip'

type Props = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: Variant
  noArrow?: boolean
}

const VARIANT_CLASSES: Record<Variant, string> = {
  primary: 'bg-gold text-white active:bg-[#B08A48]',
  secondary: 'bg-green text-white active:bg-green-2',
  outline: 'bg-transparent text-green border-[1.5px] border-green active:bg-green/5',
  chip: 'bg-chip text-text active:opacity-80',
}

export default function Button({ variant = 'primary', noArrow = false, className = '', onClick, children, ...rest }: Props) {
  const showArrow = variant !== 'chip' && !noArrow
  return (
    <button
      className={`w-full h-[52px] rounded-full flex items-center justify-center gap-2 font-sans text-btn font-medium ${VARIANT_CLASSES[variant]} ${className}`}
      onClick={(e) => {
        haptic('select')
        onClick?.(e)
      }}
      {...rest}
    >
      <span>{children}</span>
      {showArrow && <ArrowRight size={18} strokeWidth={1.5} />}
    </button>
  )
}
