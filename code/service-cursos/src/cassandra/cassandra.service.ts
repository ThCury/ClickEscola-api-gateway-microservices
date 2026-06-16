import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Client } from 'cassandra-driver';

@Injectable()
export class CassandraService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(CassandraService.name);
  public client: Client;

  // Conexão com retry/backoff: mesmo com healthcheck, é a falha mais comum na subida.
  async onModuleInit(): Promise<void> {
    const contactPoints = (process.env.CASSANDRA_HOSTS || 'cassandra').split(',');
    const port = parseInt(process.env.CASSANDRA_PORT || '9042', 10);
    const keyspace = process.env.CASSANDRA_KEYSPACE || 'cursos_ks';
    const localDataCenter = process.env.CASSANDRA_DC || 'datacenter1';

    const retries = 12;
    const backoffMs = 3000;

    for (let attempt = 1; attempt <= retries; attempt++) {
      try {
        this.client = new Client({
          contactPoints,
          localDataCenter,
          keyspace,
          protocolOptions: { port },
        });
        await this.client.connect();
        this.logger.log(`Conectado ao Cassandra (keyspace=${keyspace})`);
        return;
      } catch (err) {
        const wait = backoffMs * attempt;
        this.logger.warn(
          `Falha ao conectar ao Cassandra (tentativa ${attempt}/${retries}): ${err.message} — aguardando ${wait / 1000}s`,
        );
        await new Promise((resolve) => setTimeout(resolve, wait));
      }
    }

    throw new Error('Não foi possível conectar ao Cassandra após várias tentativas');
  }

  async onModuleDestroy(): Promise<void> {
    await this.client?.shutdown();
  }
}
