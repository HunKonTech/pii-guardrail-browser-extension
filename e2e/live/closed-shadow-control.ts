import type { Page } from '@playwright/test';
import { LiveE2EError } from './classifier';
import type { LivePhase } from './contracts';

const ALLOWED_CONTROLS: Record<string, ReadonlySet<string>> = {
  '#pg-review-overlay-host': new Set(['pg-confirm-btn']),
  '.pg-deanon-host': new Set(['pg-reveal-btn', 'pg-copy-btn']),
  '#pg-clipboard-toast-host': new Set(['pg-clipboard-replace-btn']),
};

interface CdpNode {
  nodeId?: number;
  backendNodeId?: number;
  nodeName?: string;
  attributes?: string[];
  children?: CdpNode[];
  shadowRoots?: CdpNode[];
}

export interface ShadowControlTarget {
  id: string;
}

export async function clickExtensionShadowControl(
  page: Page,
  hostSelector: string,
  target: ShadowControlTarget,
  phase: LivePhase = 'unknown',
): Promise<void> {
  const allowed = ALLOWED_CONTROLS[hostSelector];
  if (!allowed || !allowed.has(target.id)) {
    throw new LiveE2EError('harness-error', phase, `Closed-shadow access is not allowed for ${hostSelector}`);
  }

  const client = await page.context().newCDPSession(page);
  try {
    await client.send('DOM.enable');
    const { root } = (await client.send('DOM.getDocument', { depth: 0 })) as { root: CdpNode };
    const { nodeIds: hostNodeIds } = (await client.send('DOM.querySelectorAll', {
      nodeId: root.nodeId!,
      selector: hostSelector,
    })) as { nodeIds: number[] };
    if (hostNodeIds.length !== 1) {
      throw new LiveE2EError(
        'harness-error',
        phase,
        hostNodeIds.length === 0
          ? `Extension shadow host ${hostSelector} was not found`
          : `Extension shadow host ${hostSelector} was ambiguous`,
      );
    }

    // Describe only the allowlisted extension host. This pierces its closed
    // roots without exposing similarly named controls elsewhere on the page.
    const { node: hostTree } = (await client.send('DOM.describeNode', {
      nodeId: hostNodeIds[0],
      depth: -1,
      pierce: true,
    })) as { node: CdpNode };
    const matches: CdpNode[] = [];
    const visit = (node: CdpNode): void => {
      const attributes = node.attributes ?? [];
      const idIndex = attributes.indexOf('id');
      if (
        node.nodeName?.toLowerCase() === 'button' &&
        idIndex >= 0 &&
        attributes[idIndex + 1] === target.id
      ) {
        matches.push(node);
      }
      for (const child of node.children ?? []) visit(child);
      for (const shadowRoot of node.shadowRoots ?? []) visit(shadowRoot);
    };
    visit(hostTree);
    if (matches.length !== 1 || !matches[0].backendNodeId) {
      throw new LiveE2EError(
        'harness-error',
        phase,
        matches.length === 0 ? 'Extension shadow control was not found' : 'Extension shadow control was ambiguous',
      );
    }

    const { model } = (await client.send('DOM.getBoxModel', {
      backendNodeId: matches[0].backendNodeId,
    })) as { model?: { content: number[] } };
    const quad = model?.content;
    if (!quad || quad.length < 8) {
      throw new LiveE2EError('harness-error', phase, 'Extension shadow control has no visible geometry');
    }
    const x = (quad[0] + quad[2] + quad[4] + quad[6]) / 4;
    const y = (quad[1] + quad[3] + quad[5] + quad[7]) / 4;
    const unobstructed = await page.evaluate(
      ({ selector, x, y }) => {
        const host = document.querySelector(selector);
        const hit = document.elementFromPoint(x, y);
        return Boolean(host && hit && (hit === host || host.contains(hit)));
      },
      { selector: hostSelector, x, y },
    );
    if (!unobstructed) {
      throw new LiveE2EError('harness-error', phase, 'Extension shadow control is covered');
    }
    await page.mouse.click(x, y);
  } finally {
    await client.detach();
  }
}
