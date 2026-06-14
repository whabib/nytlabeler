import { test, describe, before, after } from 'node:test';
import assert from 'node:assert';
import { WebSocketServer, WebSocket } from 'ws';
import http from 'node:http';

// Override environment variables BEFORE importing the server module
process.env.PORT = '14100';
process.env.LABELER_PORT = '14101';
process.env.DRY_RUN = 'true';

// Dynamically import to ensure process.env is read correctly
const { server, wss, labelerProxyWss } = await import('../src/server.js');
const { setLabelerServer, setLocalMaxId } = await import('../src/labeler.js');
const { pool } = await import('../src/database.js');

describe('WebSocket Protocol Proxy', () => {
  let mockTargetWss: WebSocketServer;
  let mockTargetConnections: WebSocket[] = [];
  
  before(async () => {
    // 1. Mock the presence of labelerServer so proxy allows connection
    setLabelerServer({ mock: true });

    // 2. Start a mock target WebSocket server on LABELER_PORT (14101)
    mockTargetWss = new WebSocketServer({ port: 14101, host: '127.0.0.1' });
    mockTargetWss.on('connection', (ws) => {
      mockTargetConnections.push(ws);
    });

    // 3. Start the main proxy server on PORT (14100)
    await new Promise<void>((resolve) => {
      server.listen(14100, '127.0.0.1', () => {
        resolve();
      });
    });
  });

  after(async () => {
    // 1. Terminate any mock target connections
    for (const conn of mockTargetConnections) {
      try { 
        conn.terminate(); 
      } catch {}
    }

    // 2. Terminate any client connections on our proxy and dashboard servers
    for (const client of labelerProxyWss.clients) {
      try { 
        client.terminate(); 
      } catch {}
    }
    for (const client of wss.clients) {
      try { 
        client.terminate(); 
      } catch {}
    }

    // 3. Force-close all connections to the HTTP Express server
    if (typeof (server as any).closeAllConnections === 'function') {
      (server as any).closeAllConnections();
    }

    // 4. Close the servers
    await Promise.all([
      new Promise<void>((resolve) => {
        mockTargetWss.close(() => {
          resolve();
        });
      }),
      new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
      }),
    ]);
    
    // 5. End pg pool
    await pool.end();

    // 6. Reset labelerServer
    setLabelerServer(null);
  });

  test('should return 503 if labelerServer is not initialized', async () => {
    setLabelerServer(null);
    
    // Attempt to connect via raw HTTP request to see if we get a 503 upgrade rejection
    const options = {
      port: 14100,
      host: '127.0.0.1',
      headers: {
        'Connection': 'Upgrade',
        'Upgrade': 'websocket',
      },
      path: '/xrpc/com.atproto.label.subscribeLabels',
    };

    const req = http.request(options);
    
    const responsePromise = new Promise<http.IncomingMessage>((resolve) => {
      req.on('response', (res) => {
        resolve(res);
      });
      req.on('upgrade', (res) => {
        resolve(res); // Node http client might trigger upgrade event
      });
    });

    req.end();
    
    const res = await responsePromise;
    assert.strictEqual(res.statusCode, 503);
    res.destroy();
    
    // Restore labelerServer for subsequent tests
    setLabelerServer({ mock: true });
  });

  test('should successfully proxy bidirectional messages', async () => {
    const clientWs = new WebSocket('ws://127.0.0.1:14100/xrpc/com.atproto.label.subscribeLabels');
    
    // Wait for both client and target connections to be established
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Connection timeout')), 2000);
      clientWs.on('open', () => {
        // Wait a small moment to ensure the mock target also registers the connection
        const checkTarget = setInterval(() => {
          if (mockTargetConnections.length > 0) {
            clearInterval(checkTarget);
            clearTimeout(timeout);
            resolve();
          }
        }, 50);
      });
    });

    const targetWs = mockTargetConnections[0];
    assert.ok(targetWs);

    // Test client -> target message proxying
    const targetMsgPromise = new Promise<string>((resolve) => {
      targetWs.once('message', (data) => {
        resolve(data.toString());
      });
    });

    clientWs.send('hello-from-client');
    const receivedByTarget = await targetMsgPromise;
    assert.strictEqual(receivedByTarget, 'hello-from-client');

    // Test target -> client message proxying
    const clientMsgPromise = new Promise<string>((resolve) => {
      clientWs.once('message', (data) => {
        resolve(data.toString());
      });
    });

    targetWs.send('hello-from-target');
    const receivedByClient = await clientMsgPromise;
    assert.strictEqual(receivedByClient, 'hello-from-target');

    // Test connection termination propagation
    const targetClosePromise = new Promise<void>((resolve) => {
      targetWs.once('close', () => {
        resolve();
      });
    });

    clientWs.close();
    await targetClosePromise;
  });

  test('should successfully invoke ensureDatabaseSequence when connecting with a cursor', async () => {
    // 1. Setup mock pool and spy server
    const originalQuery = pool.query;
    pool.query = (async () => ({ rows: [] })) as any;

    let executeCalledCount = 0;
    let createLabelCalledCount = 0;

    const spyServer = {
      createLabel: async (label: any) => {
        createLabelCalledCount++;
      },
      db: {
        execute: async (query: any) => {
          if (query.sql.includes('MAX(id)')) {
            executeCalledCount++;
            return { rows: [{ id: 5 }] };
          }
          if (query.sql.includes('SELECT * FROM labels')) {
            return {
              rows: [
                {
                  id: 6,
                  src: 'did:plc:mock',
                  uri: query.args[0],
                  val: 'dummy-sequence-pad',
                  neg: 0,
                  cts: new Date().toISOString(),
                  exp: null,
                  sig: new Uint8Array([1, 2, 3])
                }
              ]
            };
          }
          return { rows: [] };
        }
      }
    };

    setLabelerServer(spyServer as any);
    setLocalMaxId(0); // Ensure the cursor (6) is larger than localMaxId to trigger padding

    // 2. Clear any existing connections on the mock target
    mockTargetConnections = [];

    // 3. Connect via WebSocket with a cursor parameter
    const clientWs = new WebSocket('ws://127.0.0.1:14100/xrpc/com.atproto.label.subscribeLabels?cursor=6');

    // 4. Wait for connection to open and proxy to target
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Connection with cursor timeout')), 2000);
      clientWs.on('open', () => {
        const checkTarget = setInterval(() => {
          if (mockTargetConnections.length > 0) {
            clearInterval(checkTarget);
            clearTimeout(timeout);
            resolve();
          }
        }, 50);
      });
    });

    const targetWs = mockTargetConnections[0];
    assert.ok(targetWs);

    // 5. Assert that ensureDatabaseSequence was called and executed padding
    assert.ok(executeCalledCount > 0, 'Should have queried sqlite for MAX(id) during padding');
    assert.ok(createLabelCalledCount > 0, 'Should have called createLabel to pad the sequence gaps');

    // 6. Test that proxy is still functional and proxies messages
    const targetMsgPromise = new Promise<string>((resolve) => {
      targetWs.once('message', (data) => {
        resolve(data.toString());
      });
    });

    clientWs.send('hello-cursor-test');
    const receivedByTarget = await targetMsgPromise;
    assert.strictEqual(receivedByTarget, 'hello-cursor-test');

    // 7. Cleanup connection
    const targetClosePromise = new Promise<void>((resolve) => {
      targetWs.once('close', () => {
        resolve();
      });
    });

    clientWs.close();
    await targetClosePromise;

    // 8. Restore original helpers & mock server
    pool.query = originalQuery;
    setLocalMaxId(0);
    setLabelerServer({ mock: true });
  });

  test('should ignore invalid cursor parameter and proxy successfully', async () => {
    // 1. Setup mock pool and spy server
    const originalQuery = pool.query;
    pool.query = (async () => ({ rows: [] })) as any;

    let executeCalledCount = 0;
    let createLabelCalledCount = 0;

    const spyServer = {
      createLabel: async (label: any) => {
        createLabelCalledCount++;
      },
      db: {
        execute: async (query: any) => {
          if (query.sql.includes('MAX(id)')) {
            executeCalledCount++;
            return { rows: [{ id: 5 }] };
          }
          return { rows: [] };
        }
      }
    };

    setLabelerServer(spyServer as any);
    setLocalMaxId(0);

    // 2. Clear any existing connections on the mock target
    mockTargetConnections = [];

    // 3. Connect via WebSocket with an invalid cursor parameter
    const clientWs = new WebSocket('ws://127.0.0.1:14100/xrpc/com.atproto.label.subscribeLabels?cursor=invalid123');

    // 4. Wait for connection to open and proxy to target
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Connection with invalid cursor timeout')), 2000);
      clientWs.on('open', () => {
        const checkTarget = setInterval(() => {
          if (mockTargetConnections.length > 0) {
            clearInterval(checkTarget);
            clearTimeout(timeout);
            resolve();
          }
        }, 50);
      });
    });

    const targetWs = mockTargetConnections[0];
    assert.ok(targetWs);

    // 5. Assert that ensureDatabaseSequence was NOT called
    assert.strictEqual(executeCalledCount, 0, 'Should NOT have queried sqlite for MAX(id) for invalid cursor');
    assert.strictEqual(createLabelCalledCount, 0, 'Should NOT have padded sequence for invalid cursor');

    // 6. Test that proxy is functional
    const targetMsgPromise = new Promise<string>((resolve) => {
      targetWs.once('message', (data) => {
        resolve(data.toString());
      });
    });

    clientWs.send('hello-invalid-cursor');
    const receivedByTarget = await targetMsgPromise;
    assert.strictEqual(receivedByTarget, 'hello-invalid-cursor');

    // 7. Cleanup connection
    const targetClosePromise = new Promise<void>((resolve) => {
      targetWs.once('close', () => {
        resolve();
      });
    });

    clientWs.close();
    await targetClosePromise;

    // 8. Restore original helpers & mock server
    pool.query = originalQuery;
    setLocalMaxId(0);
    setLabelerServer({ mock: true });
  });
});
