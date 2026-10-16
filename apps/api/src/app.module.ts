import { Module } from '@nestjs/common';
import { AuthModule } from './auth/auth.module';
import { HealthController } from './health.controller';

/**
 * Root application module.
 * Modules (auth, tenancy, cases, ...) are added here as they are built;
 * see Documentation/SERVICE_BOUNDARIES.md for the target module catalog.
 */
@Module({
  imports: [AuthModule],
  controllers: [HealthController],
  providers: [],
})
export class AppModule {}
