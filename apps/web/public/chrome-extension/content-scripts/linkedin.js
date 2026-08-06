// LinkedIn Content Script for HireMateX Assistant
// Passively & reliably detects jobs viewed on LinkedIn across all layouts:
// Search 2-column view, Collections, Recommended, Direct Detail, and Mini Cards.

(function () {
  'use strict';

  // Prevent multiple injections
  if (window.__hirematex_linkedin_injected) {
    return;
  }
  window.__hirematex_linkedin_injected = true;

  console.log('%c[HireMateX Assistant]%c LinkedIn content script active.', 'color: #a855f7; font-weight: 700;', 'color: #a1a1aa;');

  const syncedJobIds = new Set();
  let toastContainer = null;
  let statusPill = null;
  let isConnected = false;
  let sessionSyncCount = 0;
  let lastHref = window.location.href;

  // 0. Check initial token & connection
  function checkExtensionStatus() {
    try {
      chrome.runtime.sendMessage({ action: 'PING' }, (res) => {
        if (chrome.runtime.lastError) {
          // background might be sleeping
          return;
        }
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

  // 1. In-Page Status Pill & Notification Toast
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

  function countVisiblePageCards() {
    const listItems = document.querySelectorAll(
      'li.scaffold-layout__list-item, ' +
      'li.jobs-search-results-list__list-item, ' +
      'div.job-card-container, ' +
      'li[data-occludable-job-id], ' +
      'div.job-card-square, ' +
      'div.base-card'
    );
    return listItems.length;
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

  function truncate(text, max = 400) {
    const clean = cleanString(text);
    return clean.length > max ? clean.slice(0, max) + '...' : clean;
  }

  // Batch Message Dispatcher
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
          console.warn('[HireMateX] Extension notice:', chrome.runtime.lastError.message);
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

  // 2. Safe Single Message Dispatcher
  function sendJob(data) {
    if (!data.title || data.title.length < 2) return;
    const key = data.id || data.url;
    if (syncedJobIds.has(key)) return;
    syncedJobIds.add(key);

    try {
      chrome.runtime.sendMessage({ action: 'JOB_FOUND', data }, (response) => {
        if (chrome.runtime.lastError) {
          console.warn('[HireMateX] Extension notice:', chrome.runtime.lastError.message);
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

  // 3. Extract numeric Job ID from DOM Elements or URLs
  function extractJobId(el, hrefHint = '') {
    if (hrefHint) {
      const match = hrefHint.match(/currentJobId=(\d+)/) ||
                    hrefHint.match(/\/jobs\/view\/(\d+)/) ||
                    hrefHint.match(/jobId=(\d+)/);
      if (match) return match[1];
    }

    if (!el) return null;

    const directId = el.getAttribute('data-job-id') || 
                     el.getAttribute('data-occludable-job-id') ||
                     el.getAttribute('data-job-urn')?.match(/(\d+)/)?.[1] ||
                     el.getAttribute('data-entity-urn')?.match(/(\d+)/)?.[1];
    if (directId) return directId;

    const childWithUrn = el.querySelector('[data-job-id], [data-occludable-job-id], [data-job-urn], [data-entity-urn]');
    if (childWithUrn) {
      const childId = childWithUrn.getAttribute('data-job-id') || 
                      childWithUrn.getAttribute('data-occludable-job-id') ||
                      childWithUrn.getAttribute('data-job-urn')?.match(/(\d+)/)?.[1] ||
                      childWithUrn.getAttribute('data-entity-urn')?.match(/(\d+)/)?.[1];
      if (childId) return childId;
    }

    const links = el.querySelectorAll('a[href]');
    for (let i = 0; i < links.length; i++) {
      const href = links[i].getAttribute('href') || '';
      const match = href.match(/currentJobId=(\d+)/) ||
                    href.match(/\/jobs\/view\/(\d+)/) ||
                    href.match(/jobId=(\d+)/);
      if (match) return match[1];
    }

    return null;
  }

  function isInvalidTitle(rawTitle) {
    if (!rawTitle) return true;
    const clean = rawTitle.trim().toLowerCase();
    if (clean.length < 3) return true;
    const invalidList = [
      'top job picks for you',
      'job collections',
      'recommended jobs',
      'search results',
      'jobs you may be interested in',
      'easy apply',
      'viewed',
      'promoted',
      'welcome',
      'sign in',
      'messages',
      'notifications'
    ];
    return invalidList.some(item => clean === item || clean.startsWith(item));
  }

  // 4. Strategy 1: Active Detail View (Right Column / Dedicated View)
  function extractActiveDetailJob() {
    const currentUrl = window.location.href;
    const urlJobId = currentUrl.match(/currentJobId=(\d+)/)?.[1] ||
                     currentUrl.match(/\/jobs\/view\/(\d+)/)?.[1] ||
                     currentUrl.match(/jobId=(\d+)/)?.[1];

    // Find the right-hand details pane specifically
    const detailPane = document.querySelector(
      '.scaffold-layout__detail, .jobs-search__job-details--container, [data-view-name="job-details"], .jobs-details__main-content, .job-view-layout, .jobs-details'
    );

    if (!detailPane && !urlJobId) return;

    const root = detailPane || document;

    // Title Extraction inside the detail pane
    let title = '';
    const titleCandidates = [
      root.querySelector('.job-details-jobs-unified-top-card__job-title h1'),
      root.querySelector('.job-details-jobs-unified-top-card__job-title a'),
      root.querySelector('.job-details-jobs-unified-top-card__job-title'),
      root.querySelector('.jobs-unified-top-card__job-title h1'),
      root.querySelector('.jobs-unified-top-card__job-title a'),
      root.querySelector('.jobs-unified-top-card__job-title'),
      root.querySelector('h1.t-24.t-bold'),
      root.querySelector('h1.t-24'),
      root.querySelector('h2.t-24.t-bold'),
      root.querySelector('h1.topcard__title'),
      root.querySelector('h1.top-card-layout__title'),
      root.querySelector('[data-view-name="job-details"] h1')
    ];

    for (const el of titleCandidates) {
      if (el && el.innerText && el.innerText.trim().length > 1) {
        const text = cleanString(el.innerText);
        if (!isInvalidTitle(text)) {
          title = text;
          break;
        }
      }
    }

    if (!title && urlJobId && document.title) {
      const docTitle = document.title;
      if (docTitle.includes('| LinkedIn') || docTitle.includes('LinkedIn')) {
        const parts = docTitle.replace(/\|\s*LinkedIn/i, '').split(' - ');
        if (parts.length > 0 && parts[0].trim().length > 2) {
          const candidateTitle = cleanString(parts[0].replace(/^\(\d+\)\s*/, ''));
          if (!isInvalidTitle(candidateTitle)) {
            title = candidateTitle;
          }
        }
      }
    }

    // Company Extraction inside the detail pane
    let company = '';
    const companyCandidates = [
      root.querySelector('.job-details-jobs-unified-top-card__company-name a'),
      root.querySelector('.job-details-jobs-unified-top-card__company-name'),
      root.querySelector('.job-details-jobs-unified-top-card__primary-description a'),
      root.querySelector('.jobs-unified-top-card__company-name a'),
      root.querySelector('.jobs-unified-top-card__company-name'),
      root.querySelector('a.topcard__org-name-link'),
      root.querySelector('a.top-card-layout__first-subline'),
      root.querySelector('a[href*="/company/"]'),
      root.querySelector('[data-anonymize="company-name"]')
    ];

    for (const el of companyCandidates) {
      if (el && el.innerText && el.innerText.trim().length > 0) {
        company = cleanString(el.innerText);
        break;
      }
    }

    if (!company) {
      company = 'LinkedIn Employer';
    }

    // Location Extraction inside the detail pane
    let location = 'Remote';
    const locationCandidates = [
      root.querySelector('.job-details-jobs-unified-top-card__bullet'),
      root.querySelector('.jobs-unified-top-card__bullet'),
      root.querySelector('.job-details-jobs-unified-top-card__primary-description-container'),
      root.querySelector('.jobs-unified-top-card__primary-description span:nth-of-type(1)'),
      root.querySelector('span.topcard__flavor--bullet'),
      root.querySelector('span.top-card-layout__second-subline'),
      root.querySelector('[data-anonymize="location"]')
    ];

    for (const el of locationCandidates) {
      if (el && el.innerText && el.innerText.trim().length > 0) {
        let locText = cleanString(el.innerText);
        if (locText.includes('·')) locText = locText.split('·')[0].trim();
        if (locText) {
          location = locText;
          break;
        }
      }
    }

    // Description Extraction
    const descEl = root.querySelector(
      '#job-details, .jobs-description__content, .jobs-description-content__text, .jobs-box__html-content, [data-view-name="job-description"], article.jobs-description__container, article'
    );
    const description = descEl ? descEl.innerText : '';

    const canonicalJobId = urlJobId || extractJobId(detailPane, currentUrl);
    const jobUrl = canonicalJobId ? `https://www.linkedin.com/jobs/view/${canonicalJobId}/` : currentUrl.split('?')[0];

    if (title && title.length > 1) {
      sendJob({
        id: canonicalJobId,
        title,
        company,
        location,
        description: truncate(description),
        url: jobUrl,
        sourcePlatform: 'LinkedIn',
      });
    }
  }

  // 5. Strategy 2: List Cards & Full Page Harvester
  async function harvestAllPageJobs(isManual = false) {
    if (isHarvesting) return;
    isHarvesting = true;
    updateStatusPill();

    try {
      // Find the scrollable list container on LinkedIn
      const scrollContainer = document.querySelector(
        '.jobs-search-results-list, .scaffold-layout__list, .scaffold-layout__list-container, div.jobs-search-results-list'
      );

      // Auto-scan container if it exists to unocclude all 25 jobs
      if (scrollContainer && scrollContainer.scrollHeight > scrollContainer.clientHeight) {
        const initialScroll = scrollContainer.scrollTop;
        const totalHeight = scrollContainer.scrollHeight;
        const step = Math.max(300, Math.floor(scrollContainer.clientHeight * 0.8));
        
        for (let pos = 0; pos <= totalHeight; pos += step) {
          scrollContainer.scrollTop = pos;
          await new Promise(r => setTimeout(r, 60));
        }
        scrollContainer.scrollTop = initialScroll;
      } else if (window.innerHeight < document.body.scrollHeight) {
        const origY = window.scrollY;
        const maxScroll = Math.min(document.body.scrollHeight, 4000);
        for (let pos = 0; pos <= maxScroll; pos += 600) {
          window.scrollTo(0, pos);
          await new Promise(r => setTimeout(r, 50));
        }
        window.scrollTo(0, origY);
      }

      // Collect all cards now materialized
      const collected = collectAllPageJobObjects();
      if (collected.length > 0) {
        sendBatchJobs(collected);
      }
    } catch (err) {
      console.warn('[HireMateX] Error harvesting page jobs:', err);
    } finally {
      isHarvesting = false;
      updateStatusPill();
    }
  }

  function collectAllPageJobObjects() {
    const jobs = [];
    const cards = document.querySelectorAll(
      'li.scaffold-layout__list-item, ' +
      'li.jobs-search-results-list__list-item, ' +
      'div.job-card-container, ' +
      'div[data-view-name="job-card"], ' +
      'li[data-occludable-job-id], ' +
      'div.job-card-square, ' +
      'li.job-card-square__wrapper, ' +
      'div.base-card, ' +
      'div.base-search-card, ' +
      'div[data-job-id], ' +
      'li.jobs-search-two-pane__job-card-container, ' +
      'div.artdeco-entity-lockup'
    );

    cards.forEach(card => {
      const titleLink = card.querySelector(
        'a.job-card-list__title--link, ' +
        'a.job-card-list__title, ' +
        'a.job-card-container__link, ' +
        'a.job-card-square__title, ' +
        'a.base-card__full-link, ' +
        '.artdeco-entity-lockup__title a, ' +
        'a[href*="/jobs/view/"], ' +
        'a[href*="currentJobId="]'
      );

      let title = '';
      if (titleLink) {
        const spanText = titleLink.querySelector('strong, span[aria-hidden="true"], span');
        title = cleanString(spanText ? spanText.innerText : titleLink.innerText);
      }

      if (isInvalidTitle(title)) {
        const fallbackTitle = card.querySelector('.artdeco-entity-lockup__title strong, .artdeco-entity-lockup__title, .base-search-card__title, h3, strong');
        if (fallbackTitle) {
          title = cleanString(fallbackTitle.innerText);
        }
      }

      if (isInvalidTitle(title)) return;

      const jobId = extractJobId(card, titleLink?.getAttribute('href') || '');
      if (!jobId) return;

      const jobUrl = `https://www.linkedin.com/jobs/view/${jobId}/`;

      let company = '';
      const companyEl = card.querySelector(
        '.job-card-container__primary-description, ' +
        '.job-card-container__company-name, ' +
        '.artdeco-entity-lockup__subtitle, ' +
        '.base-search-card__subtitle, ' +
        'h4.base-search-card__subtitle, ' +
        'a[href*="/company/"]'
      );
      if (companyEl) {
        company = cleanString(companyEl.innerText.split('\n')[0]);
      }
      if (!company) company = 'LinkedIn Employer';

      let location = 'Remote';
      const locEl = card.querySelector(
        '.job-card-container__metadata-item, ' +
        '.artdeco-entity-lockup__caption, ' +
        '.job-search-card__location, ' +
        'ul.job-card-container__metadata-wrapper li'
      );
      if (locEl) {
        let locText = cleanString(locEl.innerText);
        if (locText.includes('·')) locText = locText.split('·')[0].trim();
        if (locText) location = locText;
      }

      jobs.push({
        id: jobId,
        title,
        company,
        location,
        url: jobUrl,
        sourcePlatform: 'LinkedIn',
      });
    });

    return jobs;
  }

  function extractListCards() {
    const jobs = collectAllPageJobObjects();
    if (jobs.length > 0) {
      sendBatchJobs(jobs);
    }
  }

  // 6. Main Scraper Runner
  let debounceTimer = null;
  function triggerScrape() {
    ensureUIElements();
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      extractActiveDetailJob();
      extractListCards();
    }, 150);
  }

  // 7. Passive polling loop for dynamic card appearance & SPA URL changes
  setInterval(() => {
    const currentHref = window.location.href;
    if (currentHref !== lastHref) {
      lastHref = currentHref;
      triggerScrape();
      setTimeout(triggerScrape, 400);
      setTimeout(() => harvestAllPageJobs(false), 800);
    }
  }, 250);

  // Passive automatic background scanner every 1.5 seconds (no clicks needed)
  setInterval(triggerScrape, 1500);

  // 8. Mutation Observer for DOM updates
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

  // 9. Passive scroll listeners on window and all scrollable child panes
  window.addEventListener('scroll', triggerScrape, { passive: true });
  document.addEventListener('scroll', triggerScrape, { passive: true, capture: true });

  // 10. Startup execution
  checkExtensionStatus();
  triggerScrape();
  setTimeout(() => harvestAllPageJobs(false), 1200);
  setInterval(checkExtensionStatus, 4000);

})();

