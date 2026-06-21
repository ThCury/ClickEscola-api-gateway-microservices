-- Modelagem query-first: um keyspace por serviço, replication_factor=1 (ambiente local/dev).

-- ===== Serviço de Alunos =====
CREATE KEYSPACE IF NOT EXISTS alunos_ks
  WITH replication = {'class': 'SimpleStrategy', 'replication_factor': 1};

CREATE TABLE IF NOT EXISTS alunos_ks.alunos (
  id        uuid PRIMARY KEY,
  nome      text,
  email     text,
  matricula text
);

-- ===== Serviço de Cursos =====
CREATE KEYSPACE IF NOT EXISTS cursos_ks
  WITH replication = {'class': 'SimpleStrategy', 'replication_factor': 1};

CREATE TABLE IF NOT EXISTS cursos_ks.cursos (
  id            uuid PRIMARY KEY,
  nome          text,
  carga_horaria int
);

-- ===== Tracing (roteamento ponta a ponta) =====
-- Cada serviço grava aqui, por requisição, quando o gateway recebeu e quando
-- o serviço recebeu/respondeu. Permite ver o caminho gateway -> serviço e os
-- tempos em milissegundos. TTL de 1h para não crescer indefinidamente na demo.
CREATE KEYSPACE IF NOT EXISTS tracing_ks
  WITH replication = {'class': 'SimpleStrategy', 'replication_factor': 1};

CREATE TABLE IF NOT EXISTS tracing_ks.request_traces (
  bucket                 text,       -- partição fixa ('all') p/ consultar os mais recentes
  id                     timeuuid,   -- ordenação temporal (mais recente primeiro)
  request_id             text,       -- X-Request-ID gerado pelo gateway (correlação)
  service                text,       -- 'alunos' | 'cursos'
  method                 text,
  route                  text,       -- /api/alunos | /api/cursos
  path                   text,       -- caminho real recebido pelo serviço
  status                 int,
  gateway_received       timestamp,  -- quando o gateway recebeu (X-Request-Start)
  service_received       timestamp,  -- quando o serviço recebeu (UTC)
  service_received_local text,       -- mesmo instante no fuso de Belo Horizonte (America/Sao_Paulo)
  service_completed      timestamp,  -- quando o serviço terminou
  gateway_to_service_ms  double,     -- salto gateway -> serviço (ms)
  service_ms             double,     -- processamento no serviço (ms, alta resolução)
  total_ms               double,     -- gateway -> serviço -> resposta (ms)
  PRIMARY KEY (bucket, id)
) WITH CLUSTERING ORDER BY (id DESC)
  AND default_time_to_live = 3600;

-- Garante a coluna mesmo se a tabela já existia de uma subida anterior.
ALTER TABLE tracing_ks.request_traces ADD IF NOT EXISTS service_received_local text;
