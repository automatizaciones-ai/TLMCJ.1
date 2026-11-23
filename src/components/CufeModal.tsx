import React from 'react';
import { Factura } from '../types/index.ts';
import { X, ShieldCheck, Copy } from 'lucide-react';

interface CufeModalProps {
  factura: Factura | null;
  onClose: () => void;
  onShowToast?: (message: string, type?: 'success' | 'info' | 'error') => void;
}

export const CufeModal: React.FC<CufeModalProps> = ({ factura, onClose, onShowToast }) => {
  if (!factura) return null;

  const copyToClipboard = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      if (onShowToast) onShowToast('CUFE copiado al portapapeles.');
      else alert('CUFE copiado al portapapeles.');
    } catch {
      const message = 'No se pudo copiar el CUFE al portapapeles.';
      if (onShowToast) onShowToast(message, 'error');
      else alert(message);
    }
  };

  const formatCOP = (num: number) => {
    return new Intl.NumberFormat('es-CO', {
      style: 'currency',
      currency: 'COP',
      maximumFractionDigits: 0
    }).format(num || 0);
  };

  const totalFactura = factura.total ?? factura.subtotal + factura.iva;
  const signoFactura = Math.sign(totalFactura || factura.subtotal || 1);
  const retencionFuente = Math.abs(factura.retencion_valor || 0);
  const retencionIca = Math.round(Math.abs(factura.subtotal || 0) * (factura.reteica_tarifa || 0) / 1000);
  const retencionIva = Math.round(Math.abs(factura.iva || 0) * (factura.reteiva_porc || 0) / 100);
  const impuestoConsumo = Math.abs((factura.items || []).reduce((total, item) => total + (item.inc || 0), 0));
  const netoEstimado = totalFactura - signoFactura * (retencionFuente + retencionIca + retencionIva);

  return (
    <div className="fixed inset-0 z-50 bg-slate-900/60 backdrop-blur-xs flex items-center justify-center p-4">
      <div className="bg-white rounded-2xl shadow-2xl max-w-2xl w-full max-h-[90vh] flex flex-col overflow-hidden animate-in fade-in zoom-in-95 duration-150">
        {/* Modal Header */}
        <div className="p-4 bg-[#1c1343] text-white flex items-center justify-between border-b border-indigo-900/60">
          <div className="flex items-center gap-2.5">
            <div className="bg-[#e64519] p-2 rounded-xl text-white shadow-xs">
              <ShieldCheck className="w-5 h-5 text-white" />
            </div>
            <div>
              <h3 className="font-bold text-base leading-tight">Auditoría UBL 2.1 - {factura.factura_num}</h3>
              <p className="text-xs text-indigo-200">Verificación DIAN CUFE & Metadatos Fiscales TLM</p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg bg-white/10 hover:bg-white/20 text-white transition cursor-pointer"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Modal Body */}
        <div className="p-6 space-y-5 overflow-y-auto">
          {/* CUFE Box */}
          <div className="bg-slate-50 border border-slate-200 rounded-xl p-3.5 space-y-1.5">
            <div className="flex items-center justify-between">
              <span className="text-xs font-bold text-slate-700 uppercase tracking-wider">Código Único Factura Electrónica (CUFE)</span>
              <button
                onClick={() => copyToClipboard(factura.cufe_hash)}
                className="flex items-center gap-1 text-[11px] font-semibold text-[#271a82] hover:text-[#e64519] cursor-pointer"
              >
                <Copy className="w-3.5 h-3.5" /> Copiar Hash
              </button>
            </div>
            <p className="font-mono text-xs text-slate-600 break-all bg-white p-2.5 rounded-lg border border-slate-200">
              {factura.cufe_hash}
            </p>
          </div>

          {/* Third party info */}
          <div className="grid grid-cols-2 gap-4">
            <div className="p-3 bg-slate-50 rounded-xl border border-slate-200">
              <span className="text-[11px] text-slate-500 font-semibold block uppercase">Emisor / Proveedor</span>
              <span className="text-sm font-bold text-slate-800 block truncate mt-0.5">{factura.proveedor}</span>
              <span className="text-xs text-slate-600 block">NIT: {factura.nit_tercero}</span>
              <span className="text-xs text-slate-500 block">{factura.ciudad || factura.departamento || '—'}</span>
            </div>
            <div className="p-3 bg-slate-50 rounded-xl border border-slate-200">
              <span className="text-[11px] text-slate-500 font-semibold block uppercase">Condiciones Comerciales</span>
              <span className="text-sm font-bold text-slate-800 block mt-0.5">{factura.forma_pago || '—'}</span>
              <span className="text-xs text-slate-600 block">Medio: {factura.medio_pago || '—'}</span>
              <span className="text-xs text-slate-500 block">Fecha: {factura.fecha}</span>
            </div>
          </div>

          {/* Financial Breakdown */}
          <div className="border border-slate-200 rounded-xl overflow-hidden">
            <div className="bg-slate-100/70 px-4 py-2 text-xs font-bold text-slate-700 uppercase">
              Liquidación Económica UBL 2.1
            </div>
            <div className="p-4 space-y-2 text-xs">
              <div className="flex justify-between text-slate-600">
                <span>Subtotal (Base Imponible)</span>
                <span className="font-semibold text-slate-800">{formatCOP(factura.subtotal)}</span>
              </div>
              <div className="flex justify-between text-slate-600">
                <span>IVA</span>
                <span className="font-semibold text-slate-800">{formatCOP(factura.iva)}</span>
              </div>
              {impuestoConsumo > 0 && (
                <div className="flex justify-between text-slate-600">
                  <span>Impuesto al consumo (INC)</span>
                  <span className="font-semibold text-slate-800">{formatCOP(impuestoConsumo)}</span>
                </div>
              )}
              <div className="flex justify-between text-slate-600">
                <span>Total factura</span>
                <span className="font-semibold text-slate-800">{formatCOP(totalFactura)}</span>
              </div>
              <div className="flex justify-between text-amber-700 bg-amber-50 p-1.5 rounded-lg">
                <span>Retención en la Fuente ({factura.retencion_porc}% - Casilla {factura.casilla_350})</span>
                <span className="font-bold">-{formatCOP(retencionFuente)}</span>
              </div>
              {retencionIca > 0 && (
                <div className="flex justify-between text-orange-700 bg-orange-50 p-1.5 rounded-lg">
                  <span>ReteICA ({factura.reteica_tarifa}‰)</span>
                  <span className="font-bold">-{formatCOP(retencionIca)}</span>
                </div>
              )}
              {retencionIva > 0 ? (
                <div className="flex justify-between text-purple-700 bg-purple-50 p-1.5 rounded-lg">
                  <span>ReteIVA ({factura.reteiva_porc}%)</span>
                  <span className="font-bold">-{formatCOP(retencionIva)}</span>
                </div>
              ) : null}
              <div className="pt-2 border-t border-slate-200 flex justify-between text-sm font-black text-slate-900">
                <span>Neto a Pagar Estimado</span>
                <span>{formatCOP(netoEstimado)}</span>
              </div>
            </div>
          </div>

          {/* Accounting Routing */}
          <div className="p-3 bg-indigo-50/70 border border-indigo-200 rounded-xl flex items-center justify-between text-xs">
            <div>
              <span className="font-bold text-[#271A82] block">Cuenta Contable de Gasto: {factura.cuenta_gasto}</span>
              <span className="text-indigo-700 text-[11px]">Asignada automáticamente por motor heurístico de concepto</span>
            </div>
            <span className="px-2.5 py-1 rounded-md bg-[#271A82] text-white font-bold text-[10px]">
              {factura.estado_revision}
            </span>
          </div>
        </div>

        {/* Modal Footer */}
        <div className="p-4 bg-slate-50 border-t border-slate-200 flex justify-end">
          <button
            onClick={onClose}
            className="px-4 py-2 rounded-xl bg-slate-800 hover:bg-slate-900 text-white font-semibold text-xs transition cursor-pointer"
          >
            Cerrar Detalle
          </button>
        </div>
      </div>
    </div>
  );
};
