/**
 * NeoKidsPro EMR · Tailwind configuration  (v3.1 — Blue-Green rebrand)
 *
 * Primary brand identity: Blue-Green #89BCBD (per Brand Book).
 * Pink / coral / yellow / lavender / lime are used SPARINGLY as accents only.
 */
module.exports = {
  content: [
    "./public/doctor/**/*.{html,js}",
    "./public/admin/**/*.{html,js}",
    "./public/assets/**/*.{html,js}"
  ],
  theme: {
    extend: {
      colors: {
        // ── Primary identity ──
        'brand-primary':  '#89BCBD',   // Blue-Green (NeoKidsPro primary)
        'brand-primary-600': '#5A9495',
        'brand-teal':     '#89BCBD',
        'brand-teal-50':  '#F1F7F7',
        'brand-teal-100': '#DCEBEB',
        'brand-teal-300': '#A4CDCE',
        'brand-teal-500': '#6FAAAB',
        'brand-teal-700': '#467878',

        // ── Sparing accents (Brand Book palette) ──
        'brand-pink':     '#FE84A4',   // Soft Coral Pink
        'brand-pink-50':  '#FFF1F5',
        'brand-orange':   '#F9A945',   // Warm Apricot
        'brand-yellow':   '#FED960',   // Soft Sun
        'brand-purple':   '#CE7ED4',   // Soft Lavender
        'brand-lime':     '#C0CF56',   // Fresh Lime
        'brand-blush':    '#FFEEEF',   // Warm Blush White

        // ── Neutrals ──
        'brand-ink':      '#0F2E3A',
        'brand-mint':     '#DCEBEB',
        'brand-cream':    '#FFEEEF',
        'brand-coral':    '#FE84A4',
        'brand-surface':  '#F7FAFA'
      },
      fontFamily: {
        sans:    ['Inter', 'system-ui', 'sans-serif'],
        display: ['Poppins', 'Inter', 'system-ui', 'sans-serif']
      },
      borderRadius: {
        'card': '18px',
        'pill': '999px'
      },
      boxShadow: {
        'soft':  '0 1px 2px rgba(15,46,58,.05), 0 4px 14px -6px rgba(15,46,58,.08)',
        'card':  '0 4px 12px -2px rgba(15,46,58,.08), 0 16px 32px -12px rgba(15,46,58,.14)',
        'lift':  '0 24px 48px -16px rgba(15,46,58,.22)'
      }
    }
  }
};
