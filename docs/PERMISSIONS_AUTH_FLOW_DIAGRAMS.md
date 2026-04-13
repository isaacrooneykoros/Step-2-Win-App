# Permission & Authentication Flow Diagrams

## 1. APP LAUNCH FLOW

```
┌─────────────────────────────────────────────────────────────────┐
│ User Opens App                                                  │
└────────────────────────────┬────────────────────────────────────┘
                             │
                             ▼
                    ┌─────────────────┐
                    │ Capacitor Loads │ (App initialization)
                    └────────┬────────┘
                             │
                             ▼
                    ┌────────────────────────────┐
                    │ authStore.init()           │
                    │ [Check stored tokens]      │
                    └────────┬───────────────────┘
                             │
                ┌────────────┴────────────┐
                │                         │
                ▼                         ▼
        Token Found?             Token Not Found
                │                         │
                ✓                         ✗
                │                         │
                ▼                         ▼
        isAuthenticated=true  isAuthenticated=false
                │                         │
                ▼                         ▼
        ┌──────────────┐        ┌─────────────────┐
        │ MainLayout   │        │ Launch Screen   │
        │ (Protected)  │        │ (Public)        │
        └──────────────┘        └────────┬────────┘
                │                         │
                ▼                         ▼
        [Show Home]           [Redirect to Login]
```

---

## 2. PERMISSION REQUEST FLOW (Activity Recognition)

```
┌─────────────────────────────────────────────────────────────────┐
│ User Taps "Enable step sensor" in SettingsScreen               │
└────────────────────────────┬────────────────────────────────────┘
                             │
                             ▼
                    ┌───────────────────┐
                    │ connectDevice()   │
                    │ [useHealthSync]   │
                    └────────┬──────────┘
                             │
                             ▼
                   ┌──────────────────────┐
                   │ Check Platform       │
                   │ (Android vs Web/iOS) │
                   └────────┬─────────────┘
                            │
                ┌───────────┴──────────────┐
                │                          │
                ▼                          ▼
            Android?                 Not Android
                │                          │
                ✓                          ✗
                │                          ▼
                ▼                  permissionStatus=
         ensureAndroidStep        'unavailable'
         Permissions()                    │
                │                         ▼
                ▼                    [Show Error Toast]
     DeviceStepCounter
     .checkPermissions()
                │
           ┌────┴────────────┐
           │                 │
           ▼                 ▼
      Granted?          Not Granted
           │                 │
           ✓                 ✗
           │                 │
           ▼                 ▼
        Return      DeviceStepCounter
                    .requestPermissions()
                            │
                            ▼
                    ┌────────────────┐
                    │ Android Shows  │
                    │ Permission Box │
                    └────────┬───────┘
                             │
                ┌────────────┴────────────┐
                │                         │
                ▼                         ▼
            Allow                      Deny
                │                         │
                ▼                         ▼
        permissionStatus        permissionStatus
         = 'granted'             = 'denied'
                │                         │
                ▼                         ▼
        Green Dot UI         Red Dot + Toast
        "Connected"          "Permission Required"
```

---

## 3. LOGIN / AUTHENTICATION FLOW

```
┌────────────────────────────────────────────────────────────────┐
│ Unauthenticated User Visits /challenges (Protected Route)     │
└──────────────────────────┬─────────────────────────────────────┘
                           │
                           ▼
                   ┌──────────────────┐
                   │ ProtectedRoute   │
                   │ checks:          │
                   │ isAuthenticated? │
                   └────────┬─────────┘
                            │
                            ✗ (false)
                            │
                            ▼
                   ┌──────────────────────┐
                   │ <Navigate to="/login"│
                   │  replace />          │
                   └────────┬─────────────┘
                            │
                            ▼
                   ┌──────────────────┐
                   │ LoginScreen      │
                   │ Displayed        │
                   └────────┬─────────┘
                            │
                            ▼
        ┌───────────────────────────────────────┐
        │ User enters email + password          │
        │ Clicks "Sign in"                      │
        └────────────────┬──────────────────────┘
                         │
                         ▼
        ┌────────────────────────────────┐
        │ POST /api/auth/login/          │
        │ {email, password}              │
        └────────────────┬───────────────┘
                         │
                         ▼
        ┌────────────────────────────────────┐
        │ Backend Checks:                    │
        │ - User exists?                     │
        │ - Password correct?                │
        │ - Not locked out? (3 attempts)     │
        └────────────┬──────────────────────┘
                     │
         ┌───────────┴──────────────┐
         │                          │
         ▼                          ▼
      Valid                     Invalid
         │                          │
         ▼                          ▼
    Return                    Return 401
    {access, refresh,         or 429
     sessionId}               (Locked out)
         │                          │
         ▼                          ▼
    ┌─────────────────────┐  [Show Error]
    │ useAuthStore.setAuth│  [Clear fields]
    │ - Save tokens       │
    │ - Set isAuthenticated
    │ - Set user profile
    └────────┬────────────┘
             │
             ▼
    ┌───────────────────┐
    │ Navigate to "/"   │
    │ (Home)            │
    └────────┬──────────┘
             │
             ▼
    MainLayout renders
    [All protected routes
     now accessible]
```

---

## 4. TOKEN REFRESH FLOW

```
API Request (e.g., GET /api/health/summary/)
         │
         ▼
 ┌─────────────────┐
 │ Attach Bearer   │
 │ Authorization   │
 │ Header with     │
 │ access_token    │
 └────────┬────────┘
          │
          ▼
 ┌─────────────────────────┐
 │ Backend: Verify JWT     │
 │ Token Valid?            │
 └────────┬────────────────┘
          │
      ┌───┴────────────┐
      │                │
      ▼                ▼
    Valid           Expired
      │                │
      ✓                ✗
      │                │
      ▼                ▼
   Return          Return 401
   Response        "Token Expired"
      │                │
      │                ▼
      │         ┌──────────────────┐
      │         │ Client: Check if │
      │         │ refresh_token    │
      │         │ exists?          │
      │         └────────┬─────────┘
      │                  │
      │          ┌───────┴────────┐
      │          │                │
      │          ▼                ▼
      │      Exists           Missing
      │          │                │
      │          ✓                ✗
      │          │                │
      │          ▼                ▼
      │  POST /api/token/     Redirect
      │  refresh/             to Login
      │  {refresh_token}      [Clear
      │          │             tokens]
      │          ▼
      │  Return new
      │  access_token
      │          │
      │          ▼
      │  Update in Storage
      │  (Preferences/localStorage)
      │          │
      │          ▼
      │  Retry Original Request
      │  with new token
      │
      └─────────→ [Both flows
                   reach here]
                  │
                  ▼
           User sees result
```

---

## 5. NOTIFICATION PERMISSION FLOW

```
┌─────────────────────────────────────────┐
│ MainLayout component loads              │
└──────────────────┬──────────────────────┘
                   │
                   ▼
        ┌──────────────────────┐
        │ useEffect runs:      │
        │ loadPermissions()    │
        └────────┬─────────────┘
                 │
                 ▼
        ┌──────────────────────────┐
        │ checkNotificationPerm()  │
        └────────┬────────────────┘
                 │
         ┌───────┴────────────┐
         │                    │
         ▼                    ▼
     Native?              Web Platform
     (Android)
         │                    │
         ✓                    ✗
         │                    │
         ▼                    ▼
    LocalNotifications   Return 'granted'
    .checkPermissions()  (default)
         │                    │
         ▼                    ▼
    Return status        ┌──────────────┐
    ('granted',          │ Skip showing │
     'denied',           │ modal        │
     'prompt')           └──────────────┘
         │
         ▼
    setNotificationPermission(status)
         │
         ▼
    ┌──────────────────────────┐
    │ Check if should show     │
    │ permission modal:        │
    │ - Permission not granted?│
    │ - Not dismissed in <12h? │
    └────────┬────────────────┘
             │
      ┌──────┴──────────┐
      │                 │
      ▼                 ▼
    Yes              No
      │                │
      │                ▼
      │         [Don't show modal]
      │
      ▼
  Wait 800ms
      │
      ▼
  ┌────────────────────────────┐
  │ Show Permission Modal:     │
  │ - Step tracking card       │
  │ - Notification card        │
  │ - "Enable all" button      │
  │ - "Maybe later" button     │
  └────────┬───────────────────┘
           │
    ┌──────┴──────────────┐
    │                     │
    ▼                     ▼
  User clicks         User dismisses
  "Enable all"        "Maybe later"
    │                     │
    ▼                     ▼
  LocalNotifications setLocalstorage
  .requestPermissions() 'permissions_
    │                  permission_modal_
    ▼                  dismissed_at'
  Android shows       (12-hour cooldown)
  permission          │
  dialog              ▼
    │            Modal closes
    ▼            [Won't show for 12h]
  User allows
  or denies
    │
    ▼
  setNotificationPermission
  (new status)
    │
    ▼
  Green/Red indicator
  updates
```

---

## 6. BACK BUTTON FLOW (Android)

```
┌─────────────────────────┐
│ User presses             │
│ Physical Back Button     │
│ (Android device)         │
└────────────┬─────────────┘
             │
             ▼
    ┌──────────────────────┐
    │ NativeBackButtonGuard│
    │ listener fires       │
    └────────┬─────────────┘
             │
             ▼
    ┌──────────────────┐
    │ canGoBack === true?
    │ (browser history) │
    └────────┬──────────┘
             │
      ┌──────┴────────┐
      │               │
      ▼               ▼
    YES             NO
      │               │
      ▼               ▼
  window.        Check current
  history.       path
  back()              │
      │      ┌────────┴─────────┐
      │      │                  │
      │      ▼                  ▼
      │   On home '/'?      Not home
      │      │                  │
      │      ✓                  ✗
      │      │                  │
      │      ▼                  ▼
      │   CapacitorApp    navigate('/',
      │   .minimizeApp()   {replace: true})
      │      │                  │
      │      ▼                  ▼
      │  [Keep app         [Go to
      │   running in        home]
      │   background]
      │      │                  │
      └──────┴──────────────────┘
             │
             ▼
    [End of back button
     event handling]
```

---

## 7. COMPLETE PERMISSION STATUS LIFECYCLE

```
INITIALIZATION
    │
    ▼
┌─────────────────────┐
│ permissionStatus    │
│ = 'unknown'         │
└────────┬────────────┘
         │
         ▼
[App runs useHealthSync]
         │
         ▼
    runSyncHealth()
         │
         ▼
┌──────────────────────────────┐
│ Call ensureAndroidStep       │
│ Permissions()                │
└────────┬─────────────────────┘
         │
         ▼
    DeviceStepCounter
    .checkPermissions()
         │
    ┌────┴────────────────────┐
    │                         │
    ▼                         ▼
'granted'              'prompt'/'denied'
    │                         │
    ✓                         ✗
    │                         │
    ▼                         ▼
permissionStatus=   Request
'granted'           permissions
    │                         │
    │                    ┌────┴────────┐
    │                    │             │
    │                    ▼             ▼
    │                'granted'    'denied'
    │                    │             │
    │                    ▼             ▼
    │            permissionStatus  permissionStatus
    │            = 'granted'       = 'denied'
    │                    │             │
    └────────┬───────────┘             │
             │                         │
             ├─────────────────────────┤
             │                         │
             ▼                         ▼
    ✅ Green Dot      ❌ Red Dot
    "Connected"      "Permission Required"
             │
             ├─ Sensor reads work
             ├─ Steps synced
             └─ Background capture running

    SPECIAL CASE: Non-Android → permissionStatus = 'unavailable'
         │
         ▼
    ⚠️  Gray Dot
    "Mobile app required"
```

---

## 8. CROSS-CUTTING CONCERNS

### Rate Limiting
```
Login Attempts:        5/minute
                       ↓
                    Reject with 429
                   (Retry-After header)

Health Sync:           1/second
                       ↓
                    Using Redis
                       ↓
                    Idempotency check
```

### Error Handling
```
Permission Error
    ├─ Thrown: ensureAndroidStepPermissions()
    ├─ Caught: connectDevice()
    ├─ State: permissionStatus = 'denied'
    └─ UI: Toast + Red dot

Auth Error
    ├─ Source: 401 response
    ├─ Check: Has refresh_token?
    ├─ If yes: Refresh and retry
    └─ If no: Redirect to /login

Network Error
    ├─ Caught by fetch/axios
    ├─ Extracted: extractSyncErrorMessage()
    └─ UI: Toast notification
```

---

## 9. PERMISSION STATUS IN DIFFERENT SCREENS

```
HomeScreen
    ├─ Uses: stepsService.getTodayHealth()
    ├─ Dependency: Requires API to have data
    └─ Permission: Backend guards with IsAuthenticated

StepsDetailScreen
    ├─ Uses: stepsService.getSummary()
    ├─ Uses: stepsService.getHistory()
    └─ Dependency: Android permission grants access to sensor

ProfileScreen
    ├─ Shows: Permission status indicator
    │  - Green: step permission granted
    │  - Yellow: pending or initializing
    └─ No hard dependency (read-only display)

SettingsScreen
    ├─ Controls: Permission UI
    ├─ Button: "Enable step sensor"
    │  └─ Calls: connectDevice()
    ├─ Shows: Current status (Connected/Required/Mobile app required)
    └─ Handles: Permission request flow

ChallengesScreen
    ├─ Uses: challengesService.getMyChallenges()
    ├─ Displays: Challenge progress with steps
    └─ Dependency: API returns step data (backend decides)

WalletScreen
    ├─ No permission dependency
    ├─ Uses: walletService.getSummary()
    └─ Independent of step tracking
```

---

## 10. KEY DECISION POINTS

```
Is User Authenticated?
    ├─ NO → Redirect to /login
    └─ YES ↓

Is Platform Native (Android)?
    ├─ NO → Set permissionStatus='unavailable'
    └─ YES ↓

Does User Have Activity Recognition Permission?
    ├─ YES → Show green, enable sensor reads
    ├─ NO (but never asked) → Show modal
    └─ NO (denied) → Show red, offer settings link

Should Show Permission Modal?
    ├─ Already granted? → NO
    ├─ Recently dismissed? → NO (12-hour cooldown)
    └─ Otherwise → YES (after 800ms delay)

Can Device Bind Succeed?
    ├─ Is user authenticated? → NO → 401
    ├─ Is device_id provided? → NO → 400
    ├─ Is platform valid? → NO → 400
    ├─ Is user already bound? → YES → 200 (idempotent)
    └─ Otherwise → YES → 200 & return device record
```

---

## SUMMARY: All Files Working Together

```
┌──────────────────────────────────────────────────────────────┐
│                    App Bootstrap                             │
├──────────────────────────────────────────────────────────────┤
│ 1. Device loads                                              │
│ 2. authStore.init() checks for JWT token                     │
│ 3. Sets isAuthenticated based on token                       │
│ 4. Renders appropriate screen (launch/login/home)            │
└──────────┬───────────────────────────────────────────────────┘
           │
           ├─ PROTECTED ROUTES ────────────────────┐
           │                                       │
           ▼                                       ▼
    If Authenticated              If Not Authenticated
           │                                │
           ▼                                ▼
    MainLayout Rendersred                LoginScreen
    [Full App]                       [Entry Point]
           │                                │
           ├─ Permission Modal             │
           │  └─ Show after 800ms          │
           │     (if needed)               │
           │                               │
           ├─ Health Sync                  │
           │  ├─ useHealthSync hook        │
           │  ├─ Checks permissions        │
           │  └─ Syncs every 1.5s          │
           │                               │
           ├─ Back Button Guard            │
           │  └─ Handles Android back      │
           │                               │
           └─ All Screens Available        └─ Only Login/Register
              ├─ Home                         Available
              ├─ Steps
              ├─ Challenges
              ├─ Wallet
              ├─ Profile
              ├─ Settings
              └─ Support
```

---

## FILE INTERACTION MAP

```
authStore.ts ──────────────────────────┐
                                       │
                   ┌─────────────────────────────┐
                   │                             │
                   ▼                             ▼
         App.tsx ◄─── ProtectedRoute      LoginScreen
           │                                     │
           ├─ AuthLoadRedirect                   │
           │                                     │
           ├─ NativeBackButtonGuard              │
           │                                     │
           └─ <Outlet />                        │
                  │                             │
                  ▼                             │
         MainLayout.tsx ◄───────────────────────┘
              │
              ├─ useHealthSync()  ◄──────────────────┐
              │      │                                │
              │      ├─ deviceStepCounter.ts          │
              │      └─ notifications.ts              │
              │                                       │
              ├─ Permission Modal                     │
              │                                       │
              ├─ NavBar (5 screens)                   │
              │      ├─ HomeScreen                    │
              │      ├─ StepsDetailScreen             │
              │      ├─ ChallengesScreen              │
              │      ├─ WalletScreen                  │
              │      └─ ProfileScreen                 │
              │                                       │
              └─ SettingsScreen                       │
                      │                               │
                      └─ useHealthSync.connectDevice()┘
                         (request permissions)


Backend:
────────
auth_views.py ◄─── POST /api/auth/login/
    │                                    ↓
    ├─ Generate access_token            Returns JWT
    ├─ Generate refresh_token               │
    └─ Create session                       ▼
                                     authStore.setAuth()
                                     [Save tokens]

steps/views.py
    ├─ @permission_classes([IsAuthenticated])
    ├─ Checks JWT header
    ├─ POST /api/health/sync/  ◄─── synced from Android
    ├─ Anti-cheat checks
    └─ Returns health record

Android:
────────
DeviceStepCounterPlugin.java ◄──────── checkPermissions()
                             ◄────── requestPermissions()
                             ◄────── getTodaySteps()
                             └────── startBackgroundCapture()
```
