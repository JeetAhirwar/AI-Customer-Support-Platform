import { Controller, Get } from '@nestjs/common';
import { Public } from '../common/public.decorator';
import { MetricsService } from './metrics';

/**
 * `GET /metrics` — Prometheus text exposition (ADR-008 §3). Same trust level
 * as `/health` in P2 (loopback, unauthenticated); must sit behind
 * internal-only networking/auth before any cloud exposure (gate recorded in
 * ADR-008).
 */
@Public()
@Controller()
export class MetricsController {
  constructor(private readonly metrics: MetricsService) {}

  @Get('metrics')
  async scrape(): Promise<string> {
    const body = await this.metrics.metricsText();
    return body;
  }
}
