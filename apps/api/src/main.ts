import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import {
  FastifyAdapter,
  NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { AppModule } from './app.module';
import { getConfig } from './config/env';

async function bootstrap(): Promise<void> {
  // Fail-fast config validation (ENVIRONMENT_VARIABLES.md: startup fails fast,
  // listing missing variable NAMES only). Also loads repo-root .env locally.
  const config = getConfig();

  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    new FastifyAdapter(),
  );

  app.enableShutdownHooks();

  await app.listen(config.apiPort, config.apiHost);
  // eslint-disable-next-line no-console
  console.log(`[api] listening on http://${config.apiHost}:${config.apiPort}`);
}

void bootstrap().catch((err: unknown) => {
  console.error('[api] failed to start', err);
  process.exit(1);
});
