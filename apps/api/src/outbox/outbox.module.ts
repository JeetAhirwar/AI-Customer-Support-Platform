import { Global, Module } from '@nestjs/common';
import { OutboxService } from './outbox.service';

/**
 * Outbox module — global leaf (SERVICE_BOUNDARIES rule: modules publish domain
 * events via the outbox). Producers import nothing; they receive the injected
 * OutboxService and pass their withTenant client to append().
 */
@Global()
@Module({
  providers: [OutboxService],
  exports: [OutboxService],
})
export class OutboxModule {}
