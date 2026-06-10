import type { FastifyInstance, FastifyReply } from 'fastify';
import type { Processor } from '../runtime/processor.js';
import type { ContractParams } from '../core/types.js';
import { HttpError } from './errors.js';

interface SubmitPaymentBody {
  jobId: string;
  jobSecret?: string;
  paymentTransaction: ContractParams;
}
interface SubmitUserTxBody {
  jobId: string;
  jobSecret?: string;
  userTransaction: ContractParams | ContractParams[];
}

/** The three `shield-relay/1` REST endpoints. Responses use `{ data }` so the
 *  existing client's `json.data ?? json` parsing works unchanged. */
export function registerRoutes(app: FastifyInstance, processor: Processor): void {
  app.post('/get-worker-info', async (req, reply) => {
    try {
      const txCount = (req.body as { txCount?: unknown } | undefined)?.txCount;
      return reply.send({ success: true, data: processor.getWorkerInfo(txCount) });
    } catch (e) {
      return sendError(reply, e);
    }
  });

  app.post('/submit-payment', async (req, reply) => {
    try {
      const b = (req.body ?? {}) as SubmitPaymentBody;
      const r = processor.submitPayment(b.jobId, b.jobSecret, b.paymentTransaction);
      return reply.code(202).send(r);
    } catch (e) {
      return sendError(reply, e);
    }
  });

  app.post('/submit-user-transaction', async (req, reply) => {
    try {
      const b = (req.body ?? {}) as SubmitUserTxBody;
      const r = processor.submitUserTransaction(b.jobId, b.jobSecret, b.userTransaction);
      return reply.send({ success: true, data: r });
    } catch (e) {
      return sendError(reply, e);
    }
  });
}

function sendError(reply: FastifyReply, e: unknown): FastifyReply {
  if (e instanceof HttpError) {
    return reply.code(e.statusCode).send({ error: e.message, code: e.code });
  }
  return reply.code(500).send({ error: 'Internal server error' });
}
