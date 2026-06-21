import type {
  WorkerHandle,
  WorkerTransport,
} from "../../../../../../../src/core/domains/ingest/pipeline/infra/worker-transport.js";

/**
 * In-memory transport for pool unit tests — no real threads/processes. Each
 * spawned handle records posted requests and lets the test resolve them via the
 * injected `respond` fn (called on the next microtask to mimic async delivery).
 */
export class FakeWorkerTransport<Req, Res> implements WorkerTransport<Req, Res> {
  readonly handles: FakeHandle<Req, Res>[] = [];
  constructor(private readonly respond: (req: Req, index: number) => Res | { error: string }) {}

  spawn(init: unknown): WorkerHandle<Req, Res> {
    const handle = new FakeHandle<Req, Res>(this.handles.length, init, this.respond);
    this.handles.push(handle);
    return handle;
  }
}

export class FakeHandle<Req, Res> implements WorkerHandle<Req, Res> {
  readonly posted: Req[] = [];
  private msgCb?: (m: Res | { error: string }) => void;
  private exitCb?: () => void;
  constructor(
    readonly index: number,
    readonly init: unknown,
    private readonly responder: (req: Req, index: number) => Res | { error: string },
  ) {}
  post(request: Req): void {
    this.posted.push(request);
    queueMicrotask(() => this.msgCb?.(this.responder(request, this.index)));
  }
  onMessage(cb: (m: Res | { error: string }) => void): void {
    this.msgCb = cb;
  }
  onError(): void {
    /* fakes never raise transport errors */
  }
  onExit(cb: () => void): void {
    this.exitCb = cb;
  }
  shutdown(): void {
    queueMicrotask(() => this.exitCb?.());
  }
  async terminate(): Promise<void> {
    this.exitCb?.();
  }
}
