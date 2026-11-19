import { applyDecorators } from '@nestjs/common';
import { ArrayMaxSize, IsArray, IsOptional, IsUrl } from 'class-validator';

/** Quantas fotos de prova cabem numa disputa ou numa resposta. */
export const MAX_EVIDENCE_PHOTOS = 10;

/**
 * Lista opcional de provas: endereços https de fotos já carregadas em
 * POST /disputes/upload-evidence. O serviço confirma depois que cada uma
 * está no Cloudinary do projecto, na pasta de quem a envia.
 */
export function IsEvidenceUrls() {
  return applyDecorators(
    IsOptional(),
    IsArray(),
    ArrayMaxSize(MAX_EVIDENCE_PHOTOS, {
      message: `Uma disputa leva no máximo ${MAX_EVIDENCE_PHOTOS} fotos de prova.`,
    }),
    IsUrl(
      { protocols: ['https'], require_protocol: true },
      {
        each: true,
        message:
          'Cada prova tem de ser o endereço de uma foto carregada em /disputes/upload-evidence.',
      },
    ),
  );
}
