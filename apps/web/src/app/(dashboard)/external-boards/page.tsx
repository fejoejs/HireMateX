'use client';

import React, { useState, useEffect } from 'react';
import Link from 'next/link';
import { useAuth } from '@/context/FirebaseAuthContext';
import { 
  Globe, 
  ArrowRight, 
  Check, 
  X, 
  RefreshCw, 
  Briefcase, 
  MapPin, 
  DollarSign, 
  LayoutGrid, 
  List, 
  Sparkles, 
  Search, 
  SlidersHorizontal, 
  Building2,
  ExternalLink,
  Filter
} from 'lucide-react';
import { API_BASE } from '@/lib/constants';

function decodeHtmlEntities(str: string): string {
  if (!str) return '';
  return str
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&middot;/g, '•')
    .replace(/&bull;/g, '•')
    .replace(/&rsquo;/g, "'")
    .replace(/&ldquo;/g, '"')
    .replace(/&rdquo;/g, '"')
    .replace(/&ndash;/g, '-')
    .replace(/&mdash;/g, '—')
    .replace(/&lt;br\s*\/?[&gt;]/gi, ' ')
    .replace(/\\n/g, ' ')
    .replace(/\\r/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

interface ExternalJob {
  _id: string;
  title: string;
  company: string;
  location?: string;
  salary?: string;
  shortDescription?: string;
  url: string;
  sourcePlatform: 'LinkedIn' | 'Indeed' | 'Naukri';
  lastSeenAt: string;
  createdAt?: string;
  isNew?: boolean;
  matchScore?: number;
  matchHighlights?: string[];
  isPreferenceMatch?: boolean;
}

export default function ExternalBoardsPage() {
  const { getToken, user, loading: authLoading } = useAuth();
  const [jobs, setJobs] = useState<ExternalJob[]>([]);
  const [pendingIds, setPendingIds] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<'All' | 'Naukri' | 'LinkedIn' | 'Indeed'>('All');
  const [layoutMode, setLayoutMode] = useState<'grid' | 'list'>('grid');
  const [searchQuery, setSearchQuery] = useState('');
  const [expandedDescId, setExpandedDescId] = useState<string | null>(null);

  const fetchJobs = async () => {
    setLoading(true);
    setError(null);
    try {
      const token = await getToken();
      const res = await fetch(`${API_BASE}/external-board/list`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      if (res.ok) {
        const data = await res.json();
        setJobs(data || []);
      } else {
        setError('Failed to fetch sourced jobs. Please try again.');
      }
    } catch (err) {
      console.error('Failed to load external jobs:', err);
      setError('Connection failed. Verify the server is active.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (!authLoading && user) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      fetchJobs();
    }
  }, [authLoading, user]);

  const handleApplyClick = async (job: ExternalJob) => {
    try {
      const token = await getToken();
      await fetch(`${API_BASE}/external-board/${job._id}/mark-pending`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` }
      });
      setPendingIds(prev => {
        const next = new Set(prev);
        next.add(job._id);
        return next;
      });
      window.open(job.url, '_blank', 'noopener,noreferrer');
    } catch (err) {
      console.error('Failed to mark job as pending:', err);
    }
  };

  const confirmApplied = async (id: string) => {
    try {
      const token = await getToken();
      await fetch(`${API_BASE}/external-board/${id}/confirm-applied`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` }
      });
      setPendingIds(prev => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
      setJobs(prev => prev.filter(j => j._id !== id));
    } catch (err) {
      console.error('Failed to confirm job application:', err);
    }
  };

  const confirmNotApplied = async (id: string) => {
    try {
      const token = await getToken();
      await fetch(`${API_BASE}/external-board/${id}/confirm-not-applied`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` }
      });
      setPendingIds(prev => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
    } catch (err) {
      console.error('Failed to cancel job application status:', err);
    }
  };

  const dismissJob = async (id: string) => {
    try {
      const token = await getToken();
      await fetch(`${API_BASE}/external-board/${id}/dismiss`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` }
      });
      setJobs(prev => prev.filter(j => j._id !== id));
      setPendingIds(prev => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
    } catch (err) {
      console.error('Failed to dismiss job:', err);
    }
  };

  const getPlatformBadgeColor = (platform: string) => {
    switch (platform) {
      case 'LinkedIn':
        return 'bg-sky-500/10 text-sky-400 border border-sky-500/30';
      case 'Indeed':
        return 'bg-blue-500/10 text-blue-400 border border-blue-500/30';
      case 'Naukri':
        return 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/30';
      default:
        return 'bg-zinc-800 text-zinc-400 border border-white/10';
    }
  };

  const formatDate = (dateStr: string) => {
    try {
      const d = new Date(dateStr);
      if (isNaN(d.getTime())) return '';
      return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
    } catch {
      return '';
    }
  };

  const filteredJobs = (() => {
    let result = activeTab === 'All'
      ? jobs
      : jobs.filter(j => (j.sourcePlatform || '').toLowerCase() === activeTab.toLowerCase());

    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase().trim();
      result = result.filter(j => 
        (j.title && j.title.toLowerCase().includes(q)) ||
        (j.company && j.company.toLowerCase().includes(q)) ||
        (j.location && j.location.toLowerCase().includes(q))
      );
    }

    return [...result].sort((a, b) => {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      const aIsNew = a.isNew !== undefined ? (a.isNew ? 1 : 0) : (a.createdAt || a.lastSeenAt ? (Date.now() - new Date(a.createdAt || a.lastSeenAt).getTime() < 24 * 60 * 60 * 1000 ? 1 : 0) : 0);
      // eslint-disable-next-line react-hooks/set-state-in-effect
      const bIsNew = b.isNew !== undefined ? (b.isNew ? 1 : 0) : (b.createdAt || b.lastSeenAt ? (Date.now() - new Date(b.createdAt || b.lastSeenAt).getTime() < 24 * 60 * 60 * 1000 ? 1 : 0) : 0);
      if (aIsNew !== bIsNew) return bIsNew - aIsNew; // New on top
      if (a.isPreferenceMatch !== b.isPreferenceMatch) return a.isPreferenceMatch ? -1 : 1;
      if ((b.matchScore || 0) !== (a.matchScore || 0)) return (b.matchScore || 0) - (a.matchScore || 0);
      return new Date(b.lastSeenAt || b.createdAt || 0).getTime() - new Date(a.lastSeenAt || a.createdAt || 0).getTime();
    });
  })();

  if (loading && jobs.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center min-h-[60vh] gap-3">
        <RefreshCw className="w-8 h-8 text-purple-500 animate-spin" />
        <span className="text-xs text-zinc-400 font-medium tracking-wide">Loading Sourced Jobs...</span>
      </div>
    );
  }

  return (
    <div className="space-y-5 flex-1 w-full max-w-7xl mx-auto px-1 sm:px-0 pb-12">
      {/* Header Bar */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 bg-zinc-950/60 p-4 sm:p-5 rounded-2xl border border-white/5 backdrop-blur-md">
        <div>
          <div className="flex items-center gap-2.5">
            <div className="w-9 h-9 rounded-xl bg-purple-500/10 border border-purple-500/20 flex items-center justify-center text-purple-400 shrink-0 shadow-inner">
              <Globe className="w-5 h-5" />
            </div>
            <div>
              <h1 className="text-lg sm:text-xl md:text-2xl font-black tracking-tight text-white flex items-center gap-2">
                External Sourced Jobs
                <span className="text-xs px-2 py-0.5 rounded-full font-bold bg-purple-500/20 text-purple-300 border border-purple-500/30">
                  {filteredJobs.length} Live
                </span>
              </h1>
              <p className="text-zinc-400 text-xs mt-0.5">
                Automatically sourced via Chrome Extension and ranked by your profile match.
              </p>
            </div>
          </div>
        </div>

        {/* Controls & Actions */}
        <div className="flex items-center gap-2.5 flex-wrap sm:flex-nowrap justify-between sm:justify-end">

          {/* Layout Mode (Grid/List) */}
          <div className="flex items-center bg-zinc-900 border border-white/10 p-1 rounded-xl">
            <button
              type="button"
              onClick={() => setLayoutMode('grid')}
              className={`p-1.5 rounded-lg transition-all cursor-pointer ${
                layoutMode === 'grid' 
                  ? 'bg-purple-500/20 text-purple-300' 
                  : 'text-zinc-500 hover:text-zinc-300'
              }`}
              title="Grid View"
            >
              <LayoutGrid className="w-4 h-4" />
            </button>
            <button
              type="button"
              onClick={() => setLayoutMode('list')}
              className={`p-1.5 rounded-lg transition-all cursor-pointer ${
                layoutMode === 'list' 
                  ? 'bg-purple-500/20 text-purple-300' 
                  : 'text-zinc-500 hover:text-zinc-300'
              }`}
              title="List View"
            >
              <List className="w-4 h-4" />
            </button>
          </div>

          {/* Refresh Button */}
          <button 
            type="button"
            onClick={fetchJobs}
            disabled={loading}
            className="flex items-center gap-1.5 px-3 py-2 rounded-xl bg-zinc-900 border border-white/10 hover:bg-zinc-800 text-xs font-semibold transition cursor-pointer text-zinc-300 active:scale-95"
            title="Refresh vacancies"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin text-purple-400' : ''}`} />
            <span className="hidden sm:inline">Refresh</span>
          </button>
        </div>
      </div>

      {/* Preferences Pill Banner */}
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3 px-4 py-2.5 rounded-xl bg-purple-950/20 border border-purple-500/20 text-xs text-purple-300/90">
        <div className="flex items-center gap-2 flex-wrap">
          <Filter className="w-3.5 h-3.5 text-purple-400 shrink-0" />
          <span className="font-semibold text-white">Preference Filter:</span>
          <span>Only vacancies matching your Dashboard preferences (roles, location, work mode) are shown by default.</span>
        </div>
        <Link
          href="/dashboard"
          className="inline-flex items-center gap-1 text-xs font-bold text-purple-300 hover:text-white underline underline-offset-4 decoration-purple-500/40 hover:decoration-purple-300 transition shrink-0"
        >
          <SlidersHorizontal className="w-3 h-3" />
          <span>Edit Preferences</span>
        </Link>
      </div>

      {error && (
        <div className="p-3.5 rounded-xl bg-red-950/20 border border-red-500/30 text-xs text-red-400 flex items-center justify-between">
          <span>{error}</span>
          <button onClick={fetchJobs} className="underline font-bold hover:text-red-300">Retry</button>
        </div>
      )}

      {/* Filter Tabs & Search Row */}
      <div className="flex flex-col sm:flex-row justify-between items-stretch sm:items-center gap-3">
        {/* Platform Filter Tabs */}
        <div className="flex gap-1.5 border-b border-white/5 pb-1 overflow-x-auto scrollbar-none">
          {(['All', 'LinkedIn', 'Indeed', 'Naukri'] as const).map(tab => {
            const isActive = activeTab === tab;
            const count = tab === 'All' 
              ? jobs.length
              : jobs.filter(j => (j.sourcePlatform || '').toLowerCase() === tab.toLowerCase()).length;
            
            return (
              <button
                key={tab}
                onClick={() => setActiveTab(tab)}
                className={`pb-2 px-3 text-xs font-semibold border-b-2 transition-all cursor-pointer relative whitespace-nowrap flex items-center gap-1.5 ${
                  isActive 
                    ? 'border-purple-500 text-purple-400 font-bold' 
                    : 'border-transparent text-zinc-400 hover:text-zinc-200'
                }`}
              >
                <span>{tab === 'All' ? 'All Boards' : tab}</span>
                <span className={`px-1.5 py-0.2 rounded-md text-[10px] font-bold ${
                  isActive 
                    ? 'bg-purple-500/20 text-purple-300' 
                    : 'bg-zinc-900 text-zinc-500'
                }`}>
                  {count}
                </span>
              </button>
            );
          })}
        </div>

        {/* Quick Search */}
        <div className="relative w-full sm:w-64">
          <Search className="w-3.5 h-3.5 absolute left-3 top-1/2 -translate-y-1/2 text-zinc-500" />
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search role, company, city..."
            className="w-full bg-zinc-900/90 border border-white/10 focus:border-purple-500/50 pl-8 pr-8 py-1.5 rounded-xl text-xs text-white placeholder-zinc-500 outline-none transition"
          />
          {searchQuery && (
            <button
              onClick={() => setSearchQuery('')}
              className="absolute right-2.5 top-1/2 -translate-y-1/2 text-zinc-500 hover:text-zinc-300 p-0.5"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          )}
        </div>
      </div>

      {/* Jobs Listing */}
      {filteredJobs.length === 0 ? (
        <div className="text-center py-16 glass-card space-y-4 px-4 border border-white/5 rounded-2xl bg-zinc-950/40">
          <div className="w-12 h-12 rounded-2xl bg-purple-500/10 border border-purple-500/20 flex items-center justify-center mx-auto text-purple-400">
            <Briefcase className="w-6 h-6" />
          </div>
          <div className="space-y-1">
            <h3 className="text-sm sm:text-base font-bold text-white tracking-wide">
              No Vacancies Matching Your Preferences
            </h3>
            <p className="text-xs text-zinc-400 max-w-md mx-auto leading-relaxed">
              Jobs are strictly filtered against your profile preferences (Target Roles, Location, Work Mode, Experience). Update your preferences in Dashboard or source more vacancies with the Chrome Extension.
            </p>
          </div>
          <div className="flex justify-center items-center gap-3 pt-1">
            <Link
              href="/dashboard"
              className="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-xl bg-purple-600 hover:bg-purple-500 text-white text-xs font-bold transition shadow-md shadow-purple-600/20"
            >
              <SlidersHorizontal className="w-3.5 h-3.5" />
              Edit Dashboard Preferences
            </Link>
          </div>
        </div>
      ) : layoutMode === 'grid' ? (
        /* Reduced Size Grid Layout (3 columns on lg, 2 on md, 1 on sm) */
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3 sm:gap-4">
          {filteredJobs.map(job => {
            const isExpanded = expandedDescId === job._id;
            const cleanDesc = decodeHtmlEntities(job.shortDescription || '');
            const isNew = job.isNew !== undefined 
              ? job.isNew 
      // eslint-disable-next-line react-hooks/set-state-in-effect
              : (job.createdAt || job.lastSeenAt ? (Date.now() - new Date(job.createdAt || job.lastSeenAt).getTime() < 24 * 60 * 60 * 1000) : false);

            return (
              <div 
                key={job._id} 
                className="glass-card p-3.5 sm:p-4 rounded-xl border border-white/5 bg-zinc-950/70 hover:border-purple-500/40 transition-all duration-200 flex flex-col justify-between group"
              >
                <div className="space-y-2.5">
                  {/* Top Bar: Platform Badge + Match Badge + Date */}
                  <div className="flex items-center justify-between gap-1.5">
                    <div className="flex items-center gap-1.5">
                      <span className={`px-2 py-0.5 rounded-md text-[10px] font-bold uppercase tracking-wider ${getPlatformBadgeColor(job.sourcePlatform)}`}>
                        {job.sourcePlatform}
                      </span>
                      {isNew && (
                        <span className="px-1.5 py-0.5 rounded text-[8px] font-extrabold shrink-0 bg-emerald-500/15 text-emerald-300 border border-emerald-500/25">
                          NEW
                        </span>
                      )}
                    </div>

                    <div className="flex items-center gap-1.5">
                      {job.matchScore !== undefined && job.matchScore > 0 && (
                        <span className={`px-2 py-0.5 rounded-md text-[10px] font-extrabold flex items-center gap-1 ${
                          job.matchScore >= 70
                            ? 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/20'
                            : 'bg-purple-500/10 text-purple-400 border border-purple-500/20'
                        }`}>
                          <Sparkles className="w-2.5 h-2.5" />
                          {job.matchScore}% Match
                        </span>
                      )}
                      {job.lastSeenAt && (
                        <span className="text-[10px] text-zinc-500 font-medium">
                          {formatDate(job.lastSeenAt)}
                        </span>
                      )}
                    </div>
                  </div>

                  {/* Title & Company */}
                  <div>
                    <h3 className="font-bold text-xs sm:text-sm text-white line-clamp-2 leading-snug group-hover:text-purple-300 transition-colors">
                      {job.title}
                    </h3>
                    <div className="flex items-center gap-1.5 mt-0.5 text-xs text-purple-400 font-medium truncate">
                      <Building2 className="w-3 h-3 text-purple-400/70 shrink-0" />
                      <span className="truncate">{job.company || 'Confidential'}</span>
                    </div>
                  </div>

                  {/* Location & Salary Info */}
                  <div className="flex items-center gap-2 flex-wrap text-[11px] text-zinc-400 pt-1 border-t border-white/5">
                    {job.location && (
                      <div className="flex items-center gap-1 max-w-[180px] truncate">
                        <MapPin className="w-3 h-3 text-zinc-500 shrink-0" />
                        <span className="truncate">{job.location}</span>
                      </div>
                    )}
                    {job.salary && (
                      <div className="flex items-center gap-1 font-mono text-[10px] text-emerald-400/90 font-semibold">
                        <DollarSign className="w-3 h-3 shrink-0" />
                        <span>{job.salary}</span>
                      </div>
                    )}
                  </div>

                  {/* Match Highlights Chips */}
                  {job.matchHighlights && job.matchHighlights.length > 0 && (
                    <div className="flex items-center gap-1 flex-wrap pt-0.5">
                      {job.matchHighlights.slice(0, 3).map((hl, i) => (
                        <span key={i} className="px-1.5 py-0.5 rounded text-[9px] font-semibold bg-white/5 text-zinc-300 border border-white/5">
                          {hl}
                        </span>
                      ))}
                    </div>
                  )}

                  {/* Compact Description Clamped */}
                  {cleanDesc && (
                    <div className="text-[11px] text-zinc-400 leading-relaxed bg-zinc-900/60 p-2 rounded-lg border border-white/5">
                      <p className={isExpanded ? 'whitespace-pre-wrap' : 'line-clamp-2'}>
                        {cleanDesc}
                      </p>
                      {cleanDesc.length > 120 && (
                        <button
                          type="button"
                          onClick={() => setExpandedDescId(isExpanded ? null : job._id)}
                          className="text-[10px] text-purple-400 hover:text-purple-300 font-semibold mt-1 block"
                        >
                          {isExpanded ? 'Show less' : 'Read snippet...'}
                        </button>
                      )}
                    </div>
                  )}
                </div>

                {/* Footer Actions */}
                <div className="mt-3 pt-2.5 border-t border-white/5 flex items-center justify-between gap-2">
                  {pendingIds.has(job._id) ? (
                    <div className="flex items-center justify-between w-full bg-zinc-900 border border-purple-500/30 p-1 rounded-lg">
                      <span className="text-[10px] font-bold text-zinc-300 px-1.5">Did you apply?</span>
                      <div className="flex items-center gap-1">
                        <button 
                          onClick={() => confirmApplied(job._id)}
                          className="px-2 py-1 bg-emerald-500/20 hover:bg-emerald-500/30 text-emerald-400 rounded-md border border-emerald-500/30 transition text-[10px] font-bold flex items-center gap-0.5"
                        >
                          <Check className="w-3 h-3" />
                          <span>Yes</span>
                        </button>
                        <button 
                          onClick={() => confirmNotApplied(job._id)}
                          className="px-2 py-1 bg-red-500/20 hover:bg-red-500/30 text-red-400 rounded-md border border-red-500/30 transition text-[10px] font-bold flex items-center gap-0.5"
                        >
                          <X className="w-3 h-3" />
                          <span>No</span>
                        </button>
                      </div>
                    </div>
                  ) : (
                    <div className="flex items-center gap-1.5 w-full justify-between">
                      <button 
                        onClick={() => dismissJob(job._id)}
                        className="p-2 rounded-lg bg-zinc-900 hover:bg-zinc-800 text-zinc-400 hover:text-white transition cursor-pointer border border-white/5 shrink-0"
                        title="Dismiss Job"
                        aria-label="Dismiss Job"
                      >
                        <X className="w-3.5 h-3.5" />
                      </button>
                      <button 
                        onClick={() => handleApplyClick(job)}
                        className="flex-1 flex items-center justify-center gap-1 px-3 py-1.5 rounded-lg bg-purple-600 hover:bg-purple-500 text-white font-bold text-xs transition cursor-pointer shadow-sm hover:shadow-purple-500/20 active:scale-98"
                      >
                        <span>Apply on {job.sourcePlatform}</span>
                        <ExternalLink className="w-3 h-3" />
                      </button>
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      ) : (
        /* Reduced Size Compact List Layout */
        <div className="space-y-2">
          {filteredJobs.map(job => {
            const isNew = job.isNew !== undefined 
              ? job.isNew 
      // eslint-disable-next-line react-hooks/set-state-in-effect
              : (job.createdAt || job.lastSeenAt ? (Date.now() - new Date(job.createdAt || job.lastSeenAt).getTime() < 24 * 60 * 60 * 1000) : false);

            return (
            <div 
              key={job._id} 
              className="glass-card p-3 sm:p-3.5 rounded-xl border border-white/5 bg-zinc-950/70 hover:border-purple-500/40 transition-all flex flex-col md:flex-row md:items-center justify-between gap-3"
            >
              {/* Left Column: Platform, Title, Company & Location */}
              <div className="flex flex-col gap-1.5 min-w-0 flex-1">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className={`px-2 py-0.5 rounded text-[10px] font-bold uppercase tracking-wider ${getPlatformBadgeColor(job.sourcePlatform)}`}>
                    {job.sourcePlatform}
                  </span>
                  {isNew && (
                    <span className="px-1.5 py-0.5 rounded text-[8px] font-extrabold shrink-0 bg-emerald-500/15 text-emerald-300 border border-emerald-500/25">
                      NEW
                    </span>
                  )}
                  {job.matchScore !== undefined && job.matchScore > 0 && (
                    <span className={`px-1.5 py-0.2 rounded text-[10px] font-extrabold flex items-center gap-1 ${
                      job.matchScore >= 70
                        ? 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/20'
                        : 'bg-purple-500/10 text-purple-400 border border-purple-500/20'
                    }`}>
                      <Sparkles className="w-2.5 h-2.5" />
                      {job.matchScore}%
                    </span>
                  )}
                  {job.lastSeenAt && (
                    <span className="text-[10px] text-zinc-500">
                      Seen {formatDate(job.lastSeenAt)}
                    </span>
                  )}
                </div>

                <div className="flex flex-col sm:flex-row sm:items-baseline gap-1 sm:gap-2">
                  <h3 className="font-bold text-xs sm:text-sm text-white leading-snug truncate">
                    {job.title}
                  </h3>
                  <span className="text-xs font-semibold text-purple-400 truncate">
                    {job.company}
                  </span>
                </div>

                <div className="flex items-center gap-2.5 flex-wrap text-[11px] text-zinc-400">
                  {job.location && (
                    <div className="flex items-center gap-1">
                      <MapPin className="w-3 h-3 text-zinc-500" />
                      <span className="truncate">{job.location}</span>
                    </div>
                  )}
                  {job.salary && (
                    <div className="flex items-center gap-1 font-mono text-[10px] text-emerald-400">
                      <DollarSign className="w-3 h-3" />
                      <span>{job.salary}</span>
                    </div>
                  )}
                  {job.matchHighlights && job.matchHighlights.length > 0 && (
                    <div className="flex items-center gap-1">
                      {job.matchHighlights.slice(0, 2).map((hl, i) => (
                        <span key={i} className="px-1.5 py-0.2 rounded text-[9px] bg-white/5 text-zinc-300">
                          {hl}
                        </span>
                      ))}
                    </div>
                  )}
                </div>
              </div>

              {/* Right Column: Compact Actions */}
              <div className="flex items-center gap-1.5 justify-end pt-2 md:pt-0 border-t md:border-t-0 border-white/5 shrink-0">
                {pendingIds.has(job._id) ? (
                  <div className="flex items-center gap-1 bg-zinc-900 border border-purple-500/30 p-1 rounded-lg">
                    <span className="text-[10px] font-bold text-zinc-300 px-1.5">Applied?</span>
                    <button 
                      onClick={() => confirmApplied(job._id)}
                      className="px-2 py-1 bg-emerald-500/20 text-emerald-400 rounded text-[10px] font-bold flex items-center gap-0.5"
                    >
                      <Check className="w-3 h-3" /> Yes
                    </button>
                    <button 
                      onClick={() => confirmNotApplied(job._id)}
                      className="px-2 py-1 bg-red-500/20 text-red-400 rounded text-[10px] font-bold flex items-center gap-0.5"
                    >
                      <X className="w-3 h-3" /> No
                    </button>
                  </div>
                ) : (
                  <div className="flex items-center gap-1.5">
                    <button 
                      onClick={() => dismissJob(job._id)}
                      className="p-1.5 rounded-lg bg-zinc-900 hover:bg-zinc-800 text-zinc-400 hover:text-white transition border border-white/5"
                      title="Dismiss"
                    >
                      <X className="w-3.5 h-3.5" />
                    </button>
                    <button 
                      onClick={() => handleApplyClick(job)}
                      className="flex items-center gap-1 px-3 py-1.5 rounded-lg bg-purple-600 hover:bg-purple-500 text-white font-bold text-xs transition"
                    >
                      <span>Apply</span>
                      <ExternalLink className="w-3 h-3" />
                    </button>
                  </div>
                )}
              </div>
            </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
