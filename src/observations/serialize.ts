import type { PageSnapshot, SnapshotNode } from './types.ts';

/**
 * Turns a snapshot into the text the model actually reads.
 *
 * A flat, line-per-node outline rather than JSON: it costs roughly half the
 * tokens, and it reads the way a person describes a page, which is the frame we
 * want the model reasoning in. Every actionable line ends with its ref, because
 * that ref is the only handle the model is given.
 */

function quote(text: string): string {
  return JSON.stringify(text);
}

function annotations(node: SnapshotNode): string[] {
  const parts: string[] = [];

  if (node.role === 'combobox' && node.options !== undefined && node.options.length > 0) {
    parts.push(`options: ${node.options.map(quote).join(', ')}`);
  }
  if (node.value !== undefined && node.value !== '') parts.push(`current value: ${quote(node.value)}`);
  if (node.role === 'password') parts.push('value hidden');
  if (node.placeholder !== undefined && node.placeholder !== '') {
    parts.push(`placeholder: ${quote(node.placeholder)}`);
  }
  if (node.required === true) parts.push('required');
  if (node.disabled === true) parts.push('disabled');
  if (node.checked === true) parts.push('checked');
  if (node.checked === false && (node.role === 'checkbox' || node.role === 'radio')) {
    parts.push('unchecked');
  }
  if (!node.inViewport) parts.push('off-screen');

  return parts;
}

export function serializeNode(node: SnapshotNode): string {
  const role = node.role === 'heading' && node.level !== undefined ? `heading${node.level}` : node.role;
  const head = `${role} ${quote(node.name)}`;
  const ref = node.ref === null ? '' : ` [${node.ref}]`;
  const extra = annotations(node);
  const tail = extra.length === 0 ? '' : `  (${extra.join('; ')})`;
  return `${head}${ref}${tail}`;
}

export function serializeSnapshot(snapshot: PageSnapshot): string {
  const lines: string[] = [
    `URL: ${snapshot.url}`,
    `Title: ${snapshot.title}`,
    '',
  ];

  if (snapshot.nodes.length === 0) {
    lines.push('(the page appears to be empty)');
  } else {
    for (const node of snapshot.nodes) lines.push(serializeNode(node));
  }

  if (snapshot.hasMoreBelow) {
    lines.push('', 'There is more content below the fold. Scroll down to see it.');
  }
  if (snapshot.truncated > 0) {
    lines.push('', `(${snapshot.truncated} further elements were omitted; this page is very large.)`);
  }

  return lines.join('\n');
}

/**
 * A short summary used for change detection and for the history the model sees
 * on later steps. Full snapshots for every past step would dominate the context
 * window and push the goal out of view.
 */
export function summarizeSnapshot(snapshot: PageSnapshot): string {
  const heading = snapshot.nodes.find((node) => node.role === 'heading');
  const alert = snapshot.nodes.find((node) => node.role === 'alert');
  const parts = [snapshot.title];
  if (heading !== undefined) parts.push(`heading ${quote(heading.name)}`);
  if (alert !== undefined) parts.push(`alert ${quote(alert.name)}`);
  return parts.join(' — ');
}

/**
 * A fingerprint for the no-change termination check. URL plus structure, not
 * content: a page that only re-renders a spinner has not moved on, but one that
 * gains an error message has.
 */
export function snapshotFingerprint(snapshot: PageSnapshot): string {
  const structure = snapshot.nodes
    .map((node) => `${node.role}:${node.name}:${node.value ?? ''}:${node.disabled === true ? 'd' : ''}`)
    .join('|');
  return `${snapshot.url}\n${structure}`;
}
