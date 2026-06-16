import { Global, Module } from '@nestjs/common';
import { CassandraService } from './cassandra.service';

// Global: a sessão do Cassandra fica disponível para qualquer módulo sem reimportar.
@Global()
@Module({
  providers: [CassandraService],
  exports: [CassandraService],
})
export class CassandraModule {}
