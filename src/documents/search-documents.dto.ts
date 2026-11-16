import { Type } from 'class-transformer';
import { IsInt, IsString, Max, MaxLength, Min, MinLength } from 'class-validator';

export class SearchDocumentsDto {
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  tenantId!: string;

  @IsString()
  @MinLength(2)
  @MaxLength(2000)
  query!: string;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(20)
  limit = 5;
}