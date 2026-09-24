/**
 * Step2Win Admin — Tailwind theme.
 *
 * Every colour is a CSS variable defined in src/index.css, so the same class
 * renders correctly in the light (default) and dark themes. The legacy names
 * (sidebar.*, surface.*, ink.*, up, down, warn, info, prime) are kept so that
 * existing pages keep working; new code should prefer the semantic aliases
 * (brand, success, danger, warning, neutral). See DESIGN_SYSTEM.md.
 */
const v = (name) => `var(--${name})`

/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        // ── Legacy names (mapped to tokens) ─────────────────────────────
        sidebar: {
          bg:     v('sidebar-bg'),
          item:   v('sidebar-hover'),
          active: v('sidebar-active'),
          border: v('sidebar-border'),
          text:   v('sidebar-text'),
        },
        surface: {
          base:     v('surface-base'),     // page background
          card:     v('surface-card'),     // cards, tables, panels
          elevated: v('surface-elevated'), // hover rows, raised chips, tooltips
          input:    v('surface-input'),    // form controls
          border:   v('border'),           // hairlines
          strong:   v('border-strong'),    // control borders, dividers that must read
          sunken:   v('surface-sunken'),   // segmented control track, code wells
          overlay:  v('surface-overlay'),  // modals, popovers, drawers
        },
        ink: {
          primary:   v('ink-1'), // headings, values
          secondary: v('ink-2'), // body, labels
          muted:     v('ink-3'), // captions, timestamps (still >= 4.5:1)
          disabled:  v('ink-disabled'),
          inverse:   v('ink-inverse'),
          onbrand:   v('on-brand'),
        },
        up:    { DEFAULT: v('success'), soft: v('success-soft') },
        down:  { DEFAULT: v('danger'),  soft: v('danger-soft') },
        warn:  { DEFAULT: v('warning'), soft: v('warning-soft') },
        info:  { DEFAULT: v('info'),    soft: v('info-soft') },
        prime: { DEFAULT: v('brand'),   soft: v('brand-soft') },

        // ── Semantic aliases (preferred for new code) ───────────────────
        brand: {
          DEFAULT: v('brand'),
          hover:   v('brand-hover'),
          soft:    v('brand-soft'),
          text:    v('brand-text'),
          on:      v('on-brand'),
        },
        success: { DEFAULT: v('success'), soft: v('success-soft'), line: v('success-line') },
        danger:  { DEFAULT: v('danger'),  soft: v('danger-soft'),  line: v('danger-line'), fill: v('danger-fill') },
        warning: { DEFAULT: v('warning'), soft: v('warning-soft'), line: v('warning-line') },
        notice:  { DEFAULT: v('info'),    soft: v('info-soft'),    line: v('info-line') },
        violet:  { DEFAULT: v('violet'),  soft: v('violet-soft') },
        neutral: { DEFAULT: v('ink-2'),   soft: v('neutral-soft') },
        chart: {
          1: v('chart-1'), 2: v('chart-2'), 3: v('chart-3'),
          4: v('chart-4'), 5: v('chart-5'), 6: v('chart-6'),
          grid: v('chart-grid'), axis: v('chart-axis'),
        },
      },
      fontFamily: {
        sans: ['"Inter Variable"', 'Inter', 'system-ui', '-apple-system', '"Segoe UI"', 'sans-serif'],
        mono: ['"JetBrains Mono"', 'ui-monospace', 'SFMono-Regular', 'Consolas', 'monospace'],
      },
      fontSize: {
        '2xs': ['11px', { lineHeight: '14px' }],
      },
      borderRadius: {
        '2xl': '12px', // was 16px — admin surfaces are tighter
        '3xl': '16px',
      },
      boxShadow: {
        card:  'var(--shadow-card)',
        glow:  'var(--shadow-card)', // deprecated: kept so old classes still resolve, renders as a plain card shadow
        float: 'var(--shadow-float)',
        pop:   'var(--shadow-pop)',
      },
      zIndex: {
        100: '100',
        200: '200',
      },
    },
  },
  plugins: [],
}
