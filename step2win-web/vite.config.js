import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
// SPA fallback middleware plugin
function spaFallback() {
    return {
        name: 'spa-fallback',
        configureServer: function (server) {
            return function () {
                server.middlewares.use(function (req, res, next) {
                    var _a;
                    var url = (_a = req.url) === null || _a === void 0 ? void 0 : _a.split('?')[0];
                    if (url && !url.includes('.') && url.startsWith('/') && !url.startsWith('/api')) {
                        req.url = '/index.html';
                    }
                    next();
                });
            };
        }
    };
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
        // The lazily loaded 3D chunk (three.js, onboarding + launch splash only) is ~550 kB; nothing
        // else comes close. Keep the warning for everything else.
        chunkSizeWarningLimit: 600,
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
});
