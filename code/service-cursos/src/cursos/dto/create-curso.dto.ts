import { IsInt, IsNotEmpty, IsString, Min } from 'class-validator';

export class CreateCursoDto {
  @IsString()
  @IsNotEmpty()
  nome: string;

  @IsInt()
  @Min(1)
  carga_horaria: number;
}
