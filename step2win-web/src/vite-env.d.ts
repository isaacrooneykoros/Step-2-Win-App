/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_API_BASE_URL: string;
  readonly VITE_WS_URL: string;
  /** Google OAuth Web client id (web popup + Android serverClientId). */
  readonly VITE_GOOGLE_CLIENT_ID: string;
  /** Google OAuth iOS client id. */
  readonly VITE_GOOGLE_IOS_CLIENT_ID: string;
  /** Apple Services ID for Sign in with Apple on the website. */
  readonly VITE_APPLE_SERVICES_ID: string;
  /** Optional: popup return URL for web sign-in (default: <origin>/login). */
  readonly VITE_AUTH_REDIRECT_URL: string;
  readonly VITE_APP_SIGNING_SECRET: string;
  readonly VITE_APP_VERSION: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
