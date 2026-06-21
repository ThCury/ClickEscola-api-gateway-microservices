// Teste de carga com k6 (ferramenta de carga da Grafana).
// Padrão: por serviço, 100 GET + 50 POST, intercalando 2 GET : 1 POST.
// Cada iteração faz (2 GET + 1 POST) em alunos E em cursos; 50 iterações = 100 GET + 50 POST por serviço.
//
// Rodar a partir do HOST (gateway publicado em :8080):
//   docker run --rm -i -e BASE=http://host.docker.internal:8080 grafana/k6 run - < demo/loadtest.k6.js
//
// Rodar DENTRO da rede do projeto (sem publicar porta):
//   docker run --rm -i --network clickescola_backend -e BASE=http://gateway grafana/k6 run - < demo/loadtest.k6.js
//
// Variáveis: BASE (url do gateway), ITER (nº de ciclos, default 50), VUS (usuários virtuais, default 5).
import http from 'k6/http';
import { check, sleep } from 'k6';

const BASE = __ENV.BASE || 'http://gateway';

export const options = {
  scenarios: {
    carga: {
      executor: 'shared-iterations',
      vus: Number(__ENV.VUS || 5),
      iterations: Number(__ENV.ITER || 50),
      maxDuration: '3m',
    },
  },
  thresholds: {
    // O gateway limita a 10 req/s: alguns 503 são esperados sob carga.
    http_req_duration: ['p(95)<800'],
  },
};

const JSON_H = { headers: { 'Content-Type': 'application/json' } };

function exercita(rota, corpoPost) {
  // 2 GET : 1 POST
  check(http.get(`${BASE}${rota}`), { 'GET ok/limite': (r) => r.status === 200 || r.status === 503 });
  check(http.get(`${BASE}${rota}`), { 'GET ok/limite': (r) => r.status === 200 || r.status === 503 });
  check(http.post(`${BASE}${rota}`, JSON.stringify(corpoPost), JSON_H), {
    'POST ok/limite': (r) => r.status === 201 || r.status === 503,
  });
}

export default function () {
  exercita('/api/alunos', { nome: 'Carga k6', email: 'k6@escola.edu', matricula: 'K6' });
  exercita('/api/cursos', { nome: 'Curso k6', carga_horaria: 80 });
  sleep(0.2); // suaviza a rajada (ainda assim haverá 503 do rate limit — é esperado)
}
