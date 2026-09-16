import type { Locator, Page } from '@playwright/test';
import { LiveE2EError } from './classifier';

export interface ComposerCandidate {
  id: string;
  visible: boolean;
  enabled: boolean;
  editable: boolean;
  role: string | null;
  nearSubmit: boolean;
  submitDistance?: number;
  tagName?: string;
}

function score(candidate: ComposerCandidate): number {
  let value = 0;
  if (candidate.role === 'textbox') value += 4;
  if (candidate.tagName === 'TEXTAREA') value += 3;
  if (candidate.nearSubmit) value += 5;
  if (candidate.submitDistance !== undefined) value += Math.max(0, 3 - candidate.submitDistance / 300);
  return value;
}

export function selectComposerCandidate(candidates: readonly ComposerCandidate[]): string {
  const ranked = candidates
    .filter((candidate) => candidate.visible && candidate.enabled && candidate.editable)
    .map((candidate) => ({ candidate, score: score(candidate) }))
    .sort((a, b) => b.score - a.score);

  if (ranked.length === 0) {
    throw new LiveE2EError('unavailable', 'composer', 'No usable composer was found on the logged-out surface');
  }
  if (ranked.length > 1 && Math.abs(ranked[0].score - ranked[1].score) < 0.01) {
    throw new LiveE2EError('harness-error', 'composer', 'Ambiguous composer candidates have the same confidence');
  }
  return ranked[0].candidate.id;
}

export async function discoverComposer(page: Page): Promise<Locator> {
  const locator = page.locator(
    'textarea, [contenteditable="true"], [role="textbox"]',
  );
  const candidates = await locator.evaluateAll((elements) =>
    elements.map((element, index) => {
      const html = element as HTMLElement;
      const rect = html.getBoundingClientRect();
      const style = getComputedStyle(html);
      const form = html.closest('form');
      const root = form ?? html.parentElement;
      const submit = Array.from(root?.querySelectorAll<HTMLElement>('button, [role="button"]') ?? [])
        .find((button) => {
          const name = [
            button.getAttribute('aria-label'),
            button.getAttribute('title'),
            button.innerText,
          ].filter(Boolean).join(' ');
          return /\b(?:send|submit)(?: message)?\b/i.test(name);
        });
      const submitRect = submit?.getBoundingClientRect();
      const submitStyle = submit ? getComputedStyle(submit) : null;
      const submitVisible = Boolean(
        submit &&
          submitRect &&
          submitRect.width > 0 &&
          submitRect.height > 0 &&
          submitStyle?.visibility !== 'hidden' &&
          submitStyle?.display !== 'none',
      );
      const disabled =
        html.hasAttribute('disabled') ||
        html.getAttribute('aria-disabled') === 'true' ||
        Boolean(html.closest('[inert],[hidden]'));
      const readonly = html.hasAttribute('readonly') || html.getAttribute('aria-readonly') === 'true';
      const editable =
        html.tagName === 'TEXTAREA' ||
        html.isContentEditable ||
        html.getAttribute('role') === 'textbox';
      return {
        id: String(index),
        visible:
          rect.width > 0 &&
          rect.height > 0 &&
          style.visibility !== 'hidden' &&
          style.display !== 'none' &&
          Number(style.opacity) !== 0,
        enabled: !disabled,
        editable: editable && !readonly,
        role: html.getAttribute('role') ?? (html.tagName === 'TEXTAREA' ? 'textbox' : null),
        nearSubmit: submitVisible,
        submitDistance:
          submitVisible && submitRect
            ? Math.hypot(rect.x + rect.width / 2 - (submitRect.x + submitRect.width / 2), rect.y - submitRect.y)
            : undefined,
        tagName: html.tagName,
      };
    }),
  );

  const id = selectComposerCandidate(candidates);
  return locator.nth(Number(id));
}
