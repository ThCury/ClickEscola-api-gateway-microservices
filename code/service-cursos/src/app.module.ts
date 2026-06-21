import { Module } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { CassandraModule } from './cassandra/cassandra.module';
import { CursosModule } from './cursos/cursos.module';
import { HealthController } from './health.controller';
import { TracingInterceptor } from './tracing/tracing.interceptor';

@Module({
  imports: [CassandraModule, CursosModule],
  controllers: [HealthController],
  providers: [{ provide: APP_INTERCEPTOR, useClass: TracingInterceptor }],
})
export class AppModule {}
