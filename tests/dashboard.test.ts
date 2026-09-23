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

describe('Dashboard escapes outside data', () => {
  let window: any;
  let document: Document;
  let socket: any;

  before(async () => {
    const html = fs.readFileSync(path.join(publicDir, 'index.html'), 'utf8');
    const script = fs.readFileSync(path.join(publicDir, 'app.js'), 'utf8');
    const dom = new JSDOM(html, {
      runScripts: 'outside-only',
      url: 'http://localhost:4100/',
      virtualConsole: new VirtualConsole(), // Silence jsdom's "not implemented" canvas messages
    });
    window = dom.window;
    document = window.document;

    const responses: Record<string, unknown> = {
      '/api/authors': [{ id: 1, name: PAYLOAD, total_articles: PAYLOAD }],
      '/api/categories': { sections: [PAYLOAD], subsections: [PAYLOAD] },
      '/api/stats': { env: 'development', dryRun: false, did: 'did:plc:x', serviceUrl: 'https://example.test' },
    };
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
    document.dispatchEvent(new window.Event('DOMContentLoaded'));
    await new Promise((resolve) => setTimeout(resolve, 20)); // Let the fetches resolve

    const stats = {
      postsProcessed: 1, nytLinksDetected: 1, labelsEmitted: 2, reconnectCount: 0,
      firehoseEnabled: true, firehoseConnected: true, throughput: 3, uptime: 10,
    };
    socket.onmessage({
      data: JSON.stringify({
        type: 'init',
        stats,
        recentLabels: [{
          id: 'a',
          uri: `at://did:plc:poster/app.bsky.feed.post/${ATTRIBUTE_BREAKOUT}`,
          authorDid: ATTRIBUTE_BREAKOUT,
          text: PAYLOAD,
          labels: ['us', PAYLOAD],
          title: PAYLOAD,
          timestamp: new Date().toISOString(),
        }],
      }),
    });
    socket.onmessage({ data: JSON.stringify({ type: 'heartbeat', stats: { ...stats, throughput: PAYLOAD } }) });
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

  test('keeps the Bluesky post link inside its href, URL-encoded', () => {
    const link = document.querySelector('#history-tbody a') as HTMLAnchorElement;
    assert.ok(link);
    assert.strictEqual(link.getAttributeNames().includes('onmouseover'), false);
    assert.ok(link.href.startsWith('https://bsky.app/profile/x%22%20onmouseover%3D%22'));
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
