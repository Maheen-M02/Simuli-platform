/**
 * The shape of what the agent can see.
 *
 * These types live apart from `extract.browser.ts` because that module's
 * function body is stringified and shipped into the page, so it cannot import
 * anything — but its *types* are needed on the Node side.
 */

/**
 * Roles are a deliberately small, closed vocabulary. The model reasons about
 * these words, so they must mean the same thing on every site.
 */
export const NODE_ROLES = [
  'heading',
  'text',
  'link',
  'button',
  'textbox',
  'password',
  'checkbox',
  'radio',
  'combobox',
  'alert',
  'listitem',
  'table',
] as const;

export type NodeRole = (typeof NODE_ROLES)[number];

export type SnapshotNode = {
  /** Opaque ref, present only on nodes the agent can act on. */
  readonly ref: string | null;
  readonly role: NodeRole;
  /** Accessible name, or the visible text for static content. */
  readonly name: string;
  /** Current value of a field. Never populated for password inputs. */
  readonly value?: string;
  readonly placeholder?: string;
  readonly disabled?: boolean;
  readonly checked?: boolean;
  readonly required?: boolean;
  /** Visible option labels, for a combobox. */
  readonly options?: readonly string[];
  /** Heading depth, 1-6. */
  readonly level?: number;
  /** False when the node sits outside the current viewport. */
  readonly inViewport: boolean;
};

export type PageSnapshot = {
  readonly url: string;
  readonly title: string;
  readonly nodes: readonly SnapshotNode[];
  /** True when there is content below the fold worth scrolling to. */
  readonly hasMoreBelow: boolean;
  /** Nodes dropped because the page exceeded the node budget. */
  readonly truncated: number;
};

/**
 * A snapshot plus the bookkeeping the loop needs. `generation` is what makes
 * stale-action rejection possible: an action decided against generation 4
 * cannot be executed once the page has moved on to generation 5.
 */
export type Observation = {
  readonly generation: number;
  readonly capturedAt: number;
  readonly snapshot: PageSnapshot;
  /** The serialised form actually shown to the model. */
  readonly text: string;
};
