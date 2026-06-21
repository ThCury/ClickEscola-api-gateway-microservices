-- =====================================================================
-- ClickEscola — Consultas (SELECTs) e dicas para os keyspaces do Cassandra
-- =====================================================================
--
-- COMO ABRIR O cqlsh (com o stack rodando via docker compose):
--
--   docker exec -it cassandra cqlsh
--
-- Rodar este arquivo inteiro de uma vez (de dentro da pasta code/):
--
--   docker exec -i cassandra cqlsh < cassandra/consultas.cql
--
-- DICAS GERAIS (Cassandra ≠ SQL):
--   • O Cassandra é "query-first": você consulta de forma eficiente apenas
--     pela PARTITION KEY (e, dentro dela, pela CLUSTERING KEY). Filtrar por
--     colunas comuns exige ALLOW FILTERING — aceitável só em tabelas pequenas
--     ou em ambiente de demo (faz varredura, é caro em produção).
--   • Não há JOIN, GROUP BY rico nem ORDER BY arbitrário. A ordenação já vem
--     definida pela CLUSTERING ORDER da tabela.
--   • COUNT(*) varre a partição — ok aqui (volume pequeno), evite em produção.
--   • Para paginar no cqlsh sem travar a tela: use LIMIT, ou PAGING.
--       PAGING 20;            -- ativa paginação de 20 em 20 (tecle espaço)
--       PAGING OFF;           -- desliga
--   • Mostrar a estrutura:
--       DESCRIBE KEYSPACES;
--       DESCRIBE KEYSPACE alunos_ks;
--       DESCRIBE TABLE tracing_ks.request_traces;
--   • Ver timestamps em UTC de forma legível:
--       SELECT id, dateOf(now()) FROM ... ;   -- exemplo de função de tempo


-- =====================================================================
-- 1) ALUNOS  (keyspace alunos_ks, tabela alunos)
--    PRIMARY KEY (id)  ->  consulta eficiente só por id.
-- =====================================================================
USE alunos_ks;

-- Todos os alunos (varredura completa — tabela pequena na demo):
SELECT id, nome, email, matricula FROM alunos;

-- Quantos alunos existem:
SELECT COUNT(*) FROM alunos;

-- Um aluno específico (eficiente — busca pela partition key):
-- Troque o UUID por um id real (copie da listagem acima).
SELECT * FROM alunos WHERE id = 11111111-1111-1111-1111-111111111111;

-- Buscar por matrícula / e-mail (NÃO é a chave -> precisa ALLOW FILTERING):
SELECT id, nome, matricula FROM alunos WHERE matricula = '2024001' ALLOW FILTERING;
SELECT id, nome, email FROM alunos WHERE email = 'maria@escola.edu' ALLOW FILTERING;


-- =====================================================================
-- 2) CURSOS  (keyspace cursos_ks, tabela cursos)
--    PRIMARY KEY (id)
-- =====================================================================
USE cursos_ks;

-- Todos os cursos:
SELECT id, nome, carga_horaria FROM cursos;

-- Total de cursos:
SELECT COUNT(*) FROM cursos;

-- Um curso específico:
SELECT * FROM cursos WHERE id = 22222222-2222-2222-2222-222222222222;

-- Cursos com carga horária acima de um valor (coluna comum -> ALLOW FILTERING):
SELECT nome, carga_horaria FROM cursos WHERE carga_horaria > 40 ALLOW FILTERING;


-- =====================================================================
-- 3) TRACING  (keyspace tracing_ks, tabela request_traces)
--    PRIMARY KEY (bucket, id) com CLUSTERING ORDER BY (id DESC).
--    bucket é fixo em 'all'; id é um timeuuid (mais recente primeiro).
--    TTL de 1h: linhas antigas somem sozinhas (default_time_to_live = 3600).
--    OBS.: o 503 barrado por rate limit NÃO aparece aqui (ele morre no
--          gateway e nunca chega ao serviço) — veja isso no Loki/Grafana.
-- =====================================================================
USE tracing_ks;

-- As 20 requisições mais recentes (já vêm ordenadas: id DESC):
SELECT service, method, route, status,
       service_received_local, gateway_to_service_ms, service_ms, total_ms
FROM request_traces
WHERE bucket = 'all'
LIMIT 20;

-- Total de requisições rastreadas:
SELECT COUNT(*) FROM request_traces WHERE bucket = 'all';

-- Quantas por serviço (coluna comum -> ALLOW FILTERING):
SELECT COUNT(*) FROM request_traces WHERE bucket = 'all' AND service = 'alunos' ALLOW FILTERING;
SELECT COUNT(*) FROM request_traces WHERE bucket = 'all' AND service = 'cursos' ALLOW FILTERING;

-- Apenas as requisições de um serviço (mais recentes primeiro):
SELECT service, method, status, service_received_local, gateway_to_service_ms, total_ms
FROM request_traces
WHERE bucket = 'all' AND service = 'cursos'
LIMIT 30 ALLOW FILTERING;

-- Apenas erros (status >= 500) registrados pelos serviços:
SELECT service, method, route, status, service_received_local, total_ms
FROM request_traces
WHERE bucket = 'all' AND status >= 500
LIMIT 30 ALLOW FILTERING;

-- Requisições mais lentas no salto gateway -> serviço (amostra recente):
-- (sem ORDER BY arbitrário no Cassandra; ordene no cliente ou inspecione visualmente)
SELECT service, gateway_to_service_ms, service_ms, total_ms, service_received_local
FROM request_traces
WHERE bucket = 'all'
LIMIT 50;

-- Rastrear UMA requisição ponta a ponta pelo X-Request-ID (correlação do gateway):
SELECT service, method, route, path, status, gateway_to_service_ms, service_ms, total_ms
FROM request_traces
WHERE bucket = 'all' AND request_id = 'COLE_AQUI_O_REQUEST_ID' ALLOW FILTERING;


-- =====================================================================
-- 4) DICA EXTRA — métricas que o Cassandra NÃO tem (use o Loki/Grafana)
-- =====================================================================
-- As contagens "recebidas pelo gateway" e "barradas por rate limit (503)"
-- são derivadas dos LOGS do Nginx via Loki (o dashboard do painel já faz
-- isso por você). Exemplos de LogQL para rodar no Grafana (datasource Loki):
--
--   # Requisições /api/* que chegaram ao gateway (por 10s):
--   sum(count_over_time({container="gateway"} | json | uri=~"/api/.*"[10s]))
--
--   # Requisições barradas por rate limit (503) (por 10s):
--   sum(count_over_time({container="gateway", status="503"}[10s]))
--
--   # Recebidas por cada serviço (linhas de trace, por 10s):
--   sum(count_over_time({service="alunos"}[10s]))
--   sum(count_over_time({service="cursos"}[10s]))
