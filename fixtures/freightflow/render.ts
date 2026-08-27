/**
 * Layout and components for FreightFlow.
 *
 * Plain server-rendered HTML. It has to look like a product a company would
 * actually buy — a real sidebar, a real table, real empty states — because an
 * agent that only ever succeeds on a three-link page tells us nothing. But it
 * stays server-rendered on purpose: a client-side app would test our
 * observation layer's SPA handling rather than the agent's judgment, and those
 * are different experiments.
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
  body { font: 15px/1.55 -apple-system, system-ui, sans-serif; margin: 0; color: #17202a; background: #f6f8fa; }
  a { color: #0b5fbb; }
  .topbar { background: #0f2942; color: #fff; padding: 10px 20px; display: flex; align-items: center; gap: 24px; }
  .topbar .brand { font-weight: 700; letter-spacing: -0.2px; }
  .topbar a { color: #cfe0f2; text-decoration: none; font-size: 14px; }
  .topbar .spacer { flex: 1; }
  .shell { display: flex; min-height: calc(100vh - 42px); }
  .side { width: 190px; background: #fff; border-right: 1px solid #e3e8ee; padding: 16px 0; }
  .side a { display: block; padding: 8px 20px; color: #33475b; text-decoration: none; font-size: 14px; }
  .side a.on { background: #eef4fb; color: #0b5fbb; font-weight: 600; box-shadow: inset 3px 0 0 #0b5fbb; }
  main { flex: 1; padding: 26px 32px; max-width: 900px; }
  h1 { font-size: 22px; margin: 0 0 4px; }
  h2 { font-size: 16px; margin: 26px 0 8px; }
  p.sub { color: #5a6b7d; margin: 0 0 20px; }
  .cards { display: flex; gap: 14px; margin-bottom: 8px; }
  .card { background: #fff; border: 1px solid #e3e8ee; border-radius: 8px; padding: 14px 16px; flex: 1; }
  .card .n { font-size: 24px; font-weight: 700; }
  .card .l { color: #5a6b7d; font-size: 13px; }
  table { width: 100%; border-collapse: collapse; background: #fff; border: 1px solid #e3e8ee; border-radius: 8px; }
  th, td { text-align: left; padding: 9px 12px; border-bottom: 1px solid #eef1f5; font-size: 14px; }
  th { color: #5a6b7d; font-weight: 600; font-size: 12px; text-transform: uppercase; letter-spacing: 0.04em; }
  tr:last-child td { border-bottom: 0; }
  label { display: block; margin: 14px 0 4px; font-weight: 600; font-size: 13px; }
  input, select { width: 100%; padding: 8px 10px; border: 1px solid #c3cdd8; border-radius: 6px; font: inherit; background: #fff; }
  button { margin-top: 18px; padding: 9px 16px; border: 0; border-radius: 6px; background: #0b5fbb; color: #fff; font: inherit; font-weight: 600; cursor: pointer; }
  button.plain { background: #fff; color: #33475b; border: 1px solid #c3cdd8; }
  form.inline { display: inline; }
  form.inline button { margin: 0; }
  .row { display: flex; gap: 10px; align-items: center; }
  .error { background: #fdecec; border: 1px solid #f3b7b7; color: #8c1c1c; padding: 9px 12px; border-radius: 6px; margin-bottom: 14px; }
  .notice { background: #eef4fb; border: 1px solid #c3d9f0; padding: 9px 12px; border-radius: 6px; margin-bottom: 14px; }
  .empty { color: #5a6b7d; font-style: italic; padding: 22px 0; }
  .pill { font-size: 12px; padding: 2px 8px; border-radius: 10px; background: #eef1f5; color: #33475b; }
  .marketing { max-width: 720px; margin: 0 auto; padding: 48px 24px; }
  .plans { display: flex; gap: 14px; align-items: stretch; }
  .plan { background: #fff; border: 1px solid #e3e8ee; border-radius: 8px; padding: 18px; flex: 1; }
  .plan .price { font-size: 26px; font-weight: 700; margin: 6px 0; }
  .plan ul { padding-left: 18px; color: #33475b; font-size: 14px; }
  .searchbar { margin-left: auto; }
  .searchbar input { width: 210px; padding: 5px 9px; font-size: 13px; }
`;

function head(title: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)} · FreightFlow</title>
<style>${STYLE}</style>
</head>`;
}

/** A page on the public marketing site. */
export function publicPage(title: string, body: string): string {
  return `${head(title)}
<body>
<div class="topbar">
  <span class="brand">FreightFlow</span>
  <a href="/">Product</a>
  <a href="/pricing">Pricing</a>
  <span class="spacer"></span>
  <a href="/signin">Sign in</a>
  <a href="/signup">Start free trial</a>
</div>
<div class="marketing">${body}</div>
</body>
</html>`;
}

/** A page during onboarding: no sidebar yet, because there is no app to use. */
export function onboardingPage(title: string, body: string): string {
  return `${head(title)}
<body>
<div class="topbar"><span class="brand">FreightFlow</span></div>
<div class="marketing">${body}</div>
</body>
</html>`;
}

export type AppNav =
  | 'dashboard'
  | 'shipments'
  | 'customers'
  | 'invoices'
  | 'account'
  | 'none';

/**
 * The signed-in application shell.
 *
 * Note what is *not* here: no billing link, and no pricing link. Billing lives
 * two levels down under "Account", and pricing is not reachable from the app at
 * all except through the billing page. Both are deliberate, both are recorded
 * in ground-truth.ts, and neither is hinted at anywhere in the markup.
 */
export function appPage(title: string, active: AppNav, body: string): string {
  const item = (href: string, label: string, key: AppNav): string =>
    `<a href="${href}"${active === key ? ' class="on"' : ''}>${label}</a>`;

  return `${head(title)}
<body>
<div class="topbar">
  <span class="brand">FreightFlow</span>
  <span class="spacer"></span>
  <form class="inline searchbar" method="get" action="/app/search">
    <input name="q" type="search" placeholder="Search" aria-label="Search">
  </form>
  <form class="inline" method="post" action="/signout"><button class="plain">Sign out</button></form>
</div>
<div class="shell">
  <nav class="side">
    ${item('/app', 'Dashboard', 'dashboard')}
    ${item('/app/shipments', 'Shipments', 'shipments')}
    ${item('/app/customers', 'Customers', 'customers')}
    ${item('/app/invoices', 'Invoices', 'invoices')}
    ${item('/app/reports', 'Reports', 'none')}
    ${item('/app/account', 'Account', 'account')}
  </nav>
  <main>${body}</main>
</div>
</body>
</html>`;
}

export function errorBox(message: string | null): string {
  return message === null ? '' : `<div class="error" role="alert">${escapeHtml(message)}</div>`;
}

export function notice(message: string): string {
  return `<div class="notice" role="status">${escapeHtml(message)}</div>`;
}

export function money(cents: number): string {
  return `£${(cents / 100).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export function weight(kg: number): string {
  return `${kg.toLocaleString('en-GB')} kg`;
}
