import type { PageSnapshot } from './types.ts';

/**
 * The in-page DOM walk.
 *
 * `extractSnapshot` is stringified by Playwright and evaluated inside the page,
 * so its body must be entirely self-contained: no imports, no closure over
 * module scope, no TypeScript that survives to runtime. Helpers live *inside*
 * it for that reason, not out of preference.
 *
 * What it produces is the agent's whole world. Two rules shape it:
 *  - Only what a person could actually see. Hidden, zero-sized and aria-hidden
 *    subtrees are skipped, because friction the customer cannot perceive is not
 *    friction.
 *  - Every actionable element is stamped with `data-sim-ref`, which is how the
 *    resolver finds it again without the model ever authoring a selector.
 */
export function extractSnapshot(nodeBudget: number): PageSnapshot {
  const REF_ATTR = 'data-sim-ref';
  const MAX_NAME = 200;

  let nextRef = 1;
  let truncated = 0;
  const nodes: Record<string, unknown>[] = [];

  // Refs are only valid within one generation; clear the last one's stamps so a
  // stale ref can never silently resolve to the right-looking element.
  for (const stamped of Array.from(document.querySelectorAll('[' + REF_ATTR + ']'))) {
    stamped.removeAttribute(REF_ATTR);
  }

  const viewportHeight = window.innerHeight;
  let maxBottom = 0;

  function clean(text: string | null | undefined): string {
    if (!text) return '';
    const collapsed = text.replace(/\s+/g, ' ').trim();
    return collapsed.length > MAX_NAME ? collapsed.slice(0, MAX_NAME) + '…' : collapsed;
  }

  function isVisible(el: Element): boolean {
    if (el.getAttribute('aria-hidden') === 'true') return false;
    if ((el as HTMLElement).hidden) return false;
    const style = window.getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) return false;
    return true;
  }

  function geometry(el: Element): { inViewport: boolean } {
    const rect = el.getBoundingClientRect();
    const absoluteBottom = rect.bottom + window.scrollY;
    if (absoluteBottom > maxBottom) maxBottom = absoluteBottom;
    return { inViewport: rect.bottom > 0 && rect.top < viewportHeight };
  }

  /**
   * Accessible name, in roughly the order a screen reader would resolve it.
   * Not the full accname spec — the common cases, honestly computed.
   */
  function accessibleName(el: Element): string {
    const ariaLabel = el.getAttribute('aria-label');
    if (ariaLabel) return clean(ariaLabel);

    const labelledBy = el.getAttribute('aria-labelledby');
    if (labelledBy) {
      const parts = labelledBy
        .split(/\s+/)
        .map((id) => document.getElementById(id)?.textContent ?? '')
        .join(' ');
      if (clean(parts)) return clean(parts);
    }

    if (el.id) {
      const label = document.querySelector('label[for="' + CSS.escape(el.id) + '"]');
      if (label?.textContent) return clean(label.textContent);
    }

    const wrappingLabel = el.closest('label');
    if (wrappingLabel?.textContent) return clean(wrappingLabel.textContent);

    const title = el.getAttribute('title');
    if (title) return clean(title);

    const placeholder = el.getAttribute('placeholder');
    if (placeholder) return clean(placeholder);

    return clean(el.textContent);
  }

  function push(node: Record<string, unknown>): void {
    if (nodes.length >= nodeBudget) {
      truncated++;
      return;
    }
    nodes.push(node);
  }

  function stamp(el: Element): string {
    const ref = 'e' + nextRef++;
    el.setAttribute(REF_ATTR, ref);
    return ref;
  }

  function describeInteractive(el: Element): Record<string, unknown> | null {
    const tag = el.tagName.toLowerCase();
    const explicitRole = el.getAttribute('role');

    if (tag === 'input') {
      const input = el as HTMLInputElement;
      const type = (input.getAttribute('type') ?? 'text').toLowerCase();
      if (type === 'hidden') return null;

      if (type === 'checkbox' || type === 'radio') {
        return {
          role: type,
          name: accessibleName(el),
          checked: input.checked,
          disabled: input.disabled,
          required: input.required,
        };
      }
      if (type === 'submit' || type === 'button' || type === 'reset') {
        return {
          role: 'button',
          name: clean(input.value) || accessibleName(el),
          disabled: input.disabled,
        };
      }
      // A password field's value is never read: it may be a real credential and
      // observations are persisted and shown to a model.
      const isPassword = type === 'password';
      return {
        role: isPassword ? 'password' : 'textbox',
        name: accessibleName(el),
        value: isPassword ? undefined : clean(input.value),
        placeholder: clean(input.getAttribute('placeholder')) || undefined,
        disabled: input.disabled,
        required: input.required,
      };
    }

    if (tag === 'textarea') {
      const area = el as HTMLTextAreaElement;
      return {
        role: 'textbox',
        name: accessibleName(el),
        value: clean(area.value),
        placeholder: clean(area.getAttribute('placeholder')) || undefined,
        disabled: area.disabled,
        required: area.required,
      };
    }

    if (tag === 'select') {
      const select = el as HTMLSelectElement;
      const options = Array.from(select.options)
        .map((option) => clean(option.textContent))
        .filter((label) => label !== '')
        .slice(0, 25);
      return {
        role: 'combobox',
        name: accessibleName(el),
        value: clean(select.selectedOptions[0]?.textContent ?? ''),
        options,
        disabled: select.disabled,
        required: select.required,
      };
    }

    if (tag === 'button' || explicitRole === 'button') {
      return {
        role: 'button',
        name: accessibleName(el),
        disabled: (el as HTMLButtonElement).disabled === true,
      };
    }

    if (tag === 'a' || explicitRole === 'link') {
      // An anchor with no href is decoration, not a destination.
      if (tag === 'a' && !el.getAttribute('href')) return null;
      return { role: 'link', name: accessibleName(el) };
    }

    return null;
  }

  const STATIC_TAGS = new Set(['h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'p', 'li', 'td', 'th', 'legend']);

  function describeStatic(el: Element): Record<string, unknown> | null {
    const tag = el.tagName.toLowerCase();
    const role = el.getAttribute('role');

    if (role === 'alert' || role === 'status') {
      const text = clean(el.textContent);
      return text === '' ? null : { role: 'alert', name: text };
    }

    if (!STATIC_TAGS.has(tag)) return null;

    // Text already carried by a nested control would otherwise appear twice.
    const text = clean(el.textContent);
    if (text === '') return null;

    if (tag[0] === 'h' && tag.length === 2) {
      return { role: 'heading', name: text, level: Number(tag[1]) };
    }
    if (tag === 'li') return { role: 'listitem', name: text };
    if (tag === 'td' || tag === 'th') return { role: 'table', name: text };
    return { role: 'text', name: text };
  }

  /**
   * One pre-order walk. Interactive elements win over the static text that
   * contains them, and a static container is skipped when a descendant will be
   * reported anyway — otherwise a button's label shows up three times.
   */
  function walk(el: Element): void {
    if (!isVisible(el)) return;

    const tag = el.tagName.toLowerCase();
    if (tag === 'script' || tag === 'style' || tag === 'noscript' || tag === 'template') return;

    const interactive = describeInteractive(el);
    if (interactive !== null) {
      const name = interactive['name'];
      // A control with no name is unusable to a person, and unnameable to us.
      if (typeof name === 'string' && name !== '') {
        push({ ...interactive, ref: stamp(el), ...geometry(el) });
      }
      // Do not descend: an anchor wrapping a button is one thing, not two.
      return;
    }

    const staticNode = describeStatic(el);
    if (staticNode !== null && !containsReportable(el)) {
      push({ ...staticNode, ref: null, ...geometry(el) });
      return;
    }

    // Text sitting directly inside an element we do not otherwise report.
    //
    // Found by a real run against FreightFlow: its pricing page puts each price
    // in a <div class="price"> and each plan name in a <strong>, so the agent
    // was shown a pricing page with no prices and no plan names on it. It
    // scrolled four times looking for them and gave up — correctly, given what
    // we had shown it. Our previous fixture used <p> and tables throughout,
    // which is why a whitelist of block tags looked sufficient for months.
    //
    // Only *direct* text children are taken, so each run of text is attributed
    // to exactly one element and nothing is reported twice.
    const own = directText(el);
    if (own !== '') push({ role: 'text', name: own, ref: null, ...geometry(el) });

    for (const child of Array.from(el.children)) walk(child);
  }

  /**
   * Concatenated text nodes that are immediate children of `el`.
   *
   * A `<label>` is excluded: its text is already the accessible name of the
   * control it labels, so reporting it again would show the customer the same
   * words twice and make a field indistinguishable from its own caption.
   */
  function directText(el: Element): string {
    if (el.tagName.toLowerCase() === 'label') return '';

    let text = '';
    for (const node of Array.from(el.childNodes)) {
      // 3 is Node.TEXT_NODE. The constant is not reliably available here.
      if (node.nodeType === 3) text += node.textContent ?? '';
    }
    return clean(text);
  }

  function containsReportable(el: Element): boolean {
    return el.querySelector('a[href], button, input, select, textarea, [role="button"], [role="link"]') !== null;
  }

  walk(document.body);

  return {
    url: window.location.href,
    title: document.title,
    nodes: nodes as unknown as PageSnapshot['nodes'],
    hasMoreBelow: maxBottom > window.scrollY + viewportHeight + 8,
    truncated,
  } as PageSnapshot;
}
