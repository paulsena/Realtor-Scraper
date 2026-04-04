import dotenv from 'dotenv';
import { loadConfig } from './config.js';
import { createApp } from './server.js';
import { createLogger } from './utils/logger.js';

dotenv.config();

const config = loadConfig();
const logger = createLogger(config.logLevel);
const app = createApp(config);

const server = app.listen(config.port, () => {
  logger.info({ port: config.port }, 'Server started');
});

function shutdown(signal: string) {
  logger.info({ signal }, 'Received shutdown signal');
  server.close(() => {
    logger.info('Server closed');
    process.exit(0);
  });

  // Force shutdown after 10 seconds
  setTimeout(() => {
    logger.error('Forced shutdown after timeout');
    process.exit(1);
  }, 10_000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
