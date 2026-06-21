---
marp: true
theme: default
paginate: true
size: 16:9
header: 'API Gateway e Microsserviços — ClickEscola'
footer: 'PUC Minas · Arquitetura de Software'
style: |
  section { font-size: 26px; }
  h1 { color: #1e40af; }
  h2 { color: #1e3a8a; }
  table { font-size: 22px; }
  code { font-size: 0.85em; }
  .small { font-size: 20px; }
---

<!-- _paginate: false -->
<!-- _header: '' -->
<!-- _footer: '' -->

# API Gateway e Microsserviços
## Plataforma Acadêmica — ClickEscola

Arquitetura baseada em microsserviços com **API Gateway** como ponto único de entrada.

<br>

**Disciplina:** Arquitetura de Software (5º período) · **PUC Minas**
Equipe: _<preencher>_

---

## Cenário

Plataforma acadêmica composta por **serviços independentes**:

- **Serviço de Alunos** — cadastrar e consultar alunos
- **Serviço de Cursos** — cadastrar e consultar cursos

Regra central do trabalho:

> As requisições externas **não acessam** os microsserviços diretamente.
> Todo acesso passa por um **API Gateway** que centraliza a entrada.

O foco não é "ter várias APIs", e sim **o papel arquitetural do gateway**:
organização, roteamento, segurança, monitoramento e controle de tráfego.

---

## Arquitetura

```
                    ┌──────────────────────────────┐
   cliente ───────▶ │     API Gateway — Nginx       │  host :8080
   curl/Postman     │  roteamento · rate limit      │  (único exposto)
                    │  logs · erros · X-Request-ID  │
                    └───────┬───────────────┬───────┘
              /api/alunos   │               │  /api/cursos
                            ▼               ▼
                 ┌──────────────────┐  ┌──────────────────┐
                 │  service-alunos  │  │  service-cursos  │
                 │  Python/FastAPI  │  │  Node.js/NestJS  │   ← poliglota
                 └─────────┬────────┘  └────────┬─────────┘
                           ▼                    ▼
                       alunos_ks            cursos_ks
                       └────────── Cassandra ─────────┘
```

Tudo em **containers Docker**; só o gateway (e a observabilidade) exposto ao host.

---

## Stack

| Componente      | Tecnologia              | Papel                              |
|-----------------|-------------------------|------------------------------------|
| Gateway         | **Nginx**               | Entrada única, roteamento, controle |
| Serviço Alunos  | **Python / FastAPI**    | CRUD de alunos                     |
| Serviço Cursos  | **Node.js / NestJS**    | CRUD de cursos                     |
| Banco           | **Cassandra**           | 1 keyspace por serviço             |
| Observabilidade | **Dozzle + Grafana/Loki/Promtail** | Logs crus + dashboard   |

---

# Os 7 itens obrigatórios
### (como demonstramos cada um)

---

## 1 · Roteamento pelo gateway

O Nginx roteia por path e remove o prefixo `/api/<serviço>`:

```nginx
location /api/alunos {
    rewrite ^/api/alunos(/.*)?$ /alunos$1 break;
    proxy_pass http://alunos_upstream;   # service-alunos:8000
}
```

```bash
curl http://localhost:8080/api/alunos   # → service-alunos
curl http://localhost:8080/api/cursos   # → service-cursos
```

> O cliente conhece **uma URL**; o gateway decide o destino interno.

---

## 2 · Dois microsserviços por uma entrada única

A **mesma origem** (`:8080`) atende dois serviços independentes, em
**linguagens diferentes**:

```bash
# Python / FastAPI
curl -X POST :8080/api/alunos -d '{"nome":"Maria",...}'

# Node.js / NestJS
curl -X POST :8080/api/cursos -d '{"nome":"Eng. Software","carga_horaria":3600}'
```

Separação de responsabilidades: cada serviço tem **seu próprio código e seu
próprio keyspace**.

---

## 3 · Logs das requisições

Log estruturado (JSON) no gateway, com ID de rastreio:

```json
{"time":"...","request_id":"a1b2…","method":"GET",
 "uri":"/api/alunos","status":200,
 "request_time":0.012,"upstream_response_time":"0.011"}
```

- **Dozzle** (`:9999`) — todas as linhas em tempo real.
- `X-Request-ID` é devolvido ao cliente e propagado ao backend (rastreabilidade
  ponta a ponta).

---

## 4 · Tempo de resposta pelo gateway

O log separa **tempo total** do **tempo do backend**:

- `request_time` — cliente → gateway → serviço → cliente
- `upstream_response_time` — só o serviço

**Dashboard Grafana** (`:3001`) mostra ao vivo:

- Latência **p50 / p95** através do gateway
- **Throughput** por rota (alunos × cursos)
- **Status HTTP** (dá para ver os `503` subindo na demo)

> "Quanto tempo demora" deixa de ser teoria: aparece no gráfico em tempo real.

---

## 5 · Acesso direto × via gateway

| Aspecto              | Direto no serviço (`:3000`) | Via gateway (`:8080`)       |
|----------------------|-----------------------------|-----------------------------|
| Rate limiting        | ❌ não tem                  | ✔ 10 req/s, burst 20        |
| Log centralizado     | ❌ espalhado por serviço    | ✔ um ponto, formato único   |
| `X-Request-ID`       | ❌ ausente                  | ✔ rastreável                |
| Acoplamento          | cliente conhece a porta/linguagem | cliente só conhece `/api/...` |

Na demo: expomos a porta temporariamente e mostramos que o acesso direto
**não aparece** no dashboard nem sofre rate limit.

---

## 6 · Tratamento de erro (serviço fora do ar)

```bash
docker stop service-cursos
curl http://localhost:8080/api/cursos
```
```json
{"error":"servico temporariamente indisponivel",
 "status":503,"request_id":"…"}
```

- `proxy_intercept_errors` + `error_page` → **JSON amigável**, não um erro cru.
- O **outro serviço continua no ar** → isolamento de falha.

> O gateway **degrada com elegância** em vez de quebrar.

---

## 7 · Trade-offs do API Gateway

| ✔ A favor                                    | ✘ Custo                              |
|----------------------------------------------|--------------------------------------|
| Controle centralizado (segurança, logs, rate limit) | **Ponto único de falha**      |
| Desacopla cliente dos serviços               | **Latência extra** (1 hop)           |
| Esconde a linguagem → permite **poliglota**  | Risco de virar **gargalo** sob carga |
| Entrada única, governança                    | Mais um componente para operar       |

**Mitigações:** réplicas do gateway + load balancer; cache; timeouts/limites;
observabilidade (Grafana) para enxergar o gargalo antes que ele doa.

---

# As 3 justificativas arquiteturais
### (o que a banca vai cobrar)

---

## Por que Cassandra?

- **Escrita rápida e escalável horizontalmente** — encaixa no perfil de
  cadastros/consultas de uma plataforma acadêmica que cresce.
- **Sem ponto único no banco** — arquitetura distribuída (masterless),
  alta disponibilidade por design.
- **Modelagem query-first** — modelamos a tabela para a consulta, não o contrário.
- Coerente com microsserviços: cada serviço dono dos seus dados, sem JOIN
  cruzando fronteiras de serviço.

---

## Por que um keyspace por serviço?

- **Isolamento de dados** — cada serviço é dono do seu schema (`alunos_ks`,
  `cursos_ks`); ninguém lê a tabela do outro.
- **Database per service** — padrão de microsserviços: evita acoplamento pelo banco.
- **Evolução independente** — mudar o schema de cursos não afeta alunos.
- Reforça a **separação de responsabilidades** exigida pelo enunciado.

---

## Por que arquitetura poliglota (Python + NestJS)?

> **Este é o nosso trunfo.**

- Os serviços são em **linguagens diferentes** de propósito:
  `alunos` em **Python/FastAPI**, `cursos` em **Node.js/NestJS**.
- O cliente **não percebe** — fala sempre `/api/...` no gateway.
- **Prova na prática** que o gateway **esconde a linguagem de implementação**
  e **reduz o acoplamento** entre consumidor e serviço.
- Mostra que cada time poderia escolher a melhor ferramenta para o seu domínio
  sem impactar quem consome a API.

---

<!-- _paginate: false -->

# Demonstração ao vivo

1. `docker compose up --build -d`
2. **Grafana** (`:3001`) + **Dozzle** (`:9999`) abertos numa tela
3. `./demo/demo.sh` — roteiro guiado:
   roteamento → logs/tempo → rate limit → direto×gateway → serviço fora do ar

<br>

### Obrigado!
Perguntas?

<!--
Para exportar este deck:
  npx @marp-team/marp-cli@latest docs/SLIDES.md --pdf
  npx @marp-team/marp-cli@latest docs/SLIDES.md --pptx
Ou use a extensão "Marp for VS Code" (botão de preview/export).
-->
