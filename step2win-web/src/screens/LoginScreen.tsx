import { useState } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { authService } from '../services/api';
import { useAuthStore } from '../store/authStore';
import { getLoginDeviceInfo } from '../services/deviceInfo';
import { resolveApiBaseUrl } from '../config/network';
import Input from '../components/ui/Input';
import { Button } from '../components/ui/Button';
import { AuthLayout, FormError, PasswordField } from '../components/auth/AuthParts';
import { SocialSignIn } from '../components/auth/SocialSignIn';
import { useToast } from '../components/ui/Toast';

export default function LoginScreen() {
  const navigate = useNavigate();
  const setAuth = useAuthStore((state) => state.setAuth);
  const { showToast } = useToast();
  
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [socialBusy, setSocialBusy] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setIsLoading(true);

    try {
      const deviceInfo = await getLoginDeviceInfo();

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
          ? `Unable to reach server at ${resolveApiBaseUrl()}. Confirm VITE_API_BASE_URL points to a reachable backend.`
          : 'Login failed. Please try again.');
      setError(message);
      showToast({ message, type: 'error' });
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <AuthLayout
      title="Welcome back"
      subtitle="Sign in to pick up your steps, challenges and wallet."
      footer={
        <p className="text-center text-callout text-text-secondary">
          New to Step2Win?{' '}
          <Link to="/register" className="inline-flex min-h-touch items-center font-semibold text-brand hover:underline">
            Create an account
          </Link>
        </p>
      }
    >
      <FormError message={error} />

      <form onSubmit={handleSubmit}>
        <Input
          label="Username, email or phone"
          name="username"
          type="text"
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          placeholder="you@example.com or 2547XXXXXXXX"
          required
          autoComplete="username"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          enterKeyHint="next"
        />

        <PasswordField
          label="Password"
          name="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="Your password"
          required
          autoComplete="current-password"
          enterKeyHint="go"
          containerClassName="!mb-0"
        />
        <div className="mb-3 flex justify-end">
          <Link
            to="/forgot-password"
            state={{ identifier: username.trim() }}
            className="inline-flex min-h-touch items-center text-callout font-semibold text-brand hover:underline"
          >
            Forgot password?
          </Link>
        </div>

        <Button type="submit" size="lg" fullWidth isLoading={isLoading} disabled={socialBusy} loadingText="Signing in" className="mt-2">
          Sign in
        </Button>
      </form>

      <SocialSignIn mode="login" disabled={isLoading} onBusyChange={setSocialBusy} onError={setError} />
    </AuthLayout>
  );
}
