/**
 * Casas decimais das coordenadas que saem em páginas públicas. Duas casas
 * são cerca de um quilómetro: chega para mostrar a zona e ordenar por
 * distância, sem dizer a porta onde está um equipamento caro.
 */
const PUBLIC_COORDINATE_DECIMALS = 2;

/** A coordenada arredondada à zona, ou null quando não há. */
export function approximateCoordinate(value: unknown): number | null {
  if (value === null || value === undefined) {
    return null;
  }

  const factor = 10 ** PUBLIC_COORDINATE_DECIMALS;

  return Math.round(Number(value) * factor) / factor;
}
