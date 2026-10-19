import { Global, Module } from '@nestjs/common';
import { RolesGuard } from '../rbac/roles.guard';
import { TenancyModule } from '../tenancy/tenancy.module';
import { AuditController } from './audit.controller';
import { AuditService } from './audit.service';

/**
 * Audit module — global so every other module (auth, tenancy, cases, ...) can
 * inject AuditService without importing it; the service itself depends on
 * nothing (leaf per SERVICE_BOUNDARIES §10). TenancyModule is imported for
 * RolesGuard's TenancyService dependency (membership re-resolution).
 */
@Global()
@Module({
  imports: [TenancyModule],
  controllers: [AuditController],
  providers: [AuditService, RolesGuard],
  exports: [AuditService],
})
export class AuditModule {}
