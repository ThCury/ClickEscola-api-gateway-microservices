#!/usr/bin/env bash
# =============================================================================
#  ClickEscola — Roteiro de demonstração do API Gateway
#  Exercita, em sequência, todos os itens obrigatórios da rubrica:
#    1) roteamento pelo gateway
#    2) acesso a 2 microsserviços por uma entrada única
#    3) logs das requisições
#    4) tempo de resposta passando pelo gateway
#    5) comparação acesso direto vs. via gateway
#    6) tratamento de erro com serviço indisponível
#    7) (trade-offs: discutidos nos slides)
#
#  Uso:
#    cd code
#    docker compose up --build -d        # subir tudo primeiro
#    ./demo/demo.sh                       # rodar o roteiro guiado
#
#  Requisitos: bash, curl, docker. (No Windows: Git Bash ou WSL.)
# =============================================================================
set -uo pipefail

GW="http://localhost:8080"
COMPOSE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OVERRIDE="$COMPOSE_DIR/demo/docker-compose.override.demo.yml"

# ---- Cores (degradam para texto puro se o terminal não suportar) ----
if [ -t 1 ]; then
  BOLD=$'\e[1m'; DIM=$'\e[2m'; GREEN=$'\e[32m'; CYAN=$'\e[36m'; YELLOW=$'\e[33m'; RED=$'\e[31m'; RESET=$'\e[0m'
else
  BOLD=""; DIM=""; GREEN=""; CYAN=""; YELLOW=""; RED=""; RESET=""
fi

step()  { echo; echo "${BOLD}${CYAN}━━━ $* ━━━${RESET}"; }
note()  { echo "${DIM}$*${RESET}"; }
run()   { echo "${YELLOW}\$ $*${RESET}"; eval "$*"; }
pause() { echo; read -rp "${DIM}» Enter para continuar...${RESET}" _; }

echo "${BOLD}ClickEscola — Demonstração do API Gateway${RESET}"
note  "Gateway:   $GW"
note  "Dozzle:    http://localhost:9999   (logs crus)"
note  "Grafana:   http://localhost:3001   (dashboard em tempo real)"
note  "Dica: deixe o Grafana aberto em outra tela durante a demo."
pause

# -----------------------------------------------------------------------------
step "0) Saúde do gateway"
run "curl -s $GW/health; echo"
pause

# -----------------------------------------------------------------------------
step "1) Roteiro normal — gateway roteando para os DOIS serviços"
note "Mesma entrada (:8080), dois microsserviços diferentes por trás (Python e NestJS)."

note "→ Criar aluno (service-alunos / FastAPI)"
run "curl -s -X POST $GW/api/alunos -H 'Content-Type: application/json' \
  -d '{\"nome\":\"Maria Silva\",\"email\":\"maria@escola.edu\",\"matricula\":\"2024001\"}'; echo"

note "→ Criar curso (service-cursos / NestJS)"
run "curl -s -X POST $GW/api/cursos -H 'Content-Type: application/json' \
  -d '{\"nome\":\"Engenharia de Software\",\"carga_horaria\":3600}'; echo"

note "→ Listar alunos e cursos (ambos via :8080)"
run "curl -s $GW/api/alunos; echo"
run "curl -s $GW/api/cursos; echo"
pause

# -----------------------------------------------------------------------------
step "2+3+4) Logs, tempo de resposta e rastreabilidade (X-Request-ID)"
note "O gateway gera um X-Request-ID por requisição e mede o tempo de resposta."
run "curl -s -D - -o /dev/null $GW/api/alunos | grep -i -E 'HTTP/|X-Request-ID'"
echo
note "Os logs JSON do gateway (com request_time / upstream_response_time) aparecem em:"
note "  • Dozzle:  http://localhost:9999  (linha a linha)"
note "  • Grafana: http://localhost:3001  (latência p50/p95, throughput, status)"
note "Veja as últimas linhas do log do gateway agora:"
run "docker logs --tail 5 gateway"
pause

# -----------------------------------------------------------------------------
step "RATE LIMIT — o gateway é mais que um proxy (10 req/s, burst 20)"
note "Disparando 40 requisições em rajada: as que excedem o limite voltam 503."
run "for i in \$(seq 1 40); do curl -s -o /dev/null -w '%{http_code} ' $GW/api/alunos; done; echo"
note "Repare nos 503 no fim da rajada — e no pico de 503 no painel do Grafana."
pause

# -----------------------------------------------------------------------------
step "5) Comparação: acesso DIRETO vs. via GATEWAY"
note "Vou expor TEMPORARIAMENTE a porta do service-cursos (override) para simular"
note "um cliente acessando o microsserviço sem passar pelo gateway."
run "docker compose -f '$COMPOSE_DIR/docker-compose.yml' -f '$OVERRIDE' up -d service-cursos"
note "Aguardando a porta direta subir..."
sleep 4

note "→ Acesso DIRETO (http://localhost:3000/cursos) — funciona, MAS:"
note "   sem rate limit, sem X-Request-ID, sem log centralizado, acopla o cliente ao NestJS."
run "curl -s -D - http://localhost:3000/cursos | grep -i -E 'HTTP/|X-Request-ID' || true"
echo
note "→ Mesma chamada VIA GATEWAY (http://localhost:8080/api/cursos) — com X-Request-ID:"
run "curl -s -D - -o /dev/null $GW/api/cursos | grep -i -E 'HTTP/|X-Request-ID'"
echo
note "Compare no Grafana: as chamadas diretas NÃO aparecem no dashboard do gateway."
note "Fechando a porta direta para restaurar a regra (só o gateway exposto)..."
run "docker compose -f '$COMPOSE_DIR/docker-compose.yml' up -d --no-deps service-cursos"
pause

# -----------------------------------------------------------------------------
step "6) Serviço fora do ar — gateway devolve erro TRATADO (o momento mais forte)"
note "Derrubando o service-cursos..."
run "docker stop service-cursos"
sleep 2

note "→ Chamada de cursos via gateway: 503 JSON amigável (não quebra o gateway):"
run "curl -s -D - $GW/api/cursos; echo"
echo
note "→ E o OUTRO serviço continua no ar (isolamento de falha):"
run "curl -s -o /dev/null -w 'alunos via gateway -> HTTP %{http_code}\n' $GW/api/alunos"
pause

note "Religando o service-cursos..."
run "docker start service-cursos"
note "Aguardando o serviço voltar (reconecta ao Cassandra)..."
sleep 8
run "curl -s -o /dev/null -w 'cursos via gateway -> HTTP %{http_code}\n' $GW/api/cursos"

# -----------------------------------------------------------------------------
step "Fim do roteiro"
echo "${GREEN}Todos os itens obrigatórios foram demonstrados.${RESET}"
note "Trade-offs do gateway: ver docs/SLIDES.md (ponto único de falha, latência extra,"
note "risco de gargalo  ×  controle centralizado, segurança e desacoplamento)."
