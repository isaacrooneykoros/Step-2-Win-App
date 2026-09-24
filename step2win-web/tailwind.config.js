/** @type {import('tailwindcss').Config} */
const token = (name) => `hsl(var(--${name}) / <alpha-value>)`;

export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      fontFamily: {
        sans: ['"DM Sans Variable"', '"DM Sans"', 'system-ui', 'sans-serif'],
        // Kept for backwards compatibility; the product type system is DM Sans only.
        display: ['"DM Sans Variable"', '"DM Sans"', 'system-ui', 'sans-serif'],
      },
      fontSize: {
        // Product type scale — size / line-height / tracking / weight
        display: ['40px', { lineHeight: '44px', letterSpacing: '-0.035em', fontWeight: '700' }],
        'title-lg': ['28px', { lineHeight: '34px', letterSpacing: '-0.025em', fontWeight: '700' }],
        title: ['22px', { lineHeight: '28px', letterSpacing: '-0.02em', fontWeight: '700' }],
        headline: ['17px', { lineHeight: '22px', letterSpacing: '-0.01em', fontWeight: '600' }],
        body: ['15px', { lineHeight: '22px' }],
        callout: ['14px', { lineHeight: '20px' }],
        caption: ['12px', { lineHeight: '16px' }],
        micro: ['11px', { lineHeight: '14px', letterSpacing: '0.02em' }],
      },
      colors: {
        // Surfaces
        bg: {
          page: token('bg-page'),
          card: token('bg-card'),
          input: token('bg-input'),
          elevated: token('bg-elevated'),
          sunken: token('bg-sunken'),
        },
        // Text
        text: {
          primary: token('text-primary'),
          secondary: token('text-secondary'),
          muted: token('text-muted'),
          inverse: token('text-inverse'),
        },
        border: {
          DEFAULT: token('border-default'),
          light: token('border-light'),
        },
        // Brand
        brand: {
          DEFAULT: token('brand'),
          hover: token('brand-hover'),
          active: token('brand-active'),
          soft: token('brand-soft'),
          fg: token('brand-fg'),
        },
        // Money earned / payouts only
        reward: {
          DEFAULT: token('reward'),
          soft: token('reward-soft'),
          ink: token('reward-ink'),
        },
        // Semantic status colours
        success: { DEFAULT: token('success'), soft: token('success-soft') },
        warning: { DEFAULT: token('warning'), soft: token('warning-soft') },
        danger: { DEFAULT: token('danger'), soft: token('danger-soft') },
        error: { DEFAULT: token('danger'), soft: token('danger-soft') },
        info: { DEFAULT: token('info'), soft: token('info-soft') },
        // Legacy accent palette — remapped onto semantic tokens so older markup stays on-brand.
        // New code should use brand / reward / success / warning / danger / info.
        accent: {
          blue: token('brand'),
          green: token('success'),
          yellow: token('reward'),
          red: token('danger'),
          purple: token('info'),
          pink: token('info'),
          cyan: token('info'),
        },
        tint: {
          blue: token('brand-soft'),
          green: token('success-soft'),
          yellow: token('reward-soft'),
          red: token('danger-soft'),
          purple: token('info-soft'),
          pink: token('info-soft'),
        },
      },
      borderRadius: {
        '2xl': '16px',
        '3xl': '24px',
        '4xl': '32px',
        card: '20px',
        control: '14px',
      },
      boxShadow: {
        card: '0 1px 2px hsl(var(--shadow-color) / 0.04)',
        'card-hover': '0 6px 18px -8px hsl(var(--shadow-color) / 0.14)',
        raised: '0 10px 30px -12px hsl(var(--shadow-color) / 0.18)',
        modal: '0 -8px 40px -12px hsl(var(--shadow-color) / 0.25)',
      },
      transitionDuration: {
        instant: '80ms',
        fast: '150ms',
        normal: '240ms',
        deliberate: '420ms',
      },
      transitionTimingFunction: {
        standard: 'cubic-bezier(0.2, 0, 0, 1)',
        enter: 'cubic-bezier(0.05, 0.7, 0.1, 1)',
        exit: 'cubic-bezier(0.3, 0, 0.8, 0.15)',
        spring: 'cubic-bezier(0.34, 1.36, 0.64, 1)',
      },
      minHeight: {
        touch: '44px',
      },
      minWidth: {
        touch: '44px',
      },
    },
  },
  plugins: [],
}
