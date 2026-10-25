import { Module } from '@nestjs/common';
import { RolesGuard } from '../rbac/roles.guard';
import { TenancyModule } from '../tenancy/tenancy.module';
import { CasesController } from './cases.controller';
import { CasesService } from './cases.service';

/**
 * Cases module — P3 business slice (SERVICE_BOUNDARIES: cases own the
 * conversation timeline). AuditService and OutboxService are @Global leaf
 * providers, so they are injected here without importing those modules.
 * TenancyModule is imported for RolesGuard's TenancyService dependency
 * (membership re-resolution on every request); RolesGuard must be listed in
 * providers because guards are instantiated per module.
 */
@Module({
  imports: [TenancyModule],
  controllers: [CasesController],
  providers: [CasesService, RolesGuard],
})
export class CasesModule {}
