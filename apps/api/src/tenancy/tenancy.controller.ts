import { Controller, Get, Req } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { TenancyService } from './tenancy.service';

interface RequestWithClaims extends FastifyRequest {
  user?: { sub: string };
}

@Controller('v1/tenants')
export class TenancyController {
  constructor(private readonly tenancy: TenancyService) {}

  /** Workspace picker: active memberships of the authenticated user only. */
  @Get('mine')
  async mine(@Req() req: RequestWithClaims) {
    const memberships = await this.tenancy.membershipsForUser(req.user!.sub);
    return { memberships };
  }
}
