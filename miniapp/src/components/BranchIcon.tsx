type Props = {
  size?: number
  className?: string
}

// Тонкая веточка с листьями — декоративный элемент бренда (рядом с
// логотипом, в аватарах-заглушках, у пунктов списка ингредиентов).
export default function BranchIcon({ size = 20, className = '' }: Props) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      className={className}
    >
      <path d="M12 21c0-6 0-11 4-16" />
      <path d="M12 15c-2.5-1-4-3-4-6" />
      <path d="M14 10c2-.5 3.5-2 4-4.5" />
      <path d="M12 21c1.5-.5 2.5-1.5 3-3" />
    </svg>
  )
}
