// ==========================================================================
// NYT Labeler Dashboard Frontend Script (app.js)
// ==========================================================================

document.addEventListener('DOMContentLoaded', () => {
  // Tab Navigation Setup: every sidebar item with a data-tab opens that tab's pane
  const tabs = document.querySelectorAll('.nav-item[data-tab]');
  const panes = document.querySelectorAll('.tab-pane');
  const reportsToggle = document.querySelector('#reports-nav .nav-group-toggle');
  const reportsSubmenu = document.getElementById('reports-submenu');

  function showTab(activeTab) {
    // Update sidebar nav state
    tabs.forEach(t => t.classList.toggle('active', t.getAttribute('data-tab') === activeTab));

    // Update pane state
    panes.forEach(pane => {
      if (pane.id === `tab-${activeTab}`) {
        pane.classList.add('active');
      } else {
        pane.classList.remove('active');
      }
    });

    // The Reports group shows which of its reports is open
    const inReports = Boolean(reportsSubmenu?.querySelector(`[data-tab="${activeTab}"]`));
    reportsToggle?.classList.toggle('has-active', inReports);
    if (inReports) setReportsExpanded(true);

    // Reports are loaded when opened, so they're current each time
    if (activeTab === 'reports') loadReports();
    if (activeTab === 'reports-authors') loadAuthorsReport();
  }

  tabs.forEach(tab => {
    tab.addEventListener('click', () => showTab(tab.getAttribute('data-tab')));
  });

  function setReportsExpanded(expanded) {
    if (!reportsToggle || !reportsSubmenu) return;
    reportsToggle.setAttribute('aria-expanded', String(expanded));
    reportsSubmenu.hidden = !expanded;
  }

  // Opening the Reports group shows its first report, unless one is already open. The group
  // stays open while one of its reports is showing, so the open report is never hidden.
  reportsToggle?.addEventListener('click', () => {
    const expanded = reportsToggle.getAttribute('aria-expanded') === 'true';
    const reportShowing = Boolean(reportsSubmenu.querySelector('.nav-item.active'));
    if (expanded && reportShowing) return;
    setReportsExpanded(!expanded);
    if (!expanded && !reportShowing) {
      showTab(reportsSubmenu.querySelector('[data-tab]').getAttribute('data-tab'));
    }
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
  const firehoseSwitchEl = document.getElementById('firehose-switch');

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

  // Database status from the server's periodic check (a null status means none has run yet)
  function updateDbStatus(status) {
    const badge = document.getElementById('db-status');
    if (!badge) return;
    let state = 'checking';
    let text = 'Checking…';
    if (status && status.connected === true) {
      state = 'connected';
      const latency = Number(status.latencyMs);
      text = Number.isFinite(latency) ? `Connected · ${Math.round(latency)} ms` : 'Connected';
    } else if (status && status.connected === false) {
      state = 'down';
      text = 'Unreachable';
    }
    const dot = { connected: 'green', down: 'red', checking: 'yellow' }[state];
    badge.className = `db-status-badge ${state}`;
    badge.innerHTML = `<span class="status-dot ${dot}"></span>`;
    badge.append(` ${text}`);
    const checkedAt = new Date(status?.checkedAt);
    badge.title = Number.isNaN(checkedAt.getTime()) ? '' : `Last checked ${checkedAt.toLocaleTimeString()}`;
  }

  // Populate dynamic DOM values
  function updateStats(stats) {
    updateDbStatus(stats.database);
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

    if (firehoseSwitchEl && typeof stats.firehoseEnabled === 'boolean' && !isToggling && (Date.now() - lastToggleTime > 3000)) {
      firehoseSwitchEl.checked = stats.firehoseEnabled;
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
  // so check them instead of encoding them. Bluesky accounts use only two DID methods:
  // did:plc (24 base32 characters) and did:web (a hostname, with an optional %3A-encoded port).
  // Valid values can't contain quotes, spaces or angle brackets; anything else gets no link.
  const DID_PATTERNS = [
    /^did:plc:[a-z2-7]{24}$/,
    /^did:web:[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?)+(?:%3A[0-9]{1,5})?$/,
  ];
  const RECORD_KEY_PATTERN = /^[a-zA-Z0-9._:~-]{1,512}$/;

  function bskyPostUrl(did, uri) {
    const recordKey = String(uri ?? '').split('/').pop();
    if (!DID_PATTERNS.some((pattern) => pattern.test(String(did ?? '')))) return null;
    if (!RECORD_KEY_PATTERN.test(recordKey) || recordKey === '.' || recordKey === '..') return null;
    return `https://bsky.app/profile/${did}/post/${recordKey}`;
  }

  // Reports: the most shared articles per period, from /api/reports/popular-articles
  document.getElementById('reports-refresh')?.addEventListener('click', () => loadReports());

  async function loadReports() {
    const list = document.getElementById('reports-list');
    if (!list) return;
    if (!list.children.length) list.innerHTML = '<div class="empty-state">Loading reports…</div>';
    try {
      const res = await fetch('/api/reports/popular-articles');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      renderReports(await res.json());
    } catch (err) {
      console.error('Failed to load reports:', err);
      list.innerHTML = '<div class="empty-state">Couldn\'t load reports. Try Refresh.</div>';
    }
  }

  // An article's title (or URL, without one), linked to the article
  function articleLinkHtml(article) {
    const title = escapeHtml(article.title || article.url);
    // Link only to web pages: an article URL from the database can't become a script link
    return /^https?:\/\//i.test(String(article.url ?? ''))
      ? `<a href="${escapeHtml(article.url)}" target="_blank" rel="noopener noreferrer" class="report-article-link">${title}</a>`
      : title;
  }

  // Reports › By Authors: the author list, and a drill-down into one author's articles
  // scope: 'shared' (articles shared since recording began) or 'all' (every article nytdata has)
  const authorsView = { author: null, articles: [], sort: { key: 'shares', dir: 'desc' }, scope: 'shared' };
  const AUTHOR_DESCRIPTIONS = {
    shared: 'Authors with their own label, and how often their articles were linked in labeled Bluesky posts since recording began on September 26, 2026. An article with several authors counts for each of them.',
    all: 'Every author with their own label, with all of their articles. Shares are counted since recording began on September 26, 2026, so earlier articles show 0. An article with several authors counts for each of them.',
  };
  const scopeQuery = () => (authorsView.scope === 'all' ? '?scope=all' : '');

  document.getElementById('authors-all')?.addEventListener('change', (event) => {
    authorsView.scope = event.target.checked ? 'all' : 'shared';
    const description = document.getElementById('authors-description');
    if (description) description.textContent = AUTHOR_DESCRIPTIONS[authorsView.scope];
    // Reload whichever view is showing
    if (authorsView.author) loadAuthor(authorsView.author.id);
    else loadAuthorsReport();
  });
  let authorsRequest = 0; // Only the latest request's response is shown

  document.getElementById('authors-refresh')?.addEventListener('click', () => {
    if (authorsView.author) loadAuthor(authorsView.author.id);
    else loadAuthorsReport();
  });

  document.getElementById('authors-report')?.addEventListener('click', (event) => {
    const authorButton = event.target.closest('[data-author-id]');
    if (authorButton) {
      loadAuthor(Number(authorButton.getAttribute('data-author-id')));
      return;
    }
    if (event.target.closest('[data-action="all-authors"]')) {
      loadAuthorsReport();
      return;
    }
    const sortButton = event.target.closest('[data-sort]');
    if (sortButton) {
      const key = sortButton.getAttribute('data-sort');
      const { sort } = authorsView;
      // The same column flips direction; a new column starts with the highest first
      authorsView.sort = sort.key === key ? { key, dir: sort.dir === 'desc' ? 'asc' : 'desc' } : { key, dir: 'desc' };
      renderAuthorArticles();
    }
  });

  // Returns null when a newer request has replaced this one, whether this one succeeded or
  // failed, so a late response never overwrites the newer view
  async function fetchAuthorsJson(url, container, loadingText) {
    const request = ++authorsRequest;
    container.innerHTML = `<div class="empty-state">${loadingText}</div>`;
    try {
      const res = await fetch(url);
      if (request !== authorsRequest) return null;
      if (res.status === 404) return { notFound: true };
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      return request === authorsRequest ? data : null;
    } catch (err) {
      if (request !== authorsRequest) return null;
      throw err;
    }
  }

  async function loadAuthorsReport() {
    const container = document.getElementById('authors-report');
    if (!container) return;
    authorsView.author = null;
    try {
      const report = await fetchAuthorsJson(`/api/reports/authors${scopeQuery()}`, container, 'Loading authors…');
      if (report) renderAuthors(report);
    } catch (err) {
      console.error('Failed to load the authors report:', err);
      container.innerHTML = '<div class="empty-state">Couldn\'t load the authors report. Try Refresh.</div>';
    }
  }

  function renderAuthors(report) {
    const authors = Array.isArray(report?.authors) ? report.authors : [];
    const rows = authors.length
      ? authors.map((author) => {
          const name = escapeHtml(author.name);
          // Ids are integers; anything else isn't clickable
          const nameHtml = Number.isInteger(author.id) && author.id > 0
            ? `<button type="button" class="link-button" data-author-id="${author.id}">${name}</button>`
            : name;
          return `
            <tr>
              <td class="article-title-cell">${nameHtml}</td>
              <td class="report-shares">${Number(author.articles) || 0}</td>
              <td class="report-shares">${Number(author.shares) || 0}</td>
            </tr>`;
        }).join('')
      : `<tr><td colspan="3" class="empty-state">${authorsView.scope === 'all' ? 'No authors yet.' : 'No shares recorded yet.'}</td></tr>`;
    document.getElementById('authors-report').innerHTML = `
      <div class="report-card glass history-table-container authors-card">
        <table class="history-table">
          <thead>
            <tr>
              <th>Author Name</th>
              <th class="report-shares">Number of Articles</th>
              <th class="report-shares">Number of Shares</th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
      </div>`;
    setUpdated('authors-updated', report?.generatedAt);
  }

  async function loadAuthor(authorId) {
    const container = document.getElementById('authors-report');
    if (!container || !Number.isInteger(authorId) || authorId <= 0) return;
    try {
      const report = await fetchAuthorsJson(`/api/reports/authors/${authorId}${scopeQuery()}`, container, 'Loading articles…');
      if (!report) return;
      if (report.notFound) {
        authorsView.author = null;
        container.innerHTML = `
          <button type="button" class="action-btn back-btn" data-action="all-authors">← All authors</button>
          <div class="empty-state">That author wasn't found.</div>`;
        return;
      }
      // A different author starts sorted by shares; reloading the same one (Refresh, or the
      // Show all articles switch) keeps the chosen sort
      if (authorsView.author?.id !== report.author?.id) authorsView.sort = { key: 'shares', dir: 'desc' };
      authorsView.author = report.author;
      authorsView.articles = Array.isArray(report.articles) ? report.articles : [];
      authorsView.generatedAt = report.generatedAt;
      renderAuthorArticles();
    } catch (err) {
      console.error('Failed to load the author report:', err);
      container.innerHTML = `
        <button type="button" class="action-btn back-btn" data-action="all-authors">← All authors</button>
        <div class="empty-state">Couldn't load this author's articles. Try Refresh.</div>`;
    }
  }

  const timeOf = (value) => {
    const time = Date.parse(value);
    return Number.isNaN(time) ? 0 : time;
  };

  function sortedAuthorArticles() {
    const { key, dir } = authorsView.sort;
    const sign = dir === 'asc' ? 1 : -1;
    return [...authorsView.articles].sort((a, b) => {
      const byDate = timeOf(a.dateAdded) - timeOf(b.dateAdded);
      const byShares = (Number(a.shares) || 0) - (Number(b.shares) || 0);
      // Ties on the chosen column go to the other one, highest (or newest) first
      return key === 'date' ? sign * byDate || -byShares : sign * byShares || -byDate;
    });
  }

  function formatReportDate(value) {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return '—';
    // Dates are shown in New York time
    return date.toLocaleDateString('en-US', { timeZone: 'America/New_York', month: 'short', day: 'numeric', year: 'numeric' });
  }

  function renderAuthorArticles() {
    const { author, sort } = authorsView;
    const articles = sortedAuthorArticles();
    const header = (key, label, extraTitle = '') => {
      const active = sort.key === key;
      const ariaSort = active ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none';
      const arrow = active ? (sort.dir === 'asc' ? ' ▲' : ' ▼') : '';
      return `<th class="report-shares" aria-sort="${ariaSort}"${extraTitle ? ` title="${extraTitle}"` : ''}>
          <button type="button" class="sort-button" data-sort="${key}">${label}${arrow}</button>
        </th>`;
    };
    const rows = articles.length
      ? articles.map((article) => `
          <tr>
            <td class="article-title-cell">${articleLinkHtml(article)}</td>
            <td class="report-shares report-date">${escapeHtml(formatReportDate(article.dateAdded))}</td>
            <td class="report-shares">${Number(article.shares) || 0}</td>
          </tr>`).join('')
      : `<tr><td colspan="3" class="empty-state">${authorsView.scope === 'all' ? 'No articles.' : 'No shared articles.'}</td></tr>`;
    document.getElementById('authors-report').innerHTML = `
      <button type="button" class="action-btn back-btn" data-action="all-authors">← All authors</button>
      <div class="report-card glass history-table-container author-articles-card">
        <h3>${escapeHtml(author?.name)}</h3>
        <table class="history-table">
          <thead>
            <tr>
              <th>Article Title</th>
              ${header('date', 'Date Published', 'When the article first appeared in the NYT Top Stories feed, usually close to publication')}
              ${header('shares', 'Number of Shares')}
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
      </div>`;
    setUpdated('authors-updated', authorsView.generatedAt);
  }

  function setUpdated(elementId, generatedAt) {
    const updated = document.getElementById(elementId);
    const at = new Date(generatedAt);
    if (updated) updated.textContent = Number.isNaN(at.getTime()) ? '' : `Updated ${at.toLocaleTimeString('en-US', { timeZone: 'America/New_York' })} ET`;
  }

  function renderReports(report) {
    const list = document.getElementById('reports-list');
    const windows = Array.isArray(report?.windows) ? report.windows : [];
    list.innerHTML = windows.map((period) => {
      const articles = Array.isArray(period.articles) ? period.articles : [];
      const rows = articles.length
        ? articles.map((article) => {
            const titleHtml = articleLinkHtml(article);
            const authors = Array.isArray(article.authors) && article.authors.length
              ? article.authors.map(escapeHtml).join(', ')
              : '—';
            return `
              <tr>
                <td class="article-title-cell">${titleHtml}</td>
                <td class="report-authors">${authors}</td>
                <td class="report-shares">${Number(article.shares) || 0}</td>
              </tr>`;
          }).join('')
        : '<tr><td colspan="3" class="empty-state">No shares recorded in this period yet.</td></tr>';
      return `
        <div class="report-card glass history-table-container" data-report="${escapeHtml(period.key)}">
          <h3>Most Popular Shared Posts in the ${escapeHtml(period.label)}</h3>
          <table class="history-table">
            <thead>
              <tr>
                <th>Article</th>
                <th>Authors</th>
                <th class="report-shares">Times Shared</th>
              </tr>
            </thead>
            <tbody>${rows}</tbody>
          </table>
        </div>`;
    }).join('');

    setUpdated('reports-updated', report?.generatedAt);
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

      if (setHandle) showHandle(setHandle, config);
      if (setUrl) setUrl.value = config.serviceUrl;
      if (setDid) setDid.value = config.did || 'dry_run_unbound_did';
      if (setDbName) setDbName.value = config.dbName || 'nytdata';
    } catch (err) {
      console.error('Failed to load system config:', err);
    }
  }

  // Bluesky handles are domain names (e.g. nyt-labeler-dev.bsky.social)
  const HANDLE_PATTERN = /^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+$/;

  // Shows the labeler's handle, linked to its bsky.app profile when it's a real handle
  function showHandle(element, config) {
    const handle = config.dryRun ? null : config.bskyIdentifier;
    if (handle && HANDLE_PATTERN.test(handle)) {
      element.textContent = handle;
      element.href = `https://bsky.app/profile/${handle}`;
      element.title = 'Open this account on Bluesky';
    } else {
      element.textContent = config.dryRun ? 'nyt-labeler-dev.bsky.social (Dry-Run)' : (handle || 'Unknown Handle');
      element.removeAttribute('href');
      element.removeAttribute('title');
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
  if (firehoseSwitchEl) {
    firehoseSwitchEl.addEventListener('change', async () => {
      if (isToggling) return;
      isToggling = true;
      lastToggleTime = Date.now();
      firehoseSwitchEl.disabled = true;
      const enabled = firehoseSwitchEl.checked;

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
            firehoseSwitchEl.disabled = false;
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
      firehoseSwitchEl.checked = data.firehoseEnabled;
    } catch (err) {
      console.error('❌ Failed to toggle Feed Listener via HTTP:', err);
      firehoseSwitchEl.checked = !enabled; // Revert
    } finally {
      isToggling = false;
      firehoseSwitchEl.disabled = false;
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
