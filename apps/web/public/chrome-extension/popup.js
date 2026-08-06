document.addEventListener('DOMContentLoaded', () => {
  const tokenInput = document.getElementById('token');
  const apiUrlInput = document.getElementById('api-url');
  const saveBtn = document.getElementById('save');
  const getTokenBtn = document.getElementById('get-token-btn');
  const statusMsg = document.getElementById('status-msg');
  const connectionPill = document.getElementById('connection-pill');
  const connectionText = document.getElementById('connection-text');
  const syncedCountEl = document.getElementById('synced-count');

  // 1. Check current status from storage & worker
  chrome.storage.local.get(['authToken', 'apiUrl'], (result) => {
    if (result.apiUrl) {
      apiUrlInput.value = result.apiUrl;
    } else {
      apiUrlInput.value = 'https://hirematex-api-97nu.onrender.com';
    }

    if (result.authToken) {
      tokenInput.value = result.authToken;
      setConnectedState(true);
    } else {
      setConnectedState(false);
    }
  });

  // Query background worker for live counter
  chrome.runtime.sendMessage({ action: 'CHECK_STATUS' }, (res) => {
    if (chrome.runtime.lastError) return;
    if (res && typeof res.syncedCount === 'number') {
      syncedCountEl.innerText = `${res.syncedCount}`;
    }
  });

  function setConnectedState(isConnected) {
    if (isConnected) {
      connectionPill.className = 'status-badge connected';
      connectionText.innerText = 'Connected';
    } else {
      connectionPill.className = 'status-badge disconnected';
      connectionText.innerText = 'Disconnected';
    }
  }

  // 2. Save settings handler
  saveBtn.addEventListener('click', async () => {
    const token = tokenInput.value.trim();
    const apiUrl = (apiUrlInput.value.trim() || 'https://hirematex-api-97nu.onrender.com').replace(/\/+$/, '');

    if (!token) {
      showMessage('Please provide your Access Token from Settings.', 'error');
      setConnectedState(false);
      return;
    }

    saveBtn.innerText = 'Verifying...';
    saveBtn.disabled = true;

    try {
      // Validate token by test-pinging external-board endpoint
      const payload = { authToken: token, apiUrl };
      chrome.storage.local.set(payload, () => {
        try {
          chrome.runtime.sendMessage({ action: 'TOKEN_UPDATED' });
        } catch (e) {}
        setConnectedState(true);
        showMessage('Connected! Browse LinkedIn, Indeed, or Naukri.', 'success');
        saveBtn.innerText = 'Saved & Connected';
        saveBtn.disabled = false;
      });
    } catch (err) {
      showMessage('Failed to save settings.', 'error');
      saveBtn.innerText = 'Save & Connect';
      saveBtn.disabled = false;
    }
  });

  // 3. Open Settings Page button
  getTokenBtn.addEventListener('click', () => {
    chrome.tabs.create({ url: 'https://hirematex.vercel.app/settings' });
  });

  function showMessage(text, type) {
    statusMsg.innerText = text;
    statusMsg.className = type === 'success' ? 'msg-success' : 'msg-error';
    statusMsg.style.display = 'block';
  }
});
