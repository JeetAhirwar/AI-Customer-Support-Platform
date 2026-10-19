import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { AuditModule } from './audit/audit.module';
import { JwtAuthGuard } from './auth/jwt-auth.guard';
import { AuthModule } from './auth/auth.module';
import { HealthController } from './health.controller';
import { TenancyModule } from './tenancy/tenancy.module';

/**
 * Root application module.
 * Modules (auth, tenancy, audit, cases, ...) are added here as they are built;
 * see Documentation/SERVICE_BOUNDARIES.md for the target module catalog.
 */
@Module({
  imports: [AuthModule, TenancyModule, AuditModule],
  controllers: [HealthController],
  providers: [
    // every route requires a valid Bearer JWT unless marked @Public()
    { provide: APP_GUARD, useClass: JwtAuthGuard },
  ],
})
export class AppModule {}
