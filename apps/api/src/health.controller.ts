import { Controller, Get } from '@nestjs/common';
import { Public } from './common/public.decorator';

export interface HealthResponse {
  status: 'ok';
  service: 'api';
  timestamp: string;
}

@Public()
@Controller('health')
export class HealthController {
  @Get()
  getHealth(): HealthResponse {
    return {
      status: 'ok',
      service: 'api',
      timestamp: new Date().toISOString(),
    };
  }
}
