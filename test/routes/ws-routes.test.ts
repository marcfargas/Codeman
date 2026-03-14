/**
 * @fileoverview Tests for WebSocket terminal I/O route.
 *
 * Unlike other route tests that use app.inject(), WebSocket testing requires
 * a real listening server since inject() doesn't support upgrade requests.
 * Uses the `ws` package (transitive dep of @fastify/websocket) as the client.
 *
 * Port: 3170 (ws-routes tests)
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import fastifyWebsocket from '@fastify/websocket';
import WebSocket from 'ws';
import { createMockRouteContext, type MockRouteContext } from '../mocks/index.js';
import { registerWsRoutes } from '../../src/web/routes/ws-routes.js';

const PORT = 3170;

/** Helper: open a WebSocket connection and wait for it to reach OPEN state. */
function connectWs(path: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}${path}`);
    ws.on('open', () => resolve(ws));
    ws.on('error', reject);
  });
}

/** Helper: wait for the next WS message, parsed as JSON. */
function nextMessage(ws: WebSocket, timeoutMs = 2000): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('WS message timeout')), timeoutMs);
    ws.once('message', (raw) => {
      clearTimeout(timer);
      resolve(JSON.parse(String(raw)));
    });
  });
}

/** Helper: wait for WS close event and return { code, reason }. */
function waitForClose(ws: WebSocket, timeoutMs = 2000): Promise<{ code: number; reason: string }> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('WS close timeout')), timeoutMs);
    ws.on('close', (code, reason) => {
      clearTimeout(timer);
      resolve({ code, reason: reason.toString() });
    });
  });
}

describe('ws-routes', () => {
  let app: FastifyInstance;
  let ctx: MockRouteContext;

  beforeEach(async () => {
    app = Fastify({ logger: false });
    await app.register(fastifyWebsocket);

    ctx = createMockRouteContext({ sessionId: 'ws-test-session' });
    registerWsRoutes(app, ctx as never);

    await app.listen({ port: PORT, host: '127.0.0.1' });
  });

  afterEach(async () => {
    await app.close();
  });

  // ========== Session not found ==========

  describe('session not found', () => {
    it('closes with 4004 when session does not exist', async () => {
      const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws/sessions/nonexistent/terminal`);
      const { code, reason } = await waitForClose(ws);
      expect(code).toBe(4004);
      expect(reason).toBe('Session not found');
    });
  });

  // ========== Terminal output ==========

  describe('terminal output', () => {
    it('receives terminal output via WS with DEC 2026 sync markers', async () => {
      const ws = await connectWs('/ws/sessions/ws-test-session/terminal');
      try {
        const session = ctx._session;

        // Emit terminal data from mock session
        session.emit('terminal', 'hello world');

        // Wait for the micro-batched message (8ms batch interval + margin)
        const msg = (await nextMessage(ws)) as { t: string; d: string };
        expect(msg.t).toBe('o');
        // Should contain DEC 2026 sync markers wrapping the data
        expect(msg.d).toContain('hello world');
        expect(msg.d).toMatch(/^\x1b\[\?2026h/); // starts with DEC 2026 start
        expect(msg.d).toMatch(/\x1b\[\?2026l$/); // ends with DEC 2026 end
      } finally {
        ws.close();
      }
    });

    it('sends clearTerminal event as {"t":"c"}', async () => {
      const ws = await connectWs('/ws/sessions/ws-test-session/terminal');
      try {
        ctx._session.emit('clearTerminal');

        const msg = (await nextMessage(ws)) as { t: string };
        expect(msg.t).toBe('c');
      } finally {
        ws.close();
      }
    });

    it('sends needsRefresh event as {"t":"r"}', async () => {
      const ws = await connectWs('/ws/sessions/ws-test-session/terminal');
      try {
        ctx._session.emit('needsRefresh');

        const msg = (await nextMessage(ws)) as { t: string };
        expect(msg.t).toBe('r');
      } finally {
        ws.close();
      }
    });
  });

  // ========== Client input ==========

  describe('client input', () => {
    it('forwards input messages to session.write()', async () => {
      const ws = await connectWs('/ws/sessions/ws-test-session/terminal');
      try {
        const session = ctx._session;
        session.writeBuffer = [];

        ws.send(JSON.stringify({ t: 'i', d: 'ls -la\r' }));

        // Give the message handler time to process
        await vi.waitFor(() => {
          expect(session.writeBuffer).toContain('ls -la\r');
        });
      } finally {
        ws.close();
      }
    });

    it('ignores input exceeding MAX_INPUT_LENGTH', async () => {
      const ws = await connectWs('/ws/sessions/ws-test-session/terminal');
      try {
        const session = ctx._session;
        session.writeBuffer = [];

        // MAX_INPUT_LENGTH is 64KB
        const hugeInput = 'x'.repeat(65 * 1024);
        ws.send(JSON.stringify({ t: 'i', d: hugeInput }));

        // Send a valid message after to confirm the connection still works
        ws.send(JSON.stringify({ t: 'i', d: 'ok' }));

        await vi.waitFor(() => {
          expect(session.writeBuffer).toContain('ok');
        });

        // The oversized input should not have been written
        expect(session.writeBuffer).not.toContain(hugeInput);
      } finally {
        ws.close();
      }
    });

    it('ignores malformed JSON messages', async () => {
      const ws = await connectWs('/ws/sessions/ws-test-session/terminal');
      try {
        const session = ctx._session;
        session.writeBuffer = [];

        ws.send('not-json{{{');

        // Send valid input to verify connection still alive
        ws.send(JSON.stringify({ t: 'i', d: 'after-bad' }));

        await vi.waitFor(() => {
          expect(session.writeBuffer).toContain('after-bad');
        });

        // Only 'after-bad' should be in the buffer
        expect(session.writeBuffer).toHaveLength(1);
      } finally {
        ws.close();
      }
    });
  });

  // ========== Resize validation ==========

  describe('resize validation', () => {
    it('accepts valid resize within bounds', async () => {
      const ws = await connectWs('/ws/sessions/ws-test-session/terminal');
      try {
        const session = ctx._session;

        ws.send(JSON.stringify({ t: 'z', c: 120, r: 40 }));

        await vi.waitFor(() => {
          expect(session.resize).toHaveBeenCalledWith(120, 40);
        });
      } finally {
        ws.close();
      }
    });

    it('accepts resize at minimum bounds (1x1)', async () => {
      const ws = await connectWs('/ws/sessions/ws-test-session/terminal');
      try {
        const session = ctx._session;

        ws.send(JSON.stringify({ t: 'z', c: 1, r: 1 }));

        await vi.waitFor(() => {
          expect(session.resize).toHaveBeenCalledWith(1, 1);
        });
      } finally {
        ws.close();
      }
    });

    it('accepts resize at maximum bounds (500x200)', async () => {
      const ws = await connectWs('/ws/sessions/ws-test-session/terminal');
      try {
        const session = ctx._session;

        ws.send(JSON.stringify({ t: 'z', c: 500, r: 200 }));

        await vi.waitFor(() => {
          expect(session.resize).toHaveBeenCalledWith(500, 200);
        });
      } finally {
        ws.close();
      }
    });

    it('rejects resize with cols out of bounds (0 cols)', async () => {
      const ws = await connectWs('/ws/sessions/ws-test-session/terminal');
      try {
        const session = ctx._session;

        ws.send(JSON.stringify({ t: 'z', c: 0, r: 40 }));

        // Send a valid message to confirm processing continues
        ws.send(JSON.stringify({ t: 'i', d: 'sentinel' }));
        await vi.waitFor(() => {
          expect(session.writeBuffer).toContain('sentinel');
        });

        expect(session.resize).not.toHaveBeenCalled();
      } finally {
        ws.close();
      }
    });

    it('rejects resize with cols exceeding 500', async () => {
      const ws = await connectWs('/ws/sessions/ws-test-session/terminal');
      try {
        const session = ctx._session;

        ws.send(JSON.stringify({ t: 'z', c: 501, r: 40 }));

        ws.send(JSON.stringify({ t: 'i', d: 'sentinel' }));
        await vi.waitFor(() => {
          expect(session.writeBuffer).toContain('sentinel');
        });

        expect(session.resize).not.toHaveBeenCalled();
      } finally {
        ws.close();
      }
    });

    it('rejects resize with rows exceeding 200', async () => {
      const ws = await connectWs('/ws/sessions/ws-test-session/terminal');
      try {
        const session = ctx._session;

        ws.send(JSON.stringify({ t: 'z', c: 80, r: 201 }));

        ws.send(JSON.stringify({ t: 'i', d: 'sentinel' }));
        await vi.waitFor(() => {
          expect(session.writeBuffer).toContain('sentinel');
        });

        expect(session.resize).not.toHaveBeenCalled();
      } finally {
        ws.close();
      }
    });

    it('rejects resize with non-integer values', async () => {
      const ws = await connectWs('/ws/sessions/ws-test-session/terminal');
      try {
        const session = ctx._session;

        ws.send(JSON.stringify({ t: 'z', c: 80.5, r: 24 }));

        ws.send(JSON.stringify({ t: 'i', d: 'sentinel' }));
        await vi.waitFor(() => {
          expect(session.writeBuffer).toContain('sentinel');
        });

        expect(session.resize).not.toHaveBeenCalled();
      } finally {
        ws.close();
      }
    });

    it('rejects resize with negative values', async () => {
      const ws = await connectWs('/ws/sessions/ws-test-session/terminal');
      try {
        const session = ctx._session;

        ws.send(JSON.stringify({ t: 'z', c: -1, r: 24 }));

        ws.send(JSON.stringify({ t: 'i', d: 'sentinel' }));
        await vi.waitFor(() => {
          expect(session.writeBuffer).toContain('sentinel');
        });

        expect(session.resize).not.toHaveBeenCalled();
      } finally {
        ws.close();
      }
    });
  });

  // ========== Connection cleanup ==========

  describe('connection cleanup', () => {
    it('removes session event listeners on close', async () => {
      const session = ctx._session;
      const listenersBefore = session.listenerCount('terminal');

      const ws = await connectWs('/ws/sessions/ws-test-session/terminal');

      // A listener was added for 'terminal'
      expect(session.listenerCount('terminal')).toBe(listenersBefore + 1);
      expect(session.listenerCount('clearTerminal')).toBeGreaterThanOrEqual(1);
      expect(session.listenerCount('needsRefresh')).toBeGreaterThanOrEqual(1);

      // Close the WS connection
      ws.close();
      await waitForClose(ws);

      // Give the server-side close handler time to run
      await new Promise((resolve) => setTimeout(resolve, 50));

      // Listeners should be cleaned up
      expect(session.listenerCount('terminal')).toBe(listenersBefore);
      expect(session.listenerCount('clearTerminal')).toBe(0);
      expect(session.listenerCount('needsRefresh')).toBe(0);
    });
  });
});
