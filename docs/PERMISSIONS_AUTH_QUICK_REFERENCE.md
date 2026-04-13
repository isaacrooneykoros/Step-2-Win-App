# Permissions & Authentication - Quick Reference Guide

## All Permission-Related Files

### Android Native Code
```
step2win-web/android/app/src/main/java/com/step2win/app/
├── DeviceStepCounterPlugin.java          # Activity recognition permission (MAIN)
└── StepCaptureForegroundService.java     # Background step capture service
```

### Step Permission Logic (TypeScript)
```
step2win-web/src/
├── plugins/deviceStepCounter.ts          # Permission interface
├── hooks/useHealthSync.ts                # Permission check & request logic (CORE)
├── services/notifications.ts             # Notification permission handling
├── screens/SettingsScreen.tsx            # Permission control UI (USER FACING)
└── components/layout/MainLayout.tsx      # Permission modal prompt (USER FACING)
```

---

## All Authentication Files

### Auth Store & State
```
step2win-web/src/
└── store/authStore.ts                    # JWT token storage & auth state (CORE)
```

### Route Guards
```
step2win-web/src/
├── App.tsx                               # Web app routes + ProtectedRoute wrapper
└── screens/LoginScreen.tsx               # Login entry point
step2win-admin/src/
└── components/auth/ProtectedRoute.tsx    # Admin-only guard (CORE)
```

### Backend Auth
```
backend/apps/users/
├── auth_views.py                         # Login, register, logout, device binding (CORE)
├── views.py                              # Protected profile endpoints
└── models.py                             # User model with device fields
```

---

## All Backend Permission Guards

### Endpoints with Permission Classes
```
backend/apps/steps/views.py
├── sync_health()              [LINE 99]  # @permission_classes([IsAuthenticated])
├── today_health()             [LINE 355] # @permission_classes([IsAuthenticated])
└── health_summary()           [LINE 397] # @permission_classes([IsAuthenticated])

backend/apps/challenges/views.py
├── ChallengeListView          [LINE 25]  # permission_classes = [IsAuthenticated]
├── ChallengeDetailView        [LINE 272] # permission_classes = [IsAuthenticated]
└── MyChallengesView           [LINE 257] # permission_classes = [IsAuthenticated]

backend/apps/wallet/views.py
├── list_transactions()        [LINE 65]  # permission_classes = [IsAuthenticated]
├── withdraw()                 [LINE 101] # permission_classes = [IsAuthenticated]
└── list_withdrawals()         [LINE 330] # permission_classes = [IsAuthenticated]

backend/apps/users/views.py
├── bind_device()              [LINE 283] # @permission_classes([IsAuthenticated])
└── profile endpoints          [LINE 228] # @permission_classes([IsAuthenticated])

backend/apps/legal/views.py
├── public endpoints           [LINE 24]  # @permission_classes([AllowAny])
└── admin endpoints            [LINE 110] # @permission_classes([IsAdminUser])
```

---

## All Back Button Handling

### Native Back Button (Android)
```
step2win-web/src/App.tsx
└── NativeBackButtonGuard()    [LINE 88]  # Handles Android back press
    - If canGoBack: window.history.back()
    - If not home: navigate('/')
    - If home: minimize app
```

### UI Back Buttons (All Screens)
```
step2win-web/src/screens/
├── StepsDetailScreen.tsx      [LINE 53]  # ChevronLeft button -> navigate(-1)
├── ProfileScreen.tsx          [SIMILAR]  # Back button pattern
└── [ALL DETAIL SCREENS]                  # Consistent back navigation
```

---

## All Permission-Dependent Screens

### Screens That USE Permission Status
```
step2win-web/src/screens/
├── HomeScreen.tsx             # Uses step data (depends on permission)
├── StepsDetailScreen.tsx      # Step-centric (REQUIRES permission)
├── ProfileScreen.tsx          # Shows permission indicator
├── SettingsScreen.tsx         # Permission control panel (MAIN UI)
└── ChallengesScreen.tsx       # Uses step count in challenge progress

step2win-web/src/components/layout/
└── MainLayout.tsx             # Permission modal prompt (AUTO-TRIGGER)
```

### Screens That DON'T Need Permission
```
step2win-web/src/screens/
├── WalletScreen.tsx           # Finance only
├── SupportScreen.tsx          # Help/contact
└── ActiveSessionsScreen.tsx   # Session management
```

---

## Permission State Flow

### Permission Request Flow
```
1. User clicks "Enable step sensor" in SettingsScreen
2. connectDevice() called from useHealthSync hook
3. ensureAndroidStepPermissions() checks permission status
4. If denied: DeviceStepCounter.requestPermissions()
5. Android system shows permission dialog
6. User allows/denies
7. permissionStatus state updates
8. UI reflects new status (green dot = granted)
```

### Initial Permission Prompt
```
1. App loads MainLayout
2. useEffect runs with permission dependency
3. If permission not granted AND not dismissed:
   - Wait 800ms
   - Show permission modal
4. User can:
   - "Enable all" → requests both permissions
   - "Maybe later" → dismiss (12-hour cooldown)
5. Modal remembered in localStorage
```

---

## Permission States (4 Values)

### On Android Sensor
```
'unknown'     → App just launched, permission status not checked yet
'granted'     → User allowed activity recognition
'denied'      → User rejected, needs manual enable in settings
'unavailable' → No sensor available (non-Android platform)
```

### On Notifications
```
'prompt'                   → Not requested yet
'prompt-with-rationale'    → Need to show explanation
'granted'                  → User allowed notifications
'denied'                   → User rejected notifications
'unavailable'              → N/A
```

---

## Authentication Token Storage

### Native (Capacitor.Preferences)
```
Key: 'access_token'      → JWT token
Key: 'refresh_token'     → Refresh token
Key: 'session_id'        → Session identifier
```

### Web (localStorage fallback)
```
localStorage.setItem('access_token', token)
localStorage.setItem('refresh_token', refresh)
localStorage.setItem('session_id', sessionId)
```

**Initialization:**
```
authStore.init()
  → Try Preferences.get('access_token')
  → Fallback to localStorage.getItem('access_token')
  → Set isAuthenticated = true if found
```

---

## Route Protection Pattern

### Web App
```typescript
// All protected routes require isAuthenticated
<Route element={<ProtectedRoute><MainLayout /></ProtectedRoute>}>
  {/* Routes here only render if isAuthenticated === true */}
</Route>

// If not authenticated, redirects to /login
```

### Admin App
```typescript
// Requires BOTH access token AND is_staff flag
export function ProtectedRoute() {
  if (!accessToken || !user) return <Navigate to="/login" />;
  if (!user.is_staff) return <Navigate to="/login" />;
  return <Outlet />;
}
```

---

## Backend Permission Guards

### Default Setting
```python
# backend/step2win/settings.py (LINE 182)
'DEFAULT_PERMISSION_CLASSES': [
    'rest_framework.permissions.IsAuthenticated',
]
```

### Per-Endpoint Override
```python
@permission_classes([IsAuthenticated])       # Requires login
@permission_classes([AllowAny])               # Public endpoint
@permission_classes([IsAdminUser])            # Admin only
```

---

## API Authorization Header

```
GET /api/health/summary/
Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...
```

**Rate Limiting:**
```
Login attempts:    5/minute    (anti-brute-force)
Health sync:       3600/hour   (1 per second limit enforced)
```

---

## DeviceStepCounter Plugin Methods

### Check Current State
```
await DeviceStepCounter.checkPermissions()
  → { activityRecognition: 'granted' | 'denied' | 'prompt' }
```

### Request Permission
```
await DeviceStepCounter.requestPermissions()
  → Returns same type after user responds
```

### Read Step Count
```
await DeviceStepCounter.getTodaySteps()
  → { 
      steps: 1234,
      date: "2024-04-13",
      available: true,
      cadence_spm: 120,
      burst_steps_5s: 8
    }
```

### Background Capture
```
await DeviceStepCounter.startBackgroundCapture()
  → { running: true }

await DeviceStepCounter.stopBackgroundCapture()
  → { running: false }
```

---

## UI Components for Permissions

### PermissionStatusBanner Component
```
Used to show permission status on individual screens

Props:
- status: 'granted' | 'denied' | 'unavailable'
- permissionName: 'steps' | 'notifications' | 'both'
- onEnable?: () => void (handler for button click)
- dismissible?: boolean (default: true)

If status='granted': Returns null (hidden)
If status='denied': Shows alert with CTA button
If status='unavailable': Shows gray alert
```

### Permission Modal (MainLayout)
```
Shown automatically after 800ms delay
Contains:
- Step tracking permission card
- Notifications permission card
- "Enable all" button
- Individual permission buttons
- "Maybe later" button

Cooldown Logic:
- Dismissed state saved with timestamp
- Won't show again for 12 hours
- Key: 'permissions_permission_modal_dismissed_at'
```

---

## Error Handling

### Permission Denied Error
```
Thrown from: ensureAndroidStepPermissions()
Message: "Activity recognition permission is required to count your steps."
Handler: Catch in connectDevice(), set permissionStatus='denied'
```

### Sync Error Messages
```
Function: extractSyncErrorMessage(error)
Returns: User-friendly error from:
  1. error.response.data.error
  2. error.response.data.detail
  3. error.message
  4. Fallback: "Sync failed. Try again."
```

### Device Binding Error
```
POST /api/users/bind-device/
  → 400 if device_id missing
  → 400 if platform not 'android' or 'ios'
```

---

## Configuration / Environment Variables

### Backend (.env)
```
ADMIN_REGISTRATION_CODE=...          # Required to become admin
DJANGO_ADMIN_URL=admin-s2w-secure/   # Obscured admin URL
LOGIN_LOCKOUT_MINUTES=15
MAX_LOGIN_ATTEMPTS=5
SECURE_SSL_REDIRECT=True
```

### Frontend (.env)
```
VITE_APP_SIGNING_SECRET=...          # Signing key for health sync
VITE_GOOGLE_CLIENT_ID=...            # OAuth
```

---

## All Checks Performed

✅ **Permission Checks:**
- Activity recognition check before sensor read
- Notification permission before scheduling
- Permission status in all reachable screens

✅ **Authentication Checks:**
- isAuthenticated state on all protected routes
- JWT token presence on API calls
- is_staff flag for admin routes
- Backend permission_classes decorator

✅ **Route Protection:**
- ProtectedRoute wrapper all protected app routes
- AuthLoadRedirect handles redirect logic
- Navigate('/login') on auth failure

✅ **Back Button Handling:**
- NativeBackButtonGuard on Android
- UI back buttons on all detail screens
- Minimize instead of exit on home

✅ **UI Feedback:**
- Permission status indicators with colors (green/red/gray/yellow)
- Loading states during permission request
- Toast notifications for success/error
- Permission modal with 12-hour cooldown
