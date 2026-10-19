import {
  BadRequestException,
  Body,
  Controller,
  HttpCode,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { Public } from '../common/public.decorator';
import { AuthService, type RequestMeta } from './auth.service';
import { LoginRateLimitGuard } from './rate-limit.guard';

/**
 * POST /v1/auth/login | refresh | logout | switch-tenant (API_CONTRACTS §v1/auth).
 * Manual body validation for now — class-validator arrives with the broader
 * DTO layer. Error messages stay generic (SECURITY.md).
 */

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new BadRequestException(`Invalid request: ${field} is required`);
  }
  return value;
}

function optionalString(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') {
    throw new BadRequestException(`Invalid request: ${field} must be a string`);
  }
  return value;
}

function metaOf(req: FastifyRequest): RequestMeta {
  const userAgent = req.headers['user-agent'];
  return {
    ip: req.ip,
    userAgent: typeof userAgent === 'string' ? userAgent : undefined,
  };
}

@Public()
@Controller('v1/auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Post('login')
  @UseGuards(LoginRateLimitGuard)
  @HttpCode(200)
  async login(
    @Body() body: Record<string, unknown>,
    @Req() req: FastifyRequest,
  ) {
    const email = requireString(body?.email, 'email');
    const password = requireString(body?.password, 'password');
    return this.auth.login(email, password, metaOf(req));
  }

  @Post('refresh')
  @HttpCode(200)
  async refresh(
    @Body() body: Record<string, unknown>,
    @Req() req: FastifyRequest,
  ) {
    const refreshToken = requireString(body?.refreshToken, 'refreshToken');
    return this.auth.refresh(refreshToken, metaOf(req));
  }

  @Post('logout')
  @HttpCode(200)
  async logout(
    @Body() body: Record<string, unknown>,
    @Req() req: FastifyRequest,
  ) {
    const refreshToken = optionalString(body?.refreshToken, 'refreshToken');
    return this.auth.logout(refreshToken, metaOf(req));
  }

  @Post('switch-tenant')
  @HttpCode(200)
  async switchTenant(
    @Body() body: Record<string, unknown>,
    @Req() req: FastifyRequest,
  ) {
    const refreshToken = requireString(body?.refreshToken, 'refreshToken');
    const tenantId = requireString(body?.tenant_id, 'tenant_id');
    if (!UUID_RE.test(tenantId)) {
      throw new BadRequestException('Invalid request: tenant_id must be a UUID');
    }
    return this.auth.switchTenant(refreshToken, tenantId, metaOf(req));
  }
}
