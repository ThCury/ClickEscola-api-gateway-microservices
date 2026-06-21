# ClickEscola — Painel de Administração (React)

Wireframe da nova versão do frontend do ClickEscola, em **React + Vite**.

## Rodando

```bash
npm install
npm run dev
```

Abra o endereço que o Vite mostrar (geralmente http://localhost:5173).

Para build de produção:

```bash
npm run build
npm run preview
```

## Estrutura

```
src/
  App.jsx      → componente principal (todo o painel)
  main.jsx     → ponto de entrada React
  styles.css   → variáveis de tema (claro/escuro), reset e keyframes
index.html     → carrega as fontes IBM Plex
```

## O que tem

- **Dashboard** com 2 layouts (A · Equilíbrio / B · Performance), KPIs grandes,
  gráficos SVG de requisições e de 503, latência por serviço, tabela de tracing
  com filtros/paginação e comparação Gateway × Direto.
- **Alunos** e **Cursos** com CRUD em memória (criar / editar / excluir) e busca.
- **Tema claro/escuro** (botão no topo) e **teste de carga** simulado em modal.

## Props do componente (`<ClickEscola />`)

| prop        | valores                                  | padrão        |
|-------------|------------------------------------------|---------------|
| `accent`    | `blue` `violet` `emerald` `amber`        | `blue`        |
| `density`   | `comfortable` `compact`                  | `comfortable` |
| `livePulse` | `true` / `false`                         | `true`        |

## Conexão com a API real (já implementada)

O componente está **ligado ao backend** (FastAPI do `service-admin`) — não há mais
dados mockados. O mapeamento atual:

- `refresh()` → `GET /api/stats` + `/api/metrics` + `/api/traces` (KPIs, gráficos e tabela, a cada 2,5 s)
- `fetchCompare()` → `GET /api/compare?service=&n=`
- `runLoad()` → `POST /api/loadtest` (com polling do progresso)
- `saveForm()` / `doDelete()` → `POST|PUT|DELETE /api/manage/:res/:id`
- `loadConfig()` → `GET /api/config` (URLs reais do Grafana/Dozzle)

## Build e deploy

O `npm run build` gera em **`../front`** (`service-admin/front`), que é a pasta servida
pelo FastAPI em `/`. No container, o `Dockerfile` faz isso em multi-stage: estágio
Node compila o React → estágio Python copia o resultado para `front/`. Ou seja, em
produção **não** se roda o Vite: basta `docker compose up -d --build service-admin`.
