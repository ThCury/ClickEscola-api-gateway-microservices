# Roteiro de demonstração — API Gateway

Este diretório contém o roteiro que exercita, em sequência, **todos os itens
obrigatórios** da rubrica do trabalho.

## Antes de começar

```bash
cd code
docker compose up --build -d     # sobe tudo (aguarde ~1-2 min na 1ª vez)
docker compose ps                # confira que tudo está "Up"/"healthy"
```

Abra em abas/telas:
- **Painel admin:** http://localhost:8090 → roteamento ao vivo, comparação e teste de carga
- **Grafana:** http://localhost:3001 → *"API Gateway (tempo real)"* e *"Tracing Gateway → Serviço"*
- **Dozzle (logs crus):** http://localhost:9999

## Opção A — script guiado (recomendado)

```bash
./demo/demo.sh        # Git Bash / WSL / Linux / macOS
```

O script pausa entre os passos (Enter para avançar), ideal para apresentar ao vivo.

## Opção B — Postman

Importe `demo/ClickEscola.postman_collection.json` e rode os requests na ordem
(0 → 8). As variáveis `aluno_id`/`curso_id` são preenchidas automaticamente.

## Opção C — Painel de administração (visual)

Abra **http://localhost:8090** e use:
- **Rodar teste de carga** — dispara 100 GET + 50 POST por serviço (2 GET : 1 POST),
  ritmado em ~12 req/s; a tabela de roteamento enche ao vivo.
- **Rodar comparação** — mede latência via gateway × direto e mostra o overhead em ms.
- Botões para abrir o Grafana e o Dozzle.

## Teste de carga com k6 (opcional)

```bash
# A partir do host (gateway publicado em :8080):
docker run --rm -i -e BASE=http://host.docker.internal:8080 grafana/k6 run - < demo/loadtest.k6.js

# Ou dentro da rede do projeto (sem publicar porta):
docker run --rm -i --network clickescola_backend -e BASE=http://gateway grafana/k6 run - < demo/loadtest.k6.js
```

Acompanhe o efeito no Grafana e no painel admin enquanto roda.

## O que cada passo demonstra (mapa para a rubrica)

| Passo do roteiro                        | Item obrigatório do enunciado                          |
|-----------------------------------------|--------------------------------------------------------|
| 1 — criar/listar alunos **e** cursos    | Roteamento + 2 microsserviços por **entrada única**    |
| 2+3+4 — `X-Request-ID`, `docker logs`, Grafana | Logs das requisições + **tempo de resposta**    |
| Rate limit (rajada de 40 req)           | Gateway > proxy: **controle de tráfego** (503)         |
| 5 — direto (`:3000`) vs. gateway (`:8080`) | **Comparação acesso direto × via gateway**          |
| 6 — `docker stop service-cursos`        | **Tratamento de erro** com serviço indisponível (503 JSON) |
| Slides                                  | **Trade-offs** do uso do gateway                       |

## Passos manuais equivalentes (caso prefira digitar)

```bash
# 1) Roteamento para os dois serviços
curl -s -X POST http://localhost:8080/api/alunos -H 'Content-Type: application/json' \
  -d '{"nome":"Maria Silva","email":"maria@escola.edu","matricula":"2024001"}'
curl -s -X POST http://localhost:8080/api/cursos -H 'Content-Type: application/json' \
  -d '{"nome":"Engenharia de Software","carga_horaria":3600}'
curl -s http://localhost:8080/api/alunos
curl -s http://localhost:8080/api/cursos

# 2) Tempo de resposta + X-Request-ID
curl -s -D - -o /dev/null http://localhost:8080/api/alunos | grep -iE 'HTTP/|X-Request-ID'

# 3) Rate limit (veja os 503 no fim)
for i in $(seq 1 40); do curl -s -o /dev/null -w '%{http_code} ' http://localhost:8080/api/alunos; done; echo

# 4) Acesso direto vs. gateway (expõe a porta temporariamente)
docker compose -f docker-compose.yml -f demo/docker-compose.override.demo.yml up -d service-cursos
curl -s -D - http://localhost:3000/cursos | grep -iE 'HTTP/|X-Request-ID'   # SEM X-Request-ID
docker compose up -d service-cursos                                          # restaura (fecha a porta)

# 5) Serviço fora do ar -> erro tratado
docker stop service-cursos
curl -s http://localhost:8080/api/cursos      # 503 JSON amigável
curl -s -o /dev/null -w '%{http_code}\n' http://localhost:8080/api/alunos   # outro serviço segue no ar
docker start service-cursos
```
