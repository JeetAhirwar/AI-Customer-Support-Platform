import { Module } from '@nestjs/common';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { LoginRateLimitGuard } from './rate-limit.guard';

@Module({
  controllers: [AuthController],
  providers: [AuthService, LoginRateLimitGuard],
  exports: [AuthService],
})
export class AuthModule {}
