const rawGoogleClientId = import.meta.env.VITE_GOOGLE_CLIENT_ID || '';

export const GOOGLE_CLIENT_ID = rawGoogleClientId;

export const isGoogleClientIdConfigured =
  typeof rawGoogleClientId === 'string' &&
  rawGoogleClientId.endsWith('.apps.googleusercontent.com');

export const googleClientIdHelpText =
  'Set VITE_GOOGLE_CLIENT_ID to a Google OAuth Web Client ID (ends with .apps.googleusercontent.com).';
