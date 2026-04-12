import { useState } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { LogIn, Footprints, Mail } from 'lucide-react';
import { useGoogleLogin } from '@react-oauth/google';
import { Capacitor } from '@capacitor/core';
import { Device } from '@capacitor/device';
import { authService } from '../services/api';
import { useAuthStore } from '../store/authStore';
import { googleClientIdHelpText, isGoogleClientIdConfigured } from '../config/googleAuth';
import Input from '../components/ui/Input';
import { useToast } from '../components/ui/Toast';

export default function LoginScreen() {
  const navigate = useNavigate();
  const setAuth = useAuthStore((state) => state.setAuth);
  const { showToast } = useToast();
  
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [isLoading, setIsLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setIsLoading(true);

    try {
      // Collect device info for session tracking
      let deviceInfo = {
        device_type: 'web' as 'android' | 'ios' | 'web' | 'unknown',
        device_name: 'Web Browser',
        app_version: import.meta.env.VITE_APP_VERSION || '1.0.0',
      };

      if (Capacitor.isNativePlatform()) {
        try {
          const info = await Device.getInfo();
          deviceInfo = {
            device_type: info.platform as 'android' | 'ios',
            device_name: `${info.manufacturer} ${info.model}`,
            app_version: import.meta.env.VITE_APP_VERSION || '1.0.0',
          };
        } catch (e) {
          // Use defaults if device info unavailable
          console.error('Failed to get device info:', e);
        }
      }

      const response = await authService.login({
        username,
        password,
        ...deviceInfo,
      });
      
      await setAuth(
        response.user,
        response.access,
        response.refresh,
        response.session_id
      );
      navigate('/');
    } catch (err: any) {
      const data = err?.response?.data;
      const message =
        data?.error ||
        data?.message ||
        (!err?.response
          ? 'Unable to reach server. Confirm backend is running on http://127.0.0.1:8000.'
          : 'Login failed. Please try again.');
      setError(message);
      showToast({ message, type: 'error' });
    } finally {
      setIsLoading(false);
    }
  };

  const handleGoogleLogin = useGoogleLogin({
    onSuccess: async (codeResponse) => {
      setError('');
      setIsLoading(true);
      try {
        const response = await authService.googleSignIn(codeResponse.access_token);
        await setAuth(response.user, response.access, response.refresh);
        navigate('/');
      } catch (err: any) {
        setError(err.response?.data?.error || 'Google sign in failed. Please try again.');
      } finally {
        setIsLoading(false);
      }
    },
    onError: () => {
      setError('Google sign in failed. Please try again.');
    },
    flow: 'implicit',
  });

  return (
    <div className="min-h-screen bg-bg-page flex flex-col overflow-hidden">
      {/* Top section with branding */}
      <div className="flex flex-col items-center justify-center px-6 pt-12 pb-8 flex-shrink-0">
        <div 
          className="w-20 h-20 rounded-3xl bg-accent-blue flex items-center justify-center mb-4"
          style={{ boxShadow: '0 8px 24px rgba(79,156,249,0.35)' }}
        >
          <Footprints size={36} className="text-white" />
        </div>
        <h1 className="text-text-primary text-3xl font-bold mb-1">Step2Win</h1>
        <p className="text-text-muted text-sm tracking-wide">Walk. Win. Repeat.</p>
      </div>

      {/* Scrollable form section */}
      <div className="flex-1 overflow-y-auto overflow-x-hidden px-4 pb-6">
        {/* Form card */}
        <div className="card p-8 min-h-fit">
        <h2 className="text-text-primary text-2xl font-bold mb-8">Welcome back</h2>

        {error && (
          <div className="bg-tint-red border border-red-200 text-accent-red px-4 py-3 rounded-xl mb-6 text-sm">
            {error}
          </div>
        )}

        <form onSubmit={handleSubmit} className="space-y-6">
          <Input
            label="Username, Email, or Phone"
            type="text"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            placeholder="Username, email, or 254712345678"
            required
            autoComplete="username"
          />

          <Input
            label="Password"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="Enter your password"
            required
            autoComplete="current-password"
          />

          <button
            type="submit"
            disabled={isLoading}
            className="w-full py-4 rounded-2xl text-white text-sm font-bold mt-8 flex items-center justify-center gap-2 transition-all duration-200 hover:scale-105 active:scale-95"
            style={{ background: '#4F9CF9', boxShadow: '0 4px 12px rgba(79,156,249,0.3)' }}
          >
            {isLoading ? (
              <span>Signing in...</span>
            ) : (
              <>
                <LogIn size={18} />
                Sign In
              </>
            )}
          </button>
        </form>

        <div className="flex items-center gap-2 my-8">
          <div className="flex-1 h-px bg-bg-input"></div>
          <span className="text-text-muted text-xs">or</span>
          <div className="flex-1 h-px bg-bg-input"></div>
        </div>

        <button
          type="button"
          onClick={() => {
            if (!isGoogleClientIdConfigured) {
              setError(googleClientIdHelpText);
              return;
            }
            handleGoogleLogin();
          }}
          disabled={isLoading || !isGoogleClientIdConfigured}
          className="w-full py-4 rounded-2xl text-text-primary text-sm font-bold border border-bg-input bg-white flex items-center justify-center gap-3 transition-all duration-200 hover:bg-bg-page active:scale-95"
        >
          <Mail size={18} />
          Continue with Gmail
        </button>

        <p className="text-center text-text-muted text-sm mt-8">
          Don't have an account?{' '}
          <Link to="/register" className="text-accent-blue font-semibold hover:opacity-80 transition-opacity">
            Sign up
          </Link>
        </p>
        </div>
      </div>
    </div>
  );
}
