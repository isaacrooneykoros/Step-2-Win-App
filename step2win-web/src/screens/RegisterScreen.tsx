import { useState } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { UserPlus, Footprints, Mail } from 'lucide-react';
import { useGoogleLogin } from '@react-oauth/google';
import { authService } from '../services/api';
import { useAuthStore } from '../store/authStore';
import { googleClientIdHelpText, isGoogleClientIdConfigured } from '../config/googleAuth';
import Input from '../components/ui/Input';
import { useToast } from '../components/ui/Toast';

export default function RegisterScreen() {
  const navigate = useNavigate();
  const setAuth = useAuthStore((state) => state.setAuth);
  const { showToast } = useToast();
  
  const [formData, setFormData] = useState({
    username: '',
    email: '',
    phone_number: '',
    password: '',
    confirm_password: '',
  });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [isLoading, setIsLoading] = useState(false);

  const getFieldError = (value: unknown): string => {
    if (Array.isArray(value)) {
      return typeof value[0] === 'string' ? value[0] : '';
    }
    return typeof value === 'string' ? value : '';
  };

  const getPasswordStrength = (password: string) => {
    if (password.length === 0) return { strength: 0, label: '' };
    if (password.length < 6) return { strength: 33, label: 'Weak', color: 'bg-accent-red' };
    if (password.length < 10) return { strength: 66, label: 'Medium', color: 'bg-accent-yellow' };
    return { strength: 100, label: 'Strong', color: 'bg-accent-green' };
  };

  const passwordStrength = getPasswordStrength(formData.password);

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setFormData({ ...formData, [e.target.name]: e.target.value });
    setErrors({ ...errors, [e.target.name]: '' });
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrors({});
    setIsLoading(true);

    try {
      const response = await authService.register(formData);
      await setAuth(response.user, response.access, response.refresh);
      navigate('/');
    } catch (err: any) {
      const data = err?.response?.data;
      let toastMessage = 'Request failed. Please try again.';

      if (data && typeof data === 'object') {
        const normalizedErrors = (data.details && typeof data.details === 'object') ? data.details : data;
        setErrors(normalizedErrors as Record<string, string>);

        if (typeof data.message === 'string') {
          setErrors((prev) => ({ ...prev, form: data.message }));
          toastMessage = data.message;
        } else if (typeof data.error === 'string') {
          setErrors((prev) => ({ ...prev, form: data.error }));
          toastMessage = data.error;
        } else {
          const nonFieldErrors = (normalizedErrors as Record<string, unknown>).non_field_errors;
          if (Array.isArray(nonFieldErrors) && typeof nonFieldErrors[0] === 'string') {
            toastMessage = nonFieldErrors[0];
          }
        }
      } else if (!err?.response) {
        toastMessage = 'Unable to reach server. Confirm backend is running on http://localhost:8000.';
        setErrors({ form: toastMessage });
      } else {
        setErrors({ form: 'Registration failed. Please try again.' });
      }

      showToast({ message: toastMessage, type: 'error' });
    } finally {
      setIsLoading(false);
    }
  };

  const handleGoogleSignUp = useGoogleLogin({
    onSuccess: async (codeResponse) => {
      setErrors({});
      setIsLoading(true);
      try {
        const response = await authService.googleSignIn(codeResponse.access_token);
        await setAuth(response.user, response.access, response.refresh);
        navigate('/');
      } catch (err: any) {
        setErrors({ form: err.response?.data?.error || 'Google sign up failed. Please try again.' });
      } finally {
        setIsLoading(false);
      }
    },
    onError: () => {
      setErrors({ form: 'Google sign up failed. Please try again.' });
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
        <h1 className="text-text-primary text-3xl font-bold mb-1">Join Step2Win</h1>
        <p className="text-text-muted text-sm tracking-wide">Start your fitness journey today</p>
      </div>

      {/* Scrollable form section */}
      <div className="flex-1 overflow-y-auto overflow-x-hidden px-4 pb-6">
        {/* Form card */}
        <div className="card p-8 min-h-fit">
        <h2 className="text-text-primary text-2xl font-bold mb-8">Create Account</h2>

        {errors.form && (
          <div className="bg-tint-red border border-red-200 text-accent-red px-4 py-3 rounded-xl mb-6 text-sm">
            {errors.form}
          </div>
        )}

        <form onSubmit={handleSubmit} className="space-y-6">
          <Input
            label="Username"
            name="username"
            type="text"
            value={formData.username}
            onChange={handleChange}
            placeholder="Choose a username"
            error={getFieldError(errors.username)}
            required
            autoComplete="username"
          />

          <Input
            label="Email"
            name="email"
            type="email"
            value={formData.email}
            onChange={handleChange}
            placeholder="your@email.com"
            error={getFieldError(errors.email)}
            required
            autoComplete="email"
          />

          <Input
            label="Phone Number (for withdrawals)"
            name="phone_number"
            type="tel"
            value={formData.phone_number}
            onChange={handleChange}
            placeholder="254712345678"
            error={getFieldError(errors.phone_number)}
            autoComplete="tel"
          />

          <div>
            <Input
              label="Password"
              name="password"
              type="password"
              value={formData.password}
              onChange={handleChange}
              placeholder="Create a strong password"
              error={getFieldError(errors.password)}
              required
              autoComplete="new-password"
            />
            {formData.password && (
              <div className="mt-3">
                <div className="h-2 bg-bg-input rounded-full overflow-hidden">
                  <div
                    className={`h-full ${passwordStrength.color} transition-all duration-300`}
                    style={{ width: `${passwordStrength.strength}%` }}
                  />
                </div>
                <p className="text-xs text-text-muted mt-2">
                  Password strength: <span className="font-semibold">{passwordStrength.label}</span>
                </p>
              </div>
            )}
          </div>

          <Input
            label="Confirm Password"
            name="confirm_password"
            type="password"
            value={formData.confirm_password}
            onChange={handleChange}
            placeholder="Confirm your password"
            error={getFieldError(errors.confirm_password)}
            required
            autoComplete="new-password"
          />

          <button
            type="submit"
            disabled={isLoading}
            className="w-full py-4 rounded-2xl text-white text-sm font-bold mt-8 flex items-center justify-center gap-2 transition-all duration-200 hover:scale-105 active:scale-95"
            style={{ background: '#4F9CF9', boxShadow: '0 4px 12px rgba(79,156,249,0.3)' }}
          >
            {isLoading ? (
              <span>Creating account...</span>
            ) : (
              <>
                <UserPlus size={18} />
                Create Account
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
              setErrors({ form: googleClientIdHelpText });
              return;
            }
            handleGoogleSignUp();
          }}
          disabled={isLoading || !isGoogleClientIdConfigured}
          className="w-full py-4 rounded-2xl text-text-primary text-sm font-bold border border-bg-input bg-white flex items-center justify-center gap-3 transition-all duration-200 hover:bg-bg-page active:scale-95"
        >
          <Mail size={18} />
          Continue with Gmail
        </button>

        <p className="text-center text-text-muted text-sm mt-8">
          Already have an account?{' '}
          <Link to="/login" className="text-accent-blue font-semibold hover:opacity-80 transition-opacity">
            Login
          </Link>
        </p>
        </div>
      </div>
    </div>
  );
}
