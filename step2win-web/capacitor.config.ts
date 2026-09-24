import { CapacitorConfig } from '@capacitor/cli';

// Keep capacitor.config.json in sync (the CLI reads this file; the JSON copy mirrors it).
const config: CapacitorConfig = {
  appId: 'com.step2win.app',
  appName: 'Step2Win',
  webDir: 'dist',
  server: {
    androidScheme: 'https',
    cleartext: false,
    allowNavigation: [
      'https://step-2-win-app.onrender.com',
      'https://step-2-win-app.vercel.app',
      'https://*.intasend.com',
      'https://*.google.com',
    ],
  },
  plugins: {
    SplashScreen: {
      // Hidden from JS once auth state is restored (src/lib/nativeShell.ts, 6 s safety net).
      launchAutoHide: false,
      launchShowDuration: 1000,
      backgroundColor: '#F6F5F2',
      showSpinner: false,
    },
    // Capacitor 8 core plugin. Android 15+/16 draw edge-to-edge; the web layer pads with
    // env(safe-area-inset-*) (viewport-fit=cover in index.html) and this injects
    // --safe-area-inset-* fallbacks for older Android WebViews.
    SystemBars: {
      insetsHandling: 'css',
      style: 'DEFAULT',
    },
    LocalNotifications: {
      smallIcon: 'ic_stat_step2win',
      iconColor: '#14855D',
    },
    // @capgo/capacitor-social-login: only Google + Apple are bundled. `false` keeps the
    // Facebook SDK (and its trackers) and the Twitter flow out of the native builds.
    // Client ids are passed at runtime from VITE_ env vars (src/config/socialAuth.ts).
    SocialLogin: {
      providers: {
        google: true,
        apple: true,
        facebook: false,
        twitter: false,
      },
      logLevel: 1,
    },
  },
  android: {
    allowMixedContent: false,
    buildOptions: {
      releaseType: 'AAB',
    },
  },
  ios: {
    contentInset: 'never',
    backgroundColor: '#F6F5F2',
  },
};

export default config;
