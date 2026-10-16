import { Module } from '@nestjs/common';
import { RolesGuard } from '../rbac/roles.guard';
import { TenancyController } from './tenancy.controller';
import { TenancyService } from './tenancy.service';

@Module({
  controllers: [TenancyController],
  providers: [TenancyService, RolesGuard],
  exports: [TenancyService],
})
export class TenancyModule {}
