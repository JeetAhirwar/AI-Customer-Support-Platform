import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  Logger,
} from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { randomUUID } from 'crypto';
import { AppException, codeForStatus, type ErrorCode } from './errors';

/**
 * Global exception filter: renders every error as the API_CONTRACTS envelope
 * { error: { code, message, correlation_id, details? } }. 5xx is logged
 * server-side with the correlation id; the client never sees stacks/secrets.
 */
@Catch()
export class ErrorEnvelopeFilter implements ExceptionFilter {
  private readonly logger = new Logger(ErrorEnvelopeFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const request = http.getRequest<FastifyRequest>();
    const reply = http.getResponse<FastifyReply>();

    const rawCorrelation = request.headers?.['x-correlation-id'];
    const correlationId =
      typeof rawCorrelation === 'string' && rawCorrelation.trim() !== ''
        ? rawCorrelation.trim().slice(0, 128)
        : randomUUID();

    let status = 500;
    let code: ErrorCode = 'internal_error';
    let message = 'Internal server error';
    let details: unknown;

    if (exception instanceof AppException) {
      const body = exception.getResponse() as Record<string, unknown>;
      status = exception.getStatus();
      code = (body.code as ErrorCode) ?? 'internal_error';
      message = typeof body.message === 'string' ? body.message : code;
      details = body.details;
    } else if (exception instanceof HttpException) {
      status = exception.getStatus();
      code = codeForStatus(status);
      const body = exception.getResponse();
      if (typeof body === 'string') {
        message = body;
      } else if (body && typeof body === 'object') {
        const record = body as Record<string, unknown>;
        if (Array.isArray(record.message)) {
          details = record.message; // class-validator style lists → details
          message = 'Validation failed';
        } else if (typeof record.message === 'string') {
          message = record.message;
        }
      }
    } else if (exception instanceof Error) {
      this.logger.error(
        `unhandled error [${correlationId}]: ${exception.message}`,
        exception.stack,
      );
    }

    if (status >= 500) {
      this.logger.error(`responded ${status} [${correlationId}]`);
    }

    void reply.status(status).send({
      error: {
        code,
        message,
        correlation_id: correlationId,
        ...(details !== undefined ? { details } : {}),
      },
    });
  }
}
