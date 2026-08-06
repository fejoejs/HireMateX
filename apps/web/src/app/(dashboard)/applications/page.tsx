'use client';

import React, { useState, useEffect } from 'react';
import { useAuth } from '@/context/FirebaseAuthContext';
import { Layers, CheckCircle, FileText, FileCheck, HelpCircle, Eye, CornerDownRight, RefreshCw } from 'lucide-react';
import { API_BASE } from '@/lib/constants';

interface ApplicationItem {
  _id: string;
  userId: string;
  status: 'Matched' | 'Tailored' | 'Applied' | 'Interviewing' | 'Offered' | 'Rejected';
  jobId: {
    _id: string;
    title: string;
    company: string;
    location: string;
    workType: string;
    url?: string;
    applyUrl?: string;
  };
  coverLetterContent?: string;
  notes?: string;
  source?: 'direct' | 'external-board';
  sourcePlatform?: string;
  appliedVia?: 'greenhouse_api' | 'self_reported' | null;
}

function isGreenhouseApp(app: ApplicationItem | null): boolean {
  if (!app || !app.jobId) return false;
  const job = app.jobId as any;
  if (job.sourceAts?.toLowerCase() === 'greenhouse' || job.source?.toLowerCase() === 'greenhouse') return true;
  const url = job.applyUrl || job.url || '';
  return url.includes('greenhouse.io') || url.includes('boards.greenhouse');
}

export default function ApplicationsPage() {
  const [applications, setApplications] = useState<ApplicationItem[]>([]);
  const [selectedApp, setSelectedApp] = useState<ApplicationItem | null>(null);
  const [loading, setLoading] = useState(true);
  const [applyingId, setApplyingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<'Internal' | 'External'>('Internal');

  const { getToken, user, loading: authLoading } = useAuth();

  const [latestResumeId, setLatestResumeId] = useState<string | null>(null);
  const [latestResumeFileName, setLatestResumeFileName] = useState<string | null>(null);

  const [editedCoverLetter, setEditedCoverLetter] = useState<string>('');
  const [isEditingCoverLetter, setIsEditingCoverLetter] = useState(false);
  const [savingCoverLetter, setSavingCoverLetter] = useState(false);

  useEffect(() => {
    if (selectedApp) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setEditedCoverLetter(selectedApp.coverLetterContent || '');
      setIsEditingCoverLetter(false);
    }
  }, [selectedApp]);

  const fetchLatestResume = async () => {
    try {
      const token = await getToken();
      const res = await fetch(`${API_BASE}/resume/latest`, {
        headers: {
          'Authorization': `Bearer ${token}`
        }
      });
      if (res.ok) {
        const data = await res.json();
        if (data && data._id) {
          setLatestResumeId(data._id);
          setLatestResumeFileName(data.originalFileName);
        }
      }
    } catch (err) {
      console.error('Failed to fetch latest resume:', err);
    }
  };

  const fetchApplications = async () => {
    setLoading(true);
    setError(null);
    try {
      const token = await getToken();
      const res = await fetch(`${API_BASE}/application`, {
        headers: {
          'Authorization': `Bearer ${token}`
        }
      });
      if (res.ok) {
        const data = await res.json();
        setApplications(data || []);
        if (data && data.length > 0) {
          setSelectedApp(data[0]);
        } else {
          setSelectedApp(null);
        }
      } else {
        setError('Failed to fetch application records from API.');
      }
    } catch (err) {
      console.error('Failed to load applications:', err);
      setError('Connection failed. Verify the server is active.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (!authLoading && user) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      fetchApplications();
      fetchLatestResume();
    }
  }, [authLoading, user]);

  const handleGreenhouseSubmit = async (appId: string) => {
    setApplyingId(appId);
    setError(null);
    try {
      const token = await getToken();
      const res = await fetch(`${API_BASE}/application/${appId}/submit-greenhouse`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`
        }
      });
      const data = await res.json();
      if (res.ok && data.success) {
        await fetchApplications();
      } else {
        setError(data.message || 'Greenhouse rejected the submission. You can still apply on the company site and click "I\'ve Applied".');
        await fetchApplications();
      }
    } catch (err: any) {
      console.error('Greenhouse submit failed:', err);
      setError(err?.message || 'Connection error during Greenhouse submission. Please apply directly on the company site.');
      await fetchApplications();
    } finally {
      setApplyingId(null);
    }
  };

  const handleMarkAsApplied = async (appId: string) => {
    setApplyingId(appId);
    setError(null);
    try {
      const token = await getToken();
      const res = await fetch(`${API_BASE}/application/${appId}/self-report`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`
        }
      });
      if (res.ok) {
        // Refresh to get the updated Applied status + appliedVia from backend
        await fetchApplications();
      } else {
        setError('Failed to mark as applied.');
        await fetchApplications();
      }
    } catch (err) {
      console.error('Mark as applied failed:', err);
      setError('Connection error. Please try again.');
      await fetchApplications();
    } finally {
      setApplyingId(null);
    }
  };

  const handleGenerateCoverLetter = async (appId: string) => {
    setApplyingId(appId);
    setError(null);
    try {
      const token = await getToken();
      const tailorRes = await fetch(`${API_BASE}/application/${appId}/tailor`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}` }
      });
      if (tailorRes.ok) {
        // Optimistically set to Tailored
        setApplications(prev => prev.map(app => app._id === appId ? { ...app, status: 'Tailored' as const } : app));
        if (selectedApp && selectedApp._id === appId) {
          setSelectedApp({ ...selectedApp, status: 'Tailored' });
        }
        setError('Cover Letter generation started in background. Please wait a few seconds and refresh.');
      } else {
        setError('Failed to request cover letter generation.');
      }
    } catch (err) {
      console.error('Tailor request failed:', err);
      setError('Connection error while requesting cover letter.');
    } finally {
      setApplyingId(null);
    }
  };

  const getStatusBadgeClass = (status: string) => {
    switch (status) {
      case 'Matched': return 'bg-blue-500/10 text-blue-400';
      case 'Tailored': return 'bg-purple-500/10 text-purple-400';
      case 'Applied': return 'bg-green-500/10 text-green-400';
      case 'Interviewing': return 'bg-orange-500/10 text-orange-400';
      default: return 'bg-neutral-800 text-neutral-400';
    }
  };

  const downloadOriginalResume = async () => {
    if (!latestResumeId) {
      setError('No uploaded resume found.');
      return;
    }
    try {
      const token = await getToken();
      const res = await fetch(`${API_BASE}/resume/${latestResumeId}/download-file`, {
        headers: {
          'Authorization': `Bearer ${token}`
        }
      });
      if (res.ok) {
        const blob = await res.blob();
        const url = window.URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = latestResumeFileName || 'My_Resume.pdf';
        document.body.appendChild(a);
        a.click();
        a.remove();
        window.URL.revokeObjectURL(url);
      } else {
        setError('Failed to download resume file.');
      }
    } catch (err) {
      console.error('Failed to download file:', err);
      setError('Connection error during file download.');
    }
  };

  const viewOriginalResume = async () => {
    if (!latestResumeId) {
      setError('No uploaded resume found.');
      return;
    }
    try {
      const token = await getToken();
      const res = await fetch(`${API_BASE}/resume/${latestResumeId}/download-file`, {
        headers: {
          'Authorization': `Bearer ${token}`
        }
      });
      if (res.ok) {
        const blob = await res.blob();
        const url = window.URL.createObjectURL(blob);
        window.open(url, '_blank');
      } else {
        setError('Failed to load resume for viewing.');
      }
    } catch (err) {
      console.error('Failed to view file:', err);
      setError('Connection error during file display.');
    }
  };

  const saveCoverLetter = async () => {
    if (!selectedApp) return;
    setSavingCoverLetter(true);
    setError(null);
    try {
      const token = await getToken();
      const res = await fetch(`${API_BASE}/application/${selectedApp._id}/cover-letter`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`
        },
        body: JSON.stringify({ coverLetter: editedCoverLetter })
      });
      if (res.ok) {
        // Update local state
        setApplications(prev => prev.map(app => app._id === selectedApp._id ? { ...app, coverLetterContent: editedCoverLetter } : app));
        setSelectedApp(prev => prev ? { ...prev, coverLetterContent: editedCoverLetter } : null);
        setIsEditingCoverLetter(false);
      } else {
        setError('Failed to save cover letter changes.');
      }
    } catch (err) {
      console.error('Failed to save cover letter:', err);
      setError('Connection error while saving cover letter.');
    } finally {
      setSavingCoverLetter(false);
    }
  };

  if (loading) {
    return (
      <div className="flex flex-col items-center justify-center min-h-[60vh] gap-4">
        <RefreshCw className="w-8 h-8 text-purple-500 animate-spin" />
        <span className="text-sm text-zinc-400 font-medium">Loading Applications Tracker...</span>
      </div>
    );
  }

  return (
    <div className="space-y-8 flex-1">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">Applications Tracker</h1>
        <p className="text-neutral-400 mt-1 hidden md:block">Monitor auto-apply tasks, review cover letters, and download tailored resumes.</p>
      </div>

      {error && (
        <div className="p-3 rounded-xl bg-red-500/10 border border-red-500/20 text-xs text-red-400 flex items-center gap-2">
          <HelpCircle className="w-4 h-4 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {/* Internal / External Tabs */}
      <div className="flex gap-2 border-b border-white/5 pb-px overflow-x-auto scrollbar-hide">
        {(['Internal', 'External'] as const).map(tab => {
          const isActive = activeTab === tab;
          const count = applications.filter(app => 
            tab === 'Internal' ? app.source !== 'external-board' : app.source === 'external-board'
          ).length;
          
          return (
            <button
              key={tab}
              onClick={() => setActiveTab(tab)}
              className={`pb-3 px-4 text-xs font-semibold border-b-2 transition-all cursor-pointer relative whitespace-nowrap ${
                isActive 
                  ? 'border-purple-500 text-purple-400 font-bold' 
                  : 'border-transparent text-zinc-400 hover:text-zinc-200'
              }`}
            >
              {tab === 'Internal' ? 'Job Board' : 'External Boards'}
              <span className={`ml-2 px-1.5 py-0.5 rounded-md text-[10px] font-bold ${
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

      {(() => {
        const filteredApplications = applications.filter(app => 
          activeTab === 'Internal' ? app.source !== 'external-board' : app.source === 'external-board'
        );

        if (filteredApplications.length === 0) {
          return (
            <div className="text-center py-24 glass-card space-y-4">
              <Layers className="w-16 h-16 text-zinc-700 mx-auto animate-pulse" />
              <div>
                <h3 className="text-base font-bold text-white uppercase tracking-wider">No active {activeTab.toLowerCase()} applications</h3>
                <p className="text-xs text-neutral-500 mt-1 max-w-md mx-auto">
                  {activeTab === 'Internal' 
                    ? 'Find matched jobs on the Jobs Board and click "Apply" to trigger the auto-apply workflow.' 
                    : 'Apply for jobs using the HireMateX Chrome Extension on LinkedIn or Indeed to see them here.'}
                </p>
              </div>
            </div>
          );
        }

        return (
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
          
          {/* List panel */}
          <div className="lg:col-span-1 glass-card p-4 space-y-3 h-fit overflow-y-auto max-h-[75vh]">
            <h3 className="font-bold text-xs uppercase tracking-wider text-neutral-400 px-2 pb-2 border-b border-white/5">
              Applications Queue ({filteredApplications.length})
            </h3>
            {filteredApplications.map((app) => (
              <div 
                key={app._id}
                onClick={() => setSelectedApp(app)}
                className={`p-3 rounded-xl border transition cursor-pointer text-left ${
                  selectedApp?._id === app._id 
                    ? 'border-purple-500 bg-purple-500/5' 
                    : 'border-white/5 bg-zinc-950/20 hover:border-white/10'
                }`}
              >
                <div className="flex justify-between items-start gap-2">
                  <h4 className="font-bold text-xs text-white truncate max-w-[70%]">{app.jobId.title}</h4>
                  <span className={`px-2 py-0.5 rounded text-[9px] font-bold shrink-0 ${getStatusBadgeClass(app.status)}`}>
                    {app.status}
                  </span>
                </div>
                <p className="text-[10px] text-neutral-400 mt-1 font-medium">{app.jobId.company}</p>
                <div className="flex justify-between items-center text-[9px] text-neutral-500 mt-2 pt-2 border-t border-white/5">
                  <span>{app.jobId.location} &bull; {app.jobId.workType}</span>
                </div>
              </div>
            ))}
          </div>

          {/* Details panel */}
          <div className="lg:col-span-2 glass-card p-6 space-y-6 max-h-[75vh] overflow-y-auto">
            {selectedApp ? (
              <div className="space-y-6">
                
                {/* Job Title Header */}
                <div className="border-b border-white/5 pb-4 flex justify-between items-start flex-wrap gap-4">
                  <div>
                    <h2 className="font-bold text-xl text-white">{selectedApp.jobId.title}</h2>
                    <p className="text-xs text-purple-400 font-semibold mt-0.5">{selectedApp.jobId.company} &bull; {selectedApp.jobId.location}</p>
                  </div>
                  
                  {/* Actions */}
                  <div className="flex gap-2 flex-wrap">
                    {/* External board: view original posting */}
                    {selectedApp.source === 'external-board' && (
                      <button
                        onClick={() => {
                          const url = (selectedApp.jobId as any).url;
                          if (url) window.open(url, '_blank', 'noopener,noreferrer');
                        }}
                        className="px-4 py-2 bg-purple-600 hover:bg-purple-700 text-white font-bold text-xs rounded-lg transition flex items-center gap-1.5 cursor-pointer shadow-md shadow-purple-500/10"
                      >
                        View Original Posting
                      </button>
                    )}

                    {/* Matched: Generate Cover Letter */}
                    {selectedApp.source !== 'external-board' && selectedApp.status === 'Matched' && (
                      <button
                        onClick={() => handleGenerateCoverLetter(selectedApp._id)}
                        disabled={applyingId !== null}
                        className="px-4 py-2 bg-purple-600 hover:bg-purple-700 disabled:bg-neutral-800 text-white font-bold text-xs rounded-lg transition flex items-center gap-1.5 cursor-pointer shadow-md shadow-purple-500/10"
                      >
                        <FileCheck className="w-3.5 h-3.5" />
                        {applyingId === selectedApp._id ? 'Generating...' : 'Generate Cover Letter'}
                      </button>
                    )}

                    {/* Tailored: Submission options */}
                    {selectedApp.source !== 'external-board' && selectedApp.status === 'Tailored' && (
                      <div className="flex flex-col gap-2 w-full">
                        {isGreenhouseApp(selectedApp) ? (
                          <div className="flex flex-wrap gap-2">
                            <button
                              onClick={() => handleGreenhouseSubmit(selectedApp._id)}
                              disabled={applyingId !== null}
                              className="px-4 py-2 bg-gradient-to-r from-emerald-600 to-teal-600 hover:from-emerald-500 hover:to-teal-500 disabled:opacity-50 text-white font-bold text-xs rounded-lg flex items-center gap-1.5 cursor-pointer transition shadow-md shadow-emerald-500/10"
                            >
                              <CheckCircle className="w-3.5 h-3.5" />
                              {applyingId === selectedApp._id ? 'Submitting to Greenhouse...' : '🚀 Submit Application (Verified ATS)'}
                            </button>
                            {((selectedApp.jobId as any).applyUrl || (selectedApp.jobId as any).url) && (
                              <a
                                href={(selectedApp.jobId as any).applyUrl || (selectedApp.jobId as any).url}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="px-3.5 py-2 border border-white/10 bg-zinc-900 hover:bg-zinc-800 text-white font-semibold text-xs rounded-lg transition flex items-center gap-1.5"
                              >
                                <CornerDownRight className="w-3.5 h-3.5" />
                                Apply on Company Site →
                              </a>
                            )}
                            <button
                              onClick={() => handleMarkAsApplied(selectedApp._id)}
                              disabled={applyingId !== null}
                              className="px-3.5 py-2 border border-purple-500/30 bg-purple-500/10 hover:bg-purple-500/20 disabled:opacity-50 text-purple-300 font-semibold text-xs rounded-lg flex items-center gap-1.5 cursor-pointer transition"
                            >
                              <CheckCircle className="w-3.5 h-3.5" />
                              {applyingId === selectedApp._id ? 'Saving...' : "I've Applied (Self-reported)"}
                            </button>
                          </div>
                        ) : (
                          <div className="flex flex-wrap gap-2">
                            {((selectedApp.jobId as any).applyUrl || (selectedApp.jobId as any).url) && (
                              <a
                                href={(selectedApp.jobId as any).applyUrl || (selectedApp.jobId as any).url}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="px-4 py-2 bg-indigo-600 hover:bg-indigo-700 text-white font-bold text-xs rounded-lg transition flex items-center gap-1.5"
                              >
                                <CornerDownRight className="w-3.5 h-3.5" />
                                Apply on Company Site →
                              </a>
                            )}
                            <button
                              onClick={() => handleMarkAsApplied(selectedApp._id)}
                              disabled={applyingId !== null}
                              className="px-4 py-2 bg-emerald-600/20 border border-emerald-500/30 hover:bg-emerald-600/30 disabled:opacity-50 text-emerald-300 font-bold text-xs rounded-lg flex items-center gap-1.5 cursor-pointer transition"
                            >
                              <CheckCircle className="w-3.5 h-3.5" />
                              {applyingId === selectedApp._id ? 'Saving...' : "I've Applied (Self-reported)"}
                            </button>
                          </div>
                        )}
                        <p className="text-[10px] text-neutral-500 leading-relaxed">
                          {isGreenhouseApp(selectedApp)
                            ? 'Greenhouse positions can be submitted directly via API, or applied manually on the official careers page.'
                            : "Apply on the company's website first, then click above to record your application."}
                        </p>
                      </div>
                    )}

                    {/* Applied: Show honest label based on appliedVia */}
                    {selectedApp.status === 'Applied' && (
                      <div className={`px-3.5 py-2 rounded-lg flex items-center gap-1.5 text-xs font-bold ${
                        selectedApp.appliedVia === 'greenhouse_api'
                          ? 'bg-emerald-500/10 border border-emerald-500/20 text-emerald-400'
                          : 'bg-blue-500/10 border border-blue-500/20 text-blue-400'
                      }`}>
                        <CheckCircle className="w-4 h-4" />
                        {selectedApp.appliedVia === 'greenhouse_api'
                          ? '🛡️ Verified Application (Greenhouse API)'
                          : '📋 Applied (Self-reported)'}
                      </div>
                    )}
                  </div>
                </div>

                {/* AI Tailoring Notes (Only for Greenhouse / AI-tailored applications) */}
                {isGreenhouseApp(selectedApp) && selectedApp.notes && (
                  <div>
                    <h4 className="text-xs font-bold text-neutral-400 uppercase tracking-wider mb-2 flex items-center gap-1.5">
                      <FileCheck className="w-4 h-4 text-purple-400" /> AI Optimization Highlights
                    </h4>
                    <p className="text-xs text-neutral-300 bg-neutral-950/40 p-4 rounded-xl border border-white/5 leading-relaxed">
                      {selectedApp.notes}
                    </p>
                  </div>
                )}

                 {/* Cover Letter Content (Only for Greenhouse / AI-tailored applications) */}
                 {isGreenhouseApp(selectedApp) && selectedApp.coverLetterContent && (
                   <div>
                     <div className="flex justify-between items-center mb-2">
                       <h4 className="text-xs font-bold text-neutral-400 uppercase tracking-wider flex items-center gap-1.5">
                         <FileText className="w-4 h-4 text-purple-400" /> Customized Cover Letter
                       </h4>
                       {!isEditingCoverLetter && (
                         <button
                           onClick={() => setIsEditingCoverLetter(true)}
                           className="px-2.5 py-1 rounded bg-purple-500/10 border border-purple-500/20 hover:bg-purple-500/20 text-purple-300 text-[10px] font-bold uppercase tracking-wider transition cursor-pointer flex items-center gap-1"
                         >
                           Edit Letter
                         </button>
                       )}
                     </div>

                     {isEditingCoverLetter ? (
                       <div className="space-y-3">
                         <textarea
                           value={editedCoverLetter}
                           onChange={(e) => setEditedCoverLetter(e.target.value)}
                           className="w-full h-[300px] text-xs text-neutral-200 bg-neutral-900/60 border border-purple-500/30 focus:border-purple-500 rounded-xl p-4 font-mono leading-relaxed focus:outline-none focus:ring-1 focus:ring-purple-500/30 resize-y"
                         />
                         <div className="flex justify-end gap-2">
                           <button
                             onClick={() => {
                               setEditedCoverLetter(selectedApp.coverLetterContent || '');
                               setIsEditingCoverLetter(false);
                             }}
                             className="px-3 py-1.5 rounded-lg bg-white/5 hover:bg-white/10 text-neutral-400 hover:text-white text-xs font-bold transition cursor-pointer"
                           >
                             Cancel
                           </button>
                           <button
                             onClick={saveCoverLetter}
                             disabled={savingCoverLetter}
                             className="px-4 py-1.5 rounded-lg bg-gradient-to-r from-purple-600 to-indigo-600 hover:from-purple-500 hover:to-indigo-500 disabled:from-neutral-800 disabled:to-neutral-950 text-white text-xs font-bold transition flex items-center gap-1 cursor-pointer"
                           >
                             {savingCoverLetter ? 'Saving...' : 'Save Changes'}
                           </button>
                         </div>
                       </div>
                     ) : (
                       <div className="text-xs text-neutral-300 bg-neutral-950/45 p-5 rounded-xl border border-white/5 font-mono whitespace-pre-wrap leading-relaxed max-h-[350px] overflow-y-auto">
                         {selectedApp.coverLetterContent}
                       </div>
                     )}
                   </div>
                 )}

                 {/* File Downloads (Only for Greenhouse / AI-tailored applications) */}
                 {isGreenhouseApp(selectedApp) && selectedApp.source !== 'external-board' && (
                   <div>
                    <h4 className="text-xs font-bold text-neutral-400 uppercase tracking-wider mb-2">Documents</h4>
                    {latestResumeId ? (
                      <div className="flex flex-wrap gap-3">
                        <button 
                          onClick={viewOriginalResume}
                          className="flex items-center gap-2 px-4 py-2.5 rounded-lg border border-white/5 bg-zinc-950/40 hover:bg-zinc-900 text-xs text-indigo-300 font-semibold transition cursor-pointer"
                        >
                          <Eye className="w-4 h-4 text-indigo-400" /> View Uploaded Resume
                        </button>
                        <button 
                          onClick={downloadOriginalResume}
                          className="flex items-center gap-2 px-4 py-2.5 rounded-lg border border-white/5 bg-zinc-950/40 hover:bg-zinc-900 text-xs text-purple-300 font-semibold transition cursor-pointer"
                        >
                          <FileText className="w-4 h-4 text-purple-400" /> Download Uploaded Resume
                        </button>
                      </div>
                    ) : (
                      <p className="text-[10px] text-neutral-500 italic">No uploaded resume found. Please upload your resume in the Resume Profile section first.</p>
                    )}
                  </div>
                 )}

              </div>
            ) : (
              <div className="text-center py-24 text-neutral-500 flex flex-col items-center justify-center gap-3">
                <Layers className="w-12 h-12 text-neutral-600 animate-pulse" />
                <p className="text-sm">Select an application from the queue to view details.</p>
              </div>
            )}
          </div>

        </div>
        );
      })()}
    </div>
  );
}
