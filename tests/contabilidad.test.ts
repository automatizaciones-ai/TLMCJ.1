import { describe, expect, test } from 'bun:test';
import { conciliar } from '../src/server/services/contabilidadService.ts';
import type { LecturaMovimientos, MovimientoNormalizado } from '../src/server/services/lectorArchivosContables.ts';

const lectura = (movimientos: MovimientoNormalizado[]): LecturaMovimientos => ({
  movimientos,
  saldo_inicial: 0,
  saldo_final: movimientos.reduce((suma, movimiento) => suma + movimiento.valor, 0),
  neto: movimientos.reduce((suma, movimiento) => suma + movimiento.valor, 0),
  advertencias: [],
  saldos_consistentes: true
});

const movimiento = (id: string, valor: number): MovimientoNormalizado => ({
  id,
  fecha: '2026-10-15',
  descripcion: id,
  valor
});

describe('conciliación bancaria', () => {
  test('identifica un pago bancario que agrupa varios registros de Siigo', () => {
    const resultado = conciliar(
      1,
      lectura([movimiento('siigo-1', -40), movimiento('siigo-2', -60)]),
      lectura([movimiento('banco-1', -100)]),
      0,
      0,
      { cruce_por_valor: false }
    );

    expect(resultado.conciliadas).toHaveLength(1);
    expect(resultado.conciliadas[0].tipo).toBe('AGRUPADA_LIBROS');
    expect(resultado.conciliadas[0].ids_libro).toEqual(['siigo-1', 'siigo-2']);
    expect(resultado.conciliadas[0].ids_banco).toEqual(['banco-1']);
    expect(resultado.faltan_en_libros).toHaveLength(0);
    expect(resultado.faltan_en_banco).toHaveLength(0);
  });

  test('encuentra la combinación más cercana entre los 18 candidatos permitidos', () => {
    const resultado = conciliar(
      1,
      lectura([4, 6, 3, 7].map((valor, indice) => movimiento(`siigo-${indice}`, -valor))),
      lectura([movimiento('banco-1', -10)]),
      0,
      0,
      { cruce_por_valor: false }
    );

    expect(resultado.conciliadas[0].ids_libro).toEqual(['siigo-0', 'siigo-1']);
  });
});
