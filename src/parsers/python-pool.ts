import { PythonBatchParser } from "./python-batch";

export interface ParseRequest {
  file_path: string;
  content: string;
  module_name: string;
}

export interface ParseResult {
  file_path: string;
  items: Record<string, unknown>[];
  error: string | null;
}

export class PythonParserPool {
  private workers: PythonBatchParser[] = [];
  private nextWorker = 0;
  private readonly numWorkers: number;

  constructor(numWorkers = 4) {
    this.numWorkers = numWorkers;
  }

  async start(): Promise<void> {
    this.workers = [];
    for (let i = 0; i < this.numWorkers; i++) {
      const worker = new PythonBatchParser();
      await worker.start();
      this.workers.push(worker);
    }
  }

  async parse(request: ParseRequest): Promise<ParseResult> {
    if (this.workers.length === 0) {
      throw new Error("Pool not started");
    }

    const worker = this.workers[this.nextWorker];
    this.nextWorker = (this.nextWorker + 1) % this.workers.length;
    return worker.parse(request);
  }

  async stop(): Promise<void> {
    await Promise.all(this.workers.map((w) => w.stop()));
    this.workers = [];
    this.nextWorker = 0;
  }

  getWorkerCount(): number {
    return this.workers.length;
  }
}
