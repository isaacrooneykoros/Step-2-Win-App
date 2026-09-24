import { Capacitor } from '@capacitor/core';

/**
 * Sign in with Google / Apple configuration (see AUTH_SETUP.md).
 *
 * Only public client identifiers live here. They are not secrets: every one of them is
 * visible to anyone who opens the app. The server decides which tokens it accepts
 * (GOOGLE_OAUTH_CLIENT_IDS / APPLE_CLIENT_IDS) and reports it in /api/app/config/.
 */

export type SocialProvider = 'google' | 'apple';

const GOOGLE_ID_SUFFIX = '.apps.googleusercontent.com';

const clean = (value: unknown) => (typeof value === 'string' ? value.trim() : '');

/**
 * Step2Win's Google OAuth "Web application" client id (public). Default so every build
 * (web, Android, CI) offers Google sign-in; VITE_GOOGLE_CLIENT_ID overrides it. The backend's
 * GOOGLE_OAUTH_CLIENT_IDS must include the same id.
 */
const DEFAULT_GOOGLE_WEB_CLIENT_ID = '613879611722-ja8q4q1j8tdemag36mo8jk2srmhh7npj.apps.googleusercontent.com';

/** OAuth "Web application" client id. Used by the web popup and by Android as serverClientId. */
export const GOOGLE_WEB_CLIENT_ID = clean(import.meta.env.VITE_GOOGLE_CLIENT_ID) || DEFAULT_GOOGLE_WEB_CLIENT_ID;
/** OAuth "iOS" client id (bundle id com.step2win.app). */
export const GOOGLE_IOS_CLIENT_ID = clean(import.meta.env.VITE_GOOGLE_IOS_CLIENT_ID);
/** Apple Services ID for Sign in with Apple JS on the website (e.g. com.step2win.web). */
export const APPLE_SERVICES_ID = clean(import.meta.env.VITE_APPLE_SERVICES_ID);

export const platform = Capacitor.getPlatform() as 'web' | 'android' | 'ios';

const isGoogleId = (id: string) => id.endsWith(GOOGLE_ID_SUFFIX);

const isHttpsPage = () => typeof window !== 'undefined' && window.location.protocol === 'https:';

/**
 * Where the web popups return. Must be registered exactly: Google "Authorized redirect URIs"
 * and Apple Services ID "Return URLs". The page only needs to load the app; the plugin
 * hands the result back to the opener and closes the popup.
 */
export function webAuthRedirectUrl(): string {
  const override = clean(import.meta.env.VITE_AUTH_REDIRECT_URL);
  if (override) return override;
  return typeof window !== 'undefined' ? `${window.location.origin}/login` : '';
}

/** Whether this build/platform can offer the provider at all (independent of the server). */
export function isProviderConfiguredForPlatform(provider: SocialProvider): boolean {
  if (provider === 'google') {
    if (platform === 'ios') return isGoogleId(GOOGLE_IOS_CLIENT_ID);
    return isGoogleId(GOOGLE_WEB_CLIENT_ID); // web popup + Android Credential Manager
  }
  // Apple
  if (platform === 'ios') return true; // native AuthenticationServices, no client id needed
  if (platform === 'web') return APPLE_SERVICES_ID.length > 0 && isHttpsPage(); // Apple rejects http origins
  // Android would need Apple's web flow through a backend redirect + Apple key; not offered yet.
  return false;
}

/** Apple first on iOS (Apple HIG + App Review expect it at least as prominent), Google first elsewhere. */
export const providerOrder: SocialProvider[] = platform === 'ios' ? ['apple', 'google'] : ['google', 'apple'];
