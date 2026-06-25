module.exports = {
  content: [
    "./public/doctor/**/*.{html,js}",
    "./public/admin/**/*.{html,js}",
    "./public/assets/**/*.{html,js}"
  ],
  theme: {
    extend: {
      colors: {
        'brand-primary': '#2A7AD9',
        'brand-blue':    '#4DA8FF',
        'brand-mint':    '#B8F2E6',
        'brand-cream':   '#FFF8E7',
        'brand-coral':   '#FFB5A7',
        'brand-ink':     '#0F2A47',
        'brand-surface': '#F4F8FB'
      },
      fontFamily: { sans: ['Inter','system-ui','sans-serif'] }
    }
  }
}