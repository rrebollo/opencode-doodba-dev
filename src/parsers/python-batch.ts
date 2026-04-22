import { spawn } from "child_process";
import { resolve } from "path";

interface ParseRequest {
  file_path: string;
  content: string;
  module_name: string;
}

interface ParseResult {
  file_path: string;
  items: Record<string, unknown>[];
  error: string | null;
}

export class PythonBatchParser {
  private process: ReturnType<typeof spawn> | null = null;
  private queue: Array<{
    request: ParseRequest;
    resolve: (result: ParseResult) => void;
    reject: (error: Error) => void;
  }> = [];
  private buffer = "";
  private ready = false;

  constructor(private pythonPath = "python3") {}

  async start(): Promise<void> {
    if (this.process) return;

    const scriptPath = resolve(__dirname, "python_ast_extract_batch.py");
    this.process = spawn(this.pythonPath, [scriptPath], {
      stdio: ["pipe", "pipe", "pipe"],
    });

    this.process.stdout!.on("data", (data) => {
      this.buffer += data.toString();
      this.processLines();
    });

    this.process.stderr!.on("data", (data) => {
      console.error(`[PythonBatchParser] stderr: ${data}`);
    });

    this.process.on("error", (err) => {
      this.handleError(err);
    });

    this.process.on("exit", (code) => {
      if (code !== 0) {
        this.handleError(new Error(`Process exited with code ${code}`));
      }
    });

    this.ready = true;
  }

  async parse(request: ParseRequest): Promise<ParseResult> {
    if (!this.ready) {
      await this.start();
    }

    return new Promise((resolve, reject) => {
      this.queue.push({ request, resolve, reject });
      this.sendNextRequest();
    });
  }

  private sendNextRequest(): void {
    if (this.queue.length === 0 || !this.ready || !this.process) return;

    const { request } = this.queue[0];
    const line = JSON.stringify(request);
    this.process.stdin!.write(line + "\n", (err) => {
      if (err) {
        const item = this.queue.shift();
        if (item) item.reject(err);
        this.sendNextRequest();
      }
    });
  }

  private processLines(): void {
    const lines = this.buffer.split("\n");
    this.buffer = lines[lines.length - 1];

    for (let i = 0; i < lines.length - 1; i++) {
      const line = lines[i].trim();
      if (!line) continue;

      try {
        const result = JSON.parse(line) as ParseResult;
        const item = this.queue.shift();
        if (item) {
          item.resolve(result);
          this.sendNextRequest();
        }
      } catch {
        const item = this.queue.shift();
        if (item) {
          item.reject(new Error(`Failed to parse result: ${line}`));
          this.sendNextRequest();
        }
      }
    }
  }

  private handleError(err: Error): void {
    while (this.queue.length > 0) {
      const item = this.queue.shift();
      if (item) item.reject(err);
    }
    this.ready = false;
    this.process = null;
  }

  async stop(): Promise<void> {
    if (this.process) {
      this.process.stdin!.end();
      await new Promise<void>((resolve) => {
        this.process!.on("exit", () => resolve());
      });
    }
    this.ready = false;
    this.process = null;
  }
}
