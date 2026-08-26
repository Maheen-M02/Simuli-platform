/**
 * HTML rendering for the fixture site.
 *
 * Plain server-rendered pages, no client JS beyond what a page genuinely needs.
 * The observation layer must work on ordinary HTML before it works on anything
 * clever, so this stays deliberately unexotic.
 */

export function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

const STYLE = `
  * { box-sizing: border-box; }
  body { font: 16px/1.5 system-ui, sans-serif; margin: 0; color: #1a1a1a; background: #fff; }
  header { border-bottom: 1px solid #e2e2e2; padding: 12px 24px; display: flex; gap: 20px; align-items: center; }
  header a { color: #444; text-decoration: none; }
  main { max-width: 640px; margin: 0 auto; padding: 32px 24px; }
  h1 { font-size: 26px; margin: 0 0 8px; }
  p.lede { color: #555; margin: 0 0 24px; }
  label { display: block; margin: 16px 0 4px; font-weight: 600; font-size: 14px; }
  input, select { width: 100%; padding: 9px 10px; border: 1px solid #bbb; border-radius: 6px; font: inherit; }
  button { margin-top: 20px; padding: 10px 18px; border: 0; border-radius: 6px;
           background: #1a56db; color: #fff; font: inherit; cursor: pointer; }
  button.secondary { background: #eee; color: #333; margin-left: 8px; }
  .error { background: #fdeaea; border: 1px solid #f5b5b5; color: #8a1c1c;
           padding: 10px 12px; border-radius: 6px; margin-bottom: 16px; }
  .hint { color: #666; font-size: 13px; margin-top: 4px; }
  table { width: 100%; border-collapse: collapse; margin-top: 16px; }
  th, td { text-align: left; padding: 8px 6px; border-bottom: 1px solid #eee; }
  .empty { color: #666; font-style: italic; padding: 24px 0; }
`;

export type NavState = { readonly signedIn: boolean };

export function page(title: string, nav: NavState, body: string): string {
  const links = nav.signedIn
    ? `<a href="/app">Home</a><a href="/app/billing">Billing</a><a href="/settings">Settings</a>`
    : `<a href="/">Home</a><a href="/pricing">Pricing</a><a href="/signup">Sign up</a>`;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)} · Acme Billing</title>
<style>${STYLE}</style>
</head>
<body>
<header><strong>Acme Billing</strong>${links}</header>
<main>${body}</main>
</body>
</html>`;
}

export function errorBox(message: string | null): string {
  if (message === null) return '';
  return `<div class="error" role="alert">${escapeHtml(message)}</div>`;
}

export function money(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}
