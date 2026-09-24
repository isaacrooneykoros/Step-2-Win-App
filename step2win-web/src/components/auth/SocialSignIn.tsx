import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { appService, authService } from '../../services/api';
import { useAuthStore } from '../../store/authStore';
import { getLoginDeviceInfo } from '../../services/deviceInfo';
import { getProviderCredential, SocialSignInCancelled } from '../../services/socialLogin';
import { isProviderConfiguredForPlatform, providerOrder, type SocialProvider } from '../../config/socialAuth';
import { AppleButton, GoogleButton, OrDivider } from './AuthParts';

const LABEL: Record<SocialProvider, string> = { google: 'Google', apple: 'Apple' };

/** Turn a plugin or API failure into one clear sentence for the form error banner. */
function describeError(provider: SocialProvider, err: unknown): string {
  const name = LABEL[provider];
  const e = err as { response?: { status?: number; data?: { error?: string; code?: string } }; message?: string };

  if (e?.response) {
    const { code, error } = e.response.data ?? {};
    switch (code) {
      case 'provider_not_configured':
        return `${name} sign-in isn't available right now. Please use your email and password.`;
      case 'feature_disabled': // new sign-ups paused; existing accounts still get in
        return `${error ?? 'New sign-ups are paused for a short while.'} Already have an account? Sign in with it.`;
      case 'maintenance':
        return error ?? 'Step2Win is getting a quick upgrade. Please try again shortly.';
      default:
        if (error) return error;
        return `${name} sign-in didn't work. Please try again.`;
    }
  }

  const message = e?.message ?? '';
  if ((err as { isAxiosError?: boolean })?.isAxiosError) {
    return "Couldn't reach Step2Win. Check your connection and try again.";
  }
  if (provider === 'google' && /no credential/i.test(message)) {
    return 'No Google account was found on this device. Add one in your phone settings, then try again.';
  }
  if (/failed to open popup|popup/i.test(message)) {
    return `Your browser blocked the ${name} window. Allow pop-ups for this site and try again.`;
  }
  return `${name} sign-in didn't complete. Please try again.`;
}

/**
 * "Continue with Google" / "Sign in with Apple" block for the login and sign-up screens.
 * A provider is shown only when this build is configured for it on this platform AND the
 * server says it can verify its tokens (/api/app/config/ auth_providers). Apple is listed
 * first on iOS.
 */
export function SocialSignIn({
  mode,
  disabled,
  onBusyChange,
  onError,
}: {
  mode: 'login' | 'register';
  disabled?: boolean;
  onBusyChange?: (busy: boolean) => void;
  onError: (message: string) => void;
}) {
  const navigate = useNavigate();
  const setAuth = useAuthStore((state) => state.setAuth);
  const [busy, setBusy] = useState<SocialProvider | null>(null);

  const configQ = useQuery({
    queryKey: ['app-config'],
    queryFn: appService.getConfig,
    staleTime: 60_000,
    retry: 1,
  });
  const serverProviders = configQ.data?.auth_providers;

  const providers = providerOrder.filter(
    // Unknown server state (offline / older backend): show, the API answers clearly if not set up.
    (p) => isProviderConfiguredForPlatform(p) && serverProviders?.[p] !== false,
  );
  if (providers.length === 0) return null;

  const start = async (provider: SocialProvider) => {
    if (busy) return;
    onError('');
    setBusy(provider);
    onBusyChange?.(true);
    try {
      const credential = await getProviderCredential(provider);
      const device = await getLoginDeviceInfo();
      const response = await authService.socialSignIn(provider, {
        id_token: credential.idToken,
        nonce: credential.rawNonce,
        ...(credential.givenName ? { given_name: credential.givenName } : {}),
        ...(credential.familyName ? { family_name: credential.familyName } : {}),
        ...device,
      });
      await setAuth(response.user, response.access, response.refresh, response.session_id);
      navigate('/');
    } catch (err) {
      if (!(err instanceof SocialSignInCancelled)) {
        console.warn(`${provider} sign-in failed`, err);
        onError(describeError(provider, err));
      }
    } finally {
      setBusy(null);
      onBusyChange?.(false);
    }
  };

  return (
    <>
      <OrDivider />
      <div className="flex flex-col gap-3" aria-label="Other ways to sign in" role="group">
        {providers.map((p) =>
          p === 'google' ? (
            <GoogleButton
              key={p}
              onClick={() => start('google')}
              disabled={disabled || busy !== null}
              isLoading={busy === 'google'}
            />
          ) : (
            <AppleButton
              key={p}
              label={mode === 'register' ? 'Continue with Apple' : 'Sign in with Apple'}
              onClick={() => start('apple')}
              disabled={disabled || busy !== null}
              isLoading={busy === 'apple'}
            />
          ),
        )}
      </div>
    </>
  );
}
