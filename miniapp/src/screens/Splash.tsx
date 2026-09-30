import { useNavigate } from 'react-router-dom'
import BranchIcon from '../components/BranchIcon'
import Button from '../components/Button'
import ImageWithFallback from '../components/ImageWithFallback'

export default function Splash() {
  const navigate = useNavigate()

  return (
    <div className="relative h-full w-full overflow-hidden">
      <ImageWithFallback src="/images/splash.jpg" alt="" className="absolute inset-0 w-full h-full object-cover" />
      <div
        className="absolute inset-0"
        style={{ background: 'linear-gradient(to bottom, rgba(13,51,43,0.25) 0%, rgba(13,51,43,0.55) 55%, rgba(13,51,43,0.85) 100%)' }}
      />
      <div className="relative h-full flex flex-col">
        <div className="flex-1 flex flex-col items-center justify-center gap-4 px-8 pt-8 text-center">
          <BranchIcon size={56} className="text-[#F4EBDD]" />
          <div className="font-serif uppercase tracking-[0.3em] text-[34px] text-[#F4EBDD] leading-tight">
            P A U S E.
          </div>
          <div className="text-[12px] uppercase tracking-[0.25em] text-[#F4EBDD]/80 leading-relaxed">
            more than lunch,
            <br />
            packed with care
          </div>
        </div>
        <div className="px-5 pb-10">
          <Button variant="primary" noArrow onClick={() => navigate('/home')}>
            Начать
          </Button>
        </div>
      </div>
    </div>
  )
}
