import { get } from 'svelte/store';
import { previewIdentifierRenames } from '../../src/shared/anonymizer';
import type { PiiSpan } from '../../src/shared/message-types';
import { stringIndexToByteOffset } from '../../src/shared/text-offsets';
import { OverlayModel, type OverlayCallbacks } from '../../src/ui/overlay/overlay-model';

const CODE = `public sealed class FeaturedOptions
{
    /// <summary>"owner/repo" on GitHub.</summary>
    public string? Repo { get; set; }
}`;

const callbacks: OverlayCallbacks = {
  onConfirm: () => undefined,
  onPasteOriginal: () => undefined,
  onCancel: () => undefined,
  onFeedback: () => undefined,
  onAddToAllowlist: () => undefined,
  onEditDetails: () => undefined,
};

function orgSpan(needle: string): PiiSpan {
  const start = CODE.indexOf(needle);
  return {
    start: stringIndexToByteOffset(CODE, start),
    end: stringIndexToByteOffset(CODE, start + needle.length),
    entity_type: 'ORGANIZATION',
    score: 0.77,
    text: needle,
    source: 'ner',
  };
}

describe('OverlayModel preview with identifier renames', () => {
  test('shows renamed identifiers next to the replaced entities', () => {
    const model = new OverlayModel(CODE, [orgSpan('GitHub')], callbacks, 0.5, undefined, undefined, (approved) =>
      previewIdentifierRenames(CODE, approved),
    );
    const preview = get(model.previewText);

    expect(preview).toContain('[ORGANIZATION_1]');
    expect(preview).toContain('pg-highlight-identifier');
    const visible = preview.replace(/<[^>]+>/g, '');
    expect(visible).toContain('public sealed class Class1');
    expect(visible).toContain('public string? Field2 { get; set; }');
    expect(visible).not.toContain('FeaturedOptions');
    expect(get(model.renamedCount)).toBe(2);
  });

  test('shows no renames when renaming is off', () => {
    const model = new OverlayModel(CODE, [orgSpan('GitHub')], callbacks, 0.5);

    expect(get(model.previewText)).toContain('FeaturedOptions');
    expect(get(model.renamedCount)).toBe(0);
  });
});
