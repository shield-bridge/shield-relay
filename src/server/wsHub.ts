import { WebSocket } from 'ws';
import type { Store } from '../store/index.js';
import { toWireStatus } from '../core/jobs.js';
import { checkJobSecret } from './auth.js';
import { frame, type StatusFrame } from './statusFrames.js';

interface SubscribeMessage {
  action?: string;
  jobId?: string;
  jobSecret?: string;
}

/**
 * In-process WebSocket fan-out. Map<jobId, Set<ws>>; persist-then-publish (the
 * processor writes the durable status before calling publish). On (re)subscribe
 * the current durable status is replayed; unknown/expired jobIds get `not_found`
 * (the client's form soft-locks forever without it).
 */
export class WsHub {
  private readonly subs = new Map<string, Set<WebSocket>>();

  constructor(
    private readonly store: Store,
    private readonly requireJobSecret: boolean,
  ) {}

  handleConnection(ws: WebSocket): void {
    ws.on('message', (raw: Buffer | ArrayBuffer | Buffer[]) => {
      let msg: SubscribeMessage;
      try {
        msg = JSON.parse(raw.toString()) as SubscribeMessage;
      } catch {
        return;
      }
      if (msg.action === 'subscribe' && msg.jobId) {
        this.subscribe(msg.jobId, ws, msg.jobSecret);
      }
    });
    ws.on('close', () => this.remove(ws));
    ws.on('error', () => this.remove(ws));
  }

  private subscribe(jobId: string, ws: WebSocket, jobSecret?: string): void {
    const job = this.store.getJob(jobId);
    const check = checkJobSecret(jobSecret, job?.jobSecretHash, this.requireJobSecret);
    if (check !== 'ok') {
      // Unauthorized — reveal nothing beyond not_found.
      this.send(ws, frame(jobId, 'not_found', { error: 'unauthorized' }));
      return;
    }
    if (!job) {
      this.send(ws, frame(jobId, 'not_found'));
      return;
    }

    let set = this.subs.get(jobId);
    if (!set) {
      set = new Set();
      this.subs.set(jobId, set);
    }
    set.add(ws);

    // Replay the current durable status (skip the pre-payment `info_generated`).
    const wire = toWireStatus(job.status);
    if (wire) {
      this.send(
        ws,
        frame(jobId, wire, {
          opHash: job.userTxHash ?? undefined,
          error: job.errorMessage ?? undefined,
        }),
      );
    }
  }

  /** Fan a frame out to all live subscribers of its job. */
  publish(f: StatusFrame): void {
    const set = this.subs.get(f.jobId);
    if (!set) return;
    for (const ws of set) this.send(ws, f);
  }

  private send(ws: WebSocket, f: StatusFrame): void {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(f));
  }

  private remove(ws: WebSocket): void {
    for (const [jobId, set] of this.subs) {
      set.delete(ws);
      if (set.size === 0) this.subs.delete(jobId);
    }
  }
}
