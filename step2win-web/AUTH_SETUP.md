# Sign in with Google and Sign in with Apple: setup

Last updated: 2026-09-23.

## How it works

1. The app gets an **ID token** from the provider:
   - Google on the website: a popup.
   - Google on Android: Credential Manager.
   - Google on iOS: the Google Sign-In SDK.
   - Apple on iOS: AuthenticationServices.
   - Apple on the website: Sign in with Apple JS in a popup.

   All of these go through `@capgo/capacitor-social-login`, except the website Apple flow, which uses Apple's JS library loaded by the same plugin.
2. For every attempt the app makes a random nonce. It gives the provider `SHA-256(nonce)` and sends the raw nonce to our API together with the token.
3. The backend checks the token itself (`backend/apps/users/social_auth.py`):
   - The signature against Google's or Apple's public keys (JWKS, cached for an hour).
   - The issuer.
   - The audience, which must be one of **our** client ids.
   - The expiry.
   - The nonce. Apple always needs one. For Google it's checked whenever the app sends one, and the app always does.
   - The email must be verified.
4. The backend then finds the account:
   - First by provider + subject (`users.SocialAccount`).
   - Then by verified email. This links an existing password account instead of creating a duplicate.
   - If neither matches, it creates a new account, but only while "New sign-ups" is on in the admin console.
   - Staff accounts can't use Google or Apple sign-in.

   Endpoints: `POST /api/auth/google/` and `POST /api/auth/apple/`.
5. A button only appears when both of these are true:
   - The build has the matching `VITE_` id for that platform.
   - `/api/app/config/` reports `auth_providers.<provider> = true`, meaning the backend has the client ids.

Where each button is available:

| | Web | Android | iOS |
|---|---|---|---|
| Google | yes (popup) | yes (Credential Manager) | yes (Google Sign-In SDK) |
| Apple | yes, https sites only (Apple JS popup) | **not offered yet** (see below) | yes (native, shown first) |

## Where each value goes

| Value | Backend env | Web/app build env (`step2win-web/.env`) | Native project |
|---|---|---|---|
| Google **Web** client id | `GOOGLE_OAUTH_CLIENT_IDS` | `VITE_GOOGLE_CLIENT_ID` | none. Android uses it as `serverClientId` at runtime. |
| Google **iOS** client id | `GOOGLE_OAUTH_CLIENT_IDS` | `VITE_GOOGLE_IOS_CLIENT_ID` | Xcode build setting `GOOGLE_IOS_URL_SCHEME` = the **reversed** iOS client id |
| Google **Android** client ids (debug + release SHA-1) | none. The token's audience is the Web client id. | none | none. They only need to exist in Google Cloud. |
| Apple bundle id `com.step2win.app` | `APPLE_CLIENT_IDS` | none | `App.entitlements` (already added) |
| Apple **Services ID** (web), e.g. `com.step2win.web` | `APPLE_CLIENT_IDS` | `VITE_APPLE_SERVICES_ID` | none |
| Web popup return URL | none | `VITE_AUTH_REDIRECT_URL` (optional, default `<origin>/login`) | none |

Examples:
- Backend: `GOOGLE_OAUTH_CLIENT_IDS=1234-web.apps.googleusercontent.com,1234-ios.apps.googleusercontent.com`
- Backend: `APPLE_CLIENT_IDS=com.step2win.app,com.step2win.web`

None of these values are secrets. No client secret, Apple private key or Google secret is needed for the flows above. If the backend lists are empty, the endpoints return `503 {"code": "provider_not_configured"}` and the buttons stay hidden.

## 1. Google Cloud

Go to https://console.cloud.google.com and pick (or create) the Step2Win project.

1. **OAuth consent screen (Google Auth Platform › Branding / Audience).**
   - App name "Step2Win", support email, logo.
   - Authorised domains: your website domain (for example `vercel.app` for step-2-win-app.vercel.app) and `onrender.com` if you use it.
   - Privacy policy and terms URLs.
   - Scopes: only `openid`, `email` and `profile`, which are non-sensitive, so the app doesn't need verification for them.
   - Publish the app (move it to "In production"). While it's in testing, only listed test users can sign in.
2. **Web client** (Clients › Create client › *Web application*, name "Step2Win web").
   - Authorised JavaScript origins:
     - `https://step-2-win-app.vercel.app` (your production site)
     - `http://localhost:5180` (dev)
   - Authorised redirect URIs:
     - `https://step-2-win-app.vercel.app/login`
     - `http://localhost:5180/login`
   - Copy the client id. It goes in `VITE_GOOGLE_CLIENT_ID` and in backend `GOOGLE_OAUTH_CLIENT_IDS`.
3. **Android clients** (*Android* type). Create **two**, both with package name `com.step2win.app`:
   - **Debug**: get the SHA-1 with `keytool -list -v -keystore %USERPROFILE%\.android\debug.keystore -alias androiddebugkey -storepass android -keypass android`.
   - **Release**: use the **App signing key** SHA-1 from Play Console › Test and release › App integrity › App signing. If you also sideload builds signed with your upload key, add a third client with the upload-key SHA-1.

   You don't put these ids anywhere. Google matches the app's package and signature, and the ID token is issued for the Web client id (`serverClientId`). A missing or wrong SHA-1 usually shows up as "No credentials available" or `DEVELOPER_ERROR` in logcat.
4. **iOS client** (*iOS* type), bundle id `com.step2win.app`.
   - Copy the client id. It goes in `VITE_GOOGLE_IOS_CLIENT_ID` and in backend `GOOGLE_OAUTH_CLIENT_IDS`.
   - Copy the **iOS URL scheme** (the reversed client id, `com.googleusercontent.apps.1234-…`). In Xcode, set App target › Build Settings › User-Defined › `GOOGLE_IOS_URL_SCHEME` to it for both Debug and Release. It's currently the placeholder `com.step2win.app.google-signin-not-configured`.

   `Info.plist` already reads `$(GOOGLE_IOS_URL_SCHEME)`.

## 2. Apple Developer (needs the paid Apple Developer Program)

Go to https://developer.apple.com/account/resources.

1. **App ID** `com.step2win.app` (Identifiers).
   - Tick **Sign in with Apple**, as the primary App ID.
   - The Xcode project already has `App/App.entitlements` with `com.apple.developer.applesignin = [Default]`, and `CODE_SIGN_ENTITLEMENTS` is set for Debug and Release.
   - With automatic signing, Xcode regenerates the profile. In Xcode › Signing & Capabilities you should see "Sign in with Apple". If Xcode offers to "fix" it, accept.
2. **Services ID** for the website (Identifiers › + › Services IDs).
   - For example `com.step2win.web`, description "Step2Win web".
   - Enable Sign in with Apple › Configure:
     - Primary App ID: `com.step2win.app`.
     - Domains: `step-2-win-app.vercel.app`. This must be https. Apple doesn't allow `localhost` or IP addresses.
     - Return URLs: `https://step-2-win-app.vercel.app/login`.
   - The Services ID goes in `VITE_APPLE_SERVICES_ID` and in backend `APPLE_CLIENT_IDS`.
3. **Key**: not needed for sign-in. Our backend verifies the identity token with Apple's public keys. You **will** need a Sign in with Apple key (.p8, plus its Key ID and your Team ID) in two situations:
   - Revoking tokens when an account is deleted (App Store requirement; see "Account deletion" below).
   - Adding Apple sign-in on Android.

   Create it under Keys › + › Sign in with Apple. Store it only in the backend secret store, never in the app.

## 3. After changing values

- Backend: set the two env vars on Render and redeploy. No migration is needed beyond `users.0011_social_account`, which runs with `migrate`.
- App: put the `VITE_` values in `step2win-web/.env` (not committed), then run `npm run build && npx cap sync`.
- iOS: set `GOOGLE_IOS_URL_SCHEME` in Xcode (see above).

## 4. How to test

**Backend (no credentials needed):**
```
manage.py test apps.users.test_social_auth
```
This runs 31 tests with locally signed tokens and a mocked JWKS. They cover: a valid token signs in, the wrong audience, issuer or signature is rejected, an expired token is rejected, a bad or missing Apple nonce is rejected, linking by subject and by verified email, an unverified email is rejected, paused sign-ups block only new accounts, staff accounts are blocked, and missing configuration returns 503.

**Web:**
1. Open `/login` on the https site. Both buttons show.
2. Google: the popup opens, you pick an account, you land on Home.
3. Apple: the Apple popup opens (https only), and you land on Home.
4. Close either popup: nothing happens and no error appears.
5. Sign in with the email of an existing password account: you get the **same** account. Check Admin › Users, or `SocialAccount` in the Django admin.

**Android (real device or emulator with Google Play and a Google account):**
1. Debug build: the debug SHA-1 must be registered.
2. Tap Continue with Google. The Credential Manager account sheet opens, and you're signed in.
3. Settings › Active sessions shows the device.
4. Tap it again, then back out of the sheet: nothing happens.
5. Test the release AAB from Play internal testing. This checks the App signing SHA-1.

**iOS (real device or simulator, Xcode 26):**
1. The Apple button is shown first.
2. On the first Apple sign-in, choose "Hide My Email". The account is created with the relay address and the name you entered.
3. Sign out and sign in again. Apple sends no name or email this time, and you get the same account (matched by subject).
4. Google: the Google Sign-In sheet opens. If you see "missing URL scheme", `GOOGLE_IOS_URL_SCHEME` isn't set.

**Error messages to check:**
- Turn off "New sign-ups" in the admin console. A **new** Google or Apple user sees "New sign-ups are paused…", and an existing user still gets in.
- Turn off wifi before tapping a button: you see "Couldn't reach Step2Win".

## Not included yet

- **Apple on Android.** The plugin can do it only through Apple's web flow, which posts back to a backend URL. To support it, the backend would need:
  - a form-post callback,
  - an authorization-code exchange signed with the Apple .p8 key,
  - a redirect to an app deep link that `MainActivity` forwards to the plugin.

  The plugin's built-in shortcut (`useBroadcastChannel`) sends the Apple response through a third-party Firebase page (`capacitor-social-login.firebaseapp.com`), so we deliberately don't use it. Until this is built, iPhone users who chose "Hide My Email" can't sign in on Android. They can set a password once account settings allow it, or contact support.
- **Setting a password on a Google/Apple-only account.** These accounts get an unusable password, so "Change password" can't be used for them. A "set password" flow would let them sign in with email as well.
- **M-Pesa phone number.** Google and Apple accounts are created without one, just like the old Google flow. This hasn't been checked yet: confirm that deposits and withdrawals ask for a number before launch.

## Account deletion (App Store 5.1.1(v), and Sign in with Apple token revocation)

The app has **no in-app account deletion**. Only admins can delete accounts. Apple requires in-app deletion for any app that lets people create an account, and Google Play requires an in-app path plus a web URL. If Sign in with Apple is used, deleting the account must also revoke the user's Apple tokens (`POST https://appleid.apple.com/auth/revoke`, which needs the .p8 key).

This wasn't built on purpose: wallet balances, challenge entries, payouts and M-Pesa records make it a product and legal decision. Suggested approach:

1. Add Settings › Account › **Delete account**. Explain what happens, and require re-authentication: password, or a fresh Google/Apple sign-in.
2. Block deletion while there is money in play: a non-zero `wallet_balance` or `locked_balance`, an active challenge, or a pending withdrawal. Offer "withdraw first" instead.
3. On confirmation (`POST /api/auth/delete-account/`):
   - Deactivate the user and anonymise personal data: username, email, phone, name, photo, device ids, routes.
   - Keep the financial ledger and transactions as the law requires, linked to the anonymised id.
   - Blacklist all refresh tokens and delete the `SocialAccount` rows.
   - For Apple links, revoke the token. This needs a stored Apple refresh token (from exchanging the authorization code at sign-in with the .p8 key), or an authorization code the app fetches again at deletion time.
4. Publish a web deletion-request page for the Play Data safety form, and describe the retention period in the privacy policy.
