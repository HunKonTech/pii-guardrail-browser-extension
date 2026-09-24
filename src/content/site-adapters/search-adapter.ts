import { SEARCH_INPUT_SELECTOR } from '../../shared/search-engines';
import type { SiteAdapter } from './adapter-interface';
import { insertTextCompat } from './adapter-interface';

/** The query box of a web search engine, for the paste interceptor. */
export class SearchAdapter implements SiteAdapter {
  readonly name = 'Search';

  getInputElement(): HTMLElement | null {
    const focused = document.activeElement;
    if (focused instanceof HTMLElement && focused.matches(SEARCH_INPUT_SELECTOR)) return focused;
    return document.querySelector<HTMLElement>(SEARCH_INPUT_SELECTOR);
  }

  getResponseElements(): HTMLElement[] {
    return [];
  }

  insertText(element: HTMLElement, text: string): void {
    insertTextCompat(element, text);
  }

  observeResponses(_callback: (element: HTMLElement) => void): MutationObserver {
    // Search results are not model replies; there is nothing to restore.
    return new MutationObserver(() => {});
  }
}
