import { Transform, Type } from 'class-transformer';
import { IsInt, IsObject, IsOptional, IsString, MaxLength, Min, MinLength } from 'class-validator';

export class SubmitDocumentDto {
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  tenantId!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(200)
  documentId!: string;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  version!: number;

  @IsString()
  @MinLength(1)
  @MaxLength(300)
  title!: string;

  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(1000000)
  content?: string;

  @IsOptional()
  @Transform(({ value }) => {
    if (typeof value !== 'string') return value;
    try {
      return JSON.parse(value) as unknown;
    } catch {
      return value;
    }
  })
  @IsObject()
  metadata?: Record<string, unknown>;
}