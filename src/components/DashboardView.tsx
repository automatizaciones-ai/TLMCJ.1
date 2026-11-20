import React, { useEffect, useState } from 'react';
import { apiJson } from '../lib/api.ts';
import { Factura } from '../types/index.ts';
import { 
  TrendingUp, 
  Receipt, 
  Percent, 
  FileCheck2, 
  UploadCloud, 
  ArrowRight, 
  Scale,
  Sparkles,
  BarChart3,
  ShieldCheck,
  Building,
  CheckCircle2
} from 'lucide-react';
import { TlmLogo } from './TlmLogo.tsx';

interface DashboardViewProps {
  facturas: Factura[];
  kpis: {
    total_compras_netas: number;
    total_iva_descontable: number;
    total_retenciones_f350: number;
    total_auditadas: number;
    tasa_auditoria: number;
  };
  onNavigate: (section: string) => void;
  onQuickUpload: () => void;
  onOpenBrandCustomizer?: () => void;
  idEmpresa?: number;
  periodo?: { desde: string; hasta: string; tipo: string };
}

interface ResumenDashboard {
  ingresos_totales: number;
  gastos_compras: number;
  margen_bruto_porc: number;
  retefuente_f350: number;
  facturas_venta: number;
  facturas_compra: number;
  serie: { periodo: string; ventas: number; compras: number }[];
  top_gasto: { tercero: string; nit: string; valor: number }[];
}

const COLOR_VENTAS = '#5145cd';
const COLOR_COMPRAS = '#c95a10';

const formatoCorto = (n: number) => {
  const a = Math.abs(n);
  if (a >= 1e9) return `$${(n / 1e9).toFixed(1)}MM`;
  if (a >= 1e6) return `$${(n / 1e6).toFixed(1)}M`;
  if (a >= 1e3) return `$${Math.round(n / 1e3)}K`;
  return `$${Math.round(n)}`;
};

/** Línea doble Ventas vs Compras con un solo eje, leyenda y tooltip por periodo. */
const GraficoEvolucion: React.FC<{ serie: ResumenDashboard['serie'] }> = ({ serie }) => {
  const [hover, setHover] = useState<number | null>(null);
  const W = 640, H = 240, izq = 56, der = 36, arr = 16, aba = 34;
  const max = Math.max(1, ...serie.flatMap(p => [p.ventas, p.compras]));
  const paso = Math.pow(10, Math.floor(Math.log10(max)));
  const tope = Math.ceil(max / paso) * paso;
  const ticks = Array.from({ length: 5 }, (_, i) => (tope / 4) * i);
  const x = (i: number) => izq + (serie.length <= 1 ? (W - izq - der) / 2 : (i * (W - izq - der)) / (serie.length - 1));
  const y = (v: number) => arr + (H - arr - aba) * (1 - v / tope);
  const ruta = (k: 'ventas' | 'compras') => serie.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)} ${y(p[k]).toFixed(1)}`).join(' ');
  const cada = Math.max(1, Math.ceil(serie.length / 7));
  if (!serie.length) return <div className="h-[240px] flex items-center justify-center text-xs text-slate-400">Sin facturas para graficar.</div>;
  return (
    <div className="relative">
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-auto" role="img" aria-label="Evolución de ingresos y egresos">
        {ticks.map(t => (
          <g key={t}>
            <line x1={izq} x2={W - der} y1={y(t)} y2={y(t)} stroke="#e5e7eb" strokeWidth={1} />
            <text x={izq - 8} y={y(t) + 3} textAnchor="end" fontSize="10" fill="#6b7280">{formatoCorto(t)}</text>
          </g>
        ))}
        {serie.map((p, i) => i % cada === 0 || i === serie.length - 1 ? (
          <text key={p.periodo} x={x(i)} y={H - 12} textAnchor="middle" fontSize="10" fill="#6b7280">{p.periodo}</text>
        ) : null)}
        {hover !== null && <line x1={x(hover)} x2={x(hover)} y1={arr} y2={H - aba} stroke="#9ca3af" strokeDasharray="3 3" />}
        <path d={ruta('compras')} fill="none" stroke={COLOR_COMPRAS} strokeWidth={2} strokeLinejoin="round" />
        <path d={ruta('ventas')} fill="none" stroke={COLOR_VENTAS} strokeWidth={2} strokeLinejoin="round" />
        {serie.map((p, i) => (
          <g key={`pt-${p.periodo}`}>
            <circle cx={x(i)} cy={y(p.compras)} r={hover === i ? 5 : 3.5} fill={COLOR_COMPRAS} stroke="#fff" strokeWidth={2} />
            <circle cx={x(i)} cy={y(p.ventas)} r={hover === i ? 5 : 3.5} fill={COLOR_VENTAS} stroke="#fff" strokeWidth={2} />
            <rect x={x(i) - (W - izq - der) / Math.max(2, serie.length) / 2} y={arr} width={(W - izq - der) / Math.max(2, serie.length)} height={H - arr - aba} fill="transparent" onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(null)} />
          </g>
        ))}
      </svg>
      {hover !== null && (
        <div className="absolute top-2 pointer-events-none bg-white border border-slate-200 shadow-lg rounded-lg px-3 py-2 text-[11px]" style={{ left: `${Math.min(70, (x(hover) / W) * 100)}%` }}>
          <div className="font-bold text-slate-800 mb-1">{serie[hover].periodo}</div>
          <div className="flex items-center gap-2 text-slate-700"><span className="w-2.5 h-2.5 rounded-full" style={{ background: COLOR_VENTAS }} />Ventas: <b>{new Intl.NumberFormat('es-CO', { style: 'currency', currency: 'COP', maximumFractionDigits: 0 }).format(serie[hover].ventas)}</b></div>
          <div className="flex items-center gap-2 text-slate-700"><span className="w-2.5 h-2.5 rounded-full" style={{ background: COLOR_COMPRAS }} />Compras: <b>{new Intl.NumberFormat('es-CO', { style: 'currency', currency: 'COP', maximumFractionDigits: 0 }).format(serie[hover].compras)}</b></div>
        </div>
      )}
    </div>
  );
};

export const DashboardView: React.FC<DashboardViewProps> = ({
  facturas,
  kpis,
  onNavigate,
  onQuickUpload,
  onOpenBrandCustomizer,
  idEmpresa,
  periodo
}) => {
  const [agrupacion, setAgrupacion] = useState<'dia' | 'quincena' | 'mes'>('quincena');
  const [resumen, setResumen] = useState<ResumenDashboard | null>(null);
  useEffect(() => {
    if (!idEmpresa) return;
    apiJson<ResumenDashboard>(`/api/v1/empresas/${idEmpresa}/dashboard?agrupacion=${agrupacion}&desde=${periodo?.desde || ''}&hasta=${periodo?.hasta || ''}&tipo=${periodo?.tipo || 'TODOS'}`).then(setResumen).catch(() => setResumen(null));
  }, [idEmpresa, agrupacion, facturas.length, periodo?.desde, periodo?.hasta, periodo?.tipo]);

  const formatCOP = (num: number) => {
    return new Intl.NumberFormat('es-CO', {
      style: 'currency',
      currency: 'COP',
      maximumFractionDigits: 0
    }).format(num || 0);
  };

  // Group expenses by account
  const accountExpenses: Record<string, { cuenta: string; label: string; total: number; count: number }> = {};
  facturas.forEach(f => {
    const c = f.cuenta_gasto || '51953001';
    let label = 'Gastos Operacionales Diversos';
    if (c === '513515') label = 'Servicios Cloud / Hosting TI';
    if (c === '511010') label = 'Honorarios Asesoría Tributaria';
    if (c === '512010') label = 'Arrendamientos Corporativos';
    if (c === '513505') label = 'Mantenimiento y Soporte TI';

    if (!accountExpenses[c]) {
      accountExpenses[c] = { cuenta: c, label, total: 0, count: 0 };
    }
    accountExpenses[c].total += f.subtotal || 0;
    accountExpenses[c].count += 1;
  });

  const sortedAccounts = Object.values(accountExpenses).sort((a, b) => b.total - a.total);

  return (
    <div className="space-y-6">
      {/* Top Banner with Official TLM Identity & Colors */}
      <div
        className="rounded-2xl p-6 text-white shadow-xl flex flex-col md:flex-row md:items-center justify-between gap-6 border border-white/15 relative overflow-hidden transition-colors duration-200"
        style={{ background: 'linear-gradient(135deg, var(--tlm-sidebar-bg, #1c1343) 0%, var(--tlm-primary, #271a82) 100%)' }}
      >
        {/* Subtle decorative glow */}
        <div className="pointer-events-none absolute -top-24 -right-12 w-96 h-96 rounded-full bg-[#fa9d1c]/15 blur-3xl"></div>
        <div className="pointer-events-none absolute -bottom-24 -left-12 w-96 h-96 rounded-full bg-[#e64519]/15 blur-3xl"></div>

        <div className="space-y-2 relative z-10">
          <div className="flex items-center gap-2">
            <span className="bg-[#e64519] text-white text-[10px] font-extrabold px-2.5 py-0.5 rounded-full uppercase tracking-wider shadow-xs">
              Sociedad BIC
            </span>
            <span className="bg-white/10 text-indigo-100 text-[10px] font-bold px-2 py-0.5 rounded-full border border-white/15">
              Metodología Ágil TLM
            </span>
            <span className="text-xs text-indigo-200 font-medium hidden sm:inline">
              Periodo Gravable 2026
            </span>
          </div>

          <div className="flex items-center gap-3">
            <h3 className="text-2xl sm:text-3xl font-black tracking-tight" style={{ fontFamily: "'Catamaran', sans-serif" }}>
              Consola TLM Enterprise
            </h3>
          </div>

        </div>

        <div className="flex items-center gap-2.5 relative z-10 flex-wrap">
          <button
            onClick={onQuickUpload}
            className="flex items-center gap-2 px-4 py-2.5 rounded-xl bg-[#e64519] hover:bg-[#c43610] text-white font-bold text-xs shadow-lg transition active:scale-95 cursor-pointer"
          >
            <UploadCloud className="w-4 h-4" />
            Cargar Facturas Demo
          </button>
          <button
            onClick={() => onNavigate('conciliacion')}
            className="flex items-center gap-2 px-4 py-2.5 rounded-xl bg-white/10 hover:bg-white/20 text-white font-bold text-xs border border-white/20 transition active:scale-95 cursor-pointer backdrop-blur-xs"
          >
            <Scale className="w-4 h-4 text-[#fa9d1c]" />
            Conciliación Bancaria
          </button>
        </div>
      </div>

      {/* Indicadores directivos (ventas vs compras de la empresa activa) */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-5">
        <div className="bg-white rounded-2xl p-5 border border-slate-200 shadow-xs relative overflow-hidden">
          <div className="absolute top-0 left-0 bottom-0 w-1 bg-emerald-500"></div>
          <div className="text-[11px] font-bold text-slate-500 uppercase tracking-wider">Ingresos totales</div>
          <div className="text-2xl font-black text-emerald-600 tracking-tight mt-1">{formatCOP(resumen?.ingresos_totales ?? 0)}</div>
          <span className="inline-flex items-center gap-1 mt-2 px-2 py-0.5 rounded-md bg-emerald-50 text-emerald-700 text-[10px] font-bold"><TrendingUp className="w-3 h-3" /> Facturación emitida · {resumen?.facturas_venta ?? 0} fact.</span>
        </div>
        <div className="bg-white rounded-2xl p-5 border border-slate-200 shadow-xs relative overflow-hidden">
          <div className="absolute top-0 left-0 bottom-0 w-1 bg-red-500"></div>
          <div className="text-[11px] font-bold text-slate-500 uppercase tracking-wider">Gastos / Compras</div>
          <div className="text-2xl font-black text-red-600 tracking-tight mt-1">{formatCOP(resumen?.gastos_compras ?? kpis.total_compras_netas)}</div>
          <span className="inline-flex items-center gap-1 mt-2 px-2 py-0.5 rounded-md bg-red-50 text-red-700 text-[10px] font-bold"><Receipt className="w-3 h-3" /> Egresos deducibles · {resumen?.facturas_compra ?? facturas.length} fact.</span>
        </div>
        <div className="bg-white rounded-2xl p-5 border border-slate-200 shadow-xs relative overflow-hidden">
          <div className="absolute top-0 left-0 bottom-0 w-1 bg-[#271a82]"></div>
          <div className="text-[11px] font-bold text-slate-500 uppercase tracking-wider">Margen bruto</div>
          <div className="text-2xl font-black text-[#271a82] tracking-tight mt-1">{resumen && resumen.ingresos_totales > 0 ? `${resumen.margen_bruto_porc.toLocaleString('es-CO', { maximumFractionDigits: 1 })}%` : '—'}</div>
          <span className="inline-flex items-center gap-1 mt-2 px-2 py-0.5 rounded-md bg-indigo-50 text-[#271a82] text-[10px] font-bold"><Percent className="w-3 h-3" /> Utilidad bruta operativa</span>
        </div>
        <div className="bg-white rounded-2xl p-5 border border-slate-200 shadow-xs relative overflow-hidden">
          <div className="absolute top-0 left-0 bottom-0 w-1 bg-[#fa9d1c]"></div>
          <div className="text-[11px] font-bold text-slate-500 uppercase tracking-wider">Retefuente F350</div>
          <div className="text-2xl font-black text-slate-800 tracking-tight mt-1">{formatCOP(resumen?.retefuente_f350 ?? kpis.total_retenciones_f350)}</div>
          <span className="inline-flex items-center gap-1 mt-2 px-2 py-0.5 rounded-md bg-amber-50 text-amber-800 text-[10px] font-bold"><FileCheck2 className="w-3 h-3" /> Impuesto retenido a terceros</span>
        </div>
      </div>

      {/* Gráficos */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div className="bg-white rounded-2xl border border-slate-200 shadow-xs p-5">
          <div className="flex items-center justify-between mb-2">
            <h4 className="font-bold text-slate-800 text-sm">Evolución de Ingresos y Egresos</h4>
            <div className="flex bg-slate-100 rounded-lg p-0.5 text-[11px] font-semibold">
              {(['dia', 'quincena', 'mes'] as const).map(a => (
                <button key={a} onClick={() => setAgrupacion(a)} className={`px-2.5 py-1 rounded-md cursor-pointer ${agrupacion === a ? 'bg-white shadow-xs text-slate-900' : 'text-slate-500'}`}>{a === 'dia' ? 'Día' : a === 'quincena' ? 'Quincena' : 'Mes'}</button>
              ))}
            </div>
          </div>
          <div className="flex items-center gap-4 text-[11px] text-slate-600 mb-1">
            <span className="flex items-center gap-1.5"><span className="w-3 h-0.5 rounded" style={{ background: COLOR_VENTAS }} />Ventas (ingresos)</span>
            <span className="flex items-center gap-1.5"><span className="w-3 h-0.5 rounded" style={{ background: COLOR_COMPRAS }} />Compras (egresos)</span>
          </div>
          <GraficoEvolucion serie={resumen?.serie || []} />
        </div>
        <div className="bg-white rounded-2xl border border-slate-200 shadow-xs p-5">
          <h4 className="font-bold text-slate-800 text-sm mb-3">Concentración de Gasto (Top 5 proveedores)</h4>
          {resumen && resumen.top_gasto.length ? (
            <div className="space-y-3">
              {resumen.top_gasto.map(t => {
                const pct = resumen.gastos_compras > 0 ? (t.valor / resumen.gastos_compras) * 100 : 0;
                return (
                  <div key={t.nit} title={`${t.tercero} · NIT ${t.nit}`}>
                    <div className="flex justify-between text-xs mb-1">
                      <span className="font-semibold text-slate-700 truncate max-w-[65%]">{t.tercero}</span>
                      <span className="text-slate-600"><b className="text-slate-800">{formatCOP(t.valor)}</b> · {pct.toLocaleString('es-CO', { maximumFractionDigits: 1 })}%</span>
                    </div>
                    <div className="h-2 bg-slate-100 rounded-full overflow-hidden"><div className="h-full rounded-full" style={{ width: `${Math.max(2, pct)}%`, background: COLOR_COMPRAS }} /></div>
                  </div>
                );
              })}
            </div>
          ) : <div className="h-[200px] flex items-center justify-center text-xs text-slate-400">Sin compras registradas.</div>}
        </div>
      </div>

      {/* Two Column Layout */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Left Column (2 cols): Recent Invoices & Audit Status */}
        <div className="lg:col-span-2 bg-white rounded-2xl border border-slate-200 shadow-xs p-5">
          <div className="flex items-center justify-between mb-4 pb-3 border-b border-slate-100">
            <div>
              <h4 className="font-bold text-[#271a82] text-base" style={{ fontFamily: "'Catamaran', sans-serif" }}>
                Últimas Facturas Registradas UBL 2.1
              </h4>
              <p className="text-xs text-slate-500">Comprobantes listos para validación y causación en Siigo</p>
            </div>
            <button
              onClick={() => onNavigate('facturas')}
              className="flex items-center gap-1.5 text-xs font-bold text-[#271a82] hover:text-[#e64519] transition cursor-pointer"
            >
              Ver todas ({facturas.length}) <ArrowRight className="w-3.5 h-3.5" />
            </button>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="bg-[#f8f9fa] text-slate-600 font-bold uppercase text-[10px]">
                <tr>
                  <th className="py-2.5 px-3">Número</th>
                  <th className="py-2.5 px-3">Proveedor / NIT</th>
                  <th className="py-2.5 px-3">Subtotal</th>
                  <th className="py-2.5 px-3">Casilla F350</th>
                  <th className="py-2.5 px-3 text-right">Estado</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {facturas.slice(0, 5).map(f => (
                  <tr key={f.id_factura} className="hover:bg-slate-50/80 transition">
                    <td className="py-3 px-3 font-bold text-slate-800">{f.factura_num}</td>
                    <td className="py-3 px-3">
                      <div className="font-semibold text-slate-800 truncate max-w-[200px]">{f.proveedor}</div>
                      <div className="text-[10px] text-slate-400 font-mono">NIT: {f.nit_tercero}</div>
                    </td>
                    <td className="py-3 px-3 font-semibold text-slate-700">{formatCOP(f.subtotal)}</td>
                    <td className="py-3 px-3">
                      <span className="px-2 py-0.5 rounded-md font-semibold text-[10px] bg-indigo-50 text-[#271a82] border border-indigo-200">
                        C.{f.casilla_350} ({f.retencion_porc}%)
                      </span>
                    </td>
                    <td className="py-3 px-3 text-right">
                      <span className={`px-2 py-0.5 rounded-full font-bold text-[10px] ${
                        f.estado_revision === 'AUDITADA'
                          ? 'bg-blue-100 text-blue-700'
                          : f.estado_revision === 'SINCRONIZADA_SIIGO'
                          ? 'bg-emerald-100 text-emerald-700'
                          : 'bg-amber-100 text-amber-800 border border-amber-200'
                      }`}>
                        {f.estado_revision}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        {/* Right Column (1 col): Expense by PUC Account */}
        <div className="bg-white rounded-2xl border border-slate-200 shadow-xs p-5 space-y-4">
          <div className="pb-3 border-b border-slate-100">
            <h4 className="font-bold text-[#271a82] text-base" style={{ fontFamily: "'Catamaran', sans-serif" }}>
              Distribución por Cuenta PUC
            </h4>
            <p className="text-xs text-slate-500">Mapeo automático de cuentas de gastos</p>
          </div>

          <div className="space-y-3">
            {sortedAccounts.map((acc) => {
              const perc = kpis.total_compras_netas > 0
                ? Math.round((acc.total / kpis.total_compras_netas) * 100)
                : 0;

              return (
                <div key={acc.cuenta} className="p-3 rounded-xl bg-[#f8f9fa] border border-slate-200/70">
                  <div className="flex items-center justify-between text-xs mb-1">
                    <span className="font-bold text-[#271a82] font-mono">{acc.cuenta}</span>
                    <span className="font-extrabold text-slate-800">{formatCOP(acc.total)}</span>
                  </div>
                  <div className="text-[11px] text-slate-600 truncate mb-2 font-medium">{acc.label}</div>
                  <div className="flex items-center justify-between text-[10px] text-slate-400">
                    <span>{acc.count} comprobantes</span>
                    <span className="font-semibold text-slate-600">{perc}% del total</span>
                  </div>
                  <div className="w-full bg-slate-200 h-1.5 rounded-full mt-1 overflow-hidden">
                    <div 
                      className="h-full rounded-full transition-colors duration-200"
                      style={{ width: `${perc}%`, background: 'linear-gradient(90deg, var(--tlm-sidebar-bg, #1c1343), var(--tlm-primary, #271a82))' }}
                    ></div>
                  </div>
                </div>
              );
            })}
          </div>

          <div className="pt-2">
            <button
              onClick={() => onNavigate('centro-fiscal')}
              className="w-full py-2.5 rounded-xl bg-[#271a82] hover:bg-[#1c1343] text-white font-bold text-xs flex items-center justify-center gap-2 transition active:scale-95 cursor-pointer shadow-sm"
            >
              Ver Liquidación Oficial F350
              <ArrowRight className="w-4 h-4 text-[#fa9d1c]" />
            </button>
          </div>
        </div>
      </div>

      {/* Official TLM Ecosystem Banner */}
      <div className="bg-[#f8f9fa] border border-slate-200 rounded-2xl p-5 flex flex-col md:flex-row items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <div className="p-2.5 rounded-xl bg-[#271a82] text-white">
            <ShieldCheck className="w-6 h-6 text-[#fa9d1c]" />
          </div>
          <div>
            <h5 className="font-bold text-slate-800 text-sm">
              Servicios Integrales TLM Get Adviced SAS BIC
            </h5>
            <p className="text-xs text-slate-500">
              Contabilidad NIIF, Revisoría Fiscal, Asesoría Tributaria y Dashboards Power BI & Looker Studio.
            </p>
          </div>
        </div>
        <div className="flex items-center gap-3">
          <a
            href="https://www.tlmcol.com/"
            target="_blank"
            rel="noreferrer"
            className="text-xs font-bold text-[#271a82] hover:text-[#e64519] underline"
          >
            Conoce más en www.tlmcol.com
          </a>
        </div>
      </div>
    </div>
  );
};
