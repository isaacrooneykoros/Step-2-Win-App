/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      fontFamily: {
        sans: ['DM Sans', 'sans-serif'],
        display: ['DM Serif Display', 'serif'],
      },
      colors: {
        // Backgrounds
        bg: {
          page: 'hsl(var(--bg-page) / <alpha-value>)',
          card: 'hsl(var(--bg-card) / <alpha-value>)',
          input: 'hsl(var(--bg-input) / <alpha-value>)',
          elevated: 'hsl(var(--bg-elevated) / <alpha-value>)',
        },
        // Text
        text: {
          primary: 'hsl(var(--text-primary) / <alpha-value>)',
          secondary: 'hsl(var(--text-secondary) / <alpha-value>)',
          muted: 'hsl(var(--text-muted) / <alpha-value>)',
          inverse: 'hsl(var(--text-inverse) / <alpha-value>)',
        },
        // Borders
        border: {
          DEFAULT: 'hsl(var(--border-default) / <alpha-value>)',
          light: 'hsl(var(--border-light) / <alpha-value>)',
        },
        // Accent colors — used ONLY on icons, progress bars, and badges
        accent: {
          blue: '#4F9CF9',      // Steps / primary action
          pink: '#F472B6',      // Active time / challenges
          yellow: '#FBBF24',    // Wallet / money
          green: '#34D399',     // Completed / success / streak
          purple: '#A78BFA',    // Advanced challenges
          red: '#F87171',       // Warnings / logout
        },
        // Light tinted backgrounds for accent icons
        tint: {
          blue: '#EFF6FF',
          pink: '#FDF2F8',
          yellow: '#FFFBEB',
          green: '#ECFDF5',
          purple: '#F5F3FF',
          red: '#FEF2F2',
        },
      },
      borderRadius: {
        '2xl': '16px',
        '3xl': '24px',
        '4xl': '32px',
      },
      boxShadow: {
        card: '0 1px 3px rgba(0,0,0,0.06), 0 1px 2px rgba(0,0,0,0.04)',
        'card-hover': '0 4px 12px rgba(0,0,0,0.08)',
        modal: '0 20px 60px rgba(0,0,0,0.12)',
      },
    },
  },
  plugins: [],
}
