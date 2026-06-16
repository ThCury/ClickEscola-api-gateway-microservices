-- Modelagem query-first: um keyspace por serviço, replication_factor=1 (ambiente local/dev).

-- ===== Serviço de Alunos =====
CREATE KEYSPACE IF NOT EXISTS alunos_ks
  WITH replication = {'class': 'SimpleStrategy', 'replication_factor': 1};

CREATE TABLE IF NOT EXISTS alunos_ks.alunos (
  id        uuid PRIMARY KEY,
  nome      text,
  email     text,
  matricula text
);

-- ===== Serviço de Cursos =====
CREATE KEYSPACE IF NOT EXISTS cursos_ks
  WITH replication = {'class': 'SimpleStrategy', 'replication_factor': 1};

CREATE TABLE IF NOT EXISTS cursos_ks.cursos (
  id            uuid PRIMARY KEY,
  nome          text,
  carga_horaria int
);
