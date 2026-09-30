import BranchIcon from './BranchIcon'

type Props = {
  light?: boolean
  size?: number
}

// «P A U S E.» — Playfair Display, uppercase, разрядка 0.35em, с точкой,
// цвет green (или светлый на тёмном фоне сплэша), слева веточка.
export default function Logo({ light = false, size = 20 }: Props) {
  const color = light ? 'text-[#F4EBDD]' : 'text-green'
  return (
    <div className={`flex items-center gap-1.5 ${color}`}>
      <BranchIcon size={size} />
      <span className="font-serif uppercase tracking-[0.35em] text-[15px] leading-none">P A U S E.</span>
    </div>
  )
}
