// Indeed Content Script for HireMateX Assistant
// Passively captures jobs viewed on Indeed (Job Search, Direct View, Side Panel)

(function () {
  'use strict';

  if (window.__hirematex_indeed_injected) {
    return;
  }
  window.__hirematex_indeed_injected = true;

  console.log('%c[HireMateX Assistant]%c Indeed content script active.', 'color: #a855f7; font-weight: 700;', 'color: #a1a1aa;');

  const syncedJobIds = new Set();
  let toastContainer = null;
  let statusPill = null;
  let isConnected = false;
  let sessionSyncCount = 0;
  let lastHref = window.location.href;

  function checkExtensionStatus() {
    try {
      chrome.runtime.sendMessage({ action: 'PING' }, (res) => {
        if (chrome.runtime.lastError) return;
        if (res) {
          isConnected = !!res.connected;
          if (res.syncedCount !== undefined) {
            sessionSyncCount = Math.max(sessionSyncCount, res.syncedCount);
          }
          updateStatusPill();
        }
      });
    } catch (e) {}
  }

  function ensureUIElements() {
    if (document.getElementById('hirematex-toast-root')) {
      toastContainer = document.getElementById('hirematex-toast-root');
    } else if (document.body) {
      toastContainer = document.createElement('div');
      toastContainer.id = 'hirematex-toast-root';
      toastContainer.style.cssText = `
        position: fixed;
        bottom: 24px;
        right: 24px;
        z-index: 999999;
        display: flex;
        flex-direction: column;
        gap: 8px;
        pointer-events: none;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      `;
      document.body.appendChild(toastContainer);
    }

    if (!document.getElementById('hirematex-status-pill') && document.body) {
      statusPill = document.createElement('div');
      statusPill.id = 'hirematex-status-pill';
      statusPill.style.cssText = `
        position: fixed;
        bottom: 24px;
        left: 24px;
        z-index: 999998;
        background: rgba(9, 9, 11, 0.95);
        border: 1px solid rgba(168, 85, 247, 0.4);
        border-radius: 30px;
        padding: 6px 14px;
        color: #fafafa;
        font-size: 11px;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
        box-shadow: 0 4px 20px rgba(0,0,0,0.5);
        display: flex;
        align-items: center;
        gap: 8px;
        backdrop-filter: blur(8px);
        transition: all 0.2s ease;
      `;
      document.body.appendChild(statusPill);
      updateStatusPill();
    }
  }

  let isHarvesting = false;
  function countVisiblePageCards() {
    return document.querySelectorAll('[data-jk], [id^="job_"], .job_seen_beacon, .cardOutline').length;
  }

  function updateStatusPill() {
    if (!statusPill) return;
    const pageCount = countVisiblePageCards();

    if (isConnected) {
      statusPill.innerHTML = `
        <span style="width: 8px; height: 8px; border-radius: 50%; background: #10b981; display: inline-block; box-shadow: 0 0 8px #10b981;"></span>
        <span style="font-weight: 600; color: #c084fc; cursor: pointer;" id="hmx-settings-link">HireMateX Active</span>
        <span style="color: #71717a; font-size: 10px;">• ${sessionSyncCount} synced</span>
        ${pageCount > 0 ? `
          <button id="hmx-sync-all-btn" style="
            background: linear-gradient(135deg, #a855f7 0%, #6366f1 100%);
            border: none;
            border-radius: 14px;
            color: #fff;
            font-weight: 700;
            font-size: 10px;
            padding: 3px 9px;
            cursor: pointer;
            display: flex;
            align-items: center;
            gap: 4px;
            box-shadow: 0 2px 8px rgba(168, 85, 247, 0.4);
            margin-left: 4px;
          ">${isHarvesting ? '⏳ Syncing Page...' : `⚡ Sync All Page Jobs (${pageCount})`}</button>
        ` : ''}
      `;
      statusPill.style.borderColor = 'rgba(168, 85, 247, 0.4)';

      const settingsLink = statusPill.querySelector('#hmx-settings-link');
      if (settingsLink) {
        settingsLink.onclick = () => window.open('https://hirematex.vercel.app/settings', '_blank');
      }

      const syncAllBtn = statusPill.querySelector('#hmx-sync-all-btn');
      if (syncAllBtn && !isHarvesting) {
        syncAllBtn.onclick = (e) => {
          e.stopPropagation();
          harvestAllPageJobs(true);
        };
      }
    } else {
      statusPill.innerHTML = `
        <span style="width: 8px; height: 8px; border-radius: 50%; background: #ef4444; display: inline-block; box-shadow: 0 0 8px #ef4444;"></span>
        <span style="font-weight: 600; color: #f87171; cursor: pointer;" id="hmx-settings-link">HireMateX Disconnected</span>
        <span style="color: #a1a1aa; font-size: 10px;">• Click to connect</span>
      `;
      statusPill.style.borderColor = 'rgba(239, 68, 68, 0.4)';
      const settingsLink = statusPill.querySelector('#hmx-settings-link');
      if (settingsLink) {
        settingsLink.onclick = () => window.open('https://hirematex.vercel.app/settings', '_blank');
      }
    }
  }

  function showToast(title, company, isBatch = false) {
    ensureUIElements();
    if (!toastContainer) return;

    const toast = document.createElement('div');
    toast.style.cssText = `
      background: #09090b;
      border: 1px solid #a855f7;
      border-radius: 12px;
      padding: 10px 16px;
      color: #fafafa;
      font-size: 12px;
      box-shadow: 0 10px 25px rgba(0,0,0,0.6);
      display: flex;
      align-items: center;
      gap: 10px;
      pointer-events: auto;
      max-width: 380px;
      animation: fadeIn 0.3s ease-out;
    `;

    toast.innerHTML = `
      <div style="width: 26px; height: 26px; border-radius: 7px; background: rgba(168, 85, 247, 0.2); display: flex; align-items: center; justify-content: center; flex-shrink: 0;">
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#c084fc" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
          <polyline points="20 6 9 17 4 12"></polyline>
        </svg>
      </div>
      <div style="flex: 1; overflow: hidden;">
        <div style="font-weight: 700; color: #c084fc; font-size: 10px; text-transform: uppercase; letter-spacing: 0.5px;">${isBatch ? 'Bulk Synced to HireMateX' : 'Synced to HireMateX'}</div>
        <div style="font-weight: 600; color: #fafafa; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">${escapeHtml(title)}</div>
        <div style="font-size: 11px; color: #a1a1aa; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">${escapeHtml(company)}</div>
      </div>
    `;

    toastContainer.appendChild(toast);

    setTimeout(() => {
      toast.style.opacity = '0';
      toast.style.transform = 'translateY(10px)';
      toast.style.transition = 'all 0.3s ease-in';
      setTimeout(() => toast.remove(), 300);
    }, 3800);
  }

  function escapeHtml(str) {
    return (str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function cleanString(str) {
    return (str || '').replace(/\s+/g, ' ').trim();
  }

  function truncate(text, max = 350) {
    const clean = cleanString(text);
    return clean.length > max ? clean.slice(0, max) + '...' : clean;
  }

  function sendBatchJobs(jobs) {
    if (!Array.isArray(jobs) || jobs.length === 0) return;

    const unSynced = jobs.filter(j => {
      const key = j.id || j.url;
      if (syncedJobIds.has(key)) return false;
      syncedJobIds.add(key);
      return true;
    });

    if (unSynced.length === 0) return;

    try {
      chrome.runtime.sendMessage({ action: 'JOB_BATCH_FOUND', jobs: unSynced }, (response) => {
        if (chrome.runtime.lastError) {
          console.warn('[HireMateX] Indeed extension notice:', chrome.runtime.lastError.message);
        } else if (response && response.synced) {
          isConnected = true;
          sessionSyncCount = response.count !== undefined ? response.count : (sessionSyncCount + unSynced.length);
          updateStatusPill();
          const newAdded = response.added !== undefined ? response.added : unSynced.length;
          const refreshed = response.refreshed || 0;
          if (newAdded > 0) {
            showToast(`⚡ Synced ${newAdded} New Jobs`, `${newAdded} new vacancies added to HireMateX (${sessionSyncCount} in DB)`, true);
          } else if (refreshed > 0) {
            showToast(`⚡ Refreshed ${refreshed} Jobs`, `${refreshed} existing listings updated (${sessionSyncCount} in DB)`, true);
          }
        } else if (response && response.reason === 'NO_TOKEN') {
          isConnected = false;
          updateStatusPill();
        }
      });
    } catch (err) {}
  }

  function sendJob(data) {
    if (!data.title || data.title.length < 2) return;
    const key = data.id || data.url;
    if (syncedJobIds.has(key)) return;
    syncedJobIds.add(key);

    try {
      chrome.runtime.sendMessage({ action: 'JOB_FOUND', data }, (response) => {
        if (chrome.runtime.lastError) {
          console.warn('[HireMateX] Indeed extension notice:', chrome.runtime.lastError.message);
        } else if (response && response.synced) {
          isConnected = true;
          sessionSyncCount = response.count || (sessionSyncCount + 1);
          updateStatusPill();
          showToast(data.title, data.company);
        } else if (response && response.reason === 'NO_TOKEN') {
          isConnected = false;
          updateStatusPill();
        }
      });
    } catch (err) {}
  }

  function getIndeedJobId(url) {
    const match = url.match(/(?:jk=|vjk=)([a-f0-9]+)/i);
    return match ? match[1] : null;
  }

  function extractSingleJob() {
    const url = window.location.href;
    const jobId = getIndeedJobId(url);
    const hasJobDescription = !!document.querySelector('#jobDescriptionText, [data-testid="jobsearch-JobInfoHeader-title"]');

    // Only extract as a single job page if it's an actual job posting view or has a job description container
    if (!url.includes('/viewjob') && !jobId && !hasJobDescription) {
      return;
    }

    const titleEl = document.querySelector(
      'h1[data-testid="jobsearch-JobInfoHeader-title"], h2.jobsearch-JobInfoHeader-title, .jobsearch-JobInfoHeader-title, h1.jobsearch-JobInfoHeader-title, .jobsearch-JobInfoHeader-title-container h1'
    );
    const rawTitle = titleEl ? titleEl.innerText : '';
    const title = cleanString(rawTitle);

    if (!title || title.length < 3 || title.toLowerCase().startsWith('welcome,') || title.toLowerCase().includes('what job are you looking for')) {
      return;
    }
    
    const company = document.querySelector(
      'div[data-testid="inlineHeader-companyName"] a, div[data-testid="inlineHeader-companyName"] span, div[data-company-name="true"], .jobsearch-InlineCompanyRating a, div[data-testid="inlineHeader-companyName"]'
    )?.innerText?.trim();
    
    const location = document.querySelector(
      'div[data-testid="inlineHeader-companyLocation"] div, div[data-testid="inlineHeader-companyLocation"], .jobsearch-JobInfoHeader-subtitle div:last-child, [data-testid="job-location"]'
    )?.innerText?.trim();
    
    const rawDescription = document.querySelector(
      '#jobDescriptionText, .jobsearch-JobComponent-description, #jobDetailsSection'
    )?.innerText;

    const cleanUrl = jobId ? `https://www.indeed.com/viewjob?jk=${jobId}` : url.split('?')[0];

    // Ensure we don't send root domains
    if (cleanUrl.endsWith('indeed.com') || cleanUrl.endsWith('indeed.com/')) {
      return;
    }

    sendJob({
      id: jobId || cleanUrl,
      title,
      company: cleanString(company || 'Indeed Employer'),
      location: cleanString(location || 'Remote'),
      description: truncate(rawDescription),
      url: cleanUrl,
      sourcePlatform: 'Indeed',
    });
  }

  function extractIndeedJobKey(card) {
    let id = card.getAttribute('data-jk');
    if (id) return id;

    const inner = card.querySelector('[data-jk]');
    if (inner) return inner.getAttribute('data-jk');

    const idEl = card.querySelector('[id^="job_"]');
    if (idEl) return idEl.id.replace('job_', '');

    const links = card.querySelectorAll('a');
    for (let i = 0; i < links.length; i++) {
      const rawHref = links[i].getAttribute('href') || '';
      if (rawHref && rawHref !== '#' && !rawHref.startsWith('javascript:')) {
        const match = rawHref.match(/(?:jk=|vjk=)([a-f0-9]+)/i);
        if (match) return match[1];
      }
    }
    return null;
  }

  function collectAllIndeedJobObjects() {
    const potentialCards = new Set();
    
    const idElements = document.querySelectorAll('[data-jk], [id^="job_"]');
    idElements.forEach(el => {
      const container = el.closest('.job_seen_beacon, .cardOutline, td.resultContent, li, div.slider_container, div.result');
      if (container) potentialCards.add(container);
      else potentialCards.add(el);
    });

    const links = document.querySelectorAll('a[href*="jk="], a[href*="vjk="]');
    links.forEach(link => {
      const container = link.closest('.job_seen_beacon, .cardOutline, td.resultContent, li, div.slider_container, div.result');
      if (container) potentialCards.add(container);
    });

    const cards = Array.from(potentialCards);
    const jobs = [];

    cards.forEach(card => {
      const titleEl = card.querySelector('h2.jobTitle, .jobTitle, h2, span[title], a[id^="job_"], a.jcs-JobTitle');
      const title = cleanString(titleEl?.innerText || '');
      if (!title || title.length < 2) return;

      const jk = extractIndeedJobKey(card);
      if (!jk) return;

      const link = `https://www.indeed.com/viewjob?jk=${jk}`;

      const companyEl = card.querySelector('[data-testid="company-name"], .companyName, span.css-1h7lukg, span[data-testid="company-name"], [class*="companyName"]');
      const company = cleanString(companyEl?.innerText || 'Indeed Employer');
      
      const locationEl = card.querySelector('[data-testid="text-location"], .companyLocation, div.css-1p0sjqa, div[data-testid="text-location"], [class*="companyLocation"]');
      const location = cleanString(locationEl?.innerText || 'Remote');

      jobs.push({
        id: jk,
        title,
        company,
        location,
        url: link,
        sourcePlatform: 'Indeed',
      });
    });

    return jobs;
  }

  async function harvestAllPageJobs(isManual = false) {
    if (isHarvesting) return;
    isHarvesting = true;
    updateStatusPill();

    try {
      const origY = window.scrollY;
      const maxScroll = Math.min(document.body.scrollHeight, 3500);
      for (let pos = 0; pos <= maxScroll; pos += 500) {
        window.scrollTo(0, pos);
        await new Promise(r => setTimeout(r, 50));
      }
      window.scrollTo(0, origY);

      const jobs = collectAllIndeedJobObjects();
      if (jobs.length > 0) {
        sendBatchJobs(jobs);
      }
    } catch (err) {
      console.warn('[HireMateX] Error harvesting Indeed jobs:', err);
    } finally {
      isHarvesting = false;
      updateStatusPill();
    }
  }

  function extractSearchResults() {
    const jobs = collectAllIndeedJobObjects();
    if (jobs.length > 0) {
      sendBatchJobs(jobs);
    }
  }

  let debounceTimer = null;
  function triggerScrape() {
    ensureUIElements();
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      extractSingleJob();
      extractSearchResults();
    }, 150);
  }

  setInterval(() => {
    const currentHref = window.location.href;
    if (currentHref !== lastHref) {
      lastHref = currentHref;
      triggerScrape();
      setTimeout(triggerScrape, 400);
      setTimeout(() => harvestAllPageJobs(false), 800);
    }
  }, 300);

  const observer = new MutationObserver(() => {
    triggerScrape();
  });

  if (document.body) {
    observer.observe(document.body, { childList: true, subtree: true });
  } else {
    document.addEventListener('DOMContentLoaded', () => {
      observer.observe(document.body, { childList: true, subtree: true });
    });
  }

  document.addEventListener('click', (e) => {
    const target = e.target;
    if (target && target.closest && target.closest('li, a, div[class*="job_seen_beacon"], div[data-jk], button')) {
      setTimeout(triggerScrape, 100);
      setTimeout(triggerScrape, 500);
    }
  }, { passive: true });

  window.addEventListener('scroll', triggerScrape, { passive: true });
  document.addEventListener('scroll', triggerScrape, { passive: true, capture: true });

  checkExtensionStatus();
  triggerScrape();
  setTimeout(() => harvestAllPageJobs(false), 1200);
  setInterval(checkExtensionStatus, 4000);

})();
