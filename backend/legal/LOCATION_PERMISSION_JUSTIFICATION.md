# Location permission: justification (Google Play / App Store)

> **DRAFT: have a lawyer review.** Applies from the Phase 1b release (branch
> `worktree-agent-aa3750b50a3a933bf`), which removes `ACCESS_BACKGROUND_LOCATION` with
> `tools:node="remove"` and records GPS only during walks the user starts. **Do not ship
> any build that still declares background location** (the manifest on `main` does).

## 1. What the app does with location

- The user taps **Start a walk**. Before the first walk the app shows an in-app disclosure
  and asks for consent (`requestConsent('location_walks')`, see `backend/legal/README.md`),
  then the system permission dialog for **precise location while using the app**.
- While that walk runs, `WalkSessionService` (a foreground service with
  `foregroundServiceType="location|health"` and a visible "Walk in progress" notification)
  records GPS fixes (about every 3 s) so the walk can continue with the screen off or the
  phone in a pocket. The service is `START_NOT_STICKY` and is never started from the
  background.
- When the user finishes (or after long inactivity, or 4 hours at most) GPS stops. Nothing is recorded between
  walks. The automatic step service (`foregroundServiceType="health"`) never uses GPS.
- The server keeps the raw points 30 days, then only a simplified route
  (`apps/steps/walks.py`). Routes are never shown to other users. A home privacy zone hides
  the ends of routes.

## 2. Google Play

### Permissions declared
`ACCESS_FINE_LOCATION`, `ACCESS_COARSE_LOCATION`, `FOREGROUND_SERVICE_LOCATION`.
**Not** `ACCESS_BACKGROUND_LOCATION`.

Because access starts from a user-visible action and continues only inside a foreground
service with a notification, Play treats it as **foreground (while-in-use)** access, so
the background location declaration is **not** required **[verify in Play Console: if the
Location permissions form still appears, answer that the app does not access location in
the background]**.

### Foreground service declaration (App content > Foreground service permissions)
- **Type:** Location (`FOREGROUND_SERVICE_LOCATION`).
- **Task description:** "When the user starts a walk, Step2Win records the walk's GPS route
  until the user ends the walk, so the walk counts as verified activity in step challenges.
  The service is started only by the user tapping Start walk while the app is open, shows
  an ongoing 'Walk in progress' notification, and stops when the user ends the walk, after
  a period with no movement, or after 4 hours at most."
  (Suggestion for the Android code: add an "End walk" action to that notification; reviewers
  look for an easy way to stop.)
- **User impact if deferred or interrupted:** the walk route would be incomplete and the
  walk could not be verified.
- **Video:** record: open the app › Start a walk › in-app disclosure › system permission
  (While using the app) › walk with the screen off › notification visible › End walk ›
  summary. Keep under 90 seconds.

### Prominent disclosure text (shown before the system prompt)
> **Use your location during walks?**
> Step2Win records your route only while a walk you started is running. It stops when you
> finish. Never in the background, never sold, never shown to other users. Raw GPS points
> are deleted after 30 days. You can change this any time in Settings › Privacy & your data.
> [Allow during walks] [Not now]

(Implemented in `step2win-web/src/components/privacy/ConsentHost.tsx`.)

## 3. Apple App Store (later)

- `Info.plist`: `NSLocationWhenInUseUsageDescription` only (already the case; no "Always"
  key, no `location` in `UIBackgroundModes` **[verify when the iOS walk is built: continuing
  a walk with the screen locked needs `allowsBackgroundLocationUpdates` with the location
  background mode while a walk runs; declare it and show the blue status bar indicator]**).
- Suggested usage string: "Step2Win uses your location only while a walk you started is
  running, to record its route and verify the walk for challenges."
- App Privacy label: Precise Location, linked to the user, not used for tracking, purpose
  App Functionality (and Fraud Prevention).

## 4. What happens if the user says no

The walk screen explains that walks need location and offers settings. All steps still
count for goals, streaks and XP; only walk-session evidence for challenge money is missing.
