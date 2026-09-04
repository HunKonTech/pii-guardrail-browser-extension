import { spawn } from 'node:child_process';

export interface ClipboardBackend {
  readText(): Promise<string>;
  writeText(value: string): Promise<void>;
}

interface Command {
  executable: string;
  args: string[];
}

function clipboardCommands(platform: NodeJS.Platform): { read: Command; write: Command } {
  if (platform === 'darwin') {
    return {
      read: { executable: 'pbpaste', args: [] },
      write: { executable: 'pbcopy', args: [] },
    };
  }
  if (platform === 'win32') {
    return {
      read: { executable: 'powershell.exe', args: ['-NoProfile', '-Command', 'Get-Clipboard -Raw'] },
      write: {
        executable: 'powershell.exe',
        args: ['-NoProfile', '-Command', '$input | Set-Clipboard'],
      },
    };
  }
  return {
    read: { executable: 'wl-paste', args: ['--no-newline'] },
    write: { executable: 'wl-copy', args: [] },
  };
}

function run(command: Command, input?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command.executable, command.args, { stdio: ['pipe', 'pipe', 'pipe'] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve(Buffer.concat(stdout).toString('utf8'));
      else reject(new Error(`${command.executable} exited with ${code}: ${Buffer.concat(stderr).toString('utf8').trim()}`));
    });
    if (input !== undefined) child.stdin.end(input, 'utf8');
    else child.stdin.end();
  });
}

export function createSystemClipboardBackend(platform = process.platform): ClipboardBackend {
  const commands = clipboardCommands(platform);
  return {
    readText: () => run(commands.read),
    writeText: async (value) => {
      await run(commands.write, value);
    },
  };
}

export class ClipboardGuard {
  constructor(
    private readonly backend: ClipboardBackend = createSystemClipboardBackend(),
    private readonly onRestoreFailure: (message: string) => void = console.warn,
  ) {}

  async withText<T>(value: string, action: () => Promise<T>): Promise<T> {
    return this.preserve(async () => {
      await this.backend.writeText(value);
      return await action();
    });
  }

  async preserve<T>(action: () => Promise<T>): Promise<T> {
    const previous = await this.backend.readText();
    try {
      return await action();
    } finally {
      try {
        await this.backend.writeText(previous);
      } catch (error) {
        const cause = error instanceof Error ? error.message : String(error);
        this.onRestoreFailure(`Could not restore the previous clipboard text: ${cause}`);
      }
    }
  }

  readText(): Promise<string> {
    return this.backend.readText();
  }
}
