/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        bg: '#F4EBDD',
        card: '#FFFDF8',
        border: '#DED7C8',
        chip: '#ECE3D3',
        green: '#0D332B',
        'green-2': '#17483D',
        gold: '#C39A52',
        text: '#28251F',
        muted: '#777268',
        'nav-inactive': '#A7B3A7',
        error: '#C4453A',
        success: '#2E7D4F',
        sand: '#E3D6C1',
      },
      fontFamily: {
        serif: ['"Playfair Display"', '"Cormorant Garamond"', 'serif'],
        sans: ['Inter', 'Manrope', 'sans-serif'],
      },
      fontSize: {
        h1: ['32px', { lineHeight: '40px' }],
        h2: ['24px', { lineHeight: '32px' }],
        h3: ['20px', { lineHeight: '28px' }],
        h4: ['16px', { lineHeight: '24px' }],
        body: ['16px', { lineHeight: '24px' }],
        small: ['14px', { lineHeight: '20px' }],
        caption: ['12px', { lineHeight: '16px' }],
        btn: ['16px', { lineHeight: '20px' }],
      },
      boxShadow: {
        card: '0 1px 3px rgba(40,37,31,0.05)',
      },
    },
  },
  plugins: [],
}
