import { Module } from '@nestjs/common';
import { CassandraModule } from './cassandra/cassandra.module';
import { CursosModule } from './cursos/cursos.module';
import { HealthController } from './health.controller';

@Module({
  imports: [CassandraModule, CursosModule],
  controllers: [HealthController],
})
export class AppModule {}
