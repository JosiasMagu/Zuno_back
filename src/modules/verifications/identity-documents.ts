/** Pasta do armazenamento privado com os documentos de identidade de uma conta. */
export const identityDocumentsFolder = (userId: string) => `zuno/kyc/${userId}`;

/**
 * Só conta como documento da conta o que ela própria carregou em
 * `/users/me/verification/documents`. Sem isto, bastava conhecer o
 * identificador do documento de outra pessoa para o apresentar como seu.
 */
export function isOwnIdentityDocument(
  documentId: string,
  userId: string,
): boolean {
  const folder = `${identityDocumentsFolder(userId)}/`;

  return (
    documentId.startsWith(folder) &&
    /^[A-Za-z0-9_-]+$/.test(documentId.slice(folder.length))
  );
}
