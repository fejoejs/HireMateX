// HireMateX Assistant - Background Service Worker (Manifest V3)
// Passively receives detected vacancies and synchronizes them to HireMateX backend

let syncedCounter = 0;

// Initialize badge
chrome.storage.local.get(['authToken'], (res) => {
  updateBadge(!!res.authToken);
});

function updateBadge(hasToken) {
  if (!chrome.action || !chrome.action.setBadgeText) return;
  if (!hasToken) {
    chrome.action.setBadgeText({ text: '!' });
    chrome.action.setBadgeBackgroundColor({ color: '#ef4444' });
    chrome.action.setTitle({ title: 'HireMateX: Token required. Click to connect.' });
  } else if (syncedCounter > 0) {
    chrome.action.setBadgeText({ text: `${syncedCounter}` });
    chrome.action.setBadgeBackgroundColor({ color: '#8b5cf6' });
    chrome.action.setTitle({ title: `HireMateX: ${syncedCounter} jobs synced in this session.` });
  } else {
    chrome.action.setBadgeText({ text: 'ON' });
    chrome.action.setBadgeBackgroundColor({ color: '#10b981' });
    chrome.action.setTitle({ title: 'HireMateX: Ready and syncing.' });
  }
}

// Auto-inject content scripts into matching open tabs on install/startup
async function injectContentScripts() {
  try {
    const tabs = await chrome.tabs.query({ url: ['*://*.linkedin.com/*', '*://*.indeed.com/*', '*://*.naukri.com/*'] });
    for (const tab of tabs) {
      if (tab.id && tab.url) {
        try {
          if (tab.url.includes('linkedin.com')) {
            await chrome.scripting.executeScript({
              target: { tabId: tab.id },
              files: ['content-scripts/linkedin.js']
            });
          } else if (tab.url.includes('indeed.com')) {
            await chrome.scripting.executeScript({
              target: { tabId: tab.id },
              files: ['content-scripts/indeed.js']
            });
          } else if (tab.url.includes('naukri.com')) {
            await chrome.scripting.executeScript({
              target: { tabId: tab.id },
              files: ['content-scripts/naukri.js']
            });
          }
        } catch (e) {
          // Tab might be restricted or unloaded
        }
      }
    }
  } catch (err) {
    console.warn('[HireMateX Worker] Tab injection notice:', err);
  }
}

chrome.runtime.onInstalled.addListener(() => {
  console.log('[HireMateX Worker] Extension installed/updated. Injecting content scripts...');
  injectContentScripts();
});

chrome.runtime.onStartup.addListener(() => {
  console.log('[HireMateX Worker] Browser started. Injecting content scripts...');
  injectContentScripts();
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'JOB_FOUND' && message.data) {
    const jobData = message.data;
    console.log('[HireMateX Worker] Job detected:', jobData.title, 'at', jobData.company, `(${jobData.url})`);

    chrome.storage.local.get(['authToken', 'apiUrl'], async (result) => {
      const token = result.authToken;
      const apiBase = (result.apiUrl || 'https://hirematex-api-97nu.onrender.com').replace(/\/+$/, '');

      if (!token) {
        console.warn('[HireMateX Worker] No auth token configured. Open extension popup to connect.');
        updateBadge(false);
        sendResponse({ success: false, reason: 'NO_TOKEN' });
        return;
      }

      let success = false;
      for (let attempt = 1; attempt <= 2; attempt++) {
        try {
          const res = await fetch(`${apiBase}/external-board/receive`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${token}`,
            },
            body: JSON.stringify(jobData),
          });

          if (res.ok) {
            const respData = await res.json().catch(() => ({}));
            if (respData && respData.isNew) {
              syncedCounter++;
            }
            success = true;
            console.log(`[HireMateX Worker] Synced job: ${jobData.title} (${respData?.isNew ? 'New' : 'Refreshed'})`);
            updateBadge(true);
            sendResponse({ success: true, synced: true, count: syncedCounter, isNew: respData?.isNew });
            break;
          } else {
            const err = await res.text();
            console.warn(`[HireMateX Worker] Sync attempt ${attempt} response (${res.status}):`, err);
            if (res.status === 401) {
              updateBadge(false);
              sendResponse({ success: false, reason: 'UNAUTHORIZED' });
              return;
            }
            if (attempt < 2) await new Promise(r => setTimeout(r, 1000));
          }
        } catch (netErr) {
          console.error(`[HireMateX Worker] Network failure on attempt ${attempt}:`, netErr);
          if (attempt < 2) await new Promise(r => setTimeout(r, 1000));
        }
      }

      if (!success) {
        sendResponse({ success: false, reason: 'NETWORK_ERROR' });
      }
    });

    return true; // Keep message channel open for asynchronous sendResponse
  }

  if (message.action === 'JOB_BATCH_FOUND' && Array.isArray(message.jobs) && message.jobs.length > 0) {
    const jobsList = message.jobs;
    console.log(`[HireMateX Worker] Batch detected: ${jobsList.length} jobs to sync`);

    chrome.storage.local.get(['authToken', 'apiUrl'], async (result) => {
      const token = result.authToken;
      const apiBase = (result.apiUrl || 'https://hirematex-api-97nu.onrender.com').replace(/\/+$/, '');

      if (!token) {
        console.warn('[HireMateX Worker] No auth token configured.');
        updateBadge(false);
        sendResponse({ success: false, reason: 'NO_TOKEN' });
        return;
      }

      try {
        const res = await fetch(`${apiBase}/external-board/receive`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${token}`,
          },
          body: JSON.stringify(jobsList),
        });

        if (res.ok) {
          const respData = await res.json().catch(() => ({}));
          const newInserted = respData.newInserted !== undefined ? respData.newInserted : jobsList.length;
          const refreshed = respData.refreshed !== undefined ? respData.refreshed : 0;
          const totalInDb = respData.totalInDatabase;
          
          if (totalInDb !== undefined) {
            syncedCounter = totalInDb;
          } else {
            syncedCounter += newInserted;
          }

          console.log(`[HireMateX Worker] Successfully batch synced ${jobsList.length} jobs (${newInserted} new, ${refreshed} refreshed) | Total in DB: ${syncedCounter}`);
          updateBadge(true);
          sendResponse({
            success: true,
            synced: true,
            count: syncedCounter,
            added: newInserted,
            refreshed,
            totalInDatabase: totalInDb
          });
        } else {
          const err = await res.text();
          console.warn('[HireMateX Worker] Batch sync response error:', err);
          if (res.status === 401) {
            updateBadge(false);
            sendResponse({ success: false, reason: 'UNAUTHORIZED' });
            return;
          }
          sendResponse({ success: false, reason: 'API_ERROR' });
        }
      } catch (netErr) {
        console.error('[HireMateX Worker] Batch sync network failure:', netErr);
        sendResponse({ success: false, reason: 'NETWORK_ERROR' });
      }
    });

    return true;
  }

  if (message.action === 'TOKEN_UPDATED') {
    chrome.storage.local.get(['authToken'], (res) => {
      updateBadge(!!res.authToken);
      sendResponse({ success: true, connected: !!res.authToken });
    });
    return true;
  }

  if (message.action === 'CHECK_STATUS' || message.action === 'PING') {
    chrome.storage.local.get(['authToken', 'apiUrl'], (res) => {
      sendResponse({
        connected: !!res.authToken,
        apiUrl: res.apiUrl || 'https://hirematex-api-97nu.onrender.com',
        syncedCount: syncedCounter
      });
    });
    return true;
  }
});
