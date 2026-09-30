import type { HTMLAttributes } from 'react'

type Props = HTMLAttributes<HTMLDivElement>

export default function Card({ className = '', children, ...rest }: Props) {
  return (
    <div className={`bg-card border border-border rounded-2xl shadow-card ${className}`} {...rest}>
      {children}
    </div>
  )
}
