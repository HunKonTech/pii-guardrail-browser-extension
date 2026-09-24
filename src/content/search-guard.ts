import { SEARCH_INPUT_SELECTOR } from '../shared/search-engines';

/**
 * Holds a web search until its query has been checked for personal data.
 *
 * Search engines submit on Enter or through their form, so both are caught
 * in the capture phase before the page sees them. A query that passes review
 * — clean, anonymized, or deliberately sent as is — is remembered and the
 * search is re-submitted; the re-submission is recognised by that value and
 * let through.
 *
 * What cannot be caught here: searches typed into the browser's address bar
 * (they never reach the page) and the autocomplete requests an engine sends
 * while the user is still typing.
 */

export type SearchReviewOutcome =
  | { kind: 'send'; query: string }
  | { kind: 'cancel' };

export interface SearchGuardOptions {
  /** Whether protection is currently on; re-read on every attempt. */
  isActive: () => boolean;
  /** Check a query and, if needed, let the user review it. */
  review: (query: string) => Promise<SearchReviewOutcome>;
  /** Write the reviewed query into the box the way a user edit would. */
  setQuery: (input: HTMLInputElement | HTMLTextAreaElement, query: string) => void;
}

const MIN_QUERY_LENGTH = 3;

export class SearchGuard {
  private approvedQuery: string | null = null;
  private reviewing = false;

  constructor(private readonly options: SearchGuardOptions) {}

  start(): void {
    window.addEventListener('keydown', this.handleKeydown, true);
    window.addEventListener('submit', this.handleSubmit, true);
  }

  stop(): void {
    window.removeEventListener('keydown', this.handleKeydown, true);
    window.removeEventListener('submit', this.handleSubmit, true);
  }

  private handleKeydown = (event: KeyboardEvent): void => {
    if (event.key !== 'Enter' || event.shiftKey || event.isComposing) return;
    const input = asSearchInput(event.target);
    if (input) this.intercept(event, input);
  };

  private handleSubmit = (event: SubmitEvent): void => {
    const form = event.target;
    if (!(form instanceof HTMLFormElement)) return;
    const input = form.querySelector<HTMLInputElement | HTMLTextAreaElement>(SEARCH_INPUT_SELECTOR);
    if (input) this.intercept(event, input);
  };

  private intercept(event: Event, input: HTMLInputElement | HTMLTextAreaElement): void {
    if (!this.options.isActive()) return;
    const query = input.value.trim();
    if (query.length < MIN_QUERY_LENGTH || query === this.approvedQuery) return;

    event.preventDefault();
    event.stopImmediatePropagation();
    if (this.reviewing) return;

    this.reviewing = true;
    void this.options
      .review(query)
      .then((outcome) => {
        if (outcome.kind === 'cancel') {
          input.focus();
          return;
        }
        if (outcome.query !== query) this.options.setQuery(input, outcome.query);
        this.approvedQuery = outcome.query.trim();
        resubmit(input);
      })
      .catch(() => {
        // A failed check must not silently send the query; leave it in the box.
        input.focus();
      })
      .finally(() => {
        this.reviewing = false;
      });
  }
}

function asSearchInput(target: EventTarget | null): HTMLInputElement | HTMLTextAreaElement | null {
  if (!(target instanceof HTMLInputElement) && !(target instanceof HTMLTextAreaElement)) return null;
  return target.matches(SEARCH_INPUT_SELECTOR) ? target : null;
}

/** Submit the search the way the page expects: through its form, or by Enter. */
function resubmit(input: HTMLInputElement | HTMLTextAreaElement): void {
  const form = input.form ?? input.closest('form');
  if (form) {
    if (typeof form.requestSubmit === 'function') form.requestSubmit();
    else form.submit();
    return;
  }
  input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true, cancelable: true }));
}
