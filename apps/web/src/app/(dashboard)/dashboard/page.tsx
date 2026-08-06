'use client';

import React, { useState, useEffect } from 'react';
import { LayoutDashboard, Sparkles, FileText, Briefcase, Layers, Sliders, Save, Check, Shield, Phone, Mail, CheckCircle, Send, ArrowRight, ArrowLeft, User as UserIcon, Globe, Loader2, Award, MessageCircle } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { useUser, useAuth } from '@/context/FirebaseAuthContext';
import { auth } from '@/lib/firebase';
import { API_BASE } from '@/lib/constants';

export default function DashboardPage() {
  const { user } = useUser();
  const { getToken } = useAuth();
  const [loading, setLoading] = useState(false);
  const [saved, setSaved] = useState(false);
  const [profileLoading, setProfileLoading] = useState(true);
  const [refreshKey, setRefreshKey] = useState(0);
  
  const [fullName, setFullName] = useState('');
  const [email, setEmail] = useState('');
  const [locationInput, setLocationInput] = useState('');
  const [experienceLevel, setExperienceLevel] = useState('Mid');

  // User Filters state
  const [minSalary, setMinSalary] = useState(600000); // 6 Lakhs INR
  const [workTypes, setWorkTypes] = useState<string[]>(['Remote', 'Hybrid']);
  const [countries, setCountries] = useState<string[]>(['Bengaluru', 'Remote']); // Target locations
  const [targetJobRole, setTargetJobRole] = useState('');
  const [educationFilter, setEducationFilter] = useState('B.E./B.Tech');
  const [jobSourceFilter, setJobSourceFilter] = useState<'All' | 'Company' | 'Consultant'>('All');

  // Real-time Dashboard metrics state
  const [realtimeStats, setRealtimeStats] = useState({
    atsScore: 0,
    recsCount: 0,
    highMatches: 0,
    activeApps: 0,
    submittedApps: 0
  });

  // Verification state
  const [emailOtp, setEmailOtp] = useState('');
  const [emailVerified, setEmailVerified] = useState(false);
  const [emailOtpSent, setEmailOtpSent] = useState(false);
  const [telegramVerified, setTelegramVerified] = useState(false);
  const [telegramBotUsername, setTelegramBotUsername] = useState('AIJobCopilotBot');
  const [verifyLoading, setVerifyLoading] = useState<string | null>(null);
  const [verifyMsg, setVerifyMsg] = useState<string | null>(null);

  // Sync with Clerk User session dynamically
  useEffect(() => {
    if (user) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setFullName(user.fullName || '');
      setEmail(user.primaryEmailAddress?.emailAddress || '');
    }
  }, [user]);

  // Load live metric statistics from NestJS backend instead of mock localStorage seeding
  useEffect(() => {
    const fetchRealStats = async () => {
      try {
        const token = await getToken();
        if (!token) return;

        // Run all stats fetches in parallel for massive speedup!
        const [appRes, matchRes, extRes, resumeRes] = await Promise.all([
          fetch(`${API_BASE}/application`, { headers: { Authorization: `Bearer ${token}` } }),
          fetch(`${API_BASE}/job/dashboard`, { headers: { Authorization: `Bearer ${token}` } }),
          fetch(`${API_BASE}/external-board/list`, { headers: { Authorization: `Bearer ${token}` } }).catch(() => ({ ok: false, json: async () => [] } as any)),
          fetch(`${API_BASE}/resume/latest`, { headers: { Authorization: `Bearer ${token}` } })
        ]);

        let appsList = [];
        if (appRes.ok) appsList = await appRes.json();

        let recsCount = 0;
        let highMatches = 0;
        if (matchRes.ok) {
          const matchData = await matchRes.json();
          const jobsList = Array.isArray(matchData) ? matchData : (matchData.recommendations || []);
          recsCount = jobsList.length;
          highMatches = jobsList.filter((item: any) => item.match && item.match.matchScore >= 90).length;
        }

        let extCount = 0;
        if (extRes.ok) {
          try {
            const extJobs = await extRes.json();
            if (Array.isArray(extJobs)) extCount = extJobs.length;
          } catch (e) {}
        }
        
        let atsScore = 0;
        if (resumeRes.ok) {
          const resumeData = await resumeRes.json();
          atsScore = resumeData.atsScore || 0;

          if (!atsScore) {
            const cachedAts = typeof window !== 'undefined' ? localStorage.getItem('ats_result') : null;
            if (cachedAts) {
              try {
                const parsedAts = JSON.parse(cachedAts);
                atsScore = parsedAts.overallScore || 0;
              } catch (e) {
                atsScore = 0;
              }
            }
          }
        }

        const active = appsList.filter((a: any) => 
          a.status === 'Matched' || a.status === 'Tailored' || a.status === 'Applying'
        ).length;

        const submitted = appsList.filter((a: any) => 
          a.status === 'Applied' || a.status === 'Interviewing' || a.status === 'Offered' || a.status === 'Rejected'
        ).length;

        setRealtimeStats({
          atsScore: resumeRes.ok ? atsScore : 0,
          recsCount: recsCount + extCount,
          highMatches: highMatches,
          activeApps: active,
          submittedApps: submitted
        });
      } catch (err) {
        console.error('Failed to load real stats:', err);
      }
    };

    fetchRealStats();
  }, [refreshKey, user, getToken]);

  // Fetch or init filters
  useEffect(() => {
    const loadProfileAndFilters = async () => {
      setProfileLoading(true);
      try {
        const token = await getToken();
        
        // 1. Fetch user verification status and profile simultaneously!
        const [statusRes, profileRes] = await Promise.all([
          fetch(`${API_BASE}/auth/status`, { headers: { 'Authorization': `Bearer ${token}` } }),
          fetch(`${API_BASE}/user/profile`, { headers: { 'Authorization': `Bearer ${token}` } })
        ]);

        if (statusRes.ok) {
          const data = await statusRes.json();
          setEmailVerified(data.emailVerified);
          setTelegramVerified(data.telegramVerified);
          if (data.telegramBotUsername) setTelegramBotUsername(data.telegramBotUsername);
          if (data.emailVerified) localStorage.setItem('emailVerified', 'true');
          else localStorage.removeItem('emailVerified');
          if (data.telegramVerified) localStorage.setItem('telegramVerified', 'true');
          else localStorage.removeItem('telegramVerified');
        }

        if (profileRes.ok) {
          const profile = await profileRes.json();
          if (profile && profile.filters) {
            const f = profile.filters;
            if (f.minSalary) setMinSalary(Number(f.minSalary));
            if (f.workTypes) setWorkTypes(f.workTypes);
            if (f.countries) setCountries(f.countries);
            if (f.experienceLevel) setExperienceLevel(f.experienceLevel);
            const targetRoleStr = f.targetJobRole || (f.targetRoles ? f.targetRoles.join(', ') : '');
            if (targetRoleStr) setTargetJobRole(targetRoleStr);
          }
          if (profile.name) setFullName(profile.name);
          if (profile.email) setEmail(profile.email);
        }
      } catch (err) {
        console.error('Failed to load profile from Mongoose backend:', err);
      } finally {
        setProfileLoading(false);
      }
    };
    loadProfileAndFilters();
  }, [user]);

  const handleSaveFilters = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setSaved(false);

    // Save to local storage for failproof fallback
    localStorage.setItem('minSalary', minSalary.toString());
    localStorage.setItem('workTypes', JSON.stringify(workTypes));
    localStorage.setItem('countries', JSON.stringify(countries));
    localStorage.setItem('experienceLevel', experienceLevel);
    localStorage.setItem('educationFilter', educationFilter);
    localStorage.setItem('jobSourceFilter', jobSourceFilter);
    localStorage.setItem('targetJobRole', targetJobRole);

    try {
      const token = await getToken();
      // Try hitting the backend API
      const res = await fetch(`${API_BASE}/job/filters`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`
        },
        body: JSON.stringify({
          email: email || 'user@example.com',
          filters: {
            workTypes,
            minSalary,
            countries,
            experienceLevel,
            targetJobRole: targetJobRole || undefined,
            targetRoles: targetJobRole ? targetJobRole.split(',').map(r => r.trim()).filter(Boolean) : []
          }
        })
      });

      if (res.ok) {
        console.log('Filters saved to backend API');
        setRefreshKey(prev => prev + 1);
      }
    } catch (err) {
      console.warn('Backend API connection offline. Filters saved locally in Sandbox.', err);
    } finally {
      setLoading(false);
      setSaved(true);
      setTimeout(() => setSaved(false), 3000);
    }
  };

  const handleToggleWorkType = (type: string) => {
    if (workTypes.includes(type)) {
      setWorkTypes(workTypes.filter(t => t !== type));
    } else {
      setWorkTypes([...workTypes, type]);
    }
  };

  if (profileLoading) {
    return (
      <div className="flex-1 flex justify-center items-center h-64">
        <div className="w-8 h-8 border-2 border-purple-500 border-t-transparent rounded-full animate-spin"></div>
      </div>
    );
  }

  return (
    <div className="space-y-8 flex-1 flex flex-col justify-start">
      {/* Welcome Banner */}
      <div className="flex justify-between items-center">
        <div>
          <h1 className="text-[1.3rem] sm:text-2xl md:text-3xl font-bold tracking-tight bg-gradient-to-r from-purple-400 via-indigo-300 to-indigo-400 bg-clip-text text-transparent whitespace-nowrap flex items-center gap-2">
            <LayoutDashboard className="w-5 h-5 md:w-6 md:h-6 text-purple-400 shrink-0" />
            Overview Dashboard
          </h1>
          <p className="hidden md:block text-neutral-400 text-sm mt-1.5 leading-relaxed max-w-2xl">Track your job matches, resume score, and automation pipeline status.</p>
        </div>
        {realtimeStats.atsScore > 0 ? (
          <div className="flex items-center gap-2 px-3 py-1.5 rounded-full bg-purple-500/10 border border-purple-500/20 text-xs text-purple-300 font-semibold">
            <Sparkles className="w-3.5 h-3.5 text-purple-400 animate-pulse" /> AI Engine Online
          </div>
        ) : (
          <div className="flex items-center gap-2 px-3 py-1.5 rounded-full bg-neutral-900 border border-white/5 text-xs text-neutral-400 font-semibold">
            <div className="w-1.5 h-1.5 rounded-full bg-neutral-600 animate-ping" /> AI Engine Offline
          </div>
        )}
      </div>

      {/* Grid of Stats Cards */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-6">
        <div className="glass-card p-6">
          <div className="flex justify-between items-start text-neutral-400">
            <span className="text-sm font-semibold">Resume ATS Score</span>
            <FileText className="w-5 h-5 text-purple-400" />
          </div>
          <div className="mt-4 flex items-baseline gap-2">
            <span className="text-3xl font-extrabold">
              {realtimeStats.atsScore > 0 ? `${realtimeStats.atsScore}%` : 'N/A'}
            </span>
            <span className={`text-xs font-bold ${realtimeStats.atsScore > 0 ? 'text-green-400' : 'text-neutral-500'}`}>
              {realtimeStats.atsScore > 0 ? 'Excellent' : 'No Resume'}
            </span>
          </div>
          <div className="mt-3 w-full bg-neutral-800 h-1.5 rounded-full overflow-hidden">
            <div className="bg-purple-500 h-full rounded-full transition-all" style={{ width: `${realtimeStats.atsScore}%` }} />
          </div>
        </div>
        <div className="glass-card p-6">
          <div className="flex justify-between items-start text-neutral-400">
            <span className="text-sm font-semibold">Total Recommendations</span>
            <Briefcase className="w-5 h-5 text-purple-400" />
          </div>
          <div className="mt-4 flex items-baseline gap-2">
            <span className="text-3xl font-extrabold">{realtimeStats.recsCount}</span>
            <span className="text-xs text-purple-400 font-bold">Discovered Roles</span>
          </div>
          <p className="text-xs text-neutral-500 mt-3">{realtimeStats.highMatches} highly compatible matches (&gt;90%)</p>
        </div>

        <div className="glass-card p-6">
          <div className="flex justify-between items-start text-neutral-400">
            <span className="text-sm font-semibold">Active Applications</span>
            <Layers className="w-5 h-5 text-purple-400" />
          </div>
          <div className="mt-4 flex items-baseline gap-2">
            <span className="text-3xl font-extrabold">{realtimeStats.activeApps}</span>
            <span className="text-xs text-indigo-400 font-bold">in Progress</span>
          </div>
          <p className="text-xs text-neutral-500 mt-3">Tailored matches awaiting submission</p>
        </div>

        <div className="glass-card p-6">
          <div className="flex justify-between items-start text-neutral-400">
            <span className="text-sm font-semibold">Applications Submitted</span>
            <Check className="w-5 h-5 text-green-400" />
          </div>
          <div className="mt-4 flex items-baseline gap-2">
            <span className="text-3xl font-extrabold">{realtimeStats.submittedApps}</span>
            <span className="text-xs text-green-400 font-bold">Submitted</span>
          </div>
          <p className="text-xs text-neutral-500 mt-3">Processed automatically by copilot</p>
        </div>
      </div>

      {/* Verification Panel */}
      <div className="glass-card p-6">
        <div className="flex flex-col md:flex-row md:items-center gap-2 mb-6 border-b border-white/5 pb-4">
          <div className="flex items-center gap-2">
            <Shield className="w-5 h-5 text-purple-400 shrink-0" />
            <h3 className="font-bold text-lg whitespace-nowrap">Contact Verification</h3>
          </div>
          <span className="text-xs text-neutral-500 md:ml-auto">Required for auto-apply & Telegram bot notifications</span>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-6 w-full">
          {/* Email Verification (Read Only - Since they are on this screen, they are verified) */}
          <div className="p-5 rounded-xl bg-neutral-950/40 border border-white/5 space-y-3 flex flex-col justify-center">
            <div className="flex items-center gap-2">
              <Mail className="w-4 h-4 text-purple-400" />
              <span className="text-sm font-bold text-white">Email Verification</span>
              <span className="ml-auto px-2 py-0.5 rounded-full bg-purple-500/10 text-purple-400 text-[10px] font-bold flex items-center gap-1"><CheckCircle className="w-3 h-3" /> Verified</span>
            </div>
            <p className="text-xs text-neutral-500">Your email address is securely verified and linked to your account.</p>
          </div>

          {/* Telegram Verification */}
          <div className="p-5 rounded-xl bg-neutral-950/40 border border-white/5 space-y-3 flex flex-col justify-center">
            <div className="flex items-center gap-2">
              <MessageCircle className="w-4 h-4 text-blue-400" />
              <span className="text-sm font-bold text-white">Telegram Alerts</span>
              {telegramVerified && <span className="ml-auto px-2 py-0.5 rounded-full bg-blue-500/10 text-blue-400 text-[10px] font-bold flex items-center gap-1"><CheckCircle className="w-3 h-3" /> Connected</span>}
            </div>
            {!telegramVerified ? (
              <div className="space-y-3">
                <p className="text-xs text-neutral-400">Connect your Telegram account to receive instant job matches and application updates directly on your phone.</p>
                <button
                  onClick={() => {
                    const botUsername = telegramBotUsername;
                    window.open(`https://t.me/${botUsername}?start=${user?.id}`, '_blank');
                    
                    // Optimistically poll for verification status
                    setVerifyMsg('Polling for Telegram verification...');
                    let attempts = 0;
                    const pollInterval = setInterval(async () => {
                      attempts++;
                      try {
                        const res = await fetch(`${API_BASE}/auth/status`, { headers: { 'Authorization': `Bearer ${await getToken()}` } });
                        const data = await res.json();
                        if (data.telegramVerified) {
                          setTelegramVerified(true);
                          localStorage.setItem('telegramVerified', 'true');
                          setVerifyMsg('Successfully connected to Telegram!');
                          clearInterval(pollInterval);
                          setTimeout(() => setVerifyMsg(null), 5000);
                        } else if (attempts > 30) { // Timeout after 1 minute (2s * 30)
                          clearInterval(pollInterval);
                          setVerifyMsg('Verification timed out. Try again.');
                          setTimeout(() => setVerifyMsg(null), 5000);
                        }
                      } catch (e) {}
                    }, 2000);
                  }}
                  className="w-full py-2.5 rounded-xl bg-blue-600 hover:bg-blue-700 text-white text-xs font-semibold transition flex items-center justify-center gap-2 cursor-pointer"
                >
                  <Send className="w-3.5 h-3.5" /> Connect via Telegram
                </button>
              </div>
            ) : (
              <div className="space-y-3 mt-2 border-t border-white/5 pt-3">
                <p className="text-xs text-neutral-400">Your Telegram account is connected. You will receive live match scores and apply updates securely via Telegram.</p>
              </div>
            )}
          </div>
        </div>

        {/* Verification status toast */}
        {verifyMsg && (
          <div className="mt-4 p-3 rounded-xl bg-purple-500/10 border border-purple-500/20 text-xs text-purple-300 flex items-center gap-2">
            <CheckCircle className="w-4 h-4" />
            <span>{verifyMsg}</span>
          </div>
        )}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
        {/* Preference Filters form */}
        <div className="glass-card p-4 md:p-8 lg:col-span-1 h-fit">
          <div className="flex items-center gap-2 mb-6 border-b border-white/5 pb-4">
            <Sliders className="w-5 h-5 text-purple-400" />
            <h3 className="font-bold text-lg">Job Discovery Filters</h3>
          </div>

          <form onSubmit={handleSaveFilters} className="space-y-6">
            {/* Target Job Role */}
            <div className="space-y-2">
              <label className="text-xs font-semibold text-neutral-400 block">Target Job Roles (Comma Separated)</label>
              <input placeholder="e.g. React Developer, Data Scientist" type="text"
                value={targetJobRole}
                onChange={(e) => setTargetJobRole(e.target.value)}
                className="w-full bg-neutral-900 border border-white/5 rounded-xl px-4 py-2.5 text-xs text-white focus:outline-none focus:border-purple-500/50 transition"
              />
              <p className="text-[10px] text-neutral-500">Specify multiple roles to search across combinations of roles and locations.</p>
            </div>

            {/* Work Type */}
            <div className="space-y-2">
              <label className="text-xs font-semibold text-neutral-400 block">Work Preference</label>
              <div className="flex gap-2 flex-wrap">
                {['Remote', 'Hybrid', 'Onsite'].map(type => {
                  const active = workTypes.includes(type);
                  return (
                    <button
                      key={type}
                      type="button"
                      onClick={() => handleToggleWorkType(type)}
                      className={`px-3 py-1.5 rounded-lg text-xs font-semibold border transition ${
                        active
                          ? 'bg-purple-600/20 border-purple-500/50 text-purple-300'
                          : 'bg-neutral-900 border-white/5 text-neutral-400 hover:text-white'
                      }`}
                    >
                      {type}
                    </button>
                  );
                })}
              </div>
            </div>

            {/* Target Locations */}
            <div className="space-y-2">
              <label className="text-xs font-semibold text-neutral-400 block">Target Locations (Comma Separated)</label>
              <input placeholder="e.g. Bengaluru, Mumbai" type="text"
                value={countries.join(', ')}
                onChange={(e) => setCountries(e.target.value.split(',').map(s => s.trim()))}
                className="w-full bg-neutral-900 border border-white/5 rounded-xl px-4 py-2.5 text-xs text-white focus:outline-none focus:border-purple-500/50 transition"
              />
            </div>

            {/* Experience Level */}
            <div className="space-y-2">
              <label className="text-xs font-semibold text-neutral-400 block">Experience Level</label>
              <select
                value={experienceLevel}
                onChange={(e) => setExperienceLevel(e.target.value)}
                className="w-full bg-neutral-900 border border-white/5 rounded-xl px-4 py-2.5 text-xs text-white focus:outline-none focus:border-purple-500/50 cursor-pointer"
              >
                <option value="Fresher">Fresher (0-1 years)</option>
                <option value="Junior">Junior (1-3 years)</option>
                <option value="Mid">Mid Level (3-5 years)</option>
                <option value="Senior">Senior (5+ years)</option>
              </select>
            </div>

            {/* Education Filter */}
            <div className="space-y-2">
              <label className="text-xs font-semibold text-neutral-400 block">Education Qualification</label>
              <select
                value={educationFilter}
                onChange={(e) => setEducationFilter(e.target.value)}
                className="w-full bg-neutral-900 border border-white/5 rounded-xl px-4 py-2.5 text-xs text-white focus:outline-none focus:border-purple-500/50 cursor-pointer"
              >
                <option value="B.E./B.Tech">B.E./B.Tech</option>
                <option value="MCA/BCA">MCA/BCA</option>
                <option value="MBA/BBA">MBA/BBA</option>
                <option value="Any Graduate">Any Graduate</option>
              </select>
            </div>

            {/* Min Salary (Placed Last) */}
            <div className="space-y-2">
              <div className="flex justify-between text-xs font-semibold">
                <label className="text-neutral-400">Minimum Annual Salary</label>
                <span className="text-purple-300">₹{(minSalary / 100000).toFixed(0)} Lakhs (LPA)</span>
              </div>
              <input
                type="range"
                min="300000"
                max="5000000"
                step="100000"
                value={minSalary}
                onChange={(e) => setMinSalary(Number(e.target.value))}
                className="w-full accent-purple-500 cursor-pointer"
              />
            </div>

            {/* Submit button */}
            <button
              type="submit"
              disabled={profileLoading || loading}
              className="w-full py-3 rounded-xl bg-purple-600 hover:bg-purple-700 disabled:bg-neutral-800 disabled:text-neutral-500 disabled:cursor-not-allowed text-white text-sm font-semibold transition flex items-center justify-center gap-2 cursor-pointer shadow-lg shadow-purple-500/10"
            >
              {profileLoading ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin text-purple-400" /> Initializing Filters...
                </>
              ) : loading ? (
                <span>Saving...</span>
              ) : saved ? (
                <>
                  <Check className="w-4 h-4 text-green-300" /> Filters Saved!
                </>
              ) : (
                <>
                  <Save className="w-4 h-4" /> Save Filters
                </>
              )}
            </button>
          </form>
        </div>

        {/* AI Recommendations & Actions logs */}
        <div className="glass-card p-6 lg:col-span-2">
          <div className="flex justify-between items-center mb-6 border-b border-white/5 pb-4">
            <div className="flex items-center gap-2">
              <Sparkles className="w-5 h-5 text-purple-400" />
              <h3 className="font-bold text-lg">AI Decision engine suggestions</h3>
            </div>
          </div>

          <div className="space-y-4">
            <div className="p-4 rounded-xl bg-purple-500/5 border border-purple-500/10 flex gap-4">
              <div className="p-2.5 rounded-xl bg-purple-500/10 text-purple-300 h-fit">
                <Sparkles className="w-4 h-4" />
              </div>
              <div>
                <h4 className="font-bold text-sm text-white">ATS Scoring Engine</h4>
                <p className="text-xs text-neutral-400 mt-1 leading-relaxed">
                  Your uploaded resume is scanned and scored in real-time against matched jobs. Suggests keyword optimizations automatically to maximize your match score.
                </p>
              </div>
            </div>

            <div className="p-4 rounded-xl bg-indigo-500/5 border border-indigo-500/10 flex gap-4">
              <div className="p-2.5 rounded-xl bg-indigo-500/10 text-indigo-300 h-fit">
                <Briefcase className="w-4 h-4" />
              </div>
              <div>
                <h4 className="font-bold text-sm text-white">Auto-Apply Scheduler</h4>
                <p className="text-xs text-neutral-400 mt-1 leading-relaxed">
                  Claude automatically custom-tailors and submits your application to any vacancy recommendation that exceeds your match score threshold.
                </p>
              </div>
            </div>

            {/* Live Telegram Alert Status */}
            <div className="bg-gradient-to-r from-blue-950/20 to-indigo-900/10 border border-blue-500/10 p-5 rounded-2xl flex items-start gap-4">
              <div className="w-10 h-10 rounded-full bg-blue-500/10 flex items-center justify-center shrink-0">
                <MessageCircle className="w-5 h-5 text-blue-400" />
              </div>
              <div>
                <h4 className="font-bold text-sm text-white">Telegram Bot Alerts</h4>
                <p className="text-xs text-neutral-400 mt-1.5 leading-relaxed">
                  {telegramVerified ? (
                    <>Telegram Auto-apply alert bot is configured. You will receive live updates when Claude submits cover letters and resumes.</>
                  ) : (
                    <>Telegram notifications offline. Please connect your Telegram account in the Contact Verification card above to receive instant mobile notifications.</>
                  )}
                </p>
              </div>
            </div>



            {/* Indeed & Naukri Sync */}
            <div className="p-4 rounded-xl bg-indigo-500/5 border border-indigo-500/10 flex gap-4">
              <div className="p-2.5 rounded-xl bg-indigo-500/10 text-indigo-300 h-fit">
                <Globe className="w-4 h-4" />
              </div>
              <div>
                <h4 className="font-bold text-sm text-white">Job Portal Sync Engine</h4>
                <p className="text-xs text-neutral-400 mt-1 leading-relaxed">
                  Scans search indexes across Indeed, Naukri, LinkedIn, Greenhouse, and Lever in real-time based on your target location, experience, and work mode filters.
                </p>
              </div>
            </div>

            {/* AI Resume Tailoring Engine */}
            <div className="p-4 rounded-xl bg-purple-500/5 border border-purple-500/10 flex gap-4">
              <div className="p-2.5 rounded-xl bg-purple-500/10 text-purple-300 h-fit">
                <Award className="w-4 h-4" />
              </div>
              <div>
                <h4 className="font-bold text-sm text-white">AI Resume Tailoring Engine</h4>
                <p className="text-xs text-neutral-400 mt-1 leading-relaxed">
                  Automatically custom-tailors your resume's professional summaries and bullet-point achievements to match the specific keywords and requirements of target jobs.
                </p>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
