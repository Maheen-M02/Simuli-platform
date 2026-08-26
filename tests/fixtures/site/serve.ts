import { startFixtureSite } from './server.ts';

/**
 * Serves the fixture site until interrupted, for driving a real run against it
 * by hand. Tests start their own instance; this is only for the CLI.
 */
const site = await startFixtureSite();
process.stdout.write(`${site.url}\n`);

process.on('SIGINT', () => {
  void site.close().then(() => process.exit(0));
});
