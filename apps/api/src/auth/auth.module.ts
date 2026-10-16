import { Module } from '@nestjs/common';
import { TenancyModule } from '../tenancy/tenancy.module';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { LoginRateLimitGuard } from './rate-limit.guard';

@Module({
  imports: [TenancyModule],
  controllers: [AuthController],
  providers: [AuthService, LoginRateLimitGuard],
  exports: [AuthService],
})
export class AuthModule {}
