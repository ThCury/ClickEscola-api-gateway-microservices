"""Serviço de Administração — painel de observabilidade do API Gateway.

Expõe:
  • GET    /api/traces            -> roteamento ponta a ponta (lido do Cassandra tracing_ks)
  • GET    /api/compare           -> comparação de latência gateway x direto
  • POST   /api/loadtest          -> dispara carga (100 GET + 50 POST por serviço, 2 GET:1 POST)
  • GET    /api/config            -> URLs do Grafana/Dozzle
  • GET    /api/metrics           -> dados dos dashboards (latência por serviço + séries Loki)
  • CRUD   /api/manage/alunos[..] -> proxy CRUD para o serviço de alunos
  • CRUD   /api/manage/cursos[..] -> proxy CRUD para o serviço de cursos
  • GET    /                      -> frontend React compilado (front/)
"""
import asyncio
import logging
import os
import time
from contextlib import asynccontextmanager
from statistics import mean

import httpx
from cassandra.cluster import Cluster
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse, Response
from fastapi.staticfiles import StaticFiles

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s [admin] %(message)s")
logger = logging.getLogger("service-admin")

CASSANDRA_HOSTS = os.getenv("CASSANDRA_HOSTS", "cassandra").split(",")
CASSANDRA_PORT = int(os.getenv("CASSANDRA_PORT", "9042"))
TRACING_KEYSPACE = os.getenv("TRACING_KEYSPACE", "tracing_ks")

GATEWAY_URL = os.getenv("GATEWAY_URL", "http://gateway")
ALUNOS_URL = os.getenv("ALUNOS_URL", "http://service-alunos:8000")
CURSOS_URL = os.getenv("CURSOS_URL", "http://service-cursos:3000")
GRAFANA_PUBLIC = os.getenv("GRAFANA_PUBLIC_URL", "http://localhost:3001")
DOZZLE_PUBLIC = os.getenv("DOZZLE_PUBLIC_URL", "http://localhost:9999")
LOKI_URL = os.getenv("LOKI_URL", "http://loki:3100")

# CRUD: cada recurso é proxyado direto ao serviço (rede interna, sem rate limit),
# para a administração ser sempre confiável independentemente do gateway.
CRUD = {
    "alunos": {"base": f"{ALUNOS_URL}/alunos"},
    "cursos": {"base": f"{CURSOS_URL}/cursos"},
}

# Onde cada serviço fica direto (sem gateway) e via gateway.
SERVICES = {
    "alunos": {
        "gateway": f"{GATEWAY_URL}/api/alunos",
        "direct": f"{ALUNOS_URL}/alunos",
        "post_body": {"nome": "Carga Teste", "email": "carga@escola.edu", "matricula": "LOAD"},
    },
    "cursos": {
        "gateway": f"{GATEWAY_URL}/api/cursos",
        "direct": f"{CURSOS_URL}/cursos",
        "post_body": {"nome": "Curso de Carga", "carga_horaria": 60},
    },
}

db: dict = {}


def connect_with_retry(retries: int = 15, backoff: float = 3.0):
    last_err = None
    for attempt in range(1, retries + 1):
        try:
            cluster = Cluster(CASSANDRA_HOSTS, port=CASSANDRA_PORT)
            session = cluster.connect()
            session.set_keyspace(TRACING_KEYSPACE)
            logger.info("Conectado ao Cassandra (keyspace=%s)", TRACING_KEYSPACE)
            return cluster, session
        except Exception as err:  # noqa: BLE001
            last_err = err
            wait = backoff * attempt
            logger.warning("Cassandra indisponível (%d/%d): %s — aguardando %.0fs",
                           attempt, retries, err, wait)
            time.sleep(wait)
    raise RuntimeError(f"Não foi possível conectar ao Cassandra: {last_err}")


@asynccontextmanager
async def lifespan(app: FastAPI):
    cluster, session = connect_with_retry()
    db["cluster"] = cluster
    db["session"] = session
    db["select_traces"] = session.prepare(
        "SELECT request_id, service, method, route, path, status, "
        "service_received, service_received_local, gateway_to_service_ms, service_ms, total_ms "
        "FROM request_traces WHERE bucket = 'all' LIMIT ?"
    )
    db["count_all"] = session.prepare(
        "SELECT COUNT(*) FROM request_traces WHERE bucket = 'all'"
    )
    db["count_service"] = session.prepare(
        "SELECT COUNT(*) FROM request_traces WHERE bucket = 'all' AND service = ? ALLOW FILTERING"
    )
    yield
    cluster.shutdown()


app = FastAPI(title="Serviço de Admin", version="1.0.0", lifespan=lifespan)


def _stats(samples: list[float]) -> dict:
    if not samples:
        return {"count": 0, "min": None, "avg": None, "p50": None, "p95": None, "max": None}
    s = sorted(samples)
    def pct(p: float) -> float:
        idx = min(len(s) - 1, int(round(p * (len(s) - 1))))
        return round(s[idx], 3)
    return {
        "count": len(s),
        "min": round(s[0], 3),
        "avg": round(mean(s), 3),
        "p50": pct(0.50),
        "p95": pct(0.95),
        "max": round(s[-1], 3),
    }


@app.get("/api/config")
def config():
    return {"grafana": GRAFANA_PUBLIC, "dozzle": DOZZLE_PUBLIC}


@app.get("/api/stats")
def stats():
    """Estatísticas reais (não limitadas pelo tamanho da página da tabela)."""
    sess = db["session"]
    total = sess.execute(db["count_all"]).one()[0]
    alunos = sess.execute(db["count_service"], ("alunos",)).one()[0]
    cursos = sess.execute(db["count_service"], ("cursos",)).one()[0]
    # Médias sobre uma janela recente (suficiente e barato).
    window = list(sess.execute(db["select_traces"], (300,)))
    g2s = [r.gateway_to_service_ms for r in window if r.gateway_to_service_ms is not None]
    svc = [r.service_ms for r in window if r.service_ms is not None]
    avg = lambda a: round(sum(a) / len(a), 3) if a else None  # noqa: E731
    return {
        "total": total,
        "alunos": alunos,
        "cursos": cursos,
        "avg_gateway_to_service_ms": avg(g2s),
        "avg_service_ms": avg(svc),
        "window": len(g2s),
    }


@app.get("/api/traces")
def traces(limit: int = 100):
    limit = max(1, min(limit, 500))
    rows = db["session"].execute(db["select_traces"], (limit,))
    out = []
    for r in rows:
        out.append({
            "request_id": r.request_id,
            "service": r.service,
            "method": r.method,
            "route": r.route,
            "path": r.path,
            "status": r.status,
            "service_received": r.service_received.isoformat() if r.service_received else None,
            "service_received_local": r.service_received_local,
            "gateway_to_service_ms": r.gateway_to_service_ms,
            "service_ms": r.service_ms,
            "total_ms": r.total_ms,
        })
    return {"count": len(out), "traces": out}


async def _measure(client: httpx.AsyncClient, url: str, n: int, pace: float) -> dict:
    """Mede n GETs em `url`, devolve estatísticas (ms) das respostas de sucesso."""
    samples, errors = [], 0
    for _ in range(n):
        t = time.perf_counter()
        try:
            r = await client.get(url, timeout=10.0)
            dt = (time.perf_counter() - t) * 1000.0
            if r.status_code < 400:
                samples.append(dt)
            else:
                errors += 1
        except Exception:  # noqa: BLE001
            errors += 1
        if pace:
            await asyncio.sleep(pace)
    st = _stats(samples)
    st["errors"] = errors
    return st


@app.get("/api/compare")
async def compare(service: str = "cursos", n: int = 25):
    if service not in SERVICES:
        return JSONResponse({"error": "serviço inválido"}, status_code=400)
    n = max(5, min(n, 100))
    cfg = SERVICES[service]
    async with httpx.AsyncClient() as client:
        # Gateway é limitado a 10 req/s: espaçamos p/ medir latência sem cair no rate limit.
        gateway = await _measure(client, cfg["gateway"], n, pace=0.12)
        direct = await _measure(client, cfg["direct"], n, pace=0.0)
    overhead = None
    if gateway["avg"] is not None and direct["avg"] is not None:
        overhead = round(gateway["avg"] - direct["avg"], 3)
    return {"service": service, "n": n, "gateway": gateway, "direct": direct,
            "overhead_ms": overhead}


def _build_plan(n_get: int, n_post: int) -> list[str]:
    """Sequência intercalada 2 GET : 1 POST até esgotar GETs/POSTs."""
    seq, g, p = [], n_get, n_post
    while g > 0 or p > 0:
        for _ in range(2):
            if g > 0:
                seq.append("GET"); g -= 1
        if p > 0:
            seq.append("POST"); p -= 1
    return seq


@app.post("/api/loadtest")
async def loadtest(get: int = 100, post: int = 50, rate: float = 12.0):
    """Dispara, por serviço, n_get GET + n_post POST (2 GET:1 POST), ritmado em ~rate req/s.

    O ritmo mantém a carga perto do limite do gateway (10 req/s): a maioria das
    requisições chega aos serviços (e popula os dashboards ao vivo), mas alguns
    503 ainda aparecem demonstrando o rate limit sob carga.
    """
    get = max(0, min(get, 500))
    post = max(0, min(post, 500))
    rate = max(1.0, min(rate, 100.0))

    names = list(SERVICES.keys())
    plans = {n: _build_plan(get, post) for n in names}
    # Intercala os serviços (round-robin) para os dois receberem tráfego junto.
    combined: list[tuple[str, str]] = []
    for i in range(max((len(p) for p in plans.values()), default=0)):
        for n in names:
            if i < len(plans[n]):
                combined.append((n, plans[n][i]))

    results = {n: {"get": 0, "post": 0, "ok": 0, "by_status": {}} for n in names}
    interval = 1.0 / rate
    sem = asyncio.Semaphore(25)
    t0 = time.perf_counter()

    async with httpx.AsyncClient() as client:
        async def one(name: str, method: str):
            cfg = SERVICES[name]
            async with sem:
                try:
                    if method == "GET":
                        code = (await client.get(cfg["gateway"], timeout=10.0)).status_code
                    else:
                        code = (await client.post(cfg["gateway"], json=cfg["post_body"], timeout=10.0)).status_code
                except Exception:  # noqa: BLE001
                    code = 0
            res = results[name]
            res[method.lower()] += 1
            res["by_status"][str(code)] = res["by_status"].get(str(code), 0) + 1
            if 200 <= code < 400:
                res["ok"] += 1

        tasks = []
        for name, method in combined:
            tasks.append(asyncio.create_task(one(name, method)))
            await asyncio.sleep(interval)  # ritmo de lançamento (~rate req/s)
        await asyncio.gather(*tasks)

    dur = time.perf_counter() - t0
    total = sum(s["get"] + s["post"] for s in results.values())
    ok = sum(s["ok"] for s in results.values())
    return {
        "duration_s": round(dur, 2),
        "total_requests": total,
        "ok": ok,
        "rate_limited_503": sum(s["by_status"].get("503", 0) for s in results.values()),
        "rps": round(total / dur, 1) if dur > 0 else None,
        "by_service": results,
        "nota": "Ritmo ~%g req/s. 503 = rate limit do gateway (10 req/s) sob carga." % rate,
    }


# ===================== Dashboards: métricas para os gráficos =====================
async def _loki_series(client: httpx.AsyncClient, query: str, start: int, end: int,
                       step: int) -> dict[int, float]:
    """Executa um query_range no Loki e devolve {bucket_ts_segundos: valor}.

    Os timestamps são alinhados ao `step` (mesma grade usada para montar o eixo X),
    de modo que séries diferentes se sobreponham corretamente no gráfico.
    """
    params = {
        "query": query,
        "start": str(start * 1_000_000_000),  # Loki espera nanossegundos
        "end": str(end * 1_000_000_000),
        "step": f"{step}s",
    }
    r = await client.get(f"{LOKI_URL}/loki/api/v1/query_range", params=params, timeout=8.0)
    r.raise_for_status()
    out: dict[int, float] = {}
    for series in r.json().get("data", {}).get("result", []):
        for ts, val in series.get("values", []):
            bucket = int(round(float(ts) / step) * step)
            out[bucket] = out.get(bucket, 0.0) + float(val)
    return out


@app.get("/api/metrics")
async def metrics(window_s: int = 300, step_s: int = 10):
    """Dados dos dashboards.

    • latency  -> média gateway→serviço e no serviço, POR serviço (lido do Cassandra).
    • series   -> séries temporais (passo de `step_s`, padrão 10s) das requisições
                  recebidas pelo gateway, alunos e cursos + quantas o gateway barrou
                  por rate limit (503). Fonte: Loki (logs do Nginx e dos serviços).
    """
    step_s = max(5, min(step_s, 60))
    window_s = max(60, min(window_s, 1800))

    # ---- Latência média por serviço (janela recente do tracing no Cassandra) ----
    rows = list(db["session"].execute(db["select_traces"], (400,)))
    acc: dict[str, dict[str, list]] = {
        "alunos": {"gw": [], "svc": []}, "cursos": {"gw": [], "svc": []}
    }
    for r in rows:
        b = acc.get(r.service)
        if b is None:
            continue
        if r.gateway_to_service_ms is not None:
            b["gw"].append(r.gateway_to_service_ms)
        if r.service_ms is not None:
            b["svc"].append(r.service_ms)
    avg = lambda a: round(sum(a) / len(a), 3) if a else None  # noqa: E731
    latency = [
        {
            "service": name,
            "avg_gateway_to_service_ms": avg(b["gw"]),
            "avg_service_ms": avg(b["svc"]),
            "count": len(b["gw"]) or len(b["svc"]),
        }
        for name, b in acc.items()
    ]

    # ---- Séries temporais (Loki) ----
    now = int(time.time())
    end = (now // step_s) * step_s
    n = window_s // step_s
    start = end - step_s * (n - 1)
    buckets = [start + i * step_s for i in range(n)]

    queries = {
        # Tudo o que chegou ao gateway nas rotas /api/* (forwardado OU barrado).
        "gateway": f'sum(count_over_time({{container="gateway"}} | json | uri=~"/api/.*"[{step_s}s]))',
        # Barradas pelo rate limit: 503 é label de baixa cardinalidade no gateway.
        "rate_limited": f'sum(count_over_time({{container="gateway",status="503"}}[{step_s}s]))',
        # Linhas de trace = requisições que de fato chegaram a cada serviço.
        "alunos": f'sum(count_over_time({{service="alunos"}}[{step_s}s]))',
        "cursos": f'sum(count_over_time({{service="cursos"}}[{step_s}s]))',
    }

    series = {"step_s": step_s, "buckets": buckets,
              "gateway": [], "alunos": [], "cursos": [], "rate_limited": []}
    loki_ok = True
    try:
        async with httpx.AsyncClient() as client:
            results = await asyncio.gather(
                *[_loki_series(client, q, start, end, step_s) for q in queries.values()]
            )
        data = dict(zip(queries.keys(), results))
        for key in ("gateway", "alunos", "cursos", "rate_limited"):
            series[key] = [int(data[key].get(b, 0)) for b in buckets]
    except Exception as err:  # noqa: BLE001 — Loki indisponível não pode derrubar o painel
        logger.warning("Falha ao consultar o Loki: %s", err)
        loki_ok = False
        for key in ("gateway", "alunos", "cursos", "rate_limited"):
            series[key] = [0 for _ in buckets]

    return {"latency": latency, "series": series, "loki_ok": loki_ok}


# ===================== CRUD: proxy para os serviços =====================
def _crud_base(resource: str) -> str:
    cfg = CRUD.get(resource)
    if cfg is None:
        raise HTTPException(status_code=404, detail="recurso inválido")
    return cfg["base"]


async def _proxy(method: str, url: str, json_body=None) -> Response:
    """Encaminha a chamada ao serviço e devolve a resposta como veio (status + corpo)."""
    try:
        async with httpx.AsyncClient() as client:
            r = await client.request(method, url, json=json_body, timeout=10.0)
    except Exception as err:  # noqa: BLE001
        raise HTTPException(status_code=502, detail=f"serviço indisponível: {err}")
    return Response(content=r.content, status_code=r.status_code,
                    media_type=r.headers.get("content-type", "application/json"))


@app.get("/api/manage/{resource}")
async def crud_list(resource: str):
    return await _proxy("GET", _crud_base(resource))


@app.post("/api/manage/{resource}")
async def crud_create(resource: str, request: Request):
    return await _proxy("POST", _crud_base(resource), await request.json())


@app.put("/api/manage/{resource}/{item_id}")
async def crud_update(resource: str, item_id: str, request: Request):
    return await _proxy("PUT", f"{_crud_base(resource)}/{item_id}", await request.json())


@app.delete("/api/manage/{resource}/{item_id}")
async def crud_delete(resource: str, item_id: str):
    return await _proxy("DELETE", f"{_crud_base(resource)}/{item_id}")


# Frontend React compilado (precisa ficar por último para não sombrear /api/*).
app.mount("/", StaticFiles(directory="front", html=True), name="front")
