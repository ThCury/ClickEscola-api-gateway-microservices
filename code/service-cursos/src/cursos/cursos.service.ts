import { Injectable, NotFoundException } from '@nestjs/common';
import { types } from 'cassandra-driver';
import { v4 as uuidv4 } from 'uuid';
import { CassandraService } from '../cassandra/cassandra.service';
import { CreateCursoDto } from './dto/create-curso.dto';

@Injectable()
export class CursosService {
  constructor(private readonly cassandra: CassandraService) {}

  async create(dto: CreateCursoDto) {
    const id = uuidv4();
    await this.cassandra.client.execute(
      'INSERT INTO cursos (id, nome, carga_horaria) VALUES (?, ?, ?)',
      [id, dto.nome, dto.carga_horaria],
      { prepare: true },
    );
    return { id, nome: dto.nome, carga_horaria: dto.carga_horaria };
  }

  async findAll() {
    const result = await this.cassandra.client.execute(
      'SELECT id, nome, carga_horaria FROM cursos',
    );
    return result.rows.map((r) => ({
      id: r.id.toString(),
      nome: r.nome,
      carga_horaria: r.carga_horaria,
    }));
  }

  async findOne(id: string) {
    let uid: types.Uuid;
    try {
      uid = types.Uuid.fromString(id);
    } catch {
      throw new NotFoundException(`Curso ${id} não encontrado`);
    }

    const result = await this.cassandra.client.execute(
      'SELECT id, nome, carga_horaria FROM cursos WHERE id = ?',
      [uid],
      { prepare: true },
    );

    const row = result.first();
    if (!row) {
      throw new NotFoundException(`Curso ${id} não encontrado`);
    }
    return {
      id: row.id.toString(),
      nome: row.nome,
      carga_horaria: row.carga_horaria,
    };
  }
}
