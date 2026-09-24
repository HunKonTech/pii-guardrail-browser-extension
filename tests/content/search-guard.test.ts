/** @jest-environment jsdom */
import { SEARCH_ENGINE_ORIGINS } from '../../src/shared/search-engines';
import { SearchGuard, type SearchReviewOutcome } from '../../src/content/search-guard';
import manifest from '../../manifest.json';

function searchPage(): { form: HTMLFormElement; input: HTMLTextAreaElement; submitted: string[] } {
  document.body.innerHTML = '<form action="/search"><textarea name="q"></textarea></form>';
  const form = document.querySelector('form')!;
  const input = document.querySelector('textarea')!;
  const submitted: string[] = [];
  // The page's own handler, registered after the guard like a real engine's.
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    submitted.push(input.value);
  });
  return { form, input, submitted };
}

function pressEnter(input: HTMLElement): KeyboardEvent {
  const event = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
  input.dispatchEvent(event);
  return event;
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('SearchGuard', () => {
  let guard: SearchGuard;
  afterEach(() => guard?.stop());

  function startGuard(review: (query: string) => Promise<SearchReviewOutcome>, active = true) {
    guard = new SearchGuard({
      isActive: () => active,
      review,
      setQuery: (input, query) => {
        input.value = query;
      },
    });
    guard.start();
  }

  test('holds Enter until the query is reviewed, then submits the anonymized query', async () => {
    const { input, submitted } = searchPage();
    const review = jest.fn(async () => ({ kind: 'send', query: '[PERSON_1] address Berlin' }) as const);
    startGuard(review);

    input.value = 'Anna Mueller address Berlin';
    const enter = pressEnter(input);
    expect(enter.defaultPrevented).toBe(true);
    expect(submitted).toEqual([]);

    await flush();
    expect(review).toHaveBeenCalledWith('Anna Mueller address Berlin');
    expect(input.value).toBe('[PERSON_1] address Berlin');
    expect(submitted).toEqual(['[PERSON_1] address Berlin']);
  });

  test('holds a form submit (search button) the same way', async () => {
    const { form, input, submitted } = searchPage();
    startGuard(async (query) => ({ kind: 'send', query }));

    input.value = 'weather tomorrow';
    form.requestSubmit();
    expect(submitted).toEqual([]);

    await flush();
    expect(submitted).toEqual(['weather tomorrow']);
  });

  test('a cancelled review sends nothing and keeps the query in the box', async () => {
    const { input, submitted } = searchPage();
    startGuard(async () => ({ kind: 'cancel' }));

    input.value = 'Anna Mueller address';
    pressEnter(input);
    await flush();

    expect(submitted).toEqual([]);
    expect(input.value).toBe('Anna Mueller address');
  });

  test('a failed check sends nothing', async () => {
    const { input, submitted } = searchPage();
    startGuard(async () => {
      throw new Error('offscreen gone');
    });

    input.value = 'Anna Mueller address';
    pressEnter(input);
    await flush();

    expect(submitted).toEqual([]);
  });

  test('does nothing while protection is off', () => {
    const { input } = searchPage();
    const review = jest.fn();
    startGuard(review, false);

    input.value = 'Anna Mueller address';
    expect(pressEnter(input).defaultPrevented).toBe(false);
    expect(review).not.toHaveBeenCalled();
  });
});

test('search engine origins match the manifest optional host permissions', () => {
  expect([...SEARCH_ENGINE_ORIGINS].sort()).toEqual([...(manifest as any).optional_host_permissions].sort());
});
