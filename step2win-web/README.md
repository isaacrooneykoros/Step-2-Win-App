# Step2Win Frontend

Modern React + TypeScript fitness challenge platform with Capacitor for mobile.

## Features

- 🎨 Dark theme UI with Tailwind CSS
- 📱 Capacitor for Android wrapper
- 🔐 JWT authentication with auto-refresh
- 📊 Real-time step tracking
- 🏆 Challenge leaderboards
- 💰 Wallet management
- 📈 Statistics and analytics

## Tech Stack

- Vite + React 18
- TypeScript
- Tailwind CSS
- React Router v6
- TanStack Query v5
- Zustand (state management)
- Axios
- Capacitor 5

## Quick Start

```bash
# Install dependencies
npm install

# Run development server
npm run dev

# Build for production
npm run build

# Preview production build
npm run preview
```

## Android Development

```bash
# Build web assets
npm run build

# Sync with Capacitor
npx cap sync android

# Open in Android Studio
npx cap open android
```

## Environment Variables

Create `.env` file:

```env
VITE_API_BASE_URL=http://10.0.2.2:8000
```

For production (`.env.production`):

```env
VITE_API_BASE_URL=https://your-backend-url.com
```

## Project Structure

```
src/
├── components/           # Reusable components
│   ├── layout/          # Layout components
│   └── ui/              # UI components
├── screens/             # Screen components
├── services/            # API services
│   └── api/            # API client
├── store/              # Zustand stores
├── types/              # TypeScript types
├── utils/              # Utility functions
├── App.tsx             # Main app component
└── main.tsx            # Entry point
```

## Available Routes

- `/login` - Login screen
- `/register` - Registration screen
- `/` - Home screen (protected)
- `/challenges` - Challenges list (protected)
- `/challenges/:id` - Challenge detail (protected)
- `/wallet` - Wallet screen (protected)
- `/profile` - Profile screen (protected)

## Design System

### Colors

- Primary: `#14B8A6` (Teal)
- Accent: `#3B82F6` (Blue)
- Background: `#0A0E27` (Dark blue)
- Success: `#10B981` (Green)
- Warning: `#F59E0B` (Orange)
- Error: `#EF4444` (Red)

### Typography

Uses system fonts with Tailwind's default font stack.

## Building for Production

### Web Deployment

```bash
npm run build
# Deploy dist/ folder to Vercel/Netlify
```

### Android APK

```bash
# Build web assets
npm run build

# Sync with Android
npx cap sync android

# Open in Android Studio
npx cap open android

# In Android Studio:
# Build → Generate Signed Bundle/APK
```

## API Integration

API client automatically:
- Adds JWT tokens to requests
- Handles token refresh
- Redirects to login on 401

## State Management

Using Zustand for:
- Authentication state
- User profile
- Global app state

Using TanStack Query for:
- API data fetching
- Caching
- Background updates

## Development Tips

### Android Emulator

Use `10.0.2.2` to access localhost from Android emulator:

```env
VITE_API_BASE_URL=http://10.0.2.2:8000
```

### Real Device

Ensure backend allows your device IP in `CORS_ALLOWED_ORIGINS`.

## License

Proprietary - All rights reserved
