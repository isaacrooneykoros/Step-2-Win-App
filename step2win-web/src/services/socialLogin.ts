import { SocialLogin } from '@capgo/capacitor-social-login';
import CryptoJS from 'crypto-js';
import {
  APPLE_SERVICES_ID,
  GOOGLE_IOS_CLIENT_ID,
  GOOGLE_WEB_CLIENT_ID,
  isProviderConfiguredForPlatform,
  platform,
  webAuthRedirectUrl,
  type SocialProvider,
} from '../config/socialAuth';

/**
 * Thin wrapper over @capgo/capacitor-social-login.
 *
 * Every sign-in uses a fresh random nonce: the provider receives SHA-256(raw) and embeds
 * it in the ID token; the backend receives the raw value and checks the hash, so a token
 * captured elsewhere can't be replayed without the nonce that never left this app.
 */

export interface ProviderCredential {
  provider: SocialProvider;
  idToken: string;
  rawNonce: string;
  /** Apple only shares the name on the very first authorisation. */
  givenName?: string;
  familyName?: string;
}

/** Thrown for a user-initiated cancel so the UI can stay quiet. */
export class SocialSignInCancelled extends Error {
  constructor() {
    super('cancelled');
    this.name = 'SocialSignInCancelled';
  }
}

let initPromise: Promise<void> | null = null;

function ensureInitialized(): Promise<void> {
  if (!initPromise) {
    const google = isProviderConfiguredForPlatform('google')
      ? platform === 'ios'
        ? { iOSClientId: GOOGLE_IOS_CLIENT_ID, mode: 'online' as const }
        : { webClientId: GOOGLE_WEB_CLIENT_ID, mode: 'online' as const, redirectUrl: platform === 'web' ? webAuthRedirectUrl() : undefined }
      : undefined;
    const apple = isProviderConfiguredForPlatform('apple')
      ? platform === 'ios'
        ? {} // native AuthenticationServices; no redirect, token goes straight to our API
        : { clientId: APPLE_SERVICES_ID, redirectUrl: webAuthRedirectUrl() }
      : undefined;
    initPromise = SocialLogin.initialize({ google, apple }).catch((err) => {
      initPromise = null; // allow a retry (e.g. Apple JS failed to load while offline)
      throw err;
    });
  }
  return initPromise;
}

function randomNonce(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/** SHA-256 hex. crypto-js, because crypto.subtle is missing on some WebView origins (capacitor://). */
const sha256Hex = (value: string) => CryptoJS.SHA256(value).toString(CryptoJS.enc.Hex);

const CANCEL_PATTERN =
  /cancel|popup closed|window was closed|access_denied|AuthorizationError error 1001/i;

function isCancel(err: unknown): boolean {
  const e = err as { code?: string; message?: string; errorMessage?: string } | undefined;
  if (e?.code === 'USER_CANCELLED') return true;
  const message = `${e?.message ?? ''} ${e?.errorMessage ?? ''}`;
  return CANCEL_PATTERN.test(message);
}

export async function getProviderCredential(provider: SocialProvider): Promise<ProviderCredential> {
  await ensureInitialized();
  const rawNonce = randomNonce();
  const nonce = sha256Hex(rawNonce);

  try {
    if (provider === 'google') {
      const res = await SocialLogin.login({
        provider: 'google',
        // No extra scopes: the default openid/email/profile sign-in returns the ID token without
        // an additional authorisation step on Android.
        options: { nonce, prompt: 'select_account' },
      });
      const result = res.result as { idToken?: string | null; responseType?: string };
      if (!result?.idToken) throw new Error('Google did not return an ID token.');
      return { provider, idToken: result.idToken, rawNonce };
    }

    const res = await SocialLogin.login({
      provider: 'apple',
      options: { scopes: ['email', 'name'], nonce },
    });
    const result = res.result as { idToken?: string | null; profile?: { givenName?: string | null; familyName?: string | null } };
    if (!result?.idToken) throw new Error('Apple did not return an identity token.');
    return {
      provider,
      idToken: result.idToken,
      rawNonce,
      givenName: result.profile?.givenName || undefined,
      familyName: result.profile?.familyName || undefined,
    };
  } catch (err) {
    if (isCancel(err)) throw new SocialSignInCancelled();
    throw err;
  }
}
