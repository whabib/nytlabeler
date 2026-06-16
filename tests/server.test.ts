import { test, describe, before, after } from 'node:test';
import assert from 'node:assert';
import { WebSocketServer, WebSocket } from 'ws';
import http from 'node:http';

// Override environment variables BEFORE importing the server module
process.env.PORT = '14100';
process.env.LABELER_PORT = '14101';
process.env.DRY_RUN = 'true';

// Log unhandled errors for diagnostics but do NOT call process.exit(1) — doing so overrides the
// Node.js test runner's own uncaughtException/unhandledRejection handlers, causing it to exit
// abruptly while the IPC channel has an in-flight write, corrupting the message and producing:
//   "Error: Unable to deserialize cloned data due to invalid or unsupported version"
process.on('uncaughtException', (err) => {
  console.error('🔥 UNCAUGHT EXCEPTION IN SERVER TEST WORKER:', err);
});

process.on('unhandledRejection', (reason) => {
  console.error('🔥 UNHANDLED REJECTION IN SERVER TEST WORKER:', reason);
});

// Helper to convert any error into a simple, clean, serializable Error
function cleanErrors<T extends (...args: any[]) => any>(fn: T): T {
  return (async (...args: any[]) => {
    try {
      return await fn(...args);
    } catch (err: any) {
      const cleanErr = new Error(err?.message || String(err));
      cleanErr.stack = err?.stack;
      throw cleanErr;
    }
  }) as T;
}

// Dynamically import to ensure process.env is read correctly
const { server, wss, labelerProxyWss } = await import('../src/server.js');
const { setLabelerServer, setLocalMaxId } = await import('../src/labeler.js');
const { pool } = await import('../src/database.js');

describe('WebSocket Protocol Proxy', () => {
  let mockTargetWss: WebSocketServer;
  const mockTargetConnections: WebSocket[] = [];
  const activeClientWebSockets: WebSocket[] = [];
  const activeSockets = new Set<any>();

  function clearMockTargetConnections() {
    for (const conn of mockTargetConnections) {
      try {
        conn.terminate();
      } catch {}
    }
    mockTargetConnections.length = 0;
  }

  function createClientWebSocket(url: string): WebSocket {
    const ws = new WebSocket(url);
    activeClientWebSockets.push(ws);
    ws.on('error', () => {}); // Prevent unhandled socket errors from crashing process
    return ws;
  }

  // Helper to wait for client connection to propagate through the proxy to the target
  function waitForConnection(clientWs: WebSocket, timeoutMs = 2000): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      let completed = false;
      
      const cleanup = () => {
        completed = true;
        clearTimeout(timeout);
        clearInterval(interval);
        clientWs.off('open', onOpen);
        clientWs.off('error', onError);
        clientWs.off('close', onClose);
      };

      const timeout = setTimeout(() => {
        if (completed) return;
        cleanup();
        reject(new Error('Connection timeout waiting for mock target'));
      }, timeoutMs);

      let interval: NodeJS.Timeout;

      const onOpen = () => {
        if (completed) return;
        interval = setInterval(() => {
          if (completed) return;
          if (mockTargetConnections.length > 0) {
            cleanup();
            resolve();
          }
        }, 20);
      };

      const onError = (err: any) => {
        if (completed) return;
        cleanup();
        reject(new Error(`WebSocket connection error: ${err?.message || err}`));
      };

      const onClose = (code: any, reason: any) => {
        if (completed) return;
        cleanup();
        reject(new Error(`WebSocket connection closed prematurely (Code: ${code}, Reason: ${reason})`));
      };

      clientWs.on('open', onOpen);
      clientWs.on('error', onError);
      clientWs.on('close', onClose);
    });
  }
  
  before(cleanErrors(async () => {
    // 1. Mock the presence of labelerServer so proxy allows connection
    setLabelerServer({ mock: true });

    // 2. Start a mock target WebSocket server on LABELER_PORT (14101)
    mockTargetWss = new WebSocketServer({ port: 14101, host: '127.0.0.1' });
    mockTargetWss.on('error', (err) => {
      console.error('⚠️ mockTargetWss error:', err);
    });
    mockTargetWss.on('connection', (ws) => {
      mockTargetConnections.push(ws);
      ws.on('error', () => {}); // Prevent unhandled socket errors from crashing process during teardown
    });

    // Register error listeners on proxy servers to catch socket problems early
    wss.on('error', (err) => {
      console.error('⚠️ wss error:', err);
    });
    labelerProxyWss.on('error', (err) => {
      console.error('⚠️ labelerProxyWss error:', err);
    });

    // 3. Start the main proxy server on PORT (14100) and track client sockets for clean destruction
    server.on('connection', (socket) => {
      activeSockets.add(socket);
      socket.on('close', () => {
        activeSockets.delete(socket);
      });
    });

    await new Promise<void>((resolve, reject) => {
      server.on('error', (err) => {
        reject(err);
      });
      server.listen(14100, '127.0.0.1', () => {
        resolve();
      });
    });
  }));

  after(cleanErrors(async () => {
    // 0. Force terminate any client WebSockets created during tests to prevent hanging handles
    for (const ws of activeClientWebSockets) {
      try {
        ws.terminate();
      } catch {}
    }
    activeClientWebSockets.length = 0;

    // 1. Terminate any mock target connections
    clearMockTargetConnections();

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

    // 3. Force-close all tracked TCP sockets and Express connections to guarantee clean exit
    for (const socket of activeSockets) {
      try {
        socket.destroy();
      } catch {}
    }
    activeSockets.clear();

    if (typeof (server as any).closeAllConnections === 'function') {
      try {
        (server as any).closeAllConnections();
      } catch {}
    }

    // 4. Close the servers with a strict 3-second timeout protection to avoid process stalling
    const closePromise = Promise.all([
      new Promise<void>((resolve) => {
        if (!mockTargetWss) return resolve();
        mockTargetWss.close(() => {
          resolve();
        });
      }),
      new Promise<void>((resolve) => {
        if (!server) return resolve();
        server.close(() => {
          resolve();
        });
      }),
      new Promise<void>((resolve) => {
        if (!wss) return resolve();
        wss.close(() => {
          resolve();
        });
      }),
      new Promise<void>((resolve) => {
        if (!labelerProxyWss) return resolve();
        labelerProxyWss.close(() => {
          resolve();
        });
      }),
    ]);

    await Promise.race([
      closePromise,
      new Promise<void>((resolve) => setTimeout(resolve, 3000))
    ]);
    
    // 5. End pg pool
    await pool.end();

    // 6. Reset labelerServer
    setLabelerServer(null);
  }));

  test('should return 503 if labelerServer is not initialized', cleanErrors(async () => {
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
    
    const responsePromise = new Promise<http.IncomingMessage>((resolve, reject) => {
      req.on('error', reject);
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
  }));

  test('should successfully proxy bidirectional messages', cleanErrors(async () => {
    clearMockTargetConnections();
    const clientWs = createClientWebSocket('ws://127.0.0.1:14100/xrpc/com.atproto.label.subscribeLabels');
    
    // Wait for both client and target connections to be established
    await waitForConnection(clientWs);

    const targetWs = mockTargetConnections[0];
    assert.ok(targetWs);

    // Test client -> target message proxying
    const targetMsgPromise = new Promise<string>((resolve, reject) => {
      targetWs.once('error', reject);
      targetWs.once('message', (data) => {
        resolve(data.toString());
      });
    });

    clientWs.send('hello-from-client');
    const receivedByTarget = await targetMsgPromise;
    assert.strictEqual(receivedByTarget, 'hello-from-client');

    // Test target -> client message proxying
    const clientMsgPromise = new Promise<string>((resolve, reject) => {
      clientWs.once('error', reject);
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
  }));

  test('should successfully invoke ensureDatabaseSequence when connecting with a cursor', cleanErrors(async () => {
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
    clearMockTargetConnections();

    // 3. Connect via WebSocket with a cursor parameter
    const clientWs = createClientWebSocket('ws://127.0.0.1:14100/xrpc/com.atproto.label.subscribeLabels?cursor=6');

    // 4. Wait for connection to open and proxy to target
    await waitForConnection(clientWs);

    const targetWs = mockTargetConnections[0];
    assert.ok(targetWs);

    // 5. Assert that ensureDatabaseSequence was called and executed padding
    assert.ok(executeCalledCount > 0, 'Should have queried sqlite for MAX(id) during padding');
    assert.ok(createLabelCalledCount > 0, 'Should have called createLabel to pad the sequence gaps');

    // 6. Test that proxy is still functional and proxies messages
    const targetMsgPromise = new Promise<string>((resolve, reject) => {
      targetWs.once('error', reject);
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
  }));

  test('should ignore invalid cursor parameter and proxy successfully', cleanErrors(async () => {
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
    clearMockTargetConnections();

    // 3. Connect via WebSocket with an invalid cursor parameter
    const clientWs = createClientWebSocket('ws://127.0.0.1:14100/xrpc/com.atproto.label.subscribeLabels?cursor=invalid123');

    // 4. Wait for connection to open and proxy to target
    await waitForConnection(clientWs);

    const targetWs = mockTargetConnections[0];
    assert.ok(targetWs);

    // 5. Assert that ensureDatabaseSequence was NOT called
    assert.strictEqual(executeCalledCount, 0, 'Should NOT have queried sqlite for MAX(id) for invalid cursor');
    assert.strictEqual(createLabelCalledCount, 0, 'Should NOT have padded sequence for invalid cursor');

    // 6. Test that proxy is functional
    const targetMsgPromise = new Promise<string>((resolve, reject) => {
      targetWs.once('error', reject);
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
  }));
});
