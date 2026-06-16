"""Serviço de Alunos — FastAPI + Cassandra."""
import logging
import os
import time
import uuid
from contextlib import asynccontextmanager
from typing import List

from cassandra.cluster import Cluster
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s [%(name)s] %(message)s",
)
logger = logging.getLogger("service-alunos")

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
    yield
    cluster.shutdown()


app = FastAPI(title="Serviço de Alunos", version="1.0.0", lifespan=lifespan)


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
    try:
        uid = uuid.UUID(aluno_id)
    except ValueError:
        raise HTTPException(status_code=400, detail="id inválido")
    row = db["session"].execute(db["select_one"], (uid,)).one()
    if row is None:
        raise HTTPException(status_code=404, detail="aluno não encontrado")
    return AlunoOut(id=str(row.id), nome=row.nome, email=row.email, matricula=row.matricula)
