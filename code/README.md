# Plataforma Acadêmica — API Gateway + Microsserviços

Arquitetura de microsserviços com **ponto único de entrada**: o cliente só fala com o
gateway Nginx, que roteia para os serviços internos. Os serviços e o banco **não expõem
portas para o host** — só são acessíveis dentro da rede Docker.

```
                 ┌─────────────┐
   cliente  ───▶ │  Nginx :80  │  (gateway — único exposto, host :8080)
                 └──────┬──────┘
            /api/alunos │ /api/cursos
            ┌───────────┴───────────┐
            ▼                       ▼
   ┌─────────────────┐     ┌─────────────────┐
   │ service-alunos  │     │ service-cursos  │
   │ FastAPI :8000   │     │ NestJS  :3000   │
   └────────┬────────┘     └────────┬────────┘
            └───────────┬───────────┘
                        ▼
                ┌───────────────┐
                │  Cassandra    │  (keyspaces: alunos_ks / cursos_ks)
                │    :9042      │
                └───────────────┘
```

## Stack

| Componente      | Tecnologia            | Função                                  |
|-----------------|-----------------------|-----------------------------------------|
| Gateway         | Nginx 1.27            | Roteamento, rate limit, logs, erros     |
| Serviço Alunos  | Python / FastAPI      | CRUD de alunos                          |
| Serviço Cursos  | Node.js / NestJS      | CRUD de cursos                          |
| Banco de dados  | Cassandra 4.1         | Persistência (1 keyspace por serviço)   |
| Observabilidade | Dozzle                | Logs de todos os containers em tempo real |

## Portas

Apenas o **gateway** e o **Dozzle** ficam acessíveis pelo host:

| Serviço         | Porta no host | Porta interna | Acesso                                  |
|-----------------|---------------|---------------|-----------------------------------------|
| **Gateway**     | `8080`        | `80`          | http://localhost:8080                   |
| **Dozzle**      | `9999`        | `8080`        | http://localhost:9999                   |
| service-alunos  | — (interno)   | `8000`        | só na rede Docker (`service-alunos:8000`) |
| service-cursos  | — (interno)   | `3000`        | só na rede Docker (`service-cursos:3000`) |
| cassandra       | — (interno)   | `9042`        | só na rede Docker (`cassandra:9042`)    |

## Como rodar

Pré-requisitos: **Docker** e **Docker Compose**.

```bash
cd code
docker compose up --build
```

> A primeira subida demora alguns minutos: o Cassandra leva ~1 min para ficar *healthy*
> e só então o schema é carregado (container `cassandra-init`) e os serviços sobem.
> A ordem é garantida por `depends_on` + `healthcheck` — não é preciso fazer nada manual.

Para rodar em segundo plano e derrubar depois:

```bash
docker compose up --build -d     # sobe em background
docker compose down              # derruba (use -v para apagar os dados do Cassandra)
```

## Endpoints (via gateway)

Tudo passa por `http://localhost:8080`. O gateway remove o prefixo `/api/<serviço>`
antes de repassar (ex.: `/api/alunos` → `/alunos` no serviço).

### Alunos

```bash
# Criar
curl -X POST http://localhost:8080/api/alunos \
  -H "Content-Type: application/json" \
  -d '{"nome":"Maria Silva","email":"maria@escola.edu","matricula":"2024001"}'

# Listar
curl http://localhost:8080/api/alunos

# Buscar por id
curl http://localhost:8080/api/alunos/<id>
```

### Cursos

```bash
# Criar
curl -X POST http://localhost:8080/api/cursos \
  -H "Content-Type: application/json" \
  -d '{"nome":"Engenharia de Software","carga_horaria":3600}'

# Listar
curl http://localhost:8080/api/cursos

# Buscar por id
curl http://localhost:8080/api/cursos/<id>
```

### Health check

```bash
curl http://localhost:8080/health   # gateway
```

> Cada serviço também tem um endpoint interno `/health` (`service-alunos:8000/health`,
> `service-cursos:3000/health`), acessível apenas de dentro da rede Docker — por exemplo:
> `docker compose exec gateway wget -qO- http://service-alunos:8000/health`.

## Recursos do gateway (Nginx)

- **Roteamento** por path (`/api/alunos`, `/api/cursos`) para upstreams na rede Docker.
- **Rate limiting**: 10 req/s por IP, com `burst` de 20.
- **Logs com tempo de resposta**: formato JSON incluindo `request_time` e
  `upstream_response_time` (tempo total vs. tempo do backend).
- **Tratamento de erro**: `proxy_intercept_errors` + `error_page` devolvem JSON amigável
  em caso de 502/503/504.
- **Rastreabilidade**: header `X-Request-ID` único por requisição, propagado ao backend
  e devolvido ao cliente.

## Observabilidade

Abra **http://localhost:9999** (Dozzle) para ver os logs de todos os containers em tempo
real durante a apresentação — útil para acompanhar o fluxo cliente → gateway → serviço → Cassandra.

## Estrutura do projeto

```
code/
├── docker-compose.yml      # orquestração de todos os containers
├── nginx/
│   └── nginx.conf          # configuração do gateway
├── cassandra/
│   └── init.cql            # keyspaces e tabelas (carregado na subida)
├── service-alunos/         # FastAPI (Python)
│   ├── main.py
│   ├── requirements.txt
│   └── Dockerfile
├── service-cursos/         # NestJS (Node.js)
│   ├── src/
│   ├── package.json
│   └── Dockerfile          # multi-stage (build + produção)
└── README.md
```
