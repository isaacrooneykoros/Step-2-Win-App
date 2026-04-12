import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// SPA fallback middleware plugin
function spaFallback() {
  return {
    name: 'spa-fallback',
    configureServer(server: any) {
      return () => {
        server.middlewares.use((req, res, next) => {
          const url = req.url?.split('?')[0]
          if (url && !url.includes('.') && url.startsWith('/') && !url.startsWith('/api')) {
            req.url = '/index.html'
          }
          next()
        })
      }
    }
  }
}

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react(), spaFallback()],
  server: {
    port: 5173,
    host: true,
  },
  build: {
    outDir: 'dist',
    sourcemap: false,
    rollupOptions: {
      output: {
        manualChunks: {
          'vendor-react': ['react', 'react-dom', 'react-router-dom'],
          'vendor-query': ['@tanstack/react-query'],
          'vendor-map': ['leaflet', 'react-leaflet'],
          'vendor-capacitor': ['@capacitor/core', '@capacitor/device', '@capacitor/preferences'],
        },
      },
    },
  }
})
