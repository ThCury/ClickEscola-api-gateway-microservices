"""Serviço de Alunos — FastAPI + Cassandra."""
import json
import logging
import os
import time
import uuid
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from typing import List
from zoneinfo import ZoneInfo

from cassandra.cluster import Cluster
from cassandra.util import uuid_from_time
from fastapi import FastAPI, HTTPException, Request, Response
from pydantic import BaseModel, Field

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s [%(name)s] %(message)s",
)
logger = logging.getLogger("service-alunos")

# Logger dedicado que emite UMA linha JSON pura por trace (consumida pelo Loki/Grafana).
trace_logger = logging.getLogger("trace")
trace_logger.propagate = False
if not trace_logger.handlers:
    _h = logging.StreamHandler()
    _h.setFormatter(logging.Formatter("%(message)s"))
    trace_logger.addHandler(_h)
    trace_logger.setLevel(logging.INFO)

SERVICE_NAME = "alunos"
ROUTE = "/api/alunos"
TZ_BH = ZoneInfo("America/Sao_Paulo")  # fuso de Belo Horizonte


def _local_str(epoch: float) -> str:
    """Formata o instante no fuso de Belo Horizonte: 'YYYY-MM-DD HH:MM:SS.mmm'."""
    dt = datetime.fromtimestamp(epoch, TZ_BH)
    return dt.strftime("%Y-%m-%d %H:%M:%S.") + f"{dt.microsecond // 1000:03d}"

CASSANDRA_HOSTS = os.getenv("CASSANDRA_HOSTS", "cassandra").split(",")
CASSANDRA_PORT = int(os.getenv("CASSANDRA_PORT", "9042"))
KEYSPACE = os.getenv("CASSANDRA_KEYSPACE", "alunos_ks")

# Estado compartilhado (cluster/sessão e prepared statements).
db: dict = {}


# ---------- Modelos Pydantic (validação) ----------
class AlunoIn(BaseModel):
    nome: str = Field(..., min_length=1, examples=["Maria Silva"])
    email: str = Field(..., min_length=3, examples=["maria@escola.edu"])
    matricula: str = Field(..., min_length=1, examples=["2024001"])


class AlunoOut(AlunoIn):
    id: str


# ---------- Conexão com retry/backoff (mesmo com healthcheck, é a falha mais comum) ----------
def connect_with_retry(retries: int = 12, backoff: float = 3.0):
    last_err = None
    for attempt in range(1, retries + 1):
        try:
            cluster = Cluster(CASSANDRA_HOSTS, port=CASSANDRA_PORT)
            session = cluster.connect()
            session.set_keyspace(KEYSPACE)
            logger.info("Conectado ao Cassandra (keyspace=%s)", KEYSPACE)
            return cluster, session
        except Exception as err:  # noqa: BLE001
            last_err = err
            wait = backoff * attempt
            logger.warning(
                "Falha ao conectar ao Cassandra (tentativa %d/%d): %s — aguardando %.0fs",
                attempt, retries, err, wait,
            )
            time.sleep(wait)
    raise RuntimeError(f"Não foi possível conectar ao Cassandra: {last_err}")


@asynccontextmanager
async def lifespan(app: FastAPI):
    cluster, session = connect_with_retry()
    db["cluster"] = cluster
    db["session"] = session
    db["insert"] = session.prepare(
        "INSERT INTO alunos (id, nome, email, matricula) VALUES (?, ?, ?, ?)"
    )
    db["select_all"] = session.prepare(
        "SELECT id, nome, email, matricula FROM alunos"
    )
    db["select_one"] = session.prepare(
        "SELECT id, nome, email, matricula FROM alunos WHERE id = ?"
    )
    db["update"] = session.prepare(
        "UPDATE alunos SET nome = ?, email = ?, matricula = ? WHERE id = ?"
    )
    db["delete"] = session.prepare(
        "DELETE FROM alunos WHERE id = ?"
    )
    # Contador persistente (sem TTL): total histórico por escopo.
    db["count_incr"] = session.prepare(
        "UPDATE tracing_ks.request_counters SET total = total + 1 WHERE scope = ?"
    )
    # Insert de tracing (keyspace tracing_ks, fora do keyspace do serviço).
    db["trace_insert"] = session.prepare(
        """
        INSERT INTO tracing_ks.request_traces
            (bucket, id, request_id, service, method, route, path, status,
             gateway_received, service_received, service_received_local, service_completed,
             gateway_to_service_ms, service_ms, total_ms)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """
    )
    yield
    cluster.shutdown()


app = FastAPI(title="Serviço de Alunos", version="1.0.0", lifespan=lifespan)


# ---------- Tracing: registra cada requisição (gateway -> serviço) ----------
@app.middleware("http")
async def trace_middleware(request: Request, call_next):
    if request.url.path == "/health":
        return await call_next(request)

    t_recv = time.time()          # epoch (wall clock) — para comparar com o gateway
    perf0 = time.perf_counter()   # alta resolução — para o tempo dentro do serviço
    response = await call_next(request)
    service_ms = (time.perf_counter() - perf0) * 1000.0
    t_done = time.time()

    try:
        rid = request.headers.get("x-request-id", "")
        gw_raw = request.headers.get("x-request-start")
        gw_ms = float(gw_raw) * 1000.0 if gw_raw else None  # $msec vem em segundos.ms
        recv_ms = t_recv * 1000.0
        done_ms = t_done * 1000.0
        gw_to_svc_ms = (recv_ms - gw_ms) if gw_ms is not None else None
        total_ms = (done_ms - gw_ms) if gw_ms is not None else service_ms

        sess, ins = db.get("session"), db.get("trace_insert")
        if sess is not None and ins is not None:
            # Total histórico (não expira): incrementa 'all' e o próprio serviço.
            incr = db.get("count_incr")
            if incr is not None:
                sess.execute_async(incr, ("all",))
                sess.execute_async(incr, (SERVICE_NAME,))
            sess.execute_async(ins, (
                "all",
                uuid_from_time(t_recv),
                rid,
                SERVICE_NAME,
                request.method,
                ROUTE,
                request.url.path,
                response.status_code,
                datetime.fromtimestamp(gw_ms / 1000.0, timezone.utc) if gw_ms else None,
                datetime.fromtimestamp(t_recv, timezone.utc),
                _local_str(t_recv),
                datetime.fromtimestamp(t_done, timezone.utc),
                gw_to_svc_ms,
                service_ms,
                total_ms,
            ))

        # Linha JSON para o Loki/Grafana.
        trace_logger.info(json.dumps({
            "evt": "trace",
            "service": SERVICE_NAME,
            "request_id": rid,
            "method": request.method,
            "route": ROUTE,
            "path": request.url.path,
            "status": response.status_code,
            "service_received_local": _local_str(t_recv),
            "gateway_to_service_ms": round(gw_to_svc_ms, 3) if gw_to_svc_ms is not None else None,
            "service_ms": round(service_ms, 3),
            "total_ms": round(total_ms, 3) if total_ms is not None else None,
        }))
    except Exception as err:  # noqa: BLE001 — tracing nunca pode derrubar a request
        logger.warning("Falha ao registrar trace: %s", err)

    return response


# ---------- Endpoints ----------
@app.get("/health")
def health():
    return {"status": "ok", "service": "alunos"}


@app.post("/alunos", response_model=AlunoOut, status_code=201)
def criar_aluno(aluno: AlunoIn):
    new_id = uuid.uuid4()
    db["session"].execute(
        db["insert"], (new_id, aluno.nome, aluno.email, aluno.matricula)
    )
    return AlunoOut(id=str(new_id), **aluno.model_dump())


@app.get("/alunos", response_model=List[AlunoOut])
def listar_alunos():
    rows = db["session"].execute(db["select_all"])
    return [
        AlunoOut(id=str(r.id), nome=r.nome, email=r.email, matricula=r.matricula)
        for r in rows
    ]


@app.get("/alunos/{aluno_id}", response_model=AlunoOut)
def obter_aluno(aluno_id: str):
    uid = _parse_uuid(aluno_id)
    row = db["session"].execute(db["select_one"], (uid,)).one()
    if row is None:
        raise HTTPException(status_code=404, detail="aluno não encontrado")
    return AlunoOut(id=str(row.id), nome=row.nome, email=row.email, matricula=row.matricula)


@app.put("/alunos/{aluno_id}", response_model=AlunoOut)
def atualizar_aluno(aluno_id: str, aluno: AlunoIn):
    uid = _parse_uuid(aluno_id)
    if db["session"].execute(db["select_one"], (uid,)).one() is None:
        raise HTTPException(status_code=404, detail="aluno não encontrado")
    db["session"].execute(db["update"], (aluno.nome, aluno.email, aluno.matricula, uid))
    return AlunoOut(id=aluno_id, **aluno.model_dump())


@app.delete("/alunos/{aluno_id}", status_code=204)
def remover_aluno(aluno_id: str):
    uid = _parse_uuid(aluno_id)
    if db["session"].execute(db["select_one"], (uid,)).one() is None:
        raise HTTPException(status_code=404, detail="aluno não encontrado")
    db["session"].execute(db["delete"], (uid,))
    return Response(status_code=204)


def _parse_uuid(value: str) -> uuid.UUID:
    try:
        return uuid.UUID(value)
    except ValueError:
        raise HTTPException(status_code=400, detail="id inválido")
