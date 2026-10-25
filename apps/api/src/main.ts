import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import {
  FastifyAdapter,
  NestFastifyApplication,
} from '@nestjs/platform-fastify';
import pino from 'pino';
import { buildPinoOptions } from '@aicsp/shared';
import { AppModule } from './app.module';
import { getConfig } from './config/env';
import {
  correlationLogMixin,
} from './observability/correlation';
import { PinoLoggerService } from './observability/pino-logger.service';

async function bootstrap(): Promise<void> {
  // Fail-fast config validation (ENVIRONMENT_VARIABLES.md: startup fails fast,
  // listing missing variable NAMES only). Also loads repo-root .env locally.
  const config = getConfig();

  // one pino instance for Nest boot logs + Fastify request logs
  // (ADR-008 §1: structured JSON, LOG_LEVEL, redaction, correlation mixin)
  const logger = pino(
    buildPinoOptions({
      level: config.logLevel,
      service: 'api',
      mixin: correlationLogMixin,
    }),
  );

  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    // Fastify request logs ride the same pino instance (ADR-008 §1)
    new FastifyAdapter({ loggerInstance: logger }),
    {
      // structured JSON for [Nest] boot/module logs too (ADR-008 §1)
      logger: new PinoLoggerService(logger),
    },
  );

  app.enableShutdownHooks();
  // error envelope + correlation middleware + metrics interceptor are all
  // registered in AppModule (single wiring path for prod + test boots)

  await app.listen(config.apiPort, config.apiHost);
  logger.info(
    { port: config.apiPort, host: config.apiHost },
    'api listening',
  );
}

void bootstrap().catch((err: unknown) => {
  // pre-logger failure path — stderr is the only channel that exists yet
  // eslint-disable-next-line no-console
  console.error('[api] failed to start', err);
  process.exit(1);
});
