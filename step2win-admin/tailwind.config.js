/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        // Sidebar
        sidebar: {
          bg:     '#0A0C12',   // deepest dark — sidebar background
          item:   '#111318',   // nav item hover
          active: '#16192A',   // active nav item
          border: '#1C1F2E',   // sidebar right border
        },
        // Main panel
        surface: {
          base:     '#0E1016',  // page background
          card:     '#13161F',  // card background
          elevated: '#191C28',  // modals, dropdowns, tooltips
          input:    '#1C1F2E',  // input field backgrounds
          border:   '#21263A',  // card borders
        },
        // Text hierarchy
        ink: {
          primary:   '#F0F2F8',  // headings, important numbers
          secondary: '#7B82A0',  // labels, descriptions
          muted:     '#3D4260',  // captions, disabled, timestamps
        },
        // Semantic
        up:      '#22D3A0',   // teal-green — positive, growth
        down:    '#F06060',   // soft red — negative, decline
        warn:    '#F5A623',   // amber — pending, warning
        info:    '#4F9CF9',   // blue — info, Step2Win brand blue
        prime:   '#22C55E',   // vault-like green primary accent
      },
      fontFamily: {
        sans: ['Inter', 'sans-serif'],
        mono: ['JetBrains Mono', 'monospace'],
      },
      borderRadius: {
        '2xl': '16px',
        '3xl': '20px',
      },
      boxShadow: {
        card:  '0 1px 3px rgba(0,0,0,0.4), 0 4px 12px rgba(0,0,0,0.2)',
        glow:  '0 0 20px rgba(34,197,94,0.14)',
        float: '0 8px 32px rgba(0,0,0,0.5)',
      },
    },
  },
  plugins: [],
}
