/**
 * @fileoverview Orchestrator loop routes — plan-based autonomous execution.
 *
 * Endpoints:
 * - POST   /api/orchestrator/start       — Start orchestration with a goal
 * - POST   /api/orchestrator/approve      — Approve generated plan
 * - POST   /api/orchestrator/reject       — Reject plan with feedback
 * - POST   /api/orchestrator/pause        — Pause execution
 * - POST   /api/orchestrator/resume       — Resume from pause
 * - POST   /api/orchestrator/stop         — Stop and clean up
 * - GET    /api/orchestrator/status       — Get current status
 * - GET    /api/orchestrator/plan         — Get current plan
 * - POST   /api/orchestrator/phase/:id/skip  — Skip a phase
 * - POST   /api/orchestrator/phase/:id/retry — Retry a failed phase
 *
 * @module web/routes/orchestrator-routes
 */

import { FastifyInstance } from 'fastify';
import { ApiErrorCode, createErrorResponse, getErrorMessage } from '../../types.js';
import { OrchestratorStartSchema, OrchestratorRejectSchema } from '../schemas.js';
import { parseBody } from '../route-helpers.js';
import { SseEvent } from '../sse-events.js';
import type { EventPort, OrchestratorPort } from '../ports/index.js';

export function registerOrchestratorRoutes(app: FastifyInstance, ctx: OrchestratorPort & EventPort): void {
  // ═══════════════════════════════════════════════════════════════
  // Helpers
  // ═══════════════════════════════════════════════════════════════

  function getLoop() {
    const loop = ctx.orchestratorLoop;
    if (!loop) {
      throw Object.assign(new Error('Orchestrator not initialized'), {
        statusCode: 503,
        body: createErrorResponse(ApiErrorCode.INTERNAL_ERROR, 'Orchestrator not initialized'),
      });
    }
    return loop;
  }

  let forwardingLoop: import('../../orchestrator-loop.js').OrchestratorLoop | null = null;
  function setupEventForwarding(loop: import('../../orchestrator-loop.js').OrchestratorLoop) {
    if (forwardingLoop === loop) return; // Already attached to this loop instance
    forwardingLoop = loop;
    loop.on('stateChanged', (state, prevState) => {
      ctx.broadcast(SseEvent.OrchestratorStateChanged, { state, prevState });
    });
    loop.on('planProgress', (phase, detail) => {
      ctx.broadcast(SseEvent.OrchestratorPlanProgress, { phase, detail });
    });
    loop.on('planReady', (plan) => {
      ctx.broadcast(SseEvent.OrchestratorPlanReady, { plan });
    });
    loop.on('phaseStarted', (phase) => {
      ctx.broadcast(SseEvent.OrchestratorPhaseStarted, { phase });
    });
    loop.on('phaseCompleted', (phase) => {
      ctx.broadcast(SseEvent.OrchestratorPhaseCompleted, { phase });
    });
    loop.on('phaseFailed', (phase, reason) => {
      ctx.broadcast(SseEvent.OrchestratorPhaseFailed, { phase, reason });
    });
    loop.on('verificationResult', (phase, result) => {
      ctx.broadcast(SseEvent.OrchestratorVerification, { phaseId: phase.id, result });
    });
    loop.on('taskAssigned', (task, sessionId) => {
      ctx.broadcast(SseEvent.OrchestratorTaskAssigned, { task, sessionId });
    });
    loop.on('taskCompleted', (task) => {
      ctx.broadcast(SseEvent.OrchestratorTaskCompleted, { task });
    });
    loop.on('taskFailed', (task, error) => {
      ctx.broadcast(SseEvent.OrchestratorTaskFailed, { task, error });
    });
    loop.on('completed', (stats) => {
      ctx.broadcast(SseEvent.OrchestratorCompleted, { stats });
    });
    loop.on('error', (error) => {
      ctx.broadcast(SseEvent.OrchestratorError, { error: error.message });
    });
  }

  // ═══════════════════════════════════════════════════════════════
  // Start
  // ═══════════════════════════════════════════════════════════════

  app.post('/api/orchestrator/start', async (req) => {
    const { goal, config } = parseBody(OrchestratorStartSchema, req.body, 'Invalid request body');

    // Initialize loop if needed
    let loop = ctx.orchestratorLoop;
    if (!loop) {
      loop = ctx.initOrchestratorLoop();
      setupEventForwarding(loop);
    }

    // Check if already running
    if (loop.isRunning()) {
      return createErrorResponse(ApiErrorCode.INVALID_INPUT, 'Orchestrator is already running');
    }

    try {
      // Start is async — kicks off planning
      loop.start(goal).catch((err) => {
        console.error('[Orchestrator Route] Start failed:', getErrorMessage(err));
      });

      return {
        ok: true,
        state: loop.state,
        message: 'Orchestrator started — generating plan',
        config: config ?? null,
      };
    } catch (err) {
      return createErrorResponse(ApiErrorCode.INTERNAL_ERROR, getErrorMessage(err));
    }
  });

  // ═══════════════════════════════════════════════════════════════
  // Approve / Reject Plan
  // ═══════════════════════════════════════════════════════════════

  app.post('/api/orchestrator/approve', async () => {
    const loop = getLoop();

    try {
      loop.approve().catch((err) => {
        console.error('[Orchestrator Route] Approve failed:', getErrorMessage(err));
      });
      return { ok: true, state: loop.state };
    } catch (err) {
      return createErrorResponse(ApiErrorCode.INVALID_INPUT, getErrorMessage(err));
    }
  });

  app.post('/api/orchestrator/reject', async (req) => {
    const loop = getLoop();

    const { feedback } = parseBody(OrchestratorRejectSchema, req.body, 'Feedback is required');

    try {
      loop.reject(feedback).catch((err) => {
        console.error('[Orchestrator Route] Reject failed:', getErrorMessage(err));
      });
      return { ok: true, state: loop.state };
    } catch (err) {
      return createErrorResponse(ApiErrorCode.INVALID_INPUT, getErrorMessage(err));
    }
  });

  // ═══════════════════════════════════════════════════════════════
  // Pause / Resume / Stop
  // ═══════════════════════════════════════════════════════════════

  app.post('/api/orchestrator/pause', async () => {
    const loop = getLoop();

    try {
      loop.pause();
      return { ok: true, state: loop.state };
    } catch (err) {
      return createErrorResponse(ApiErrorCode.INVALID_INPUT, getErrorMessage(err));
    }
  });

  app.post('/api/orchestrator/resume', async () => {
    const loop = getLoop();

    try {
      loop.resume().catch((err) => {
        console.error('[Orchestrator Route] Resume failed:', getErrorMessage(err));
      });
      return { ok: true, state: loop.state };
    } catch (err) {
      return createErrorResponse(ApiErrorCode.INVALID_INPUT, getErrorMessage(err));
    }
  });

  app.post('/api/orchestrator/stop', async () => {
    const loop = getLoop();

    try {
      await loop.stop();
      return { ok: true, state: loop.state };
    } catch (err) {
      return createErrorResponse(ApiErrorCode.INTERNAL_ERROR, getErrorMessage(err));
    }
  });

  // ═══════════════════════════════════════════════════════════════
  // Status / Plan
  // ═══════════════════════════════════════════════════════════════

  app.get('/api/orchestrator/status', async () => {
    const loop = ctx.orchestratorLoop;
    if (!loop) {
      return { ok: true, state: 'idle', plan: null, stats: null };
    }

    return {
      ok: true,
      ...loop.getStatus(),
    };
  });

  app.get('/api/orchestrator/plan', async () => {
    const loop = ctx.orchestratorLoop;
    if (!loop) {
      return { ok: true, plan: null };
    }

    return {
      ok: true,
      plan: loop.getPlan(),
      currentPhase: loop.getCurrentPhase(),
    };
  });

  // ═══════════════════════════════════════════════════════════════
  // Phase Operations
  // ═══════════════════════════════════════════════════════════════

  app.post('/api/orchestrator/phase/:id/skip', async (req) => {
    const loop = getLoop();
    const { id } = req.params as { id: string };

    try {
      await loop.skipPhase(id);
      return { ok: true, state: loop.state };
    } catch (err) {
      return createErrorResponse(ApiErrorCode.INVALID_INPUT, getErrorMessage(err));
    }
  });

  app.post('/api/orchestrator/phase/:id/retry', async (req) => {
    const loop = getLoop();
    const { id } = req.params as { id: string };

    try {
      loop.retryPhase(id).catch((err) => {
        console.error('[Orchestrator Route] Retry failed:', getErrorMessage(err));
      });
      return { ok: true, state: loop.state };
    } catch (err) {
      return createErrorResponse(ApiErrorCode.INVALID_INPUT, getErrorMessage(err));
    }
  });
}
