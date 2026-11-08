import React, { useEffect, useState } from 'react';
import { Mail, Send, Loader2, CheckCircle2, AlertTriangle, X, Plus, RefreshCw, ShieldCheck, Building2, Info } from 'lucide-react';
import type { Empresa, Usuario } from '../types/index.ts';
import { apiJson } from '../lib/api.ts';

interface EstadoCorreo {
  proveedor: 'GMAIL_API' | 'RESEND' | 'SMTP' | 'SIMULADO';
  configurado: boolean;
  remitente: string | null;
  nombre_remitente: string;
  detalle: string;
  faltantes: string[];
  seguridad: { activo: boolean; avisar_admins_registro: boolean };
  eventos: { clave: 'CONCILIACION' | 'SIIGO' | 'CARGUE_FACTURAS'; nombre: string; descripcion: string }[];
}

interface ConfigEmpresa {
  id_empresa: number;
  activo: boolean;
  destinatarios: string[];
  incluir_usuarios_empresa: boolean;
  copia_a_quien_ejecuta: boolean;
  eventos: {
    CONCILIACION: { activo: boolean; solo_con_novedades: boolean; adjuntar_excel: boolean };
    SIIGO: { activo: boolean; solo_con_errores: boolean; adjuntar_informe: boolean };
    CARGUE_FACTURAS: { activo: boolean };
  };
  actualizado_por?: string;
  actualizado_en?: string;
}

interface Envio { id: string | number; fecha: string; evento: string; para: string; asunto: string; estado: 'ENVIADO' | 'ERROR' | 'SIMULADO'; proveedor: string; error?: string | null; adjuntos: number }

const NOMBRE_PROVEEDOR: Record<string, string> = { GMAIL_API: 'Gmail / Google Workspace', RESEND: 'Resend', SMTP: 'SMTP', SIMULADO: 'Sin proveedor (simulado)' };
const RE_CORREO = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;

const Interruptor: React.FC<{ activo: boolean; onChange: (v: boolean) => void; disabled?: boolean }> = ({ activo, onChange, disabled }) => (
  <button type="button" disabled={disabled} onClick={() => onChange(!activo)} className={`w-9 h-5 rounded-full relative transition shrink-0 cursor-pointer disabled:opacity-40 ${activo ? 'bg-emerald-500' : 'bg-slate-300'}`}>
    <span className={`absolute top-0.5 w-4 h-4 rounded-full bg-white shadow transition-all ${activo ? 'left-[18px]' : 'left-0.5'}`} />
  </button>
);

export const NotificacionesCorreoPanel: React.FC<{
  currentUser: Usuario | null;
  activeEmpresa: Empresa | null;
  onShowToast?: (m: string, t?: 'success' | 'info' | 'error') => void;
}> = ({ currentUser, activeEmpresa, onShowToast }) => {
  const avisar = (m: string, t: 'success' | 'info' | 'error' = 'success') => (onShowToast ? onShowToast(m, t) : alert(m));
  const esAdmin = currentUser?.rol === 'Administrador' || currentUser?.rol === 'Desarrollador' || Boolean((currentUser as any)?.permisos?.administrador);

  const [estado, setEstado] = useState<EstadoCorreo | null>(null);
  const [empresas, setEmpresas] = useState<Empresa[]>([]);
  const [idEmpresa, setIdEmpresa] = useState<number>(activeEmpresa?.id_empresa || 0);
  const [cfg, setCfg] = useState<ConfigEmpresa | null>(null);
  const [nuevoCorreo, setNuevoCorreo] = useState('');
  const [prueba, setPrueba] = useState(currentUser?.email || '');
  const [historial, setHistorial] = useState<Envio[]>([]);
  const [ocupado, setOcupado] = useState<'' | 'guardar' | 'prueba' | 'seguridad'>('');
  const [cambios, setCambios] = useState(false);

  const cargarEstado = () => apiJson<EstadoCorreo>('/api/v1/correo/estado').then(setEstado).catch(() => setEstado(null));
  const cargarHistorial = (id = idEmpresa) => apiJson<Envio[]>(`/api/v1/correo/historial?limite=60${id ? `&id_empresa=${id}` : ''}`).then(setHistorial).catch(() => setHistorial([]));

  useEffect(() => {
    cargarEstado();
    apiJson<Empresa[]>('/api/v1/empresas').then(l => {
      setEmpresas(l);
      if (!idEmpresa && l[0]) setIdEmpresa(l[0].id_empresa);
    }).catch(() => {});
  }, []);

  useEffect(() => {
    if (!idEmpresa) return;
    setCambios(false);
    apiJson<ConfigEmpresa>(`/api/v1/empresas/${idEmpresa}/notificaciones`).then(setCfg).catch(err => { setCfg(null); avisar(err.message, 'error'); });
    cargarHistorial(idEmpresa);
  }, [idEmpresa]);

  const actualizar = (parcial: Partial<ConfigEmpresa>) => { if (cfg) { setCfg({ ...cfg, ...parcial }); setCambios(true); } };
  const actualizarEvento = <K extends keyof ConfigEmpresa['eventos']>(k: K, parcial: Partial<ConfigEmpresa['eventos'][K]>) =>
    cfg && actualizar({ eventos: { ...cfg.eventos, [k]: { ...cfg.eventos[k], ...parcial } } });

  const agregarCorreos = () => {
    if (!cfg) return;
    const lista = nuevoCorreo.split(/[,;\s]+/).map(c => c.trim().toLowerCase()).filter(Boolean);
    const malos = lista.filter(c => !RE_CORREO.test(c));
    if (malos.length) { avisar(`Correo no válido: ${malos.join(', ')}`, 'error'); return; }
    actualizar({ destinatarios: [...new Set([...cfg.destinatarios, ...lista])] });
    setNuevoCorreo('');
  };

  const guardar = async () => {
    if (!cfg) return;
    setOcupado('guardar');
    try {
      const r = await apiJson<ConfigEmpresa>(`/api/v1/empresas/${idEmpresa}/notificaciones`, { method: 'PUT', body: JSON.stringify(cfg) });
      setCfg(r);
      setCambios(false);
      avisar('Notificaciones de la empresa guardadas.');
    } catch (err: any) { avisar(err.message, 'error'); } finally { setOcupado(''); }
  };

  const enviarPrueba = async () => {
    setOcupado('prueba');
    try {
      const r = await apiJson<{ mensaje: string; simulado?: boolean }>('/api/v1/correo/prueba', { method: 'POST', body: JSON.stringify({ para: prueba, id_empresa: idEmpresa || undefined }) });
      avisar(r.mensaje, r.simulado ? 'info' : 'success');
    } catch (err: any) { avisar(err.message, 'error'); } finally { setOcupado(''); cargarHistorial(); }
  };

  const guardarSeguridad = async (parcial: Partial<EstadoCorreo['seguridad']>) => {
    if (!estado) return;
    setOcupado('seguridad');
    try {
      const s = await apiJson<EstadoCorreo['seguridad']>('/api/v1/correo/seguridad', { method: 'PUT', body: JSON.stringify({ ...estado.seguridad, ...parcial }) });
      setEstado({ ...estado, seguridad: s });
    } catch (err: any) { avisar(err.message, 'error'); } finally { setOcupado(''); }
  };

  const destinatariosEfectivos = cfg ? cfg.destinatarios.length + (cfg.incluir_usuarios_empresa ? 1 : 0) + (cfg.copia_a_quien_ejecuta ? 1 : 0) : 0;

  return (
    <div className="space-y-5">
      {/* Proveedor */}
      <div className="bg-white rounded-2xl border border-slate-200 shadow-xs p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="flex items-start gap-3">
            <div className={`p-2.5 rounded-xl ${estado?.configurado ? 'bg-emerald-100 text-emerald-700' : 'bg-amber-100 text-amber-700'}`}><Mail className="w-5 h-5" /></div>
            <div>
              <div className="text-sm font-bold text-slate-800">Servidor de correo</div>
              {estado ? (
                <>
                  <div className="text-xs text-slate-600 mt-0.5">
                    <b>{NOMBRE_PROVEEDOR[estado.proveedor]}</b>{estado.remitente ? <> · envía como <span className="font-mono">{estado.nombre_remitente} &lt;{estado.remitente}&gt;</span></> : null}
                  </div>
                  <div className="text-[11px] text-slate-500 mt-1 max-w-2xl">{estado.detalle}</div>
                  {estado.faltantes.length > 0 && estado.proveedor !== 'SIMULADO' && (
                    <div className="text-[11px] text-red-700 mt-1 flex items-center gap-1"><AlertTriangle className="w-3.5 h-3.5" /> Falta definir en el servidor: {estado.faltantes.join(', ')}</div>
                  )}
                </>
              ) : <div className="text-xs text-slate-400">Consultando…</div>}
            </div>
          </div>
          <div className="flex items-center gap-2">
            <span className={`px-2.5 py-1 rounded-full text-[10px] font-bold ${estado?.configurado ? 'bg-emerald-100 text-emerald-700' : 'bg-amber-100 text-amber-800'}`}>{estado?.configurado ? 'Listo para enviar' : 'Sin configurar'}</span>
            <button onClick={() => { cargarEstado(); cargarHistorial(); }} title="Actualizar" className="p-2 rounded-lg bg-slate-100 hover:bg-slate-200 text-slate-600 cursor-pointer"><RefreshCw className="w-3.5 h-3.5" /></button>
          </div>
        </div>

        {estado && !estado.configurado && (
          <div className="mt-4 p-3.5 rounded-xl bg-indigo-50 border border-indigo-100 text-[11px] text-slate-700 space-y-1.5">
            <div className="flex items-center gap-1.5 font-bold text-[#271a82]"><Info className="w-3.5 h-3.5" /> Cómo activarlo (variables de entorno en Render → Environment)</div>
            <div><b>Opción 1, Gmail / Google Workspace</b> (recomendada; funciona en el plan gratuito de Render): <span className="font-mono">CORREO_REMITENTE</span> = el buzón que envía, más la cuenta de servicio <span className="font-mono">GOOGLE_SERVICE_ACCOUNT_JSON</span> con delegación de dominio para el permiso <span className="font-mono">https://www.googleapis.com/auth/gmail.send</span>, o un token OAuth <span className="font-mono">GMAIL_OAUTH_CLIENT_ID / _CLIENT_SECRET / _REFRESH_TOKEN</span>.</div>
            <div><b>Opción 2, Resend</b>: <span className="font-mono">RESEND_API_KEY</span> y <span className="font-mono">CORREO_REMITENTE</span> de un dominio verificado en Resend.</div>
            <div><b>Opción 3, SMTP</b> (requiere plan pago en Render, el gratuito bloquea el puerto): <span className="font-mono">SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS</span>.</div>
            <div className="text-slate-500">Opcional: <span className="font-mono">CORREO_REMITENTE_NOMBRE</span> (nombre visible) y <span className="font-mono">APP_URL</span> (botón "Abrir la Consola TLM" en los correos).</div>
          </div>
        )}

        {esAdmin && (
          <div className="mt-4 flex flex-wrap items-center gap-2">
            <span className="text-[11px] font-bold text-slate-500">Enviar correo de prueba a:</span>
            <input value={prueba} onChange={e => setPrueba(e.target.value)} placeholder="correo@empresa.com" className="flex-1 min-w-[220px] max-w-sm border border-slate-200 rounded-xl px-3 py-1.5 text-xs" />
            <button onClick={enviarPrueba} disabled={ocupado === 'prueba' || !prueba.trim()} className="flex items-center gap-1.5 px-3.5 py-1.5 rounded-xl bg-[#271a82] hover:bg-[#1c1343] text-white text-xs font-bold cursor-pointer disabled:opacity-50">
              {ocupado === 'prueba' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Send className="w-3.5 h-3.5" />} Probar
            </button>
          </div>
        )}
      </div>

      {/* Por empresa */}
      <div className="bg-white rounded-2xl border border-slate-200 shadow-xs p-5">
        <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
          <div className="flex items-center gap-2">
            <Building2 className="w-4 h-4 text-[#271a82]" />
            <span className="text-sm font-bold text-slate-800">Notificaciones de la empresa</span>
            <select value={idEmpresa} onChange={e => { if (cambios && !window.confirm('Hay cambios sin guardar. ¿Cambiar de empresa?')) return; setIdEmpresa(Number(e.target.value)); }} className="border border-slate-200 rounded-lg px-2 py-1 text-xs font-semibold">
              {empresas.map(e => <option key={e.id_empresa} value={e.id_empresa}>{e.nombre_comercial} · {e.nit}</option>)}
            </select>
          </div>
          {cfg && (
            <label className="flex items-center gap-2 text-xs font-bold text-slate-700">
              <Interruptor activo={cfg.activo} onChange={v => actualizar({ activo: v })} disabled={!esAdmin} /> {cfg.activo ? 'Activas' : 'Desactivadas'}
            </label>
          )}
        </div>

        {!cfg ? <div className="text-xs text-slate-400">Cargando…</div> : (
          <div className={`grid grid-cols-1 lg:grid-cols-2 gap-5 ${cfg.activo ? '' : 'opacity-60'}`}>
            <div>
              <div className="text-[11px] font-bold uppercase text-slate-500 mb-2">Destinatarios</div>
              <div className="flex flex-wrap gap-1.5 mb-2">
                {cfg.destinatarios.length === 0 && <span className="text-[11px] text-slate-400">Sin correos fijos.</span>}
                {cfg.destinatarios.map(c => (
                  <span key={c} className="flex items-center gap-1 pl-2.5 pr-1 py-1 rounded-full bg-indigo-50 border border-indigo-100 text-[11px] font-semibold text-[#271a82]">
                    {c}
                    {esAdmin && <button onClick={() => actualizar({ destinatarios: cfg.destinatarios.filter(x => x !== c) })} className="p-0.5 rounded-full hover:bg-indigo-100 cursor-pointer"><X className="w-3 h-3" /></button>}
                  </span>
                ))}
              </div>
              {esAdmin && (
                <div className="flex gap-2">
                  <input value={nuevoCorreo} onChange={e => setNuevoCorreo(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); agregarCorreos(); } }} placeholder="contador@empresa.com, gerencia@empresa.com" className="flex-1 border border-slate-200 rounded-xl px-3 py-1.5 text-xs" />
                  <button onClick={agregarCorreos} className="flex items-center gap-1 px-3 py-1.5 rounded-xl bg-slate-100 hover:bg-slate-200 text-slate-700 text-xs font-bold cursor-pointer"><Plus className="w-3.5 h-3.5" /> Agregar</button>
                </div>
              )}
              <label className="flex items-center gap-2 mt-3 text-xs text-slate-700">
                <Interruptor activo={cfg.incluir_usuarios_empresa} onChange={v => actualizar({ incluir_usuarios_empresa: v })} disabled={!esAdmin} /> Avisar también a los usuarios asignados a esta empresa
              </label>
              <label className="flex items-center gap-2 mt-2 text-xs text-slate-700">
                <Interruptor activo={cfg.copia_a_quien_ejecuta} onChange={v => actualizar({ copia_a_quien_ejecuta: v })} disabled={!esAdmin} /> Enviar copia a quien ejecuta la acción
              </label>
              {cfg.activo && destinatariosEfectivos === 0 && <p className="mt-2 text-[11px] text-amber-700 flex items-center gap-1"><AlertTriangle className="w-3.5 h-3.5" /> Agregue al menos un destinatario.</p>}
            </div>

            <div className="space-y-2.5">
              <div className="text-[11px] font-bold uppercase text-slate-500">Eventos</div>
              {estado?.eventos.map(ev => {
                const e: any = cfg.eventos[ev.clave];
                return (
                  <div key={ev.clave} className="p-3 rounded-xl border border-slate-200 bg-slate-50/60">
                    <label className="flex items-start gap-2.5">
                      <Interruptor activo={e.activo} onChange={v => actualizarEvento(ev.clave, { activo: v } as any)} disabled={!esAdmin} />
                      <span>
                        <span className="block text-xs font-bold text-slate-800">{ev.nombre}</span>
                        <span className="block text-[11px] text-slate-500">{ev.descripcion}</span>
                      </span>
                    </label>
                    {e.activo && ev.clave === 'CONCILIACION' && (
                      <div className="flex flex-wrap gap-4 mt-2 ml-11 text-[11px] text-slate-600">
                        <label className="flex items-center gap-1.5"><input type="checkbox" disabled={!esAdmin} checked={e.solo_con_novedades} onChange={x => actualizarEvento('CONCILIACION', { solo_con_novedades: x.target.checked })} /> Solo si hay pendientes o descuadre</label>
                        <label className="flex items-center gap-1.5"><input type="checkbox" disabled={!esAdmin} checked={e.adjuntar_excel} onChange={x => actualizarEvento('CONCILIACION', { adjuntar_excel: x.target.checked })} /> Adjuntar reporte Excel</label>
                      </div>
                    )}
                    {e.activo && ev.clave === 'SIIGO' && (
                      <div className="flex flex-wrap gap-4 mt-2 ml-11 text-[11px] text-slate-600">
                        <label className="flex items-center gap-1.5"><input type="checkbox" disabled={!esAdmin} checked={e.solo_con_errores} onChange={x => actualizarEvento('SIIGO', { solo_con_errores: x.target.checked })} /> Solo si hay rechazos</label>
                        <label className="flex items-center gap-1.5"><input type="checkbox" disabled={!esAdmin} checked={e.adjuntar_informe} onChange={x => actualizarEvento('SIIGO', { adjuntar_informe: x.target.checked })} /> Adjuntar informe Excel</label>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {cfg && esAdmin && (
          <div className="flex items-center justify-between mt-4 pt-4 border-t border-slate-100">
            <span className="text-[10px] text-slate-400">{cfg.actualizado_en ? `Última modificación: ${new Date(cfg.actualizado_en).toLocaleString('es-CO')}${cfg.actualizado_por ? ` por ${cfg.actualizado_por}` : ''}` : 'Sin cambios guardados'}</span>
            <button onClick={guardar} disabled={!cambios || ocupado === 'guardar'} className="flex items-center gap-1.5 px-4 py-2 rounded-xl bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-bold cursor-pointer disabled:opacity-50">
              {ocupado === 'guardar' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <CheckCircle2 className="w-3.5 h-3.5" />} Guardar
            </button>
          </div>
        )}
      </div>

      {/* Seguridad de cuentas */}
      {estado && (
        <div className="bg-white rounded-2xl border border-slate-200 shadow-xs p-5">
          <div className="flex items-center gap-2 mb-3"><ShieldCheck className="w-4 h-4 text-[#271a82]" /><span className="text-sm font-bold text-slate-800">Correos de seguridad de las cuentas</span><span className="text-[10px] text-slate-400">(para todas las empresas)</span></div>
          <div className="space-y-2 text-xs text-slate-700">
            <label className="flex items-start gap-2"><Interruptor activo={estado.seguridad.activo} onChange={v => guardarSeguridad({ activo: v })} disabled={!esAdmin || ocupado === 'seguridad'} /><span>Enviar al usuario su código de recuperación, la contraseña provisional, el aviso de cambio de contraseña y la aprobación de su cuenta.</span></label>
            <label className="flex items-start gap-2"><Interruptor activo={estado.seguridad.avisar_admins_registro} onChange={v => guardarSeguridad({ avisar_admins_registro: v })} disabled={!esAdmin || ocupado === 'seguridad'} /><span>Avisar a los administradores cuando alguien se registra y espera aprobación.</span></label>
          </div>
          {!estado.configurado && <p className="mt-3 text-[11px] text-amber-700">Mientras no haya servidor de correo, el código de recuperación de contraseña se muestra en pantalla (modo demostración). Al configurarlo, el código solo llega por correo.</p>}
        </div>
      )}

      {/* Historial */}
      <div className="bg-white rounded-2xl border border-slate-200 shadow-xs overflow-hidden">
        <div className="px-5 py-3 border-b border-slate-100 flex items-center justify-between">
          <span className="text-sm font-bold text-slate-800">Historial de envíos</span>
          <span className="text-[10px] text-slate-400">Últimos {historial.length}</span>
        </div>
        <div className="overflow-x-auto max-h-[380px]">
          <table className="w-full text-[11px]">
            <thead className="bg-slate-50 text-slate-500 uppercase text-[9px] sticky top-0">
              <tr><th className="text-left py-2 px-3">Fecha</th><th className="text-left">Evento</th><th className="text-left">Asunto</th><th className="text-left">Para</th><th className="text-left px-3">Estado</th></tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {historial.length === 0 && <tr><td colSpan={5} className="py-6 text-center text-slate-400">Aún no se han enviado correos.</td></tr>}
              {historial.map(h => (
                <tr key={String(h.id)}>
                  <td className="py-1.5 px-3 font-mono whitespace-nowrap text-slate-500">{new Date(h.fecha).toLocaleString('es-CO')}</td>
                  <td className="whitespace-nowrap">{h.evento}</td>
                  <td className="max-w-[280px] truncate" title={h.asunto}>{h.asunto}{h.adjuntos ? ` 📎${h.adjuntos}` : ''}</td>
                  <td className="max-w-[220px] truncate text-slate-500" title={h.para}>{h.para}</td>
                  <td className="px-3 whitespace-nowrap">
                    <span title={h.error || ''} className={`px-1.5 py-0.5 rounded text-[10px] font-bold ${h.estado === 'ENVIADO' ? 'bg-emerald-100 text-emerald-700' : h.estado === 'ERROR' ? 'bg-red-100 text-red-700' : 'bg-slate-100 text-slate-500'}`}>{h.estado}</span>
                    {h.error && <div className="text-[10px] text-red-600 max-w-[260px] truncate" title={h.error}>{h.error}</div>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
};
