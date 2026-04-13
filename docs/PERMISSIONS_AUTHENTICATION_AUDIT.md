# Permissions & Authentication Audit Report

## Executive Summary

Comprehensive audit of all permission-related code, authentication guards, back button handling, and permission-dependent features across the Step2Win application.

---

## 1. PERMISSION-RELATED CODE

### 1.1 Android Step Counter Permissions

**File:** [step2win-web/android/app/src/main/java/com/step2win/app/DeviceStepCounterPlugin.java](step2win-web/android/app/src/main/java/com/step2win/app/DeviceStepCounterPlugin.java)

**Current Implementation:**
- **Permission:** `android.permission.ACTIVITY_RECOGNITION`
- **Plugin Method:** `checkPermissions()` - Returns `PermissionState`
- **Plugin Method:** `requestPermissions()` - Requests ACTIVITY_RECOGNITION
- **Plugin Method:** `getTodaySteps()` - Returns step data only if permission granted
- **Plugin Method:** `startBackgroundCapture()` - Starts foreground service with permission check
- **Plugin Method:** `stopBackgroundCapture()` - Stops background service

**Key Code Logic:**
```java
// Permission check
if (getPermissionState("activityRecognition") != PermissionState.GRANTED) {
    call.reject("Activity recognition permission not granted.");
    return;
}

// Request flow
requestPermissionForAlias("activityRecognition", call, "permissionCallback");

// Sensor access guarded by permission state
```

**Permission States:**
- `prompt` - Not requested yet
- `prompt-with-rationale` - Request pending with explanation
- `granted` - Permission authorized
- `denied` - User rejected

---

### 1.2 TypeScript Permission Plugin Interface

**File:** [step2win-web/src/plugins/deviceStepCounter.ts](step2win-web/src/plugins/deviceStepCounter.ts)

**Exported Interface:**
```typescript
export type PermissionState = 'prompt' | 'prompt-with-rationale' | 'granted' | 'denied';

export interface DeviceStepCounterPermissionStatus {
  activityRecognition: PermissionState;
}

export interface DeviceStepCounterPlugin {
  checkPermissions(): Promise<DeviceStepCounterPermissionStatus>;
  requestPermissions(): Promise<DeviceStepCounterPermissionStatus>;
  getTodaySteps(): Promise<DeviceStepCounterReading>;
  startBackgroundCapture(): Promise<DeviceStepCounterBackgroundStatus>;
  stopBackgroundCapture(): Promise<DeviceStepCounterBackgroundStatus>;
  getBackgroundStatus(): Promise<DeviceStepCounterBackgroundStatus>;
}
```

---

### 1.3 Permission Request/Check Implementation

**File:** [step2win-web/src/hooks/useHealthSync.ts](step2win-web/src/hooks/useHealthSync.ts#L237-L254)

**Core Permission Logic:**
```typescript
async function ensureAndroidStepPermissions() {
  const status = await DeviceStepCounter.checkPermissions();
  if (status.activityRecognition === 'granted') {
    return;
  }

  const requested = await DeviceStepCounter.requestPermissions();
  if (requested.activityRecognition !== 'granted') {
    throw new Error('Activity recognition permission is required to count your steps.');
  }
}
```

**Hook Export:**
- `permissionStatus` - returns: `'unknown' | 'granted' | 'denied' | 'unavailable'`
- `connectDevice()` - async function to request permissions and start capture
- `isConnectingDevice` - boolean loading state
- `syncHealthSilent()` - sync health silently with permission check

---

### 1.4 Notification Permissions

**File:** [step2win-web/src/services/notifications.ts](step2win-web/src/services/notifications.ts)

**Functions:**
- `checkNotificationPermission()` - Returns permission state
- `requestNotificationPermission()` - Requests POST_NOTIFICATIONS on Android
- `syncReminderNotifications()` - Schedules reminders only if permission granted
- `openNotificationSettings()` - Opens system notification settings

**Permission Check Flow:**
```typescript
export async function checkNotificationPermission() {
  if (!Capacitor.isNativePlatform()) {
    return 'granted' as const;
  }

  const status = await LocalNotifications.checkPermissions();
  return status.display;
}

export async function requestNotificationPermission() {
  if (!Capacitor.isNativePlatform()) {
    return true;
  }

  const status = await LocalNotifications.requestPermissions();
  return status.display === 'granted';
}
```

**Channel Creation:**
```typescript
async function ensureAndroidChannel() {
  if (!Capacitor.isNativePlatform() || Capacitor.getPlatform() !== 'android') {
    return;
  }

  await LocalNotifications.createChannel({
    id: CHANNEL_ID,
    name: 'Step2Win reminders',
    importance: 4,
  });
}
```

---

## 2. AUTHENTICATION GUARDS & LOGIN REDIRECTION

### 2.1 Web App Authentication Store

**File:** [step2win-web/src/store/authStore.ts](step2win-web/src/store/authStore.ts)

**Auth State:**
```typescript
interface AuthStore {
  user: User | null;
  isAuthenticated: boolean;
  isLoading: boolean;
  sessionId: string | null;
  
  setAuth: (user, access, refresh, sessionId) => Promise<void>;
  logout: () => Promise<void>;
  init: () => Promise<boolean>;  // Initialize from stored tokens
  getAccessToken: () => Promise<string | null>;
  getRefreshToken: () => Promise<string | null>;
}
```

**Token Storage:**
- Uses `Capacitor.Preferences` on native platforms
- Falls back to `localStorage` on web
- Token keys: `access_token`, `refresh_token`, `session_id`

**Initialization Flow:**
1. Attempt to retrieve from `Preferences` (native)
2. Fall back to `localStorage` (web)
3. Set `isAuthenticated: true` if token found
4. Set `isLoading: false`

---

### 2.2 Protected Routes - Web App

**File:** [step2win-web/src/App.tsx](step2win-web/src/App.tsx#L47-L50)

**Route Guard Component:**
```typescript
function ProtectedRoute({ children }: { children: ReactNode }) {
  const isAuthenticated = useAuthStore((state) => state.isAuthenticated);
  return isAuthenticated ? <>{children}</> : <Navigate to="/login" replace />;
}
```

**Route Structure:**
```typescript
<Routes>
  {/* Public routes */}
  <Route path="/launch" element={<LaunchSplashScreen />} />
  <Route path="/login" element={<LoginScreen />} />
  <Route path="/register" element={<RegisterScreen />} />

  {/* Protected routes */}
  <Route element={<ProtectedRoute><MainLayout /></ProtectedRoute>}>
    <Route path="/" element={withSuspense(<HomeScreen />)} />
    <Route path="/steps" element={withSuspense(<StepsDetailScreen />)} />
    <Route path="/challenges" element={withSuspense(<ChallengesScreen />)} />
    <Route path="/wallet" element={withSuspense(<WalletScreen />)} />
    <Route path="/profile" element={withSuspense(<ProfileScreen />)} />
    <Route path="/settings" element={withSuspense(<SettingsScreen />)} />
    <Route path="/support" element={withSuspense(<SupportScreen />)} />
    {/* ...more routes */}
  </Route>
</Routes>
```

**Auth Redirect Logic:**
```typescript
function AuthLoadRedirect({ loading, isAuthenticated }) {
  const location = useLocation();
  const launchSeen = sessionStorage.getItem('launch_seen_v1') === 'true';

  if (loading) return null;

  if (!launchSeen && location.pathname !== '/launch' && 
      location.pathname !== '/login' && location.pathname !== '/register') {
    return <Navigate to="/launch" replace />;
  }

  if (!isAuthenticated && location.pathname !== '/launch' && 
      location.pathname !== '/login' && location.pathname !== '/register') {
    return <Navigate to="/login" replace />;
  }

  return null;
}
```

---

### 2.3 Admin App - Protected Routes

**File:** [step2win-admin/src/App.tsx](step2win-admin/src/App.tsx#L16-L60)

**Admin Route Guard:**
```typescript
export function ProtectedRoute() {
  const { accessToken, user, isHydrated } = useAuthStore();

  if (!isHydrated) {
    return <LoadingUI />;
  }

  if (!accessToken || !user) {
    return <Navigate to="/login" replace />;
  }

  if (!user.is_staff) {
    return <Navigate to="/login" replace />;
  }

  return <Outlet />;
}
```

**Key Checks:**
- `isHydrated` - Auth state loaded from storage
- `accessToken` - JWT token present
- `user.is_staff` - Admin flag required

**Admin Routes:**
```typescript
<Route element={<ProtectedRoute />}>
  <Route path="/" element={<AdminLayout />}>
    <Route index element={<DashboardPage />} />
    <Route path="dashboard" element={<DashboardPage />} />
    <Route path="users" element={<UsersPage />} />
    <Route path="challenges" element={<ChallengesPage />} />
    <Route path="transactions" element={<TransactionsPage />} />
    {/* ...more admin routes */}
  </Route>
</Route>
```

---

### 2.4 Backend Authentication Guards

**File:** [backend/step2win/settings.py](backend/step2win/settings.py#L182-L183)

**Default Permission Class:**
```python
'DEFAULT_PERMISSION_CLASSES': [
    'rest_framework.permissions.IsAuthenticated',
]
```

**Rate Limiting on Login:**
```python
'login': '5/minute'
```

**Login Security:**
- `UPDATE_LAST_LOGIN = True`
- `MAX_LOGIN_ATTEMPTS = 5`
- `LOGIN_LOCKOUT_MINUTES = 15`
- `DEFENDER_LOGIN_FAILURE_LIMIT = 5`
- Failed login middleware: `defender.middleware.FailedLoginMiddleware`

---

## 3. AUTHENTICATION ENDPOINTS & VIEWS

### 3.1 Backend Auth Views

**File:** [backend/apps/users/auth_views.py](backend/apps/users/auth_views.py)

**Protected Endpoints (All require `@permission_classes([IsAuthenticated])`)**:

1. **Logout View** (Line 118)
   - `POST /api/auth/logout/`
   - Clears tokens and sessions

2. **Update Profile** (Line 218)
   - `PUT /api/profile/`
   - Updates user profile data

3. **Delete Account** (Line 263)
   - `POST /api/users/delete-account/`
   - Requires password confirmation

4. **Bind Device** (Line 318)
   - `POST /api/users/bind-device/`
   - Binds Android/iOS device to account
   - Fields: `device_id`, `platform`

5. **Refresh Token** (Line 385)
   - `POST /api/token/refresh/`
   - Refreshes JWT token

**Public Endpoints:**
- `POST /api/auth/login/` - Login with email/password
- `POST /api/auth/register/` - Register new account
- `POST /api/auth/google/` - OAuth login

---

### 3.2 Health/Steps Endpoints

**File:** [backend/apps/steps/views.py](backend/apps/steps/views.py)

**All steps endpoints require `@permission_classes([IsAuthenticated])`:**

1. **Sync Health** (Line 99)
   - `POST /api/health/sync/`
   - Rate limited: 3600/hour
   - Accepts: date, source, steps, distance, calories, active_minutes
   - Anti-cheat checks

2. **Today's Health** (Line 355)
   - `GET /api/health/today/`
   - Returns: today's step count, progress, etc.

3. **Health Summary** (Line 397)
   - `GET /api/health/summary/`
   - Returns: all-time stats, personal records

---

### 3.3 Wallet Endpoints

**File:** [backend/apps/wallet/views.py](backend/apps/wallet/views.py)

**All wallet endpoints require `@permission_classes([IsAuthenticated])`:**

1. **List Transactions** (Line 65)
   - `GET /api/wallet/transactions/`
   - Returns user's transaction history

2. **Withdraw** (Line 101)
   - `POST /api/wallet/withdraw/`
   - Initiate withdrawal request

3. **Withdrawal History** (Line 330)
   - `GET /api/wallet/withdrawals/`
   - Lists withdrawal requests

---

## 4. BACK BUTTON HANDLING & APP LIFECYCLE

### 4.1 Native Back Button Guard

**File:** [step2win-web/src/App.tsx](step2win-web/src/App.tsx#L88-L114)

**Implementation:**
```typescript
function NativeBackButtonGuard() {
  const navigate = useNavigate();
  const location = useLocation();

  useEffect(() => {
    if (!Capacitor.isNativePlatform() || Capacitor.getPlatform() !== 'android') {
      return;
    }

    const listener = CapacitorApp.addListener('backButton', ({ canGoBack }) => {
      if (canGoBack) {
        window.history.back();
        return;
      }

      if (location.pathname !== '/') {
        navigate('/', { replace: true });
        return;
      }

      // Keep app alive in background on home screen
      CapacitorApp.minimizeApp().catch(() => null);
    });

    return () => {
      listener.then((handle) => handle.remove()).catch(() => null);
    };
  }, [location.pathname, navigate]);

  return null;
}
```

**Back Button Behavior:**
- If back stack exists: Go back in history
- If on non-home screen: Navigate to home "/"
- If on home screen: Minimize app (don't exit)

---

### 4.2 UI Back Buttons

**File:** [step2win-web/src/screens/StepsDetailScreen.tsx](step2win-web/src/screens/StepsDetailScreen.tsx#L53-L60)

**Header Back Button:**
```typescript
<button
  onClick={() => navigate(-1)}
  className="w-9 h-9 rounded-xl bg-bg-input flex items-center justify-center"
>
  <ChevronLeft size={20} className="text-text-primary" />
</button>
```

---

## 5. SCREENS ACCESSING PERMISSION-DEPENDENT FEATURES

### 5.1 Permission Status in UI

**SettingsScreen - Permission Indicators**

**File:** [step2win-web/src/screens/SettingsScreen.tsx](step2win-web/src/screens/SettingsScreen.tsx)

**Step Tracking Permission Section:**
```typescript
const { connectDevice, isConnectingDevice, permissionStatus } = useHealthSync();

const deviceStatus = useMemo(() => {
  if (permissionStatus === 'granted') return { label: 'Connected', dot: 'bg-accent-green' };
  if (permissionStatus === 'denied') return { label: 'Permission Required', dot: 'bg-accent-red' };
  if (permissionStatus === 'unavailable') return { label: 'Mobile app required', dot: 'bg-text-muted' };
  return { label: 'Initializing', dot: 'bg-accent-yellow' };
}, [permissionStatus]);
```

**UI Display (Line 482-506):**
- Title: "Step tracking"
- Current status indicator (dot + label)
- Button: "Enable step sensor" / "Step sensor connected"
- Disabled when already granted or connecting

**Notification Permission Section:**
```typescript
const notificationStatus = useMemo(() => {
  if (notificationPermission === 'granted') return { label: 'Enabled', dot: 'bg-accent-green' };
  if (notificationPermission === 'denied') return { label: 'Permission required', dot: 'bg-accent-red' };
  // ...
}, [notificationPermission]);
```

---

### 5.2 Permission Modal - MainLayout

**File:** [step2win-web/src/components/layout/MainLayout.tsx](step2win-web/src/components/layout/MainLayout.tsx#L211-L268)

**Permission Modal Trigger Logic:**
```typescript
useEffect(() => {
  if (!canRequestDevicePermission && !canRequestNotificationPermission) {
    // Don't show modal if all permissions granted
    setShowPermissionModal(false);
    return;
  }

  const dismissedAt = localStorage.getItem('permissions_permission_modal_dismissed_at');
  const cooldownMs = 12 * 60 * 60 * 1000;  // 12 hours
  const recentlyDismissed = dismissedAt ? Date.now() - Number(dismissedAt) < cooldownMs : false;

  if (!recentlyDismissed) {
    const timer = window.setTimeout(() => setShowPermissionModal(true), 800);
    return () => window.clearTimeout(timer);
  }
}, [canRequestDevicePermission, canRequestNotificationPermission]);
```

**Modal Features:**
- Title: "Enable Step2Win permissions"
- Two permission cards (Steps + Notifications)
- Buttons:
  - "Enable all permissions"
  - "Enable step sensor"
  - "Allow notifications"
  - "Maybe later"
- 12-hour cooldown after dismissal

---

### 5.3 Screens Using Permission-Dependent Features

**HomeScreen** - Uses step data:
- Fetches today's health: `stepsService.getTodayHealth`
- Fetches weekly data: `stepsService.getWeekly`
- Displays: current steps, progress, goal

**StepsDetailScreen** - Requires step permissions:
- Shows step summary and history
- Time periods: 1D, 1W, 1M, 3M, 1Y, All
- Needs permission to access sensor data

**ProfileScreen** - Requires step permissions:
- Shows permission status indicator
- Green dot if steps permission granted
- Yellow dot if pending

**ChallengesScreen** - Uses step data:
- Shows active challenges
- Uses step count for challenge progress

**WalletScreen** - No direct permission dependency:
- Shows transactions
- Shows balance
- Doesn't require step sensor access

---

## 6. PERMISSION STATUS INDICATOR COMPONENT

**File:** [step2win-web/src/components/ui/PermissionStatusBanner.tsx](step2win-web/src/components/ui/PermissionStatusBanner.tsx)

**Component Props:**
```typescript
interface PermissionStatusBannerProps {
  status: 'granted' | 'denied' | 'unavailable';
  permissionName: 'steps' | 'notifications' | 'both';
  onEnable?: () => void;
  dismissible?: boolean;
}
```

**Status Display Logic:**

1. **Granted Status:**
   - Returns `null` (hidden)

2. **Unavailable Status:**
   - Shows: "Step tracking unavailable"
   - Message: "Mobile app required"
   - Alert icon in gray

3. **Denied Status:**
   - Shows permission-specific message
   - CTA button to enable
   - Routes to `/settings` on click
   - Alert icon in orange/yellow

---

## 7. API Authorization

### 7.1 Bearer Token Authentication

**Header:** `Authorization: Bearer <JWT-token>`

**Token Format:**
- JWT with `access` and `refresh` tokens
- Stored in: Preferences (native) or localStorage (web)
- Rate limited: 5/minute on login attempts

**Token Refresh:**
- `POST /api/token/refresh/` endpoint
- Requires valid refresh token
- Returns new access token

---

## 8. ADMIN AUTHENTICATION

### 8.1 Admin User Requirements

**Backend Model Check:**
```python
if (!user.is_staff) {
  return <Navigate to="/login" replace />;
}
```

**Admin Registration Code:**
- Requires `ADMIN_REGISTRATION_CODE` env variable
- Located at backend/.env
- Used during registration to grant staff status

**Admin URL:**
- Django admin: `/admin-s2w-secure/` (obscured)
- Not `/admin/` (default)

---

## 9. CURRENT STATE SUMMARY

### 9.1 Permission Implementation Status

| Feature | Status | Location |
|---------|--------|----------|
| Activity Recognition Request | ✅ Implemented | DeviceStepCounterPlugin.java |
| Permission Check | ✅ Implemented | useHealthSync.ts |
| Permission Status UI Indicator | ✅ Implemented | SettingsScreen.tsx |
| Background Capture Permission Guard | ✅ Implemented | DeviceStepCounterPlugin.java |
| Notification Permission Request | ✅ Implemented | notifications.ts |
| Permission Modal Prompt | ✅ Implemented | MainLayout.tsx |
| Permission Cooldown (12hrs) | ✅ Implemented | MainLayout.tsx |

### 9.2 Authentication Status

| Feature | Status | Location |
|---------|--------|----------|
| JWT Token Storage | ✅ Implemented | authStore.ts |
| Protected Routes | ✅ Implemented | App.tsx |
| Admin Route Guard | ✅ Implemented | ProtectedRoute.tsx (admin) |
| Backend Auth Endpoints | ✅ Implemented | auth_views.py |
| Backend Permission Guards | ✅ Implemented | All views use IsAuthenticated |
| Token Refresh | ✅ Implemented | auth_views.py |

### 9.3 Navigation Status

| Feature | Status | Location |
|---------|--------|----------|
| Back Button (Android) | ✅ Implemented | NativeBackButtonGuard (App.tsx) |
| UI Back Buttons | ✅ Implemented | Multiple screens |
| Back Press Behavior | ✅ Implemented | Minimize on home, go back elsewhere |

---

## 10. SCREENS REQUIRING ATTENTION

### Screens That NEED Permission Checks:

1. **HomeScreen** - Uses step data
   - Currently: ✅ Using `useHealthSync()` data
   - Status: **READY**

2. **StepsDetailScreen** - Step-centric view
   - Currently: ✅ Uses `stepsService.getSummary()`
   - Status: **READY**

3. **ProfileScreen** - Shows permission status
   - Currently: ✅ Shows indicator
   - Status: **READY**

4. **ChallengesScreen** - Uses step count
   - Currently: ✅ Uses `challengesService.getMyChallenges()`
   - Status: **READY**

### Screens That Are Safe (No Permission Dependency):

5. **WalletScreen** - Finance only
   - Status: **SAFE**

6. **SettingsScreen** - Permission request interface
   - Status: **READY**

7. **SupportScreen** - Help/contact
   - Status: **SAFE**

---

## 11. MISSING ELEMENTS (None Critical)

All major permission and authentication features are implemented:
- ✅ Permission requests
- ✅ Permission checks  
- ✅ UI indicators
- ✅ Route guards
- ✅ Back button handling
- ✅ Auth stores
- ✅ Backend guards

---

## 12. KEY FILES SUMMARY

| Category | File | Responsibility |
|----------|------|-----------------|
| **Android Permissions** | `DeviceStepCounterPlugin.java` | Activity recognition permission |
| **Permission Logic** | `useHealthSync.ts` | Request/check/handle permissions |
| **Notification Permissions** | `notifications.ts` | Notification permission handling |
| **Auth Store** | `authStore.ts` | Token storage/auth state |
| **Route Guards** | `App.tsx` | ProtectedRoute wrapper |
| **Admin Guard** | `ProtectedRoute.tsx` (admin) | Admin-only access |
| **Back Button** | `App.tsx` | NativeBackButtonGuard |
| **Backend Auth** | `auth_views.py` | Authentication endpoints |
| **Backend Guards** | All `views.py` | IsAuthenticated decorator |
| **Settings UI** | `SettingsScreen.tsx` | Permission control panel |
| **Permission Modal** | `MainLayout.tsx` | Initial permission prompt |
| **Permission Banner** | `PermissionStatusBanner.tsx` | Status display component |

---

## CONCLUSION

The Step2Win application has **comprehensive permission and authentication systems** in place:

✅ **Android permissions** properly requested and guarded  
✅ **Authentication guards** on all protected screens  
✅ **Back button handling** prevents app exit on home  
✅ **Permission-dependent screens** correctly implemented  
✅ **UI feedback** for permission status visible to users  
✅ **Backend guards** ensure API security  

**No critical gaps identified.**
