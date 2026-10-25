import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { AuditModule } from './audit/audit.module';
import { JwtAuthGuard } from './auth/jwt-auth.guard';
import { AuthModule } from './auth/auth.module';
import { ErrorEnvelopeFilter } from './common/http-exception.filter';
import { HealthController } from './health.controller';
import { CorrelationMiddleware } from './observability/correlation.middleware';
import { MetricsInterceptor } from './observability/metrics';
import { MetricsModule } from './observability/metrics.module';
import { OutboxModule } from './outbox/outbox.module';
import { TenancyModule } from './tenancy/tenancy.module';

/**
 * Root application module.
 * Modules (auth, tenancy, audit, outbox, cases, ...) are added here as they
 * are built; see Documentation/SERVICE_BOUNDARIES.md for the target module
 * catalog.
 * Cross-cutting wiring (ADR-008): correlation middleware for every request,
 * uniform error envelope filter, http metrics interceptor.
 */
@Module({
  imports: [
    AuthModule,
    TenancyModule,
    AuditModule,
    OutboxModule,
    MetricsModule,
  ],
  controllers: [HealthController],
  providers: [
    // every route requires a valid Bearer JWT unless marked @Public()
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    // uniform error envelope: { error: { code, message, correlation_id, ... } }
    { provide: APP_FILTER, useClass: ErrorEnvelopeFilter },
    // Prometheus request counters/durations (ADR-008 §3)
    { provide: APP_INTERCEPTOR, useClass: MetricsInterceptor },
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    // sanitize/accept X-Correlation-ID, echo it, run request in context
    consumer.apply(CorrelationMiddleware).forRoutes('*');
  }
}
