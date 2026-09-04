import { selectComposerCandidate } from '../../e2e/live/composer';

describe('independent live composer selection', () => {
  test('prefers a visible editable textbox related to a submit control', () => {
    expect(
      selectComposerCandidate([
        { id: 'hidden', visible: false, enabled: true, editable: true, role: 'textbox', nearSubmit: true },
        { id: 'search', visible: true, enabled: true, editable: true, role: 'searchbox', nearSubmit: false },
        { id: 'composer', visible: true, enabled: true, editable: true, role: 'textbox', nearSubmit: true },
      ]),
    ).toBe('composer');
  });

  test('rejects hidden, disabled, and non-editable candidates', () => {
    expect(() =>
      selectComposerCandidate([
        { id: 'hidden', visible: false, enabled: true, editable: true, role: 'textbox', nearSubmit: true },
        { id: 'disabled', visible: true, enabled: false, editable: true, role: 'textbox', nearSubmit: true },
        { id: 'readonly', visible: true, enabled: true, editable: false, role: 'textbox', nearSubmit: true },
      ]),
    ).toThrow('No usable composer');
  });

  test('fails visibly when equally strong composer candidates remain', () => {
    expect(() =>
      selectComposerCandidate([
        { id: 'a', visible: true, enabled: true, editable: true, role: 'textbox', nearSubmit: true },
        { id: 'b', visible: true, enabled: true, editable: true, role: 'textbox', nearSubmit: true },
      ]),
    ).toThrow('Ambiguous composer');
  });
});
