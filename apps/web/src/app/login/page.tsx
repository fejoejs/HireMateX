'use client';

import React, { useState, useEffect, Suspense, useRef } from 'react';
import { Mail, Lock, User as UserIcon, ArrowRight, ArrowLeft, Send, CheckCircle2, RotateCw, KeyRound, Edit2 } from 'lucide-react';
import { Logo } from '@/components/Logo';
import { BrandName } from '@/components/BrandName';
import Link from 'next/link';
import { motion, AnimatePresence } from 'framer-motion';
import { useAuth } from '@/context/FirebaseAuthContext';
import { auth } from '@/lib/firebase';
import { signInWithEmailAndPassword, createUserWithEmailAndPassword, GoogleAuthProvider, signInWithPopup, sendPasswordResetEmail } from 'firebase/auth';
import { useSearchParams } from 'next/navigation';
import { API_BASE } from '@/lib/constants';

function BrandHeader() {
  return (
    <div className="flex flex-col items-center mb-5">
      <div className="flex items-center gap-2">
        <div className="p-1.5 rounded-lg bg-gradient-to-tr from-purple-500 to-indigo-500 shadow-sm shadow-purple-500/10">
          <Logo className="w-5 h-5 text-white" />
        </div>
        <BrandName className="font-bold text-2xl bg-gradient-to-r from-purple-400 to-indigo-400 bg-clip-text text-transparent" />
      </div>
    </div>
  );
}

function AuthContent() {
  const searchParams = useSearchParams();
  const initialTab = searchParams.get('tab') === 'signup' ? 'signup' : 'signin';
  const [activeTab, setActiveTab] = useState<'signin' | 'signup'>(initialTab);
  const [authStep, setAuthStep] = useState<'form' | 'forgot-password' | 'forgot-password-otp' | 'forgot-password-reset'>('form');

  const [fullName, setFullName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  
  // Sign-up OTP states (in-place on the Sign Up form)
  const [signupOtpSent, setSignupOtpSent] = useState(false);
  const [signupOtp, setSignupOtp] = useState('');
  const [resendTimer, setResendTimer] = useState(0);

  // Forgot password OTP
  const [forgotOtp, setForgotOtp] = useState('');
  
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const otpInputRef = useRef<HTMLInputElement>(null);

  const { user, loading: authLoading } = useAuth();
  const isSignedIn = !!user;

  // Countdown timer for OTP resend
  useEffect(() => {
    let timer: any;
    if (resendTimer > 0) {
      timer = setInterval(() => {
        setResendTimer((prev) => prev - 1);
      }, 1000);
    }
    return () => clearInterval(timer);
  }, [resendTimer]);

  // Only auto-redirect to dashboard if signed in on the sign-in tab and not in the middle of signup OTP
  useEffect(() => {
    let isMounted = true;
    if (isSignedIn && isMounted && activeTab === 'signin' && authStep === 'form') {
      window.location.href = '/dashboard';
    }
    return () => { isMounted = false; };
  }, [isSignedIn, activeTab, authStep]);

  // Focus OTP input when revealed on signup
  useEffect(() => {
    if (signupOtpSent && otpInputRef.current) {
      otpInputRef.current.focus();
    }
  }, [signupOtpSent]);

  // ── Standard Sign In ──────────────────────────────────────────
  const handleSignIn = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError(null);
    try {
      const userCredential = await signInWithEmailAndPassword(auth, email.trim().toLowerCase(), password);
      if (userCredential.user) {
        try {
          const token = await userCredential.user.getIdToken();
          await fetch(`${API_BASE}/user/profile`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${token}`
            },
            body: JSON.stringify({ 
              name: userCredential.user.displayName || email.split('@')[0] 
            })
          });
        } catch (syncErr) {
          console.error("Profile sync check error:", syncErr);
        }
        window.location.href = '/dashboard';
      }
    } catch (err: any) {
      console.error('Sign-in error:', err);
      if (err.code === 'auth/invalid-credential' || err.code === 'auth/user-not-found' || err.code === 'auth/wrong-password') {
        setError('Invalid email or password. Please check your credentials or create a new account.');
      } else if (err.code === 'auth/too-many-requests') {
        setError('Access temporarily disabled due to many failed login attempts. Please reset your password or try again later.');
      } else {
        setError(err.message || 'Sign-in failed. Please check your email and password.');
      }
      setLoading(false);
    }
  };

  // ── Step 1: Send Signup OTP (Directly in Sign Up Form) ─────────
  const handleSendSignupOtp = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!fullName.trim()) {
      setError('Please enter your full name.');
      return;
    }
    if (!email.trim() || !email.includes('@')) {
      setError('Please enter a valid email address.');
      return;
    }
    if (password.length < 6) {
      setError('Password should be at least 6 characters long.');
      return;
    }

    setLoading(true);
    setError(null);
    setMessage(null);

    const cleanEmail = email.trim().toLowerCase();

    try {
      const res = await fetch(`${API_BASE}/auth/signup-send-otp`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: cleanEmail })
      });

      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.message || 'Failed to send verification code. Please check your email.');
      }

      setSignupOtpSent(true);
      setSignupOtp('');
      setResendTimer(60);
      setMessage(`Verification code sent to ${cleanEmail}. Enter OTP below.`);
    } catch (err: any) {
      console.error('Send signup OTP error:', err);
      setError(err.message || 'Failed to send verification code. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  // ── Resend Signup OTP ──────────────────────────────────────────
  const handleResendSignupOtp = async () => {
    if (resendTimer > 0) return;
    setLoading(true);
    setError(null);
    setMessage(null);
    try {
      const res = await fetch(`${API_BASE}/auth/signup-send-otp`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: email.trim().toLowerCase() })
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.message || 'Failed to resend code.');
      }
      setResendTimer(60);
      setMessage('A fresh verification code was sent to your email.');
    } catch (err: any) {
      setError(err.message || 'Failed to resend verification code.');
    } finally {
      setLoading(false);
    }
  };

  // ── Step 2: Verify OTP & Add User to Firebase + MongoDB ────────
  const handleVerifySignupAndCreateAccount = async (e: React.FormEvent) => {
    e.preventDefault();
    const cleanEmail = email.trim().toLowerCase();
    const cleanOtp = signupOtp.trim();

    if (cleanOtp.length !== 6) {
      setError('Please enter the 6-digit verification code sent to your email.');
      return;
    }

    setLoading(true);
    setError(null);

    try {
      // 1. Verify OTP with backend first
      const verifyRes = await fetch(`${API_BASE}/auth/signup-verify-otp`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: cleanEmail, otp: cleanOtp })
      });

      const verifyData = await verifyRes.json();
      if (!verifyRes.ok || !verifyData.verified) {
        throw new Error(verifyData.message || 'Invalid verification code. Please try again.');
      }

      // 2. Add user to Firebase Auth ONLY after OTP is verified
      const userCredential = await createUserWithEmailAndPassword(auth, cleanEmail, password);
      
      if (userCredential.user) {
        // 3. Update Firebase display name
        if (fullName.trim()) {
          try {
            const { updateProfile } = await import('firebase/auth');
            await updateProfile(userCredential.user, { displayName: fullName.trim() });
          } catch (pErr) {
            console.error('Error updating Firebase display name:', pErr);
          }
        }
        
        // 4. Add/Sync user to MongoDB database
        try {
          const token = await userCredential.user.getIdToken();
          await fetch(`${API_BASE}/user/profile`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${token}`
            },
            body: JSON.stringify({ 
              name: fullName.trim() || cleanEmail.split('@')[0] 
            })
          });
        } catch (syncErr) {
          console.error("Profile sync check error:", syncErr);
        }

        // 5. Mark as verified in localStorage
        localStorage.setItem('emailVerified', 'true');
        localStorage.removeItem('needsProfileSetup');

        // 6. Navigate directly to dashboard
        window.location.href = '/dashboard';
      }
    } catch (err: any) {
      console.error('Sign-up completion error:', err);
      if (err.code === 'auth/email-already-in-use') {
        setError('An account with this email already exists. Please sign in.');
      } else if (err.code === 'auth/weak-password') {
        setError('Password should be at least 6 characters long.');
      } else {
        setError(err.message || 'Verification failed. Please try again.');
      }
      setLoading(false);
    }
  };

  // ── Forgot Password Handlers ──────────────────────────────────
  const handleForgotPassword = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError(null);
    setMessage(null);
    const cleanEmail = email.trim().toLowerCase();
    try {
      const res = await fetch(`${API_BASE}/auth/forgot-password-send-otp`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: cleanEmail })
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.message || 'Failed to send password reset code.');
      }
      setAuthStep('forgot-password-otp');
    } catch (err: any) {
      console.error('Forgot password error:', err);
      setError(err.message || 'Failed to send password reset code.');
    } finally {
      setLoading(false);
    }
  };

  const handleForgotPasswordVerifyOtp = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`${API_BASE}/auth/forgot-password-verify-otp`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: email.trim().toLowerCase(), otp: forgotOtp.trim() })
      });
      const result = await res.json();
      if (!res.ok || !result.verified) {
        throw new Error(result.message || 'Invalid code.');
      }
      setAuthStep('forgot-password-reset');
    } catch (err: any) {
      setError(err.message || 'Failed to verify code.');
    } finally {
      setLoading(false);
    }
  };

  const handleForgotPasswordReset = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`${API_BASE}/auth/forgot-password-reset`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: email.trim().toLowerCase(), otp: forgotOtp.trim(), newPassword })
      });
      if (!res.ok) {
        const errorData = await res.json();
        throw new Error(errorData.message || 'Failed to reset password.');
      }
      setMessage('Password reset successful! You can now log in.');
      setAuthStep('form');
      setActiveTab('signin');
      setPassword('');
      setForgotOtp('');
    } catch (err: any) {
      setError(err.message || 'Failed to reset password.');
    } finally {
      setLoading(false);
    }
  };

  // ── Google Authentication ─────────────────────────────────────
  const handleGoogleLogin = async () => {
    try {
      setError(null);
      setLoading(true);
      const provider = new GoogleAuthProvider();
      provider.setCustomParameters({ prompt: 'select_account' });
      const userCredential = await signInWithPopup(auth, provider);
      const googleUser = userCredential.user;
      
      if (googleUser) {
        try {
          const token = await googleUser.getIdToken();
          await fetch(`${API_BASE}/user/profile`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${token}`
            },
            body: JSON.stringify({ 
              name: googleUser.displayName || googleUser.email?.split('@')[0] || 'User',
              avatarUrl: googleUser.photoURL || undefined
            })
          });
        } catch (e) {
          console.error('Failed to sync Google user profile to backend:', e);
        }
        localStorage.setItem('emailVerified', 'true');
        window.location.href = '/dashboard';
        return;
      }
    } catch (err: any) {
      console.error('Firebase Google Auth Error:', err);
      setLoading(false);
      if (err.code === 'auth/popup-closed-by-user' || err.code === 'auth/cancelled-popup-request') {
        return;
      }
      setError(err.message || 'Failed to sign in with Google.');
    }
  };

  if (authLoading) {
    return (
      <div className="w-full h-full min-h-[400px] flex items-center justify-center">
        <div className="w-6 h-6 border-2 border-purple-500 border-t-transparent rounded-full animate-spin"></div>
      </div>
    );
  }

  // ── RENDER: Forgot Password Step 1 ────────────────────────────
  if (authStep === 'forgot-password') {
    return (
      <div className="w-full max-w-md relative z-10">
        <BrandHeader />
        <div className="glass-card py-5 px-6 border border-white/5">
          <form onSubmit={handleForgotPassword} className="space-y-4">
            <div className="text-center mb-2">
              <h3 className="font-bold text-sm text-white">Reset Password</h3>
              <p className="text-[10px] text-neutral-400 mt-1">Enter your email and we'll send you a password reset code</p>
            </div>
            <div className="space-y-1.5">
              <label className="text-[10px] font-semibold text-neutral-400 block">Email Address</label>
              <div className="relative">
                <Mail className="absolute left-4 top-2.5 w-3.5 h-3.5 text-neutral-500" />
                <input placeholder="you@example.com" type="email" value={email} onChange={(e) => setEmail(e.target.value)} className="w-full bg-neutral-900 border border-white/5 rounded-xl pl-11 pr-4 py-2 text-xs text-white focus:outline-none focus:border-purple-500/50" required />
              </div>
            </div>
            {error && <div className="p-2.5 rounded-xl bg-red-500/10 border border-red-500/20 text-[10px] text-red-400">{error}</div>}
            <button type="submit" disabled={loading || !email} className="w-full py-2.5 rounded-xl bg-purple-600 hover:bg-purple-700 disabled:bg-neutral-800 disabled:text-neutral-500 text-xs font-bold text-white transition flex items-center justify-center gap-2 cursor-pointer">
              {loading ? 'Sending Code...' : 'Send Reset Code'} <ArrowRight className="w-3.5 h-3.5" />
            </button>
            <button type="button" onClick={() => { setAuthStep('form'); setError(null); }} className="w-full text-center text-[10px] font-semibold text-neutral-400 hover:text-white transition mt-2 cursor-pointer">
              ← Back to Sign In
            </button>
          </form>
        </div>
      </div>
    );
  }

  // ── RENDER: Forgot Password OTP ───────────────────────────────
  if (authStep === 'forgot-password-otp') {
    return (
      <div className="w-full max-w-md relative z-10">
        <BrandHeader />
        <div className="glass-card py-5 px-6 border border-white/5 text-center">
          <h3 className="font-bold text-sm text-white mb-2">Verify Reset Code</h3>
          <p className="text-xs text-neutral-400 mb-6">
            We sent a 6-digit password reset code to <span className="text-purple-400">{email}</span>. Please enter the code below.
          </p>
          
          <form onSubmit={handleForgotPasswordVerifyOtp} className="space-y-4">
            <div className="space-y-1.5 text-left">
              <label className="text-[10px] font-semibold text-neutral-400 block">Reset Code (OTP)</label>
              <div className="relative">
                <Lock className="absolute left-4 top-2.5 w-3.5 h-3.5 text-neutral-500" />
                <input 
                  placeholder="123456" 
                  type="text" 
                  maxLength={6}
                  value={forgotOtp} 
                  onChange={(e) => setForgotOtp(e.target.value.replace(/[^0-9]/g, ''))} 
                  className="w-full bg-neutral-900 border border-white/5 rounded-xl pl-11 pr-4 py-2 text-xs text-white focus:outline-none focus:border-purple-500/50 tracking-widest font-mono" 
                  required 
                />
              </div>
            </div>
            {error && <div className="p-2.5 rounded-xl bg-red-500/10 border border-red-500/20 text-[10px] text-red-400 text-left">{error}</div>}
            <button type="submit" disabled={loading || forgotOtp.length !== 6} className="w-full py-2.5 rounded-xl bg-purple-600 hover:bg-purple-700 disabled:bg-neutral-800 disabled:text-neutral-500 text-xs font-bold text-white transition flex items-center justify-center gap-2 cursor-pointer">
              {loading ? 'Verifying...' : 'Verify & Continue'} <ArrowRight className="w-3.5 h-3.5" />
            </button>
            <button type="button" onClick={() => setAuthStep('forgot-password')} className="w-full text-center text-[10px] font-semibold text-neutral-400 hover:text-white transition mt-2 cursor-pointer">
              ← Use a different email
            </button>
          </form>
        </div>
      </div>
    );
  }

  // ── RENDER: Forgot Password Set New Password ──────────────────
  if (authStep === 'forgot-password-reset') {
    return (
      <div className="w-full max-w-md relative z-10">
        <BrandHeader />
        <div className="glass-card py-5 px-6 border border-white/5 text-center">
          <h3 className="font-bold text-sm text-white mb-2">Set New Password</h3>
          <p className="text-xs text-neutral-400 mb-6">
            Your identity is verified! Please enter your new secure password below.
          </p>
          
          <form onSubmit={handleForgotPasswordReset} className="space-y-4">
            <div className="space-y-1.5 text-left">
              <label className="text-[10px] font-semibold text-neutral-400 block">New Password</label>
              <div className="relative">
                <Lock className="absolute left-4 top-2.5 w-3.5 h-3.5 text-neutral-500" />
                <input 
                  placeholder="••••••••" 
                  type="password" 
                  value={newPassword} 
                  onChange={(e) => setNewPassword(e.target.value)} 
                  className="w-full bg-neutral-900 border border-white/5 rounded-xl pl-11 pr-4 py-2 text-xs text-white focus:outline-none focus:border-purple-500/50" 
                  required 
                />
              </div>
            </div>
            {error && <div className="p-2.5 rounded-xl bg-red-500/10 border border-red-500/20 text-[10px] text-red-400 text-left">{error}</div>}
            <button type="submit" disabled={loading || newPassword.length < 6} className="w-full py-2.5 rounded-xl bg-purple-600 hover:bg-purple-700 disabled:bg-neutral-800 disabled:text-neutral-500 text-xs font-bold text-white transition flex items-center justify-center gap-2 cursor-pointer">
              {loading ? 'Resetting...' : 'Reset Password'} <ArrowRight className="w-3.5 h-3.5" />
            </button>
          </form>
        </div>
      </div>
    );
  }

  // ── RENDER: Main Sign In / Sign Up Form ───────────────────────
  return (
    <div className="w-full max-w-md relative z-10">
      <BrandHeader />
      <div className="flex bg-neutral-900/50 border border-white/5 rounded-2xl p-1 mb-4">
        <button 
          onClick={() => { 
            setActiveTab('signin'); 
            setError(null); 
            setMessage(null); 
            setSignupOtpSent(false);
          }} 
          className={`flex-1 py-2.5 text-xs font-bold rounded-xl transition-all cursor-pointer ${activeTab === 'signin' ? 'bg-purple-600 text-white shadow-lg shadow-purple-500/10' : 'text-neutral-400 hover:text-white'}`}
        >
          Sign In
        </button>
        <button 
          onClick={() => { 
            setActiveTab('signup'); 
            setError(null); 
            setMessage(null); 
          }} 
          className={`flex-1 py-2.5 text-xs font-bold rounded-xl transition-all cursor-pointer ${activeTab === 'signup' ? 'bg-purple-600 text-white shadow-lg shadow-purple-500/10' : 'text-neutral-400 hover:text-white'}`}
        >
          Sign Up
        </button>
      </div>

      {message && (
        <div className="p-3 rounded-xl bg-purple-500/10 border border-purple-500/20 text-xs text-purple-300 text-center mb-4 flex items-center justify-center gap-2">
          <CheckCircle2 className="w-4 h-4 text-purple-400 shrink-0" />
          <span>{message}</span>
        </div>
      )}

      <div className="glass-card py-5 px-6 border border-white/5">
        <form onSubmit={
          activeTab === 'signin' 
            ? handleSignIn 
            : signupOtpSent 
              ? handleVerifySignupAndCreateAccount 
              : handleSendSignupOtp
        } className="space-y-4">
          
          <AnimatePresence mode="wait">
            {activeTab === 'signup' && (
              <motion.div key="signup-name" initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} exit={{ opacity: 0, height: 0 }} className="space-y-1.5 overflow-hidden">
                <label className="text-[10px] font-semibold text-neutral-400 block">Full Name</label>
                <div className="relative">
                  <UserIcon className="absolute left-4 top-2.5 w-3.5 h-3.5 text-neutral-500" />
                  <input 
                    placeholder="Jane Doe" 
                    type="text" 
                    value={fullName} 
                    disabled={signupOtpSent}
                    onChange={(e) => setFullName(e.target.value)} 
                    className="w-full bg-neutral-900 border border-white/5 rounded-xl pl-11 pr-4 py-2 text-xs text-white focus:outline-none focus:border-purple-500/50 disabled:opacity-60" 
                    required={activeTab === 'signup'} 
                  />
                </div>
              </motion.div>
            )}
          </AnimatePresence>

          <div className="space-y-1.5">
            <div className="flex justify-between items-center">
              <label className="text-[10px] font-semibold text-neutral-400 block">Email Address</label>
              {activeTab === 'signup' && signupOtpSent && (
                <button 
                  type="button" 
                  onClick={() => { setSignupOtpSent(false); setSignupOtp(''); setError(null); setMessage(null); }}
                  className="text-[10px] text-purple-400 hover:text-purple-300 transition flex items-center gap-1 cursor-pointer font-semibold"
                >
                  <Edit2 className="w-2.5 h-2.5" /> Edit
                </button>
              )}
            </div>
            <div className="relative">
              <Mail className="absolute left-4 top-2.5 w-3.5 h-3.5 text-neutral-500" />
              <input 
                placeholder="user@example.com" 
                type="email" 
                value={email} 
                disabled={signupOtpSent}
                onChange={(e) => setEmail(e.target.value)} 
                className="w-full bg-neutral-900 border border-white/5 rounded-xl pl-11 pr-4 py-2 text-xs text-white focus:outline-none focus:border-purple-500/50 disabled:opacity-60" 
                required 
              />
            </div>
          </div>

          <div className="space-y-1.5">
            <div className="flex justify-between items-center">
              <label className="text-[10px] font-semibold text-neutral-400 block">Password</label>
              {activeTab === 'signin' && (
                <button type="button" onClick={() => { setAuthStep('forgot-password'); setError(null); }} className="text-[9px] font-semibold text-purple-400 hover:text-purple-300 transition cursor-pointer">
                  Forgot Password?
                </button>
              )}
            </div>
            <div className="relative">
              <Lock className="absolute left-4 top-2.5 w-3.5 h-3.5 text-neutral-500" />
              <input 
                placeholder="••••••••" 
                type="password" 
                value={password} 
                disabled={signupOtpSent}
                onChange={(e) => setPassword(e.target.value)} 
                className="w-full bg-neutral-900 border border-white/5 rounded-xl pl-11 pr-4 py-2 text-xs text-white focus:outline-none focus:border-purple-500/50 disabled:opacity-60" 
                required 
              />
            </div>
          </div>

          {/* Inline OTP verification input right inside the Sign Up form */}
          <AnimatePresence>
            {activeTab === 'signup' && signupOtpSent && (
              <motion.div 
                initial={{ opacity: 0, y: -6 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -6 }}
                className="space-y-2 pt-1 pb-1"
              >
                <div className="flex justify-between items-center">
                  <label className="text-[10px] font-semibold text-purple-400 block flex items-center gap-1">
                    <KeyRound className="w-3 h-3 text-purple-400" /> Enter 6-Digit OTP Code
                  </label>
                  <button 
                    type="button"
                    onClick={handleResendSignupOtp}
                    disabled={resendTimer > 0 || loading}
                    className={`text-[10px] font-semibold transition cursor-pointer flex items-center gap-1 ${
                      resendTimer > 0 ? 'text-neutral-500 cursor-not-allowed' : 'text-purple-400 hover:text-purple-300'
                    }`}
                  >
                    <RotateCw className={`w-2.5 h-2.5 ${loading ? 'animate-spin' : ''}`} />
                    {resendTimer > 0 ? `Resend (${resendTimer}s)` : 'Resend'}
                  </button>
                </div>

                <div className="relative">
                  <KeyRound className="absolute left-4 top-2.5 w-3.5 h-3.5 text-neutral-500" />
                  <input 
                    ref={otpInputRef}
                    placeholder="------" 
                    type="text" 
                    maxLength={6}
                    value={signupOtp} 
                    onChange={(e) => setSignupOtp(e.target.value.replace(/[^0-9]/g, ''))} 
                    className="w-full bg-neutral-900 border border-purple-500/40 rounded-xl pl-11 pr-4 py-2 text-sm text-white text-center tracking-[6px] font-mono focus:outline-none focus:border-purple-500 transition shadow-inner shadow-purple-500/5" 
                    required 
                  />
                </div>
              </motion.div>
            )}
          </AnimatePresence>

          {error && <div className="p-2.5 rounded-xl bg-red-500/10 border border-red-500/20 text-[10px] text-red-400">{error}</div>}

          <button 
            type="submit" 
            disabled={loading || (activeTab === 'signup' && signupOtpSent && signupOtp.length !== 6)} 
            className="w-full py-2.5 rounded-xl bg-purple-600 hover:bg-purple-700 disabled:bg-neutral-800 disabled:text-neutral-500 text-xs font-bold text-white transition flex items-center justify-center gap-2 shadow-lg shadow-purple-500/15 cursor-pointer"
          >
            {loading 
              ? 'Please wait...' 
              : activeTab === 'signin' 
                ? 'Sign In' 
                : signupOtpSent 
                  ? 'Verify OTP & Create Account' 
                  : 'Create Account'}
            <ArrowRight className="w-3.5 h-3.5" />
          </button>
        </form>

        <div className="flex items-center my-4 text-neutral-600">
          <div className="flex-1 h-px bg-white/5" />
          <span className="text-[9px] uppercase font-bold px-3">or</span>
          <div className="flex-1 h-px bg-white/5" />
        </div>

        <button onClick={handleGoogleLogin} disabled={loading} className="w-full flex items-center justify-center gap-2.5 py-2.5 rounded-xl border border-white/5 bg-neutral-900 hover:bg-neutral-800 transition text-xs font-semibold cursor-pointer text-neutral-300">
          <svg className="w-3.5 h-3.5" viewBox="0 0 24 24">
            <path fill="#EA4335" d="M12 5.04c1.66 0 3.2.57 4.38 1.69l3.27-3.27C17.67 1.6 15.01 0 12 0 7.37 0 3.37 2.65 1.41 6.59l3.8 2.95C6.18 6.77 8.87 5.04 12 5.04z" />
            <path fill="#4285F4" d="M23.49 12.27c0-.81-.07-1.59-.2-2.36H12v4.51h6.46c-.27 1.57-1.16 2.9-2.46 3.77v3.15h3.99c2.33-2.14 3.7-5.31 3.7-8.87z" />
            <path fill="#FBBC05" d="M5.35 14.46c-.24-.72-.37-1.48-.37-2.46s.13-1.74.37-2.46l-3.8-2.95C.56 8.35 0 10.11 0 12s.56 3.65 1.55 5.41l3.8-2.95z" />
            <path fill="#34A853" d="M12 23c3.24 0 5.97-1.07 7.96-2.91l-3.91-2.97c-1.12.75-2.54 1.2-4.05 1.2-3.13 0-5.82-1.73-6.79-4.28l-3.8 2.95C3.37 21.35 7.37 24 12 24z" />
          </svg>
          Continue with Google
        </button>
      </div>
    </div>
  );
}

export default function LoginPage() {
  return (
    <div className="flex-1 bg-[#050508] text-white relative flex flex-col justify-center items-center min-h-screen p-6 overflow-hidden">
      <div className="fixed inset-0 overflow-hidden pointer-events-none z-0">
        <style jsx global>{`
          @keyframes drift-slow { 0% { transform: translate(0px, 0px) scale(1); } 33% { transform: translate(40px, -60px) scale(1.15); } 66% { transform: translate(-30px, 30px) scale(0.9); } 100% { transform: translate(0px, 0px) scale(1); } }
          @keyframes drift-medium { 0% { transform: translate(0px, 0px) scale(1); } 50% { transform: translate(-50px, 50px) scale(1.2); } 100% { transform: translate(0px, 0px) scale(1); } }
          .orb-1 { animation: drift-slow 22s infinite ease-in-out; will-change: transform; }
          .orb-2 { animation: drift-medium 18s infinite ease-in-out; will-change: transform; }
          .grid-overlay { background-image: linear-gradient(to right, rgba(255,255,255,0.03) 1px, transparent 1px), linear-gradient(to bottom, rgba(255,255,255,0.03) 1px, transparent 1px); background-size: 50px 50px; }
        `}</style>
        <div className="absolute inset-0 grid-overlay opacity-30" />
        <div className="absolute top-[-15%] left-[-10%] w-[550px] h-[550px] rounded-full orb-1" style={{ background: 'radial-gradient(circle, rgba(168, 85, 247, 0.15) 0%, transparent 70%)' }} />
        <div className="absolute bottom-[-15%] right-[-10%] w-[550px] h-[550px] rounded-full orb-2" style={{ background: 'radial-gradient(circle, rgba(99, 102, 241, 0.15) 0%, transparent 70%)' }} />
      </div>

      <Link href="/" className="absolute top-6 left-6 inline-flex items-center gap-2 text-xs font-semibold px-4 py-2 rounded-full border border-white/5 bg-neutral-900/60 hover:bg-neutral-800 text-neutral-300 hover:text-white transition duration-200 group z-25">
        <ArrowLeft className="w-3.5 h-3.5 group-hover:-translate-x-0.5 transition-transform" />
        <span>Back to home</span>
      </Link>

      <Suspense fallback={
        <div className="flex flex-col items-center gap-4 relative z-10">
          <div className="p-3 rounded-2xl bg-gradient-to-tr from-purple-500 to-indigo-500 shadow-lg shadow-purple-500/20 animate-pulse">
            <Logo className="w-8 h-8 text-white animate-spin [animation-duration:10s]" />
          </div>
        </div>
      }>
        <AuthContent />
      </Suspense>
    </div>
  );
}
