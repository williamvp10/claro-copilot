import { TransientReadError } from '@claro/contracts';
import { withinDeadline } from './deadline.js';
import type { Observe } from './generation.js';

const MAX_ROUNDS = 3;

type ReadRequest<T> = {
  tool: string;
  agent: string;
  step: string;
  purpose: string;
  selector?: string;
  read: () => Promise<T>;
  unavailable?: (result: T) => boolean;
};

export class TurnReads {
  private round = 0;
  private active = false;
  private pending: ((round: number) => Promise<void>)[] = [];
  private cached = new Map<string, Promise<unknown>>();

  constructor(private readonly deadline: number, private readonly observe: Observe) {}

  read<T>(request: ReadRequest<T>): Promise<T | undefined> {
    // The cache belongs to one turn, hence one case scope and one config revision.
    const key = JSON.stringify([request.tool, request.purpose, request.selector]);
    const cached = this.cached.get(key);
    if (cached) return cached as Promise<T | undefined>;
    const result = new Promise<T | undefined>(resolve => this.enqueue(request, 1, resolve));
    this.cached.set(key, result);
    return result;
  }

  private enqueue<T>(request: ReadRequest<T>, attempt: number, resolve: (result: T | undefined) => void) {
    this.pending.push(async round => {
      const started = Date.now();
      let status: string;
      let result: T | undefined;
      let retry = false;
      if (round > MAX_ROUNDS || started >= this.deadline) {
        status = round > MAX_ROUNDS ? 'round_limit' : 'deadline';
      } else {
        try {
          result = await withinDeadline<T | undefined>(this.deadline, request.read, undefined);
          status = result === undefined ? 'timeout' : request.unavailable?.(result) ? 'error' : 'success';
        } catch (error) {
          status = 'error';
          retry = error instanceof TransientReadError && attempt === 1 && round < MAX_ROUNDS && Date.now() < this.deadline;
        }
      }
      this.observe({ name: `tool.${request.tool}`, started, ended: Date.now(), metadata: {
        tool_id: request.tool, agent_id: request.agent, step_id: request.step, purpose: request.purpose,
        round: Math.min(round, MAX_ROUNDS), status, attempt, retry_scheduled: retry ? 'yes' : 'no'
      } });
      if (retry) this.enqueue(request, attempt + 1, resolve);
      else resolve(result);
    });
    this.schedule();
  }

  private schedule() {
    if (this.active || !this.pending.length) return;
    this.active = true;
    // Start after sibling subgraphs have submitted their independent reads.
    setTimeout(() => {
      const batch = this.pending.splice(0);
      const round = ++this.round;
      void Promise.all(batch.map(run => run(round))).finally(() => {
        this.active = false;
        this.schedule();
      });
    }, 0);
  }
}
