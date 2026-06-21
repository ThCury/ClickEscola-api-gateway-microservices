# ---------- Estágio 1: build do frontend React (Vite) ----------
FROM node:20-alpine AS web
WORKDIR /web
# instala dependências primeiro (cache de camadas)
COPY react-app/package.json ./
RUN npm install
# copia o código e gera o build -> /web/front (vite outDir = ../front)
COPY react-app/ ./
RUN npm run build

# ---------- Estágio 2: API + servidor estático (FastAPI) ----------
FROM python:3.12-slim
WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY main.py .
# frontend já compilado (vite outDir=../front -> /front no estágio web), servido em /
COPY --from=web /front ./front

EXPOSE 8090

CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8090"]
