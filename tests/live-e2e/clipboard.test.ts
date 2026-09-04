import { ClipboardGuard, type ClipboardBackend } from '../../e2e/live/clipboard';

function backend(initial = 'before'): ClipboardBackend & { value: string } {
  return {
    value: initial,
    async readText() {
      return this.value;
    },
    async writeText(value: string) {
      this.value = value;
    },
  };
}

describe('system clipboard guard', () => {
  test('restores the previous text after success', async () => {
    const clipboard = backend();
    const guard = new ClipboardGuard(clipboard);

    await guard.withText('synthetic@example.invalid', async () => {
      expect(clipboard.value).toBe('synthetic@example.invalid');
    });

    expect(clipboard.value).toBe('before');
  });

  test('restores the previous text after an action throws', async () => {
    const clipboard = backend();
    const guard = new ClipboardGuard(clipboard);

    await expect(
      guard.withText('temporary', async () => {
        throw new Error('flow failed');
      }),
    ).rejects.toThrow('flow failed');
    expect(clipboard.value).toBe('before');
  });

  test('reports a failed best-effort restoration without exposing content', async () => {
    const failures: string[] = [];
    let writes = 0;
    const clipboard: ClipboardBackend = {
      readText: async () => 'SECRET PREVIOUS VALUE',
      writeText: async () => {
        writes += 1;
        if (writes === 2) throw new Error('clipboard unavailable');
      },
    };

    await new ClipboardGuard(clipboard, (message) => failures.push(message)).withText(
      'temporary',
      async () => undefined,
    );

    expect(failures).toEqual(['Could not restore the previous clipboard text: clipboard unavailable']);
    expect(failures.join(' ')).not.toContain('SECRET');
  });

  test('preserves the clipboard across multiple writes in a provider flow', async () => {
    const clipboard = backend();
    const guard = new ClipboardGuard(clipboard);

    await guard.preserve(async () => {
      clipboard.value = 'extension copy result';
      expect(await guard.readText()).toBe('extension copy result');
    });

    expect(clipboard.value).toBe('before');
  });
});
