import { describe, expect, test } from 'bun:test';
import {
  crearTokenAprobacion,
  huellaCorreo,
  verificarTokenAprobacion,
  VIGENCIA_ENLACE_MS
} from '../src/server/services/aprobacionToken.ts';

describe('enlaces firmados de aprobación', () => {
  test('firma acción, usuario y huella del correo', () => {
    const ahora = Date.now();
    const token = crearTokenAprobacion(7, 'Ana@Example.com', 'aprobar', ahora);
    expect(verificarTokenAprobacion(token, ahora)).toEqual({
      accion: 'aprobar',
      idUsuario: 7,
      huella: huellaCorreo('ana@example.com')
    });
  });

  test('rechaza tokens alterados, malformados y vencidos', () => {
    const ahora = Date.now();
    const token = crearTokenAprobacion(7, 'ana@example.com', 'rechazar', ahora);
    const [payload, firma] = token.split('.');
    const texto = Buffer.from(payload, 'base64url').toString('utf8');
    const alterado = `${Buffer.from(texto.replace('rechazar', 'aprobar')).toString('base64url')}.${firma}`;

    expect(verificarTokenAprobacion(alterado, ahora)).toBeNull();
    expect(verificarTokenAprobacion(token, ahora + VIGENCIA_ENLACE_MS)).toBeNull();
    expect(verificarTokenAprobacion('not-a-token')).toBeNull();
    expect(verificarTokenAprobacion(null)).toBeNull();
  });
});
