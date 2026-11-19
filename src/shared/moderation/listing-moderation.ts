/**
 * Moderação dos anúncios, igual para equipamentos e serviços. Um anúncio só
 * fica público depois de um admin o aprovar. Estas regras dizem quando uma
 * edição o devolve à revisão e o que continua a funcionar entretanto.
 */

/** Os estados de um anúncio. São os mesmos em EquipmentStatus e ServiceStatus. */
export const ListingStatus = {
  PENDING_REVIEW: 'PENDING_REVIEW',
  ACTIVE: 'ACTIVE',
  PAUSED: 'PAUSED',
  REJECTED: 'REJECTED',
  DELETED: 'DELETED',
} as const;

export type ListingStatusValue =
  (typeof ListingStatus)[keyof typeof ListingStatus];

/**
 * Quem está a mexer no anúncio:
 * - `admin` é quem modera, por isso o que edita não volta à revisão;
 * - `trusted-owner` é um dono que publica sem revisão (provider verificado,
 *   ou auto-aprovação ligada no ambiente);
 * - `owner` é qualquer outro dono.
 */
export type ListingEditor = 'admin' | 'trusted-owner' | 'owner';

export interface ListingEdit {
  status: ListingStatusValue;
  editor: ListingEditor;
  /** A edição muda alguma coisa no anúncio. */
  changed: boolean;
  /**
   * A edição muda o que um admin aprovou: título, descrição, categoria ou
   * fotos novas. Preço, depósito, quantidade e localização não contam.
   */
  moderatedContentChanged: boolean;
}

/**
 * O anúncio volta à revisão depois desta edição?
 *
 * Um anúncio rejeitado volta sempre que o dono lhe muda alguma coisa: é a
 * forma de pedir nova revisão, e vale também para um dono de confiança,
 * porque foi um admin que o rejeitou. Um anúncio activo só volta quando muda
 * o conteúdo aprovado, para ninguém aprovar uma betoneira e publicar outra
 * coisa.
 */
export function returnsToReview(edit: ListingEdit): boolean {
  if (edit.editor === 'admin') {
    return false;
  }

  if (edit.status === ListingStatus.REJECTED) {
    return edit.changed;
  }

  return (
    edit.status === ListingStatus.ACTIVE &&
    edit.editor === 'owner' &&
    edit.moderatedContentChanged
  );
}

/**
 * O que já estava em curso num anúncio continua enquanto ele está em revisão.
 * Só se reserva ou se pede um anúncio activo, por isso uma reserva ou um
 * pedido sobre um anúncio em revisão nasceu quando ele estava aprovado.
 * Rejeitado, pausado ou removido, o anúncio já não leva trabalho adiante.
 */
export function carriesOnWork(status: ListingStatusValue): boolean {
  return (
    status === ListingStatus.ACTIVE || status === ListingStatus.PENDING_REVIEW
  );
}

function sameValue(current: unknown, next: unknown): boolean {
  if (typeof next === 'number') {
    // Os valores em dinheiro e as coordenadas chegam da base como Decimal.
    return (
      current !== null && current !== undefined && Number(current) === next
    );
  }

  return current === next;
}

/**
 * Os campos de `patch` que mudam mesmo o valor guardado em `current`. A app
 * envia o formulário inteiro em cada gravação, por isso um campo presente no
 * pedido não quer dizer que mudou. Um campo `undefined` não foi enviado.
 */
export function changedFields<K extends string>(
  current: Record<K, unknown>,
  patch: Partial<Record<K, unknown>>,
): K[] {
  return (Object.keys(patch) as K[]).filter(
    (field) =>
      patch[field] !== undefined && !sameValue(current[field], patch[field]),
  );
}
