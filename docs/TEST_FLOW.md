# 🧪 Full Integration Flow Test - Step2Win Gamification

## Test Scenario: Register → Onboard → Join Challenge → Celebrate

---

## Phase 1: User Registration & Onboarding


### Step 1: Register New User
1. Navigate to **http://localhost:5174/register**
2. Fill in form:
   - Username: `testuser_[random]` (e.g., `testuser_12345`)
   - Email: `testuser_12345@test.com`
   - Password: `TestPass123!`
   - Confirm: `TestPass123!`
3. Click **Register**
4. ✅ **Expected:** User created, auto-logged in, redirected to home

### Step 2: Onboarding Modal
1. 🎯 **Expected:** Onboarding modal automatically appears
   - Shows 4 slides (Step, Challenge, Wallet, Profile)
   - "Get Started" button visible
   - Touch/swipe navigation works
2. Swipe through all 4 slides (swipe left, or wait for auto-advance)
3. Click **Get Started** button
4. ✅ **Expected:** 
   - Modal closes
   - User is at **HomeScreen**
   - localStorage('onboarding_completed_v1') is set
   - Onboarding won't show again for this user

**localStorage Check:**
```javascript
// Open DevTools (F12) → Console
localStorage.getItem('onboarding_completed_v1')
// Should return: "true"
```

---

## Phase 2: Check Home Screen Gamification


### Step 3: Verify XP Profile Display
1. At **HomeScreen**, look for:
   - 💫 **Level badge** with number (e.g., "Level 1")
   - **XP bar** showing progression
   - **Weekly XP earned** badge (+120 XP, etc.)
2. ✅ **Expected:** All real data from API
   - Level = from database (likely 1 for new user)
   - XP bar fills based on total_xp
   - Weekly XP shows xp_this_week value

### Step 4: View Earned Badges (if any)
1. Scroll down on **HomeScreen**
2. Look for **🏆 Achievements** section
3. ✅ **Expected:**
   - If badges exist: Grid of earned badges with icons
   - If no badges: Section shouldn't display
   - Shows count badge (e.g., "5 badges")
   - "+X More" button if >4 badges
   - Click badge to see name tooltip

---

## Phase 3: Profile Screen Achievements


### Step 5: Navigate to Profile
1. Click **Profile** icon in bottom navigation
2. Scroll down past stats
3. ✅ **Expected:** Three badge sections:

#### Section A: Level & XP
- 💫 **Level X** badge
- Total XP count (e.g., "2,450 XP")
- Progress bar to next level
- Text showing "450 / 1000 XP to Level 5"

#### Section B: 🏆 Earned Achievements
- Grid of earned badges (4 per row)
- Each badge shows:
  - Badge icon 🏆
  - Badge name
  - Date earned (e.g., "3/1/2026")
- Hover effect (border glow)

#### Section C: 🎯 Available Achievements
- Grid of locked badges (semi-transparent)
- Grayscale icons
- Shows "🔒 Locked" text
- Hover to see name/description
- Up to 8 badges displayed

---

## Phase 4: Join Challenge & Earn Badges


### Step 6: Navigate to Challenges
1. Click **Challenges** in bottom navigation
2. View available challenges (should see 4+ from database)
3. ✅ **Expected:**
   - Challenge cards with status (Live, Pending, Completed)
   - Entry fee, prize pool, participants count
   - "Join Challenge" button

### Step 7: Join a Challenge
1. Click **"Join"** on an active challenge
2. Confirm joining (if modal appears)
3. ✅ **Expected:**
   - Challenge added to "My Challenges"
   - User appears in participant list
   - XP event triggered (`challenge_join` event worth ~10 XP)

### Step 8: Check XP Updated
1. Return to **HomeScreen**
2. 🔄 Refresh page (browser refresh or pull-to-refresh)
3. ✅ **Expected:**
   - XP bar slightly fuller
   - Weekly XP increases (+10 for join)
   - Badges section shows any newly earned badges

---

## Phase 5: Challenge Completion & Celebration


### Step 9: Simulate Challenge Completion
**Note:** In test environment with small participant counts, the challenge must:
- Have status = "completed" (end_date passed)
- User must be in top X participants (qualified for prize)

**Option A: Use Admin API to mark challenge completed**
```bash
# In terminal:
curl -X PATCH http://127.0.0.1:8000/api/admin/challenges/[challenge_id]/ \
  -H "Authorization: Bearer [admin_token]" \
  -H "Content-Type: application/json" \
  -d '{"status": "completed"}'
```

**Option B: Wait for challenge end_date** (not practical for testing)

**Option C: Skip to next test user who matches completed challenge**

### Step 10: View Challenge Detail - Celebration Triggers
1. Navigate to **Challenges** → Click on a **completed** challenge
2. ✅ **Expected:**
   - **CelebrationModal** auto-pops with:
     - 50 confetti particles falling
     - Challenge name
     - XP earned (50 for completion)
     - Prize earned (if qualified)
     - Rank badge: 🥇1st / 🥈2nd / 🥉3rd / ✅ Completed
     - Level-up notification (if level increased)
     - Animated trophy/star icons
   - Modal has close button
   - localStorage('celebration_shown_[userId]_[challengeId]') is set

### Step 11: Closed Celebration Modal Behavior  
1. Close the celebration modal
2. Refresh page
3. ✅ **Expected:** Modal does NOT appear again (localStorage prevents duplicate)

### Step 12: Manual Celebration Replay
1. Scroll down to bottom of challenge detail
2. Look for **"View Celebration"** button
3. Click button
4. ✅ **Expected:**
   - Celebration modal appears again
   - Confetti animation replays
   - Stats display again

---

## Phase 6: Profile Badge Updates


### Step 13: Check Profile for New Badges
1. Click **Profile** in navigation
2. Scroll to **🏆 Earned Achievements**
3. ✅ **Expected:**
   - If badges awarded:
     - New badges appear in earned section
     - Count updates (e.g., "6" badges)
     - Badge shows today's date
   - Upcoming badges count decreases

### Step 14: Verify Leaderboard Position (Optional)
1. Create 2-3 more test users (repeat Phase 1-2)
2. Have them join same challenges
3. ✅ **Expected:**
   - HomeScreen rank badge shows your position (if API supports)
   - Profile could show leaderboard rank

---

## Test Checklist

### Onboarding ✅
- [ ] New user sees onboarding modal automatically
- [ ] Onboarding has 4 slides with proper content
- [ ] Swipe/auto-advance works
- [ ] "Get Started" button closes modal
- [ ] localStorage persistence works
- [ ] Returning user doesn't see onboarding

### XP & Level ✅
- [ ] HomeScreen shows real level from API
- [ ] XP bar fills correctly
- [ ] Weekly XP displays correctly
- [ ] ProfileScreen shows level properly
- [ ] XP progress text shows "X/Y XP to Level Z"

### Badges - HomeScreen ✅
- [ ] Badge section only shows if user has badges
- [ ] Shows up to 4 badges
- [ ] "+X More" button appears if >4
- [ ] Click button navigates to Profile
- [ ] Badges have icons and names

### Badges - ProfileScreen ✅
- [ ] 🏆 Earned Achievements section shows all badges
- [ ] Each badge shows icon, name, earned date
- [ ] Hover effects work
- [ ] 🎯 Available Achievements shows upcoming badges
- [ ] Locked badges are semi-transparent/grayscale
- [ ] Count badges show correct numbers

### Celebration Modal ✅
- [ ] Auto-triggers on completed qualified challenge
- [ ] Shows challenge name
- [ ] Shows XP earned (50)
- [ ] Shows prize earned (if applicable)
- [ ] Shows rank/position badge
- [ ] 50 confetti particles animate
- [ ] Close button works
- [ ] localStorage deduplication prevents re-showing
- [ ] "View Celebration" button replays modal

### API Integration ✅
- [ ] Gamification service requests work
- [ ] XP profile loads correctly
- [ ] Badges fetch without errors
- [ ] No 404 or 500 errors in console
- [ ] Network tab shows requests to `/api/gamification/*`

---

## Debugging Tips

### Check XP/Badges Not Loading
```javascript
// DevTools Console
// Check auth token exists
localStorage.getItem('auth_token')

// Check API calls
// DevTools → Network → search for "gamification"
// Each request should return 200 with data
```

### Celebration Modal Not Showing
```javascript
// Check if challenge completed and qualified
// DevTools → Application → Storage → LocalStorage
localStorage.getItem('celebration_shown_[userId]_[challengeId]')

// If set to 'true', modal was shown before
// Delete this key to reset:
localStorage.removeItem('celebration_shown_[userId]_[challengeId]')
```

### Badges Section Not Appearing
- Refresh page (clear React cache)
- Check Network tab for `/api/gamification/badges/my_badges/` response
- Ensure API returns array of badges
- Check browser console for TypeScript errors

---

## Success Criteria - Full Integration

✅ **All 3 integration points active:**
1. **Onboarding** → Shows on first login, doesn't repeat
2. **Badges** → Display on Home & Profile, real data from API
3. **Celebration** → Triggers on challenge completion with animations

✅ **No console errors:**
- No TypeScript errors
- No API 404/500 errors
- No React warnings

✅ **Smooth user experience:**
- Animations are fluid
- Modals close properly
- Navigation flows naturally
- Data updates match expectations

---

## Test Data Setup

**Auto-created on registration:**
- User account
- UserXP (level 1, 0 total XP)
- No badges initially

**Available for testing:**
- 4+ challenges in database (from migrations)
- Badge definitions (from gamification.0001_initial)
- Sample transactions for wallet display

---

**Test Environment:**
- Backend: http://127.0.0.1:8000
- Frontend: http://localhost:5174
- Database: SQLite (test environment)

**Date:** March 1, 2026
**Status:** Ready for execution 🚀
