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
  window.fetch = async (url: string) => ({ ok: true, json: async () => responses[url] });
  window.WebSocket = class {
    static OPEN = 1;
    readyState = 0;
    onopen?: () => void;
    onmessage?: (event: { data: string }) => void;
    onclose?: () => void;
    constructor() {
      socket = this;
    }
    send() {}
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
  return { window, document: window.document as Document, send };
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
    assert.strictEqual(document.querySelectorAll('img').length, 0, 'No <img> from the payload may be created');
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
    assert.strictEqual(document.querySelectorAll('img, [onerror], [onmouseover]').length, 0);
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
