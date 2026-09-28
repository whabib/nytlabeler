import { test, describe, before, after } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM, VirtualConsole } from 'jsdom';

const publicDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src/public');

// Every value below comes from outside the app (NYT pages via the nytdata database, or
// Bluesky posts via the firehose), so each is a script-injection attempt.
const PAYLOAD = '<img src=x onerror="window.__xss = true">';
const ATTRIBUTE_BREAKOUT = `x" onmouseover="window.__xss = true`;

const BASE_STATS = {
  postsProcessed: 1, nytLinksDetected: 1, labelsEmitted: 2, reconnectCount: 0,
  firehoseEnabled: true, firehoseConnected: true, firehoseLeader: true, throughput: 3, uptime: 10,
};

/** Images other than the page's own NYT attribution logo, i.e. any a payload created. */
function injectedImages(document: Document) {
  return [...document.querySelectorAll('img')].filter((img) => !img.closest('.nyt-attribution'));
}

/** Loads the real dashboard in jsdom with stubbed fetch responses and a fake WebSocket. */
async function loadDashboard(responses: Record<string, unknown>) {
  const html = fs.readFileSync(path.join(publicDir, 'index.html'), 'utf8');
  const script = fs.readFileSync(path.join(publicDir, 'app.js'), 'utf8');
  const dom = new JSDOM(html, {
    runScripts: 'outside-only',
    url: 'http://localhost:4100/',
    virtualConsole: new VirtualConsole(), // Silence jsdom's "not implemented" canvas messages
  });
  const window: any = dom.window;
  let socket: any;
  const sent: unknown[] = []; // Messages the dashboard sends to its server
  // An Error stands for a failed request (HTTP 500)
  window.fetch = async (url: string) => {
    const response = responses[url];
    if (response instanceof Error) return { ok: false, status: 500, json: async () => ({ error: response.message }) };
    return { ok: true, json: async () => response };
  };
  window.WebSocket = class {
    static OPEN = 1;
    readyState = 0;
    onopen?: () => void;
    onmessage?: (event: { data: string }) => void;
    onclose?: () => void;
    constructor() {
      socket = this;
    }
    send(data: string) {
      sent.push(JSON.parse(data));
    }
    close() {}
  };

  window.eval(script);
  // Start the dashboard exactly once, as a browser would: jsdom fires DOMContentLoaded
  // itself when it finishes parsing, so only dispatch it by hand if that already happened
  if (window.document.readyState === 'loading') {
    await new Promise((resolve) => window.document.addEventListener('DOMContentLoaded', resolve));
  } else {
    window.document.dispatchEvent(new window.Event('DOMContentLoaded'));
  }
  socket.readyState = 1; // The dashboard's connection to its server opens
  socket.onopen?.();
  await new Promise((resolve) => setTimeout(resolve, 20)); // Let the fetches resolve
  const send = (message: unknown) => socket.onmessage({ data: JSON.stringify(message) });
  return { window, document: window.document as Document, send, sent };
}

describe('Dashboard escapes outside data', () => {
  let window: any;
  let document: Document;

  before(async () => {
    let send: (message: unknown) => void;
    ({ window, document, send } = await loadDashboard({
      '/api/authors': [{ id: 1, name: PAYLOAD, total_articles: PAYLOAD }],
      '/api/categories': { sections: [PAYLOAD], subsections: [PAYLOAD] },
      '/api/stats': { env: 'development', dryRun: false, did: 'did:plc:x', serviceUrl: 'https://example.test' },
    }));
    send({
      type: 'init',
      stats: BASE_STATS,
      recentLabels: [{
        id: 'a',
        uri: `at://did:plc:poster/app.bsky.feed.post/${ATTRIBUTE_BREAKOUT}`,
        authorDid: ATTRIBUTE_BREAKOUT,
        text: PAYLOAD,
        labels: ['us', PAYLOAD],
        title: PAYLOAD,
        timestamp: new Date().toISOString(),
      }],
    });
    send({ type: 'heartbeat', stats: { ...BASE_STATS, throughput: PAYLOAD } });
  });

  after(() => {
    // Stops the dashboard's timers so the test process can exit
    window.close();
  });

  test('renders no injected elements or event handlers anywhere', () => {
    assert.strictEqual(injectedImages(document).length, 0, 'No <img> from the payload may be created');
    assert.strictEqual(document.querySelectorAll('[onerror], [onmouseover]').length, 0);
    assert.strictEqual(window.__xss, undefined);
  });

  test('shows history titles, labels and post text as literal text', () => {
    const history = document.getElementById('history-tbody')!;
    assert.ok(history.querySelector('.article-title-cell')!.textContent!.includes(PAYLOAD));
    assert.ok(history.querySelector('.post-text-cell')!.textContent!.includes(PAYLOAD));
    const tags = [...history.querySelectorAll('.emitted-tags-cell span')].map((el) => el.textContent);
    assert.deepStrictEqual(tags, ['US', PAYLOAD]);
  });

  test('gives a post with a malformed DID or record key no link at all', () => {
    const history = document.getElementById('history-tbody')!;
    assert.strictEqual(history.querySelectorAll('a').length, 0);
    assert.strictEqual(history.querySelectorAll('[onmouseover]').length, 0);
  });

  test('shows author names and sections as literal text', () => {
    const authorTitle = document.querySelector('.author-title');
    assert.strictEqual(authorTitle?.textContent, PAYLOAD);
    const tagLabels = [...document.querySelectorAll('.tag-label')].map((el) => el.textContent?.trim());
    assert.ok(tagLabels.length >= 2 && tagLabels.every((text) => text === PAYLOAD));
  });

  test('renders throughput as a number, never as HTML', () => {
    const throughput = document.getElementById('throughput-val')!;
    assert.strictEqual(throughput.textContent, '0 /s');
    assert.strictEqual(throughput.querySelector('.unit')?.textContent, '/s');
  });
});

describe('Dashboard on a standby instance', () => {
  let window: any;
  let document: Document;
  let send: (message: unknown) => void;
  let standbyStats: any;
  const lastLabelAt = new Date(Date.now() - 12_000).toISOString();

  before(async () => {
    ({ window, document, send } = await loadDashboard({
      '/api/authors': [],
      '/api/categories': { sections: [], subsections: [] },
      '/api/stats': { env: 'development', dryRun: false },
      // Labels issued by the leader, read from the database
      '/api/labels/recent': [
        { uri: `at://did:plc:leaderpost/app.bsky.feed.post/${ATTRIBUTE_BREAKOUT}`, labels: ['politics', PAYLOAD], timestamp: lastLabelAt },
        { uri: 'at://did:plc:ewvi7nxzyoun6zhxrhs64oiz/app.bsky.feed.post/abc', labels: ['us'], timestamp: lastLabelAt },
      ],
    }));
    standbyStats = {
      ...BASE_STATS,
      postsProcessed: 0, nytLinksDetected: 0, labelsEmitted: 0, throughput: 0,
      firehoseConnected: false,
      firehoseLeader: false,
      labelStore: { total: 528909, lastHour: 214, lastLabelAt },
    };
    send({ type: 'init', stats: standbyStats, recentLabels: [] });
    send({ type: 'heartbeat', stats: standbyStats });
  });

  after(() => {
    window.close();
  });

  test('explains that another instance is processing the firehose', () => {
    const banner = document.getElementById('standby-banner')!;
    assert.strictEqual(banner.classList.contains('hidden'), false);
    assert.match(banner.textContent!, /another instance is processing the firehose/);
    assert.match(document.getElementById('diag-status')!.textContent!, /Standby/);
    assert.match(document.getElementById('ws-status')!.textContent!, /Firehose Standby/);
  });

  test('shows "—" for article titles, which the label table does not store', () => {
    const title = document.querySelector('#history-tbody .article-title-cell')!;
    assert.strictEqual(title.textContent!.trim(), '—');
  });

  test('shows label totals from the database, not this instance', () => {
    assert.strictEqual(document.getElementById('labels-count')!.textContent, (528909).toLocaleString());
    assert.match(document.getElementById('labels-sub')!.textContent!, /214 in the last hour · all instances/);
    assert.match(document.getElementById('diag-last-label')!.textContent!, /^1\ds ago$/);
  });

  test('shows the last-hour count as a lower bound at its scan limit', () => {
    send({
      type: 'heartbeat',
      stats: { ...standbyStats, labelStore: { total: 600000, lastHour: 5000, lastHourCapped: true, lastLabelAt } },
    });
    assert.match(document.getElementById('labels-sub')!.textContent!, new RegExp(`${(5000).toLocaleString()}\\+ in the last hour`));
  });

  test('lists recent labels from the database, escaped, without post text', () => {
    const rows = [...document.querySelectorAll('#history-tbody tr')];
    assert.strictEqual(rows.length, 2);
    const tags = [...rows[0].querySelectorAll('.emitted-tags-cell span')].map((el) => el.textContent);
    assert.deepStrictEqual(tags, ['politics', PAYLOAD]);
    assert.match(rows[0].querySelector('.post-text-cell')!.textContent!, /not recorded on this instance/);
    // Valid DIDs and record keys link to bsky.app verbatim; bsky.app can't resolve %3A-encoded DIDs
    assert.strictEqual(rows[0].querySelector('a'), null, 'The malformed record key gets no link');
    assert.strictEqual(
      (rows[1].querySelector('a') as HTMLAnchorElement).getAttribute('href'),
      'https://bsky.app/profile/did:plc:ewvi7nxzyoun6zhxrhs64oiz/post/abc',
    );
    assert.strictEqual(injectedImages(document).length, 0);
    assert.strictEqual(document.querySelectorAll('[onerror], [onmouseover]').length, 0);
    assert.strictEqual(window.__xss, undefined);
  });

  test('shows no standby banner on the leader', async () => {
    const leader = await loadDashboard({
      '/api/authors': [],
      '/api/categories': { sections: [], subsections: [] },
      '/api/stats': {},
    });
    try {
      leader.send({
        type: 'init',
        stats: { ...BASE_STATS, labelStore: { total: 528910, lastHour: 215, lastLabelAt } },
        recentLabels: [],
      });
      assert.strictEqual(leader.document.getElementById('standby-banner')!.classList.contains('hidden'), true);
      assert.match(leader.document.getElementById('diag-status')!.textContent!, /Online/);
      assert.match(leader.document.getElementById('ws-status')!.textContent!, /Firehose Online/);
    } finally {
      leader.window.close();
    }
  });
});

describe('Bluesky post links in the history', () => {
  const PLC = 'did:plc:sjk4jkkdt6gvx3wablhyeqo7';
  const RKEY = '3mwa5nrez5k2a';
  // Each malformed case is paired with a valid counterpart, so each check is tested on its own
  const cases = [
    { name: 'valid did:plc', did: PLC, rkey: RKEY, href: `https://bsky.app/profile/${PLC}/post/${RKEY}` },
    { name: 'valid did:web', did: 'did:web:example.com', rkey: RKEY, href: `https://bsky.app/profile/did:web:example.com/post/${RKEY}` },
    { name: 'empty DID segment', did: 'did:plc:a::b', rkey: RKEY, href: null },
    { name: 'non-hex percent escape in DID', did: 'did:plc:ab%zzcd', rkey: RKEY, href: null },
    { name: 'attribute breakout in DID', did: ATTRIBUTE_BREAKOUT, rkey: RKEY, href: null },
    { name: 'attribute breakout in record key', did: PLC, rkey: ATTRIBUTE_BREAKOUT, href: null },
    { name: 'dot-dot record key', did: PLC, rkey: '..', href: null },
  ];
  let window: any;
  let document: Document;

  before(async () => {
    let send: (message: unknown) => void;
    ({ window, document, send } = await loadDashboard({
      '/api/authors': [],
      '/api/categories': { sections: [], subsections: [] },
      '/api/stats': {},
    }));
    send({
      type: 'init',
      stats: BASE_STATS,
      recentLabels: cases.map((c, i) => ({
        id: String(i),
        uri: `at://${c.did}/app.bsky.feed.post/${c.rkey}`,
        authorDid: c.did,
        text: c.name, // Identifies the row
        labels: ['us'],
        title: 'T',
        timestamp: new Date().toISOString(),
      })),
    });
  });

  after(() => {
    window.close();
  });

  for (const c of cases) {
    test(`${c.href ? 'links' : 'does not link'} a post with ${c.name}`, () => {
      const row = [...document.querySelectorAll('#history-tbody tr')]
        .find((tr) => tr.querySelector('.post-text-cell')!.textContent === c.name)!;
      assert.ok(row, `row for ${c.name}`);
      const link = row.querySelector('a');
      assert.strictEqual(link?.getAttribute('href') ?? null, c.href);
      assert.strictEqual(row.querySelectorAll('[onmouseover]').length, 0);
    });
  }
});

describe('Reports page', () => {
  let window: any;
  let document: Document;
  const responses: Record<string, unknown> = {
    '/api/authors': [],
    '/api/categories': { sections: [], subsections: [] },
    '/api/stats': { env: 'development', dryRun: false },
  };
  const report = {
    generatedAt: '2026-09-26T18:30:00.000Z',
    windows: [
      {
        key: '1h',
        label: 'Last Hour',
        articles: [
          { id: 1, title: 'U.S. Rejects U.N. Declaration', url: 'https://www.nytimes.com/2026/09/26/us/un.html', authors: ['Adam Author', 'Zoe Writer'], shares: 4 },
          { id: 2, title: null, url: 'https://www.nytimes.com/2026/09/26/arts/untitled.html', authors: [], shares: 1 },
        ],
      },
      {
        key: '8h',
        label: 'Last 8 Hours',
        articles: [
          // Outside data at every position: title, authors, and URLs trying to break out or run script
          { id: 3, title: PAYLOAD, url: `https://www.nytimes.com/${ATTRIBUTE_BREAKOUT}`, authors: [PAYLOAD], shares: 3 },
          { id: 4, title: 'Script link', url: 'javascript:window.__xss = true', authors: ['A'], shares: PAYLOAD },
        ],
      },
      { key: '24h', label: 'Last 24 Hours', articles: [] },
      { key: '7d', label: 'Last 7 Days', articles: [] },
    ],
  };

  function openReports() {
    (document.querySelector('.nav-item[data-tab="reports"]') as HTMLElement).click();
    return new Promise((resolve) => setTimeout(resolve, 20)); // Let the fetch resolve
  }

  before(async () => {
    responses['/api/reports/popular-articles'] = report;
    ({ window, document } = await loadDashboard(responses));
    await openReports();
  });

  after(() => {
    window.close();
  });

  test('adds Reports to the sidebar and shows its page when clicked', () => {
    const nav = document.querySelector('.nav-item[data-tab="reports"]')!;
    assert.match(nav.textContent!, /Reports/);
    assert.ok(nav.classList.contains('active'));
    assert.ok(document.getElementById('tab-reports')!.classList.contains('active'));
    assert.ok(!document.getElementById('tab-overview')!.classList.contains('active'));
  });

  test('shows one table per period, in order', () => {
    const headings = [...document.querySelectorAll('#reports-list .report-card h3')].map((h) => h.textContent);
    assert.deepStrictEqual(headings, [
      'Most Popular Shared Posts in the Last Hour',
      'Most Popular Shared Posts in the Last 8 Hours',
      'Most Popular Shared Posts in the Last 24 Hours',
      'Most Popular Shared Posts in the Last 7 Days',
    ]);
    const columns = [...document.querySelectorAll('#reports-list .report-card')[0].querySelectorAll('th')].map((th) => th.textContent);
    assert.deepStrictEqual(columns, ['Article', 'Authors', 'Times Shared']);
  });

  test('links each title to its article, with its authors and share count', () => {
    const rows = [...document.querySelectorAll('[data-report="1h"] tbody tr')];
    const cells = rows.map((row) => [...row.querySelectorAll('td')].map((td) => td.textContent!.trim()));
    assert.deepStrictEqual(cells, [
      ['U.S. Rejects U.N. Declaration', 'Adam Author, Zoe Writer', '4'],
      // No title: the URL stands in; no authors: a dash
      ['https://www.nytimes.com/2026/09/26/arts/untitled.html', '—', '1'],
    ]);
    const link = rows[0].querySelector('a')!;
    assert.strictEqual(link.getAttribute('href'), 'https://www.nytimes.com/2026/09/26/us/un.html');
    assert.strictEqual(link.getAttribute('target'), '_blank');
    assert.strictEqual(link.getAttribute('rel'), 'noopener noreferrer');
  });

  test('shows an empty state for a period with no shares', () => {
    const cell = document.querySelector('[data-report="24h"] tbody td')!;
    assert.strictEqual(cell.textContent, 'No shares recorded in this period yet.');
  });

  test('renders titles, authors and URLs from the database as text, never as HTML or script', () => {
    assert.strictEqual(injectedImages(document).length, 0);
    assert.strictEqual(document.querySelectorAll('[onerror], [onmouseover]').length, 0);
    assert.strictEqual(window.__xss, undefined);

    const [payloadRow, scriptRow] = [...document.querySelectorAll('[data-report="8h"] tbody tr')];
    assert.strictEqual(payloadRow.querySelector('a')!.textContent, PAYLOAD);
    assert.strictEqual(payloadRow.querySelector('a')!.getAttribute('href'), `https://www.nytimes.com/${ATTRIBUTE_BREAKOUT}`);
    assert.strictEqual(payloadRow.querySelector('.report-authors')!.textContent, PAYLOAD);
    // A non-web URL gets no link, and a non-numeric count shows as 0
    assert.strictEqual(scriptRow.querySelector('a'), null);
    assert.strictEqual(scriptRow.querySelector('.report-shares')!.textContent, '0');
  });

  test('shows an error when the report fails, and Refresh loads it again', async () => {
    responses['/api/reports/popular-articles'] = new Error('Failed to build the popular articles report');
    await openReports();
    assert.match(document.getElementById('reports-list')!.textContent!, /Couldn't load reports/);

    responses['/api/reports/popular-articles'] = report;
    (document.getElementById('reports-refresh') as HTMLElement).click();
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.strictEqual(document.querySelectorAll('#reports-list .report-card').length, 4);
  });
});

describe('Settings tab', () => {
  async function settingsFor(stats: Record<string, unknown>) {
    const { window, document } = await loadDashboard({
      '/api/authors': [],
      '/api/categories': { sections: [], subsections: [] },
      '/api/stats': { env: 'development', did: 'did:plc:diitczh77g62vvea5fjbbz6b', serviceUrl: 'https://example.test', ...stats },
    });
    const handle = document.getElementById('set-handle')!;
    const result = { tag: handle.tagName, text: handle.textContent, href: handle.getAttribute('href'), target: handle.getAttribute('target'), rel: handle.getAttribute('rel') };
    const dbHostField = document.getElementById('set-db-host');
    window.close();
    return { ...result, dbHostField };
  }

  test('links the active handle to its Bluesky profile in a new tab', async () => {
    const handle = await settingsFor({ dryRun: false, bskyIdentifier: 'nyt-labeler-dev.bsky.social' });
    assert.deepStrictEqual(handle, {
      tag: 'A',
      text: 'nyt-labeler-dev.bsky.social',
      href: 'https://bsky.app/profile/nyt-labeler-dev.bsky.social',
      target: '_blank',
      rel: 'noopener noreferrer',
      dbHostField: null,
    });
  });

  test('shows no link in dry-run mode, or for a value that is not a handle', async () => {
    const dryRun = await settingsFor({ dryRun: true, bskyIdentifier: 'nyt-labeler-dev.bsky.social' });
    assert.strictEqual(dryRun.href, null);
    assert.strictEqual(dryRun.text, 'nyt-labeler-dev.bsky.social (Dry-Run)');

    const missing = await settingsFor({ dryRun: false });
    assert.strictEqual(missing.href, null);
    assert.strictEqual(missing.text, 'Unknown Handle');

    // Anything else is shown as plain text, never as a link or HTML
    for (const value of [PAYLOAD, ATTRIBUTE_BREAKOUT, 'javascript:alert(1)', 'user@example.com']) {
      const handle = await settingsFor({ dryRun: false, bskyIdentifier: value });
      assert.strictEqual(handle.href, null, `No link for ${value}`);
      assert.strictEqual(handle.text, value);
    }
  });

  test('no longer shows a database host field', async () => {
    const { dbHostField } = await settingsFor({ dryRun: false, bskyIdentifier: 'nyt-labeler-dev.bsky.social' });
    assert.strictEqual(dbHostField, null);
  });
});

describe('Database status badge', () => {
  let window: any;
  let document: Document;
  let send: (message: unknown) => void;

  before(async () => {
    ({ window, document, send } = await loadDashboard({
      '/api/authors': [],
      '/api/categories': { sections: [], subsections: [] },
      '/api/stats': { env: 'development', dryRun: false },
    }));
  });

  after(() => {
    window.close();
  });

  function badge() {
    const el = document.getElementById('db-status')!;
    return { text: el.textContent!.trim(), classes: el.className, dot: el.querySelector('.status-dot')!.className };
  }

  test('says it is checking until the first result arrives', () => {
    send({ type: 'init', stats: { ...BASE_STATS, database: null }, recentLabels: [] });
    assert.deepStrictEqual(badge(), { text: 'Checking…', classes: 'db-status-badge checking', dot: 'status-dot yellow' });
  });

  test('shows a connected database with its round trip', () => {
    send({ type: 'heartbeat', stats: { ...BASE_STATS, database: { connected: true, latencyMs: 12.4, checkedAt: '2026-09-26T23:00:00.000Z' } } });
    assert.deepStrictEqual(badge(), { text: 'Connected · 12 ms', classes: 'db-status-badge connected', dot: 'status-dot green' });
    assert.match(document.getElementById('db-status')!.title, /^Last checked /);
  });

  test('shows an unreachable database in red', () => {
    send({ type: 'heartbeat', stats: { ...BASE_STATS, database: { connected: false, latencyMs: null, checkedAt: '2026-09-26T23:00:30.000Z' } } });
    assert.deepStrictEqual(badge(), { text: 'Unreachable', classes: 'db-status-badge down', dot: 'status-dot red' });
  });

  test('never renders the latency as HTML', () => {
    send({ type: 'heartbeat', stats: { ...BASE_STATS, database: { connected: true, latencyMs: PAYLOAD, checkedAt: PAYLOAD } } });
    assert.strictEqual(badge().text, 'Connected');
    assert.strictEqual(injectedImages(document).length, 0);
    assert.strictEqual(document.getElementById('db-status')!.title, '');
  });
});

describe('Feed Listener switch', () => {
  let window: any;
  let document: Document;
  let send: (message: unknown) => void;
  let sent: unknown[];

  before(async () => {
    ({ window, document, send, sent } = await loadDashboard({
      '/api/authors': [],
      '/api/categories': { sections: [], subsections: [] },
      '/api/stats': { env: 'development', dryRun: false },
    }));
    send({ type: 'init', stats: { ...BASE_STATS, firehoseEnabled: false }, recentLabels: [] });
  });

  after(() => {
    window.close();
  });

  test('is on the Settings page, not the Overview page', () => {
    const toggle = document.getElementById('firehose-switch')!;
    assert.ok(document.getElementById('tab-settings')!.contains(toggle));
    assert.strictEqual(document.getElementById('tab-overview')!.querySelector('.switch'), null);
    assert.match(toggle.closest('.settings-card')!.textContent!, /Feed Listener/);
  });

  test('shows the saved setting from the server', () => {
    assert.strictEqual((document.getElementById('firehose-switch') as HTMLInputElement).checked, false);
  });

  test('sends the new setting to the server when switched', () => {
    const toggle = document.getElementById('firehose-switch') as HTMLInputElement;
    toggle.checked = true;
    toggle.dispatchEvent(new window.Event('change'));
    assert.deepStrictEqual(sent.at(-1), { type: 'toggle', enabled: true });
  });
});

describe('NYT API attribution', () => {
  let window: any;
  let document: Document;

  before(async () => {
    ({ window, document } = await loadDashboard({
      '/api/authors': [],
      '/api/categories': { sections: [], subsections: [] },
      '/api/stats': { env: 'development', dryRun: false },
    }));
  });

  after(() => {
    window.close();
  });

  test('shows the unaltered 150px logo, linking to developer.nytimes.com in a new tab', () => {
    const link = document.querySelector('.sidebar a.nyt-attribution')!;
    assert.strictEqual(link.getAttribute('href'), 'https://developer.nytimes.com');
    assert.strictEqual(link.getAttribute('target'), '_blank');
    assert.strictEqual(link.getAttribute('rel'), 'noopener noreferrer');
    const img = link.querySelector('img')!;
    assert.strictEqual(img.getAttribute('src'), 'images/poweredby_nytimes_150a.png');
    assert.deepStrictEqual([img.getAttribute('width'), img.getAttribute('height')], ['150', '30']);
    assert.strictEqual(img.getAttribute('alt'), 'Data provided by The New York Times');
  });

  test('sits just above the connection status section', () => {
    const link = document.querySelector('.nyt-attribution')!;
    assert.ok(link.nextElementSibling!.classList.contains('sidebar-footer'));
  });
});
