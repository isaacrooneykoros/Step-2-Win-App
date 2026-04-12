import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  build: {
    rollupOptions: {
      output: {
        // Keep large vendor deps split for faster caching and smaller initial chunks.
        manualChunks: {
          'vendor-react': ['react', 'react-dom', 'react-router-dom'],
          'vendor-query': ['@tanstack/react-query'],
          'vendor-editor': [
            '@tiptap/react',
            '@tiptap/starter-kit',
            '@tiptap/extension-link',
            '@tiptap/extension-highlight',
            '@tiptap/extension-underline',
            '@tiptap/extension-text-align',
            '@tiptap/extension-table',
            '@tiptap/extension-table-row',
            '@tiptap/extension-table-cell',
            '@tiptap/extension-table-header',
          ],
          'vendor-charts': ['recharts', 'date-fns'],
        },
      },
    },
  },
  server: {
    port: 5174,
    host: true,
    strictPort: true,
  },
})
