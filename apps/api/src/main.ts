import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import {
  FastifyAdapter,
  NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { AppModule } from './app.module';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    new FastifyAdapter(),
  );

  app.enableShutdownHooks();

  // Config contract: Documentation/ENVIRONMENT_VARIABLES.md ("App" section)
  const port = Number(process.env.API_PORT ?? 3000);
  const host = process.env.API_HOST ?? '127.0.0.1';

  await app.listen(port, host);
  // eslint-disable-next-line no-console
  console.log(`[api] listening on http://${host}:${port}`);
}

void bootstrap().catch((err: unknown) => {
  console.error('[api] failed to start', err);
  process.exit(1);
});
