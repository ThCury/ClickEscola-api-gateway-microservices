import {
  CallHandler,
  ExecutionContext,
  Injectable,
  Logger,
  NestInterceptor,
} from '@nestjs/common';
import { Observable, tap } from 'rxjs';
import { types } from 'cassandra-driver';
import { CassandraService } from '../cassandra/cassandra.service';

// Registra cada requisição (gateway -> serviço) no Cassandra (tracing_ks) e emite
// uma linha JSON pura no stdout para o Loki/Grafana.
@Injectable()
export class TracingInterceptor implements NestInterceptor {
  private readonly logger = new Logger('Tracing');
  private readonly SERVICE = 'cursos';
  private readonly ROUTE = '/api/cursos';

  private static readonly INSERT = `
    INSERT INTO tracing_ks.request_traces
      (bucket, id, request_id, service, method, route, path, status,
       gateway_received, service_received, service_received_local, service_completed,
       gateway_to_service_ms, service_ms, total_ms)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

  // Formata o instante (epoch ms) no fuso de Belo Horizonte: 'YYYY-MM-DD HH:MM:SS.mmm'.
  private static localStr(epochMs: number): string {
    const d = new Date(epochMs);
    const base = new Intl.DateTimeFormat('sv-SE', {
      timeZone: 'America/Sao_Paulo',
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
    }).format(d); // -> "2026-06-20 15:30:45"
    return `${base}.${String(d.getMilliseconds()).padStart(3, '0')}`;
  }

  constructor(private readonly cassandra: CassandraService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<any> {
    const http = context.switchToHttp();
    const req = http.getRequest();
    if (req.url === '/health') {
      return next.handle();
    }

    const tRecv = Date.now(); // epoch (wall clock) — comparável com o gateway
    const perf0 = process.hrtime.bigint(); // alta resolução — tempo no serviço

    return next.handle().pipe(
      tap(() => {
        const serviceMs = Number(process.hrtime.bigint() - perf0) / 1e6;
        const tDone = Date.now();
        try {
          const res = http.getResponse();
          const rid = (req.headers['x-request-id'] as string) || '';
          const gwRaw = req.headers['x-request-start'] as string | undefined;
          const gwMs = gwRaw ? parseFloat(gwRaw) * 1000 : null; // $msec em segundos.ms
          const gwToSvcMs = gwMs !== null ? tRecv - gwMs : null;
          const totalMs = gwMs !== null ? tDone - gwMs : serviceMs;

          this.cassandra.client
            .execute(
              TracingInterceptor.INSERT,
              [
                'all',
                types.TimeUuid.now(),
                rid,
                this.SERVICE,
                req.method,
                this.ROUTE,
                req.url,
                res.statusCode,
                gwMs !== null ? new Date(gwMs) : null,
                new Date(tRecv),
                TracingInterceptor.localStr(tRecv),
                new Date(tDone),
                gwToSvcMs,
                serviceMs,
                totalMs,
              ],
              { prepare: true },
            )
            .catch((e) => this.logger.warn(`Falha ao gravar trace: ${e.message}`));

          // Linha JSON para o Loki/Grafana.
          process.stdout.write(
            JSON.stringify({
              evt: 'trace',
              service: this.SERVICE,
              request_id: rid,
              method: req.method,
              route: this.ROUTE,
              path: req.url,
              status: res.statusCode,
              service_received_local: TracingInterceptor.localStr(tRecv),
              gateway_to_service_ms:
                gwToSvcMs !== null ? Math.round(gwToSvcMs * 1000) / 1000 : null,
              service_ms: Math.round(serviceMs * 1000) / 1000,
              total_ms: totalMs !== null ? Math.round(totalMs * 1000) / 1000 : null,
            }) + '\n',
          );
        } catch (e) {
          this.logger.warn(`Erro no tracing: ${(e as Error).message}`);
        }
      }),
    );
  }
}
