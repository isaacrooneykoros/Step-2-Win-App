# Step2Win mobile release guide (Android + iOS)

Last updated: 2026-09-23. Store requirements were checked on that date. Check them again before every submission.

## 1. Store requirements

| Store | Requirement | Source |
|---|---|---|
| Google Play | From **31 Aug 2026**, new apps and app updates must target **Android 16 (API 36)** or higher. You can ask for an extension to 1 Nov 2026. Existing apps must target API 35+ to stay visible to new users on newer Android versions. | https://developer.android.com/google/play/requirements/target-sdk |
| App Store | Since **28 Apr 2026**, uploads must be built with **Xcode 26+** and the **iOS 26 SDK**. Since **9 Sep 2026**, apps must target **iOS 13 or later**. | https://developer.apple.com/news/upcoming-requirements/ |

## 2. Capacitor version, and why

We upgraded from **Capacitor 5.7.8 to 8.5.2**, the latest stable version (npm `latest`). Capacitor 9 is still alpha.

Capacitor 8 meets both store rules:
- It compiles and targets API 36.
- It requires Xcode 26.
- It has a minimum of iOS 15, which meets Apple's iOS 13+ rule.

Capacitor 8 needs this toolchain:
- Node 22 or later (this machine has 22.17).
- JDK 21 (e.g. Eclipse Temurin 21 or Android Studio's bundled JBR). Point `JAVA_HOME` at it for the Gradle build.
- Android Studio Otter (2025.2.1) or later.
- AGP 8.13.0, Gradle 8.14.3, and google-services 4.4.4.
- Xcode 26 on macOS.

Migration guides followed: https://capacitorjs.com/docs/updating/6-0, https://capacitorjs.com/docs/updating/7-0 and https://capacitorjs.com/docs/updating/8-0

| Package | Before | After |
|---|---|---|
| @capacitor/core, cli, android | 5.7.8 | 8.5.2 |
| @capacitor/ios | not installed | 8.5.2 |
| @capacitor/app, device, filesystem, haptics, keyboard, local-notifications, network, preferences, share, splash-screen | 5.x | 8.x |
| @capacitor/status-bar | 5.0.8 | **removed**. It is replaced by the core `SystemBars` API (see below). |
| @capacitor-community/sqlite | 5.7.4 | 8.1.1 |
| @aparajita/capacitor-biometric-auth | 7.2.0 | 10.0.0 (the major version built for Capacitor 8) |

### Android settings after the upgrade

These live in `android/variables.gradle`, `android/build.gradle` and the Gradle wrapper:
- minSdk stays at 26 (the Java code uses `java.time`).
- compileSdk and targetSdk are **36**.
- AndroidX versions match the Capacitor 8 template.
- The `configChanges` attribute now also includes `navigation|density`.
- The Gradle DSL uses the `namespace =`, `compileSdk =` and `ignoreAssetsPattern =` syntax.
- `android.suppressUnsupportedCompileSdk` is removed.

### Edge-to-edge

Android 15 and later force edge-to-edge layout when an app targets API 36. On Android 16 you can't opt out. Because of this, `StatusBar.setOverlaysWebView` and `setBackgroundColor` no longer have any effect.

How the app handles it now:
- `src/lib/nativeShell.ts` uses `SystemBars.setStyle` (from `@capacitor/core`) so the bar icons follow the in-app light/dark theme.
- The page background shows through the status bar area.
- The layout pads itself with `env(safe-area-inset-*)`. `index.html` already has `viewport-fit=cover`.
- The `SystemBars` plugin (config: `insetsHandling: 'css'`) injects `--safe-area-inset-*` values for older WebViews.
- The window background is now the page colour (`styles.xml`), so there's no grey band on older WebViews.

## 3. Android release steps

1. **Build the web app for production.** Set `VITE_API_BASE_URL=https://step-2-win-app.onrender.com` (or leave it empty to use the default), then run `npm run build` and `npx cap sync android`. Never ship a build that was made with `http://10.0.2.2:8000`.
2. **Create an upload key once** and keep it out of git. Enrol in Play App Signing.
   ```
   keytool -genkeypair -v -keystore step2win-upload.jks -alias upload -keyalg RSA -keysize 4096 -validity 10000
   ```
3. **Set up signing.** Either:
   - add a `signingConfigs.release` block to `android/app/build.gradle` that reads from `~/.gradle/gradle.properties` or environment variables, or
   - use `npx cap build android --keystorepath … --keystorepass … --keystorealias upload --keystorealiaspass … --androidreleasetype AAB`. `capacitor.config` already sets `releaseType: 'AAB'`.
4. **Bump the version numbers** in `android/app/build.gradle` for every upload: `versionCode` (must increase) and `versionName`.
5. **Build the bundle** with `cd android && gradlew.bat bundleRelease` (JDK 21). The output is `app/build/outputs/bundle/release/app-release.aab`.
6. **Upload to Play Console.** Go to Internal testing, then Closed testing, then Production. New personal developer accounts must run a closed test with at least 12 testers for 14 days before they can release to production.
7. **Check release security.**
   - `network_security_config.xml` blocks cleartext traffic. The cleartext overlay for 10.0.2.2/localhost exists only in `app/src/debug`.
   - `allowMixedContent` is false.
   - `MainActivity` relaxes mixed content only when `FLAG_DEBUGGABLE` is set.
   - Debug builds log plugin results to logcat, including stored tokens returned by Preferences. Release builds don't, because Capacitor's `loggingBehavior` defaults to debug-only. Don't change that setting.

### Play Console declarations for this app

- **Foreground service type `health`.** `StepCaptureForegroundService` needs `FOREGROUND_SERVICE_HEALTH` and runtime `ACTIVITY_RECOGNITION`. In App content, open *Foreground service permissions*, declare **Health**, and describe the task: "Counts the user's steps with the step sensor while the app is closed, so daily steps and step challenges are recorded." Attach a short video of the ongoing "Counting your steps" notification.
- **`ACCESS_BACKGROUND_LOCATION`.** Fill in the location permissions declaration. The feature is "route of your walks on the step history map while the app is closed".
  - You must show in-app prominent disclosure before the system prompt. The permission sheet in `MainLayout` and Settings › App permissions already explain it. Make sure a reviewer can see that text before the prompt appears.
  - You need a video.
  - Play often rejects background location for fitness apps if the feature isn't core. If it's rejected, remove the permission. Foreground routes still work.
- **`SCHEDULE_EXACT_ALARM`.** Play only allows this for apps whose core function is alarms or calendars. Step2Win's reminders are now scheduled **inexact** (`isExactNotification: false` in `src/services/notifications.ts`), so nothing needs this permission any more.
  - **Recommendation:** before launch, remove `SCHEDULE_EXACT_ALARM` from the manifest and hide the "Alarms & reminders" row. The row already hides itself when the state is `unavailable`.
  - Keeping the permission means filing the exact-alarm declaration, and it will probably be refused.
- **`ACTIVITY_RECOGNITION`, `POST_NOTIFICATIONS`, `CAMERA`, `RECEIVE_BOOT_COMPLETED`, `WAKE_LOCK`.** These are standard. The camera is only used for QR invites, and it's optional (`required=false`).
- **Health apps declaration.** Declare the app as a fitness/health app. It has step counting, reads no Health Connect data, and makes no medical claims.
- **Real-money features.** Paid step challenges with KSh entries and payouts may count as **real-money gaming/contests** under Play policy, depending on how they're structured (skill-based fitness contests vs. games of chance). Get this checked before launch. Some countries need a licence, and Play may require the Real-Money Gambling/Contest form. Also complete the **Financial features** declaration: M-Pesa wallet, deposits and withdrawals.

### Data safety form (Play)

Declare the following:
- **Collected:**
  - Personal info: name, email, phone number, user IDs, profile photo.
  - Financial info: purchase history, wallet transactions, and M-Pesa phone numbers used for payments.
  - Health & fitness: step count, distance, calories, active minutes, and the gait/motion features used for anti-cheat.
  - Location: precise location for walking routes (optional).
  - App activity and in-app messages (challenge chat).
  - Device or other IDs: `ANDROID_ID`-based device ID, used for fraud prevention and session binding.
- **Purposes:** app functionality, fraud prevention/security, and account management.
- **Sharing:** none for ads. Payment data goes to the payment processor (IntaSend/M-Pesa) as a service provider, which isn't counted as "sharing" if it's only for processing.
- **Security:** data is encrypted in transit. Users can delete their account in the app and on the web.
- **Data deletion:**
  - Answer "Yes, users can request that their data is deleted".
  - **Delete account URL:** `https://step-2-win-app.onrender.com/account/delete/`. This public page is served by the backend and needs no JavaScript. Users sign in with their username or email and password, then confirm. It follows the same rules as the app. If you move the API to another domain, update this URL.
  - The in-app path is Settings › Danger zone › **Delete account**.
  - Tick "some data is kept" and give the reason: "Wallet transactions, M-Pesa payments, withdrawals and challenge results are kept in anonymised form for financial record-keeping and tax obligations. Fraud-prevention and support records are kept without contact details."
  - Personal info, profile photo, step/health data, precise location and device IDs are deleted straight away.

### Account deletion: what happens

The policy is "anonymise, keep money records". The code is in `backend/apps/users/account_deletion.py`.
- **Blocked** while the wallet balance is above zero (withdraw first), while a challenge is still pending or active or there's a locked balance, while a withdrawal is pending review, approved or processing, or while an M-Pesa deposit from the last 24 hours is still unconfirmed. Staff accounts are also blocked. The app and the web page show the specific reason and what to do.
- **Deleted:**
  - The username, email and phone are replaced with `deleted_<id>` placeholders. The name is cleared.
  - The profile photo file is removed.
  - Google and Apple links, health and hourly steps, GPS waypoints, sync events, verification rows and device registrations are deleted. Step sessions are deleted unless they are under an anti-cheat review.
  - Every session and refresh token is revoked, and sign-in is disabled.
- **Kept, linked to the anonymised user:** the wallet ledger, M-Pesa payment transactions, withdrawal requests, challenge participation and results, fraud flags and trust scores, legal acknowledgements, and support tickets. On the customer's own ticket messages, the sender name is replaced.
- **Admin:** an `account_deleted` audit entry is written. It records the reason "self-service" and the channel `app` or `web`, and contains no PII. The admin console shows the user as **Deleted**, and a deleted account can't be unbanned, edited or given a new password.
- If the user signs up again later, they get a new, empty account.

## 4. iOS: steps for later, on a Mac or cloud Mac

What's already done in this repo (the `ios/` folder, which Windows generated):
- The Xcode project uses **Swift Package Manager**. This is the Capacitor 8 default. All 12 plugins ship a `Package.swift`, so CocoaPods isn't needed.
- The bundle id is `com.step2win.app`, the display name is "Step2Win", and the deployment target is iOS 15.0.
- `App/Info.plist` has these usage strings:
  - `NSMotionUsageDescription`
  - `NSFaceIDUsageDescription`
  - `NSCameraUsageDescription`
  - `NSLocationWhenInUseUsageDescription` (foreground only; there's no "Always" key)
  - `NSPhotoLibraryAddUsageDescription` (for "Save Image" from the share sheet)

  It also sets `ITSAppUsesNonExemptEncryption=false` and requires `arm64`. **No `UIBackgroundModes`**: the app needs none.
- Native plugins, added to the App target in `project.pbxproj`:
  - `App/DeviceStepCounterPlugin.swift` (CoreMotion)
  - `App/AppSystemPlugin.swift` (settings links, camera permission, app-switcher blur)
  - `App/MainViewController.swift`, which registers both plugins. `SceneDelegate.swift` and `Main.storyboard` use it.
- Branded assets:
  - `Assets.xcassets/AppIcon.appiconset`: a single 1024 icon without alpha, plus a dark variant.
  - `Splash.imageset`: light and dark versions.

### Steps on the Mac

1. Install Xcode 26 or later and Node 22 or later. Clone the repo. **Copy `ios/` across:** it's currently gitignored (see the "Version control" section below). Then run `npm ci`, `npm run build` (production API URL) and `npx cap sync ios`.
2. Run `npx cap open ios`. Xcode resolves the SPM packages (Capacitor, SQLCipher, ZIPFoundation and so on) on first open.
3. **Build before anything else.** The Swift code was written against the Capacitor 8.5 API but couldn't be compiled on Windows. Fix any compiler errors first. The most likely spots are closure type inference in `stateQueue.sync { … }` and `@MainActor` warnings about `UIDevice`/`UIApplication` from plugin threads.
4. **Signing and capabilities.** Set the Team and let Xcode manage signing.
   - Capabilities: **Sign in with Apple** is required. `App/App.entitlements` is already referenced by `CODE_SIGN_ENTITLEMENTS`, and the App ID needs the capability ticked. Also set the `GOOGLE_IOS_URL_SCHEME` build setting (see `AUTH_SETUP.md`). Don't add HealthKit. We read steps through CoreMotion, and HealthKit would need its own entitlement, usage strings and review.
   - Push notifications are only needed if remote push is added later. Local notifications need no capability.
5. **Add `PrivacyInfo.xcprivacy`** to the App target (File › New › App Privacy). Declare:
   - `NSPrivacyAccessedAPICategoryUserDefaults` with reason `CA92.1`, because our plugins use UserDefaults.
   - `NSPrivacyTracking = false`.

   Capacitor and the plugins ship their own manifests.
6. **Set the version.** `MARKETING_VERSION` should match Android's `versionName`. `CURRENT_PROJECT_VERSION` must increase with each upload.
7. **Create the app in App Store Connect.** Use the bundle id `com.step2win.app` and SKU `step2win`. Then Product › Archive, and Distribute to TestFlight.
8. **Fill in the App Store privacy labels ("App Privacy").** Use the same data as the Play Data safety form:
   - Contact info, User ID, Health & Fitness, Precise location (optional), Financial info, Purchases, User content (chat), Device ID.
   - Everything is linked to the user, not used for tracking, and used for app functionality and fraud prevention.
9. **App Review notes:**
   - Give a demo account with an active challenge.
   - Explain that steps come from Motion & Fitness.
   - Explain the KSh entry fees and payouts. Guideline 5.3 covers contests; skill-based fitness contests must follow local law, and the official rules must be in the app.
   - The app offers Continue with Google and Sign in with Apple (guideline 4.8). Apple is shown first on iOS and has the same size as Google. Setup is in `AUTH_SETUP.md`.
   - Account deletion (guideline 5.1.1(v)) is in the app under Settings › Danger zone › **Delete account**. The user re-enters their password, or types DELETE if they signed up with Google or Apple. If the biometric lock is on, they also pass the biometric check. A web page is also available at `https://step-2-win-app.onrender.com/account/delete/`. Tell the reviewer that the demo account must have a zero balance and no live challenge to show the full flow. Otherwise the sheet lists what's blocking deletion.
   - **Still to do before submitting with Sign in with Apple enabled:** Apple token revocation on deletion is a no-op hook for now (`revoke_apple_tokens` in `backend/apps/users/account_deletion.py`). See `AUTH_SETUP.md` › Account deletion.
10. **Backend.** CORS already allows `capacitor://localhost`, which is the iOS WebView origin (see `backend/step2win/settings.py`).

### How iOS step counting works (and what to verify on a real iPhone)

- **Reading steps.** `getTodaySteps()` runs `CMPedometer.queryPedometerData(from: midnight, to: now)`. iOS records steps even while the app is closed (the motion co-processor keeps about 7 days of history), so every launch or resume gets the full day's total. **There is no foreground service on iOS.** `startBackgroundCapture()` resolves `{ running: false, supported: false }`.
- **Cadence and bursts.** While the app is open, `CMPedometer.startUpdates` provides `cadence_spm` (CoreMotion's own cadence) and `burst_steps_5s`. Steps that arrive in a batch are spread evenly over the elapsed time, so a delayed batch doesn't look like an impossible burst.
- **Permission.** iOS has no separate request API for Motion & Fitness. The prompt appears on the first pedometer query, and `requestPermissions()` waits up to 60 seconds for the user's answer. If the user denies it, only the Settings app can undo that, so the JS layer opens Settings with the right wording.
- **Missing Android features.** GaitAnalyzer and on-device ML fields are **null** on iOS, and the reading carries `gait_available: false` and `sensor_source: "cmpedometer"`. `useHealthSync` sends them to the backend as null, never 0.
- **Routes.** Waypoints are recorded only while the app is open and location is set to "While Using". The same accuracy, jump and speed filters as Android apply. There is no background location on iOS.
- **Sessions and device ID.** Step sessions and sequence numbers use the same keys and logic as Android, stored in UserDefaults. The device id is `identifierForVendor`.

### Manual test checklist

**iPhone (physical device; the simulator has no pedometer):**
- [ ] First launch: splash, then login. The Motion & Fitness prompt text reads correctly. Allow it, and today's steps match the Health app within a few steps.
- [ ] Walk about 100 steps with the app closed, then open it. Steps update without the app having run.
- [ ] Walk with the app open: steps rise within about 30 seconds. Sync succeeds, and the backend shows `platform=ios` and null gait fields.
- [ ] Deny Motion & Fitness. The banner says "Motion & Fitness", and "Allow" opens Settings › Step2Win.
- [ ] Location "While Using": walk around 200 m with the app open, and the route appears on the day map after sync.
- [ ] The permission sheet shows no background location and no "Alarms & reminders" row.
- [ ] Face ID lock: turn it on, send the app to the background for more than 60 seconds, then return. Face ID prompts, and the app-switcher snapshot is blurred.
- [ ] Camera QR scan works. Denying the camera opens Settings.
- [ ] Share card, then "Save Image": the photo-library prompt appears with our text.
- [ ] Notifications: allow them, and the reminders arrive at 19:00 and 20:00.
- [ ] Light/dark mode: the status bar icons have the right contrast, and nothing is hidden under the notch or home indicator.
- [ ] Offline: turn on Airplane mode, sync (it gets queued), turn it off, and the queue flushes. The SQLite outbox is used on iOS.
- [ ] Deposit and withdraw on the M-Pesa sandbox.

**Android (physical device, Android 14 to 16):**
- [ ] Fresh install: the permission sheet appears, "Physical activity" is allowed, and the ongoing "Counting your steps" notification shows.
- [ ] Reboot the phone: the service restarts (boot receiver) and steps keep counting.
- [ ] Walk with the app killed: steps are counted when you reopen it.
- [ ] Deny Physical activity twice: "Allow" opens App info › Permissions.
- [ ] Background location "Allow all the time": the route keeps recording with the screen off.
- [ ] Logging in does **not** open "Alarms & reminders". (This regression, caused by local-notifications 8.3's exact-by-default, is fixed.)
- [ ] Edge-to-edge in light and dark on Android 15/16 with 3-button and gesture navigation: the header clears the status bar, and the bottom nav clears the nav bar.
- [ ] Predictive back (Android 16): back closes sheets first, then navigates, then double-back exits.
- [ ] Biometric lock with fingerprint and PIN fallback. Recents shows the privacy screen.
- [ ] Release AAB installed through internal testing: no cleartext calls, and it logs in against production.

## 5. Version control

`step2win-web/.gitignore` ignores `android/` and `ios/`. The root `.gitignore` rule `lib/` also ignores `step2win-web/src/lib/`, which holds `nativeShell.ts`, `biometricLock.ts`, `backButton.ts`, `share.ts` and `format.ts`.

That means the custom native code isn't version-controlled:
- the Java plugins and service, manifest, signing and network security config
- the Swift plugins, Info.plist and assets
- the shared JS helpers in `src/lib`

Capacitor recommends committing both native projects. **Recommendation:** remove `android/` and `ios/` from `step2win-web/.gitignore`. They already have their own `.gitignore` files for build output. Also narrow the root `lib/` rule (for example to `/backend/**/lib/` or `venv/lib/`). Then commit.

A local backup of the Capacitor 5 `android/` folder was taken before the upgrade (it was not version-controlled at the time).
