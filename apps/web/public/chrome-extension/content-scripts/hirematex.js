// HireMateX Auto-Sync Bridge Content Script
// Automatically connects and refreshes extension authorization when browsing HireMateX

console.log('[HireMateX Extension] Connected to HireMateX Web Platform.');

function broadcastExtensionReady() {
  window.postMessage({ type: 'HIREMATE_EXTENSION_INSTALLED', version: '1.2.0' }, '*');
}

// 1. Listen for explicit token sync events dispatched from HireMateX frontend
window.addEventListener('message', (event) => {
  if (event.source !== window || !event.data) return;

  if (event.data.type === 'HIREMATE_SET_EXTENSION_TOKEN' && event.data.token) {
    const token = event.data.token;
    const apiUrl = event.data.apiUrl || 'https://hirematex-api-97nu.onrender.com';
    
    chrome.storage.local.set({ authToken: token, apiUrl }, () => {
      console.log('[HireMateX Extension] Auto-synchronized extension token from web app.');
      try {
        chrome.runtime.sendMessage({ action: 'TOKEN_UPDATED' }, () => {
          if (chrome.runtime.lastError) { /* ignore */ }
        });
      } catch (e) {}
      window.postMessage({ type: 'HIREMATE_EXTENSION_TOKEN_SAVED', success: true }, '*');
    });
  }
});

// 2. Announce presence on page load
broadcastExtensionReady();
setInterval(broadcastExtensionReady, 3000);
