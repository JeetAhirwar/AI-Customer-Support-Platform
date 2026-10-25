import { Global, Module } from '@nestjs/common';
import { MetricsController } from './metrics.controller';
import { MetricsService } from './metrics';

/**
 * Observability leaf module (global so AppModule can register the
 * MetricsInterceptor via APP_INTERCEPTOR and any module can record metrics).
 * Correlation context/middleware are plain utilities wired in AppModule —
 * see ADR-008.
 */
@Global()
@Module({
  controllers: [MetricsController],
  providers: [MetricsService],
  exports: [MetricsService],
})
export class MetricsModule {}
