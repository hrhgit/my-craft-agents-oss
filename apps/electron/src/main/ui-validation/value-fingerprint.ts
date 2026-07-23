export function semanticValueFingerprintScript(semanticId: string): string {
  return `
    (async () => {
      const semanticId = ${JSON.stringify(semanticId)};
      const element = Array.from(document.querySelectorAll('[data-mortise-semantic-id]'))
        .find(candidate => candidate instanceof HTMLElement && candidate.dataset.mortiseSemanticId === semanticId);
      if (!(element instanceof HTMLElement)) return null;

      const editableSelector = 'textarea,input,[contenteditable="true"]';
      const editable = element.matches(editableSelector) ? element : element.querySelector(editableSelector);
      const value = editable
        ? ('value' in editable && typeof editable.value === 'string' ? editable.value : editable.textContent ?? '')
        : element.innerText;
      const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
      return {
        length: value.length,
        sha256: Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join(''),
      };
    })()
  `
}
