import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// base: '/pauseapp/' — приложение раздаётся не с корня домена, а из
// поддомена /pauseapp/ (см. pauseapp.py), поэтому собранные ссылки на
// JS/CSS в index.html должны быть абсолютными относительно этого пути,
// а не относительно корня сайта (там же ещё курьерский /miniapp).
export default defineConfig({
  base: '/pauseapp/',
  plugins: [react()],
})
