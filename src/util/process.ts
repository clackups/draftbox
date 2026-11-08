import type { ChildProcess } from 'node:child_process';

// How a process started: its first output arrived, it finished
// successfully without output, or it failed (could not start, or ended
// with a non-zero status or a signal) before writing anything.
export type ProcessStart = 'output' | 'done' | 'failed';

export interface ProcessOutput {
  start: Promise<ProcessStart>;
  // The standard output. It ends normally only when the process exits
  // with status 0; any other end is an error, so that a client never
  // takes a truncated download for a complete one.
  body: ReadableStream<Uint8Array>;
}

// Streams the standard output of `child` (spawned with piped stdout and
// stderr) with backpressure. stderr is logged with `label`. Cancelling
// the body, e.g. when the client goes away, stops the process.
export function processOutput(child: ChildProcess, label: string): ProcessOutput {
  const stdout = child.stdout!;
  let started = false;
  let resolveStart: (s: ProcessStart) => void = () => undefined;
  const start = new Promise<ProcessStart>((resolve) => { resolveStart = resolve; });
  let spawnError: Error | null = null;
  let finish: (ok: boolean) => void = () => undefined;
  let cancelled = false;

  child.stderr?.on('data', (d: Buffer) => console.error(`[${label}] ${d.toString().trim()}`));
  child.on('error', (err) => {
    spawnError = err;
    console.error(`[${label}] ${err.message}`);
    // A process that could not be started may never emit 'close'.
    if (child.pid === undefined) finish(false);
  });

  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      let finished = false;
      finish = (ok) => {
        if (finished) return;
        finished = true;
        if (!started) resolveStart(ok ? 'done' : 'failed');
        if (cancelled) return;
        try {
          if (ok) controller.close();
          else controller.error(new Error(`${label} failed`));
        } catch {
          // Already cancelled.
        }
      };
      stdout.on('data', (chunk: Buffer) => {
        if (cancelled) return;
        if (!started) {
          started = true;
          resolveStart('output');
        }
        controller.enqueue(new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength));
        if ((controller.desiredSize ?? 1) <= 0) stdout.pause();
      });
      // 'close' follows the end of all output.
      child.on('close', (code, signal) => {
        const ok = code === 0 && !spawnError;
        if (!ok) console.error(`[${label}] failed: ${spawnError ? spawnError.message : signal ? `signal ${signal}` : `status ${code}`}`);
        finish(ok);
      });
    },
    pull() {
      stdout.resume();
    },
    cancel() {
      cancelled = true;
      stdout.destroy();
      if (child.exitCode === null && child.signalCode === null) child.kill();
    },
  });
  return { start, body };
}
