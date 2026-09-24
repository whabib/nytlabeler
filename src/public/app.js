// ==========================================================================
// NYT Labeler Dashboard Frontend Script (app.js)
// ==========================================================================

document.addEventListener('DOMContentLoaded', () => {
  // Tab Navigation Setup
  const tabs = document.querySelectorAll('.nav-item');
  const panes = document.querySelectorAll('.tab-pane');

  tabs.forEach(tab => {
    tab.addEventListener('click', () => {
      const activeTab = tab.getAttribute('data-tab');
      
      // Update sidebar nav state
      tabs.forEach(t => t.classList.remove('active'));
      tab.classList.add('active');

      // Update pane state
      panes.forEach(pane => {
        if (pane.id === `tab-${activeTab}`) {
          pane.classList.add('active');
        } else {
          pane.classList.remove('active');
        }
      });
    });
  });

  // Active Connection variables
  let ws;
  let recentLabels = [];
  let lastEventTimeStr = null;
  let lastLabelAtStr = null;
  // Recent labels from the database (all instances), used when this instance has none of its own
  let dbRecentLabels = [];
  let isToggling = false;
  let lastToggleTime = 0; // Cooldown to prevent race conditions with in-flight heartbeats
  const maxConsoleLines = 50;

  // Stats DOM Elements
  const processedEl = document.getElementById('processed-count');
  const nytEl = document.getElementById('nyt-count');
  const labelsEl = document.getElementById('labels-count');
  const labelsSubEl = document.getElementById('labels-sub');
  const standbyBannerEl = document.getElementById('standby-banner');
  const diagLastLabelEl = document.getElementById('diag-last-label');
  const throughputEl = document.getElementById('throughput-val');
  const uptimeEl = document.getElementById('uptime-val');
  const wsStatusEl = document.getElementById('ws-status');
  const envBadgeEl = document.getElementById('env-badge');
  const dryRunBannerEl = document.getElementById('dry-run-banner');

  // Stream Diagnostics DOM Elements
  const diagStatusEl = document.getElementById('diag-status');
  const diagEndpointEl = document.getElementById('diag-endpoint');
  const diagLastTimeEl = document.getElementById('diag-last-time');
  const diagReconnectsEl = document.getElementById('diag-reconnects');
  const diagSwitchEl = document.getElementById('diag-switch');

  // Terminal DOM Elements
  const terminalLogsEl = document.getElementById('terminal-logs');
  const clearTerminalBtn = document.getElementById('clear-terminal');

  // History DOM Elements
  const historyTbody = document.getElementById('history-tbody');
  const historySearch = document.getElementById('history-search');

  // Universe Badge DOM Elements
  const authorsCountBadge = document.getElementById('authors-count-badge');
  const sectionsCountBadge = document.getElementById('sections-count-badge');
  const subsectionsCountBadge = document.getElementById('subsections-count-badge');
  const authorsListEl = document.getElementById('authors-list');
  const sectionsListEl = document.getElementById('sections-list');
  const subsectionsListEl = document.getElementById('subsections-list');

  // Settings DOM Elements
  const setHandle = document.getElementById('set-handle');
  const setUrl = document.getElementById('set-url');
  const setDid = document.getElementById('set-did');
  const setDbHost = document.getElementById('set-db-host');
  const setDbName = document.getElementById('set-db-name');

  // Initialize Canvas Chart
  const canvas = document.getElementById('speed-chart');
  const ctx = canvas?.getContext('2d');
  const speedHistory = Array(40).fill(0); // Holds the last 40 data points of posts/sec

  // Adjust canvas size for high-DPI retina screens
  function resizeCanvas() {
    if (!canvas) return;
    const width = canvas.parentElement.clientWidth - 48;
    canvas.width = width;
    canvas.style.width = width + 'px';
    drawChart();
  }
  
  window.addEventListener('resize', resizeCanvas);
  setTimeout(resizeCanvas, 100);

  // Draw smooth, glowy Canvas Chart
  function drawChart() {
    if (!ctx || !canvas) return;
    
    const w = canvas.width;
    const h = canvas.height;
    ctx.clearRect(0, 0, w, h);

    // Draw Grid Lines
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.03)';
    ctx.lineWidth = 1;
    for (let i = 1; i <= 3; i++) {
      const y = h * (i / 4);
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(w, y);
      ctx.stroke();
    }

    const maxVal = Math.max(10, ...speedHistory) * 1.15; // Padding at top
    const dx = w / (speedHistory.length - 1);

    // Create gradient fill under the line
    const gradient = ctx.createLinearGradient(0, 0, 0, h);
    gradient.addColorStop(0, 'rgba(138, 92, 246, 0.25)');
    gradient.addColorStop(1, 'rgba(138, 92, 246, 0.0)');

    ctx.beginPath();
    ctx.moveTo(0, h);
    for (let i = 0; i < speedHistory.length; i++) {
      const x = i * dx;
      const y = h - (speedHistory[i] / maxVal) * h;
      ctx.lineTo(x, y);
    }
    ctx.lineTo(w, h);
    ctx.closePath();
    ctx.fillStyle = gradient;
    ctx.fill();

    // Draw neon line
    ctx.beginPath();
    for (let i = 0; i < speedHistory.length; i++) {
      const x = i * dx;
      const y = h - (speedHistory[i] / maxVal) * h;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.strokeStyle = '#a78bfa'; // Purple neon
    ctx.lineWidth = 2.5;
    ctx.shadowColor = '#8a5cf6';
    ctx.shadowBlur = 8;
    ctx.stroke();
    ctx.shadowBlur = 0; // Reset shadow
  }

  // Formatting Uptime Helper
  function formatUptime(seconds) {
    const hrs = Math.floor(seconds / 3600).toString().padStart(2, '0');
    const mins = Math.floor((seconds % 3600) / 60).toString().padStart(2, '0');
    const secs = (seconds % 60).toString().padStart(2, '0');
    return `${hrs}:${mins}:${secs}`;
  }

  // Populate dynamic DOM values
  function updateStats(stats) {
    if (processedEl) processedEl.textContent = stats.postsProcessed.toLocaleString();
    if (nytEl) nytEl.textContent = stats.nytLinksDetected.toLocaleString();
    // Label counts come from the database, so they include labels issued by any instance
    const store = stats.labelStore;
    if (labelsEl) labelsEl.textContent = (store ? store.total : stats.labelsEmitted).toLocaleString();
    if (labelsSubEl) {
      // At its scan limit the last-hour count is a lower bound
      const lastHour = `${store?.lastHour.toLocaleString()}${store?.lastHourCapped ? '+' : ''}`;
      labelsSubEl.textContent = store ? `${lastHour} in the last hour · all instances` : '';
    }
    if (store) {
      lastLabelAtStr = store.lastLabelAt;
      updateRelativeTime();
    }

    // A standby instance isn't processing the firehose; another instance is
    const standby = stats.firehoseEnabled === true && stats.firehoseLeader === false;
    if (standbyBannerEl) standbyBannerEl.classList.toggle('hidden', !standby);
    updateSidebarStatus(stats, standby);

    // Update Stream Diagnostics
    if (stats.lastEventTime) {
      lastEventTimeStr = stats.lastEventTime;
      updateRelativeTime();
    }

    if (diagReconnectsEl && typeof stats.reconnectCount === 'number') {
      diagReconnectsEl.textContent = stats.reconnectCount.toLocaleString();
    }

    if (diagSwitchEl && typeof stats.firehoseEnabled === 'boolean' && !isToggling && (Date.now() - lastToggleTime > 3000)) {
      diagSwitchEl.checked = stats.firehoseEnabled;
    }

    if (diagEndpointEl && stats.activeEndpoint) {
      try {
        const url = new URL(stats.activeEndpoint);
        diagEndpointEl.textContent = url.host;
        diagEndpointEl.title = stats.activeEndpoint; // Full URL on hover
      } catch {
        diagEndpointEl.textContent = stats.activeEndpoint;
      }
    }

    if (diagStatusEl) {
      diagStatusEl.title = '';
      if (stats.firehoseConnected) {
        diagStatusEl.innerHTML = '<span class="status-dot green pulsing"></span> Online';
        diagStatusEl.className = 'diag-value online';
      } else if (standby) {
        diagStatusEl.innerHTML = '<span class="status-dot yellow pulsing"></span> Standby';
        diagStatusEl.className = 'diag-value connecting';
        diagStatusEl.title = 'Another instance is processing the firehose';
      } else if (stats.reconnectCount > 0) {
        diagStatusEl.innerHTML = '<span class="status-dot yellow pulsing"></span> Connecting';
        diagStatusEl.className = 'diag-value connecting';
      } else {
        diagStatusEl.innerHTML = '<span class="status-dot red pulsing"></span> Offline';
        diagStatusEl.className = 'diag-value offline';
      }
    }
  }

  // Logs append helper
  function appendTerminalLine(text, type = 'pulse') {
    if (!terminalLogsEl) return;
    const div = document.createElement('div');
    div.className = `terminal-line ${type}`;
    div.textContent = `[${new Date().toLocaleTimeString()}] ${text}`;
    terminalLogsEl.appendChild(div);
    terminalLogsEl.scrollTop = terminalLogsEl.scrollHeight;

    // Truncate logs to conserve memory
    while (terminalLogsEl.children.length > maxConsoleLines) {
      terminalLogsEl.removeChild(terminalLogsEl.firstChild);
    }
  }

  // Render Label History Table
  function renderHistory(filterText = '') {
    if (!historyTbody) return;
    
    const query = filterText.toLowerCase().trim();
    const filtered = historyEntries().filter(entry => {
      if (!query) return true;
      return (
        (entry.text || '').toLowerCase().includes(query) ||
        (entry.title && entry.title.toLowerCase().includes(query)) ||
        entry.labels.some(l => l.toLowerCase().includes(query)) ||
        (entry.authorDid || '').toLowerCase().includes(query)
      );
    });

    if (filtered.length === 0) {
      historyTbody.innerHTML = `
        <tr>
          <td colspan="5" class="empty-state">No matching labeled posts found.</td>
        </tr>
      `;
      return;
    }

    historyTbody.innerHTML = filtered.map(entry => {
      const time = new Date(entry.timestamp).toLocaleTimeString();
      const tags = entry.labels.map(l => {
        let cls = 'tag-emitted';
        if (l.startsWith('sub-') || l === 'review') cls += ' sub';
        else if (l.includes('-')) {
          // If contains hyphen and not section, likely author
          cls += ' author';
        }
        const displayText = l === 'us' ? 'US' : l;
        return `<span class="${cls}">${escapeHtml(displayText)}</span>`;
      }).join(' ');

      // Build safe external links
      const postUrl = bskyPostUrl(entry.authorDid, entry.uri);

      return `
        <tr>
          <td class="history-time">${escapeHtml(time)}</td>
          <td>
            <div class="article-title-cell">${entry.fromDatabase
              ? '<span class="muted-cell">—</span>'
              : escapeHtml(entry.title || 'Unknown Title')}</div>
          </td>
          <td class="post-text-cell">${entry.text == null
            ? '<span class="muted-cell">Post text not recorded on this instance</span>'
            : escapeHtml(entry.text)}</td>
          <td><div class="emitted-tags-cell">${tags}</div></td>
          <td>
            <div style="display: flex; gap: 8px;">
              ${postUrl
                ? `<a href="${escapeHtml(postUrl)}" target="_blank" rel="noopener noreferrer" class="action-btn">Post 🦋</a>`
                : '<span class="muted-cell">—</span>'}
            </div>
          </td>
        </tr>
      `;
    }).join('');
  }

  // This instance's own labeling log, or else the database's recent labels (all instances).
  // Database entries have no post text or article title.
  function historyEntries() {
    if (recentLabels.length > 0) return recentLabels;
    return dbRecentLabels.map(post => ({
      id: post.uri,
      uri: post.uri,
      authorDid: String(post.uri).split('/')[2] || '',
      text: null,
      title: null,
      labels: post.labels,
      timestamp: post.timestamp,
      fromDatabase: true,
    }));
  }

  async function fetchDbRecentLabels() {
    try {
      const res = await fetch('/api/labels/recent');
      const posts = await res.json();
      if (!Array.isArray(posts)) return;
      dbRecentLabels = posts;
      if (recentLabels.length === 0) renderHistory(historySearchValue());
    } catch (err) {
      console.error('Failed to load recent labels:', err);
    }
  }

  function historySearchValue() {
    return document.getElementById('history-search')?.value || '';
  }

  // bsky.app needs the DID and record key verbatim (it doesn't resolve percent-encoded DIDs),
  // so check them against the AT Protocol syntax instead of encoding them. Valid values can't
  // contain quotes, spaces or angle brackets; anything else gets no link.
  const DID_PATTERN = /^did:[a-z]+:[a-zA-Z0-9._:%-]*[a-zA-Z0-9._-]$/;
  const RECORD_KEY_PATTERN = /^[a-zA-Z0-9._:~-]{1,512}$/;

  function bskyPostUrl(did, uri) {
    const recordKey = String(uri ?? '').split('/').pop();
    if (!DID_PATTERN.test(String(did ?? ''))) return null;
    if (!RECORD_KEY_PATTERN.test(recordKey) || recordKey === '.' || recordKey === '..') return null;
    return `https://bsky.app/profile/${did}/post/${recordKey}`;
  }

  // HTML escape helper to prevent XSS: apply to every outside value inserted as HTML
  function escapeHtml(value) {
    return String(value ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  // Fetch static metadata configurations
  async function fetchUniverseData() {
    try {
      // 1. Fetch opinion authors
      const authorsRes = await fetch('/api/authors');
      const authors = await authorsRes.json();
      if (authorsCountBadge) authorsCountBadge.textContent = authors.length;
      if (authorsListEl) {
        authorsListEl.innerHTML = authors.map(auth => `
          <div class="author-badge">
            <span class="author-title">${escapeHtml(auth.name)}</span>
            <div class="author-meta">
              <span class="author-token">${escapeHtml(slugify(auth.name))}</span>
              <span>${escapeHtml(auth.total_articles)} articles</span>
            </div>
          </div>
        `).join('');
      }

      // 2. Fetch sections/subsections
      const catRes = await fetch('/api/categories');
      const cats = await catRes.json();
      
      if (sectionsCountBadge) sectionsCountBadge.textContent = cats.sections.length;
      if (sectionsListEl) {
        sectionsListEl.innerHTML = cats.sections.map(sec => `
          <span class="tag-label">${escapeHtml(sec)}</span>
        `).join('');
      }

      if (subsectionsCountBadge) subsectionsCountBadge.textContent = cats.subsections.length;
      if (subsectionsListEl) {
        subsectionsListEl.innerHTML = cats.subsections.map(sub => `
          <span class="tag-label">${escapeHtml(sub)}</span>
        `).join('');
      }
    } catch (err) {
      console.error('Failed to load universe data:', err);
    }
  }

  // Slugification matching backend
  function slugify(text) {
    return text
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '');
  }

  // Fetch initial config values for Settings pane
  async function fetchSystemConfig() {
    try {
      const res = await fetch('/api/stats');
      const config = await res.json();

      if (envBadgeEl) {
        envBadgeEl.textContent = config.env === 'production' ? 'Production' : 'Dev Mode';
        envBadgeEl.className = `env-badge ${config.env}`;
      }

      if (dryRunBannerEl) {
        if (config.dryRun) dryRunBannerEl.classList.remove('hidden');
        else dryRunBannerEl.classList.add('hidden');
      }

      if (setHandle) setHandle.value = config.dryRun ? 'nyt-labeler-dev.bsky.social (Dry-Run)' : (config.bskyIdentifier || 'Unknown Handle');
      if (setUrl) setUrl.value = config.serviceUrl;
      if (setDid) setDid.value = config.did || 'dry_run_unbound_did';
      if (setDbHost) setDbHost.value = config.dbHost || 'localhost';
      if (setDbName) setDbName.value = config.dbName || 'nytdata';
    } catch (err) {
      console.error('Failed to load system config:', err);
    }
  }

  // Setup WebSocket connection
  function connectWebSocket() {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${window.location.host}/ws`;
    
    ws = new WebSocket(wsUrl);

    ws.onopen = () => {
      console.log('🔌 Connected to Server WebSocket');
      // The firehose state itself arrives with the first stats update
      if (wsStatusEl) {
        wsStatusEl.innerHTML = '<span class="status-dot green pulsing"></span> Connected';
        wsStatusEl.className = 'connection-status online';
      }
      appendTerminalLine('[SYSTEM] Socket successfully connected to backend.', 'system');
    };

    ws.onmessage = (event) => {
      const data = JSON.parse(event.data);

      if (data.type === 'init') {
        updateStats(data.stats);
        recentLabels = data.recentLabels;
        renderHistory();
        appendTerminalLine('[SYSTEM] Synced initial server data state.', 'system');
      } 
      
      else if (data.type === 'heartbeat') {
        updateStats(data.stats);
        if (throughputEl) {
          const unit = document.createElement('span');
          unit.className = 'unit';
          unit.textContent = '/s';
          throughputEl.replaceChildren(`${Number(data.stats.throughput) || 0} `, unit);
        }
        if (uptimeEl) uptimeEl.textContent = formatUptime(data.stats.uptime);

        // Update speed history and draw chart
        speedHistory.push(data.stats.throughput);
        speedHistory.shift();
        drawChart();

        // Print minor terminal ping
        if (data.stats.throughput > 0) {
          appendTerminalLine(`Ingesting firehose: scanning ${data.stats.throughput} posts/sec...`, 'pulse');
        }
      } 
      
      else if (data.type === 'log') {
        updateStats(data.stats);
        
        // Prepended new log
        recentLabels.unshift(data.log);
        if (recentLabels.length > 500) recentLabels.pop();
        renderHistory(historySearch ? historySearch.value : '');

        // Output match highlight to console
        appendTerminalLine(`[MATCHED] "${data.log.title || 'No Title'}" ➔ Emitted tokens: [${data.log.labels.join(', ')}]`, 'match');
      }
    };

    ws.onclose = () => {
      console.log('🔌 WebSocket disconnected. Retrying in 4s...');
      if (wsStatusEl) {
        wsStatusEl.innerHTML = '<span class="status-dot red pulsing"></span> Reconnecting...';
        wsStatusEl.className = 'connection-status offline';
      }
      appendTerminalLine('[SYSTEM] Socket disconnected. Attempting to reconnect...', 'system');
      setTimeout(connectWebSocket, 4000);
    };

    ws.onerror = (err) => {
      console.error('WebSocket error:', err);
    };
  }

  // Trigger Local Clears
  if (clearTerminalBtn) {
    clearTerminalBtn.addEventListener('click', () => {
      if (terminalLogsEl) {
        terminalLogsEl.innerHTML = '<div class="terminal-line system">[SYSTEM] Terminal logs cleared.</div>';
      }
    });
  }

  // Trigger search in history table
  if (historySearch) {
    historySearch.addEventListener('input', (e) => {
      renderHistory(e.target.value);
    });
  }

  // Update relative time for last post received
  function updateRelativeTime() {
    if (diagLastTimeEl) diagLastTimeEl.textContent = formatAgo(lastEventTimeStr);
    if (diagLastLabelEl) diagLastLabelEl.textContent = formatAgo(lastLabelAtStr);
  }

  // Sidebar status reflects the firehose on this instance, not just the dashboard connection
  function updateSidebarStatus(stats, standby) {
    if (!wsStatusEl || !ws || ws.readyState !== WebSocket.OPEN) return;
    let dot = 'green', text = 'Firehose Online', state = 'online';
    if (!stats.firehoseConnected) {
      if (standby) [dot, text, state] = ['yellow', 'Firehose Standby', 'connecting'];
      else if (stats.firehoseEnabled === false) [dot, text, state] = ['yellow', 'Firehose Paused', 'connecting'];
      else [dot, text, state] = ['red', 'Firehose Offline', 'offline'];
    }
    wsStatusEl.innerHTML = `<span class="status-dot ${dot} pulsing"></span> ${text}`;
    wsStatusEl.className = `connection-status ${state}`;
  }

  function formatAgo(isoTime) {
    if (!isoTime) return 'Never';
    const ts = Date.parse(isoTime);
    if (!Number.isFinite(ts)) return '-';
    const diffSecs = Math.max(0, Math.floor((Date.now() - ts) / 1000));
    if (diffSecs < 60) return `${diffSecs}s ago`;
    const diffMins = Math.floor(diffSecs / 60);
    if (diffMins < 60) return `${diffMins}m ${diffSecs % 60}s ago`;
    return `${Math.floor(diffMins / 60)}h ${diffMins % 60}m ago`;
  }

  // Local interval to update ticking timestamps
  setInterval(() => {
    updateRelativeTime();
  }, 1000);

  // Handle Feed Listener Toggle Switch
  if (diagSwitchEl) {
    diagSwitchEl.addEventListener('change', async () => {
      if (isToggling) return;
      isToggling = true;
      lastToggleTime = Date.now();
      diagSwitchEl.disabled = true;
      const enabled = diagSwitchEl.checked;

      // If WebSocket is open, toggle deterministically over WebSocket (targets current container instance)
      if (ws && ws.readyState === WebSocket.OPEN) {
        try {
          ws.send(JSON.stringify({ type: 'toggle', enabled }));
          console.log(`📡 Sent toggle command via WebSocket: ${enabled ? 'ENABLE' : 'DISABLE'}`);
        } catch (err) {
          console.error('❌ Failed to send toggle over WebSocket, falling back to HTTP POST:', err);
          await toggleViaHttp(enabled);
        } finally {
          // Keep a brief lock to let transition messages settle, then release input
          setTimeout(() => {
            isToggling = false;
            diagSwitchEl.disabled = false;
            lastToggleTime = Date.now(); // Extend/reset cooldown
          }, 800);
        }
      } else {
        // Fall back to HTTP POST if WebSocket is disconnected
        console.warn('⚠️ WebSocket not connected. Falling back to HTTP POST for toggle.');
        await toggleViaHttp(enabled);
      }
    });
  }

  async function toggleViaHttp(enabled) {
    try {
      const response = await fetch('/api/firehose/toggle', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ enabled }),
      });
      if (!response.ok) {
        throw new Error('Failed to toggle Jetstream listener');
      }
      const data = await response.json();
      console.log(`📡 [TOGGLE] Feed listener set to ${data.firehoseEnabled ? 'ENABLED' : 'DISABLED'}`);
      diagSwitchEl.checked = data.firehoseEnabled;
    } catch (err) {
      console.error('❌ Failed to toggle Feed Listener via HTTP:', err);
      diagSwitchEl.checked = !enabled; // Revert
    } finally {
      isToggling = false;
      diagSwitchEl.disabled = false;
      lastToggleTime = Date.now(); // Extend/reset cooldown
    }
  }

  // Bootstrap Dashboard
  connectWebSocket();
  fetchUniverseData();
  fetchSystemConfig();
  fetchDbRecentLabels();
  setInterval(fetchDbRecentLabels, 30000);
});
