import { Module } from '@nestjs/common';
import { HealthController } from './health.controller';

/**
 * Root application module (Phase-2 scaffold).
 * Modules (auth, tenancy, cases, ...) are added here as they are built;
 * see Documentation/SERVICE_BOUNDARIES.md for the target module catalog.
 */
@Module({
  imports: [],
  controllers: [HealthController],
  providers: [],
})
export class AppModule {}
