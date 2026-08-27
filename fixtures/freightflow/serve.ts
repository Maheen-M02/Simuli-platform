/**
 * Serves FreightFlow until interrupted, so a human can look at it.
 *
 *   npm run fixture:freightflow            # port 4321
 *   PORT=5000 npm run fixture:freightflow
 *
 * Worth doing before trusting any agent run against it: if the product does not
 * feel like a product to you, the run is not measuring what we think it is.
 */
import { startFreightFlow } from './server.ts';

const port = Number(process.env['PORT'] ?? 4321);
const site = await startFreightFlow({ port });

process.stdout.write(
  `FreightFlow running at ${site.url}\n` +
    `  Sign up at ${site.url}/signup — any email, password of 10+ characters including a number.\n` +
    `  Press Ctrl+C to stop.\n`,
);

process.on('SIGINT', () => {
  void site.close().then(() => process.exit(0));
});
