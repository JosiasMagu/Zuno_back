import {
  identityDocumentsFolder,
  isOwnIdentityDocument,
} from './identity-documents';

const USER_ID = 'user-1';

describe('isOwnIdentityDocument', () => {
  it('aceita o que a conta carregou na sua pasta', () => {
    const documentId = `${identityDocumentsFolder(USER_ID)}/abc123_XYZ-9`;

    expect(isOwnIdentityDocument(documentId, USER_ID)).toBe(true);
  });

  it.each([
    ['o documento de outra conta', 'zuno/kyc/user-2/abc123'],
    ['a conta cujo id começa pelo mesmo texto', 'zuno/kyc/user-10/abc123'],
    ['uma imagem de outra pasta', 'zuno/disputes/user-1/abc123'],
    ['um caminho que sobe de pasta', 'zuno/kyc/user-1/../user-2/abc123'],
    ['uma subpasta', 'zuno/kyc/user-1/outra/abc123'],
    ['a pasta sem ficheiro', 'zuno/kyc/user-1/'],
    ['um endereço em vez de identificador', 'https://exemplo.com/bi.jpg'],
  ])('recusa %s', (_label, documentId) => {
    expect(isOwnIdentityDocument(documentId, USER_ID)).toBe(false);
  });
});
