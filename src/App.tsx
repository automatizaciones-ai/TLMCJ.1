/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect, useRef } from 'react';
import { Sidebar } from './components/Sidebar.tsx';
import { Header } from './components/Header.tsx';
import { DashboardView } from './components/DashboardView.tsx';
import { FacturasView, FiltrosPeriodo } from './components/FacturasView.tsx';
import { NuevaEmpresaModal } from './components/EmpresaSelector.tsx';
import { CentroFiscalView } from './components/CentroFiscalView.tsx';
import { ConciliacionView } from './components/ConciliacionView.tsx';
import { CerebroContableView } from './components/CerebroContableView.tsx';
import { AccesosView } from './components/AccesosView.tsx';
import { BaseDatosCloudView } from './components/BaseDatosCloudView.tsx';
import { ArquitecturaView } from './components/ArquitecturaView.tsx';
import { CufeModal } from './components/CufeModal.tsx';
import { SiigoPushModal } from './components/SiigoPushModal.tsx';
import { BrandCustomizerModal } from './components/BrandCustomizerModal.tsx';
import { AuthModal } from './components/AuthModal.tsx';
import { TlmLogo } from './components/TlmLogo.tsx';
import { Empresa, Usuario, PermisosUsuario, Factura, CuentaPUC, BalanceTercero, F350Report, ConciliacionSummary } from './types/index.ts';

const MAX_ARCHIVOS_POR_LOTE = 25;
const MAX_BYTES_POR_LOTE = 20 * 1024 * 1024;
const MAX_BYTES_POR_GRUPO = 50 * 1024 * 1024;
type ResultadoCargaLote = {
  detail?: string;
  archivos_procesados?: number;
  xmls_extraidos?: number;
  facturas_creadas?: number;
  facturas_duplicadas?: number;
  facturas_nuevas?: number;
  pdfs_originales?: number;
  ventas?: number;
  compras?: number;
  archivados?: { ok: boolean }[];
};

function crearLotesArchivos(files: FileList): File[][] {
  const grupos = new Map<string, File[]>();
  for (const file of Array.from(files)) {
    const nombreBase = file.name.toLowerCase().replace(/\.[^.]+$/, '').replace(/[^a-z0-9]/g, '');
    const grupo = grupos.get(nombreBase) || [];
    grupo.push(file);
    grupos.set(nombreBase, grupo);
  }

  const lotes: File[][] = [];
  let lote: File[] = [];
  let bytesLote = 0;
  const guardarLote = () => {
    if (lote.length) lotes.push(lote);
    lote = [];
    bytesLote = 0;
  };

  for (const grupo of grupos.values()) {
    const bytesGrupo = grupo.reduce((total, file) => total + file.size, 0);
    if (grupo.length <= MAX_ARCHIVOS_POR_LOTE && bytesGrupo <= MAX_BYTES_POR_GRUPO) {
      if (lote.length && (lote.length + grupo.length > MAX_ARCHIVOS_POR_LOTE || bytesLote + bytesGrupo > MAX_BYTES_POR_LOTE)) {
        guardarLote();
      }
      lote.push(...grupo);
      bytesLote += bytesGrupo;
      continue;
    }

    guardarLote();
    for (const file of grupo) {
      if (lote.length && (lote.length >= MAX_ARCHIVOS_POR_LOTE || bytesLote + file.size > MAX_BYTES_POR_LOTE)) guardarLote();
      lote.push(file);
      bytesLote += file.size;
    }
  }
  guardarLote();
  return lotes;
}

export default function App() {
  const [currentSection, setCurrentSection] = useState<string>('dashboard');
  const [sidebarCollapsed, setSidebarCollapsed] = useState<boolean>(false);
  const [isRefreshing, setIsRefreshing] = useState<boolean>(false);
  const [isBrandModalOpen, setIsBrandModalOpen] = useState<boolean>(false);
  const [isAuthModalOpen, setIsAuthModalOpen] = useState<boolean>(false);
  const [primaryColor, setPrimaryColor] = useState<string>(() => {
    return localStorage.getItem('tlm_primary_color') || '#271a82';
  });
  const [sidebarColor, setSidebarColor] = useState<string>(() => {
    return localStorage.getItem('tlm_sidebar_color') || '#1c1343';
  });
  const [customLogoUrl, setCustomLogoUrl] = useState<string | null>(() => {
    return localStorage.getItem('tlm_custom_logo') || null;
  });

  const [currentUser, setCurrentUser] = useState<Usuario | null>(() => {
    try {
      const savedUser = localStorage.getItem('tlm_current_user');
      const savedTimestamp = localStorage.getItem('tlm_session_timestamp');
      const SESSION_DURATION_MS = 8 * 60 * 60 * 1000; // 8 horas
      if (savedUser && savedTimestamp) {
        const elapsed = Date.now() - Number(savedTimestamp);
        if (elapsed < SESSION_DURATION_MS) {
          return JSON.parse(savedUser);
        } else {
          localStorage.removeItem('tlm_current_user');
          localStorage.removeItem('tlm_current_user_id');
          localStorage.removeItem('tlm_session_timestamp');
        }
      }
    } catch (e) {}
    return null;
  });

  // Cierra la sesión en el servidor (borra la cookie) y luego en la interfaz
  const cerrarSesion = async () => {
    await fetch('/api/v1/auth/logout', { method: 'POST' }).catch(() => undefined);
    handleSelectUser(null);
    setIsAuthModalOpen(true);
  };

  const handleSelectUser = (u: Usuario | null) => {
    setCurrentUser(u);
    setIsAuthModalOpen(false);
    if (u) {
      localStorage.setItem('tlm_current_user_id', u.id_usuario.toString());
      localStorage.setItem('tlm_current_user', JSON.stringify(u));
      localStorage.setItem('tlm_session_timestamp', Date.now().toString());
    } else {
      localStorage.removeItem('tlm_current_user_id');
      localStorage.removeItem('tlm_current_user');
      localStorage.removeItem('tlm_session_timestamp');
    }
  };

  useEffect(() => {
    document.documentElement.style.setProperty('--tlm-primary', primaryColor);
    document.documentElement.style.setProperty('--tlm-sidebar-bg', sidebarColor);
  }, [primaryColor, sidebarColor]);

  const handleSaveCustomLogo = async (
    url: string | null, 
    variantTitle?: string, 
    primaryColorHex?: string,
    sidebarColorHex?: string
  ) => {
    setCustomLogoUrl(url);
    const newColor = primaryColorHex || primaryColor;
    const newSidebarColor = sidebarColorHex || sidebarColor;

    if (primaryColorHex) {
      setPrimaryColor(primaryColorHex);
      localStorage.setItem('tlm_primary_color', primaryColorHex);
      document.documentElement.style.setProperty('--tlm-primary', primaryColorHex);
    }

    if (sidebarColorHex) {
      setSidebarColor(sidebarColorHex);
      localStorage.setItem('tlm_sidebar_color', sidebarColorHex);
      document.documentElement.style.setProperty('--tlm-sidebar-bg', sidebarColorHex);
    }

    if (url) {
      localStorage.setItem('tlm_custom_logo', url);
      showToast(`¡${variantTitle || 'Logotipo corporativo'} y colores aplicados con éxito!`);
    } else {
      localStorage.removeItem('tlm_custom_logo');
      showToast(`¡Identidad oficial TLM y colores aplicados con éxito!`);
    }

    try {
      await fetch('/api/v1/sistema/branding', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          customLogoUrl: url,
          variantTitle,
          temaAcento: newColor,
          sidebarColor: newSidebarColor,
          autor_nombre: currentUser?.nombre_completo || 'Juan Yaya - Administrador Maestro'
        })
      });
    } catch (err) {
      console.warn('Error sincronizando branding con el servidor:', err);
    }
  };

  // Core Data State
  const [empresas, setEmpresas] = useState<Empresa[]>([]);
  const [activeEmpresa, setActiveEmpresa] = useState<Empresa | null>(null);
  const [usuarios, setUsuarios] = useState<Usuario[]>([]);
  const [facturas, setFacturas] = useState<Factura[]>([]);
  const [cuentasPUC, setCuentasPUC] = useState<CuentaPUC[]>([]);
  const [balanceTerceros, setBalanceTerceros] = useState<BalanceTercero[]>([]);
  const [kpis, setKpis] = useState({
    total_compras_netas: 0,
    total_iva_descontable: 0,
    total_retenciones_f350: 0,
    total_auditadas: 0,
    tasa_auditoria: 0
  });
  const [f350Report, setF350Report] = useState<F350Report | null>(null);
  const [conciliacionSummary, setConciliacionSummary] = useState<ConciliacionSummary | null>(null);
  const [isConciliating, setIsConciliating] = useState<boolean>(false);

  // Modal State
  const [selectedCufeFactura, setSelectedCufeFactura] = useState<Factura | null>(null);
  const [siigoPushFacturas, setSiigoPushFacturas] = useState<Factura[] | null>(null);

  // Notification Toast State
  const [filtrosPeriodo, setFiltrosPeriodo] = useState<FiltrosPeriodo>({ desde: '', hasta: '', tipo: 'TODOS' });
  const [nuevaEmpresaAbierta, setNuevaEmpresaAbierta] = useState(false);
  const [toast, setToast] = useState<{ message: string; type: 'success' | 'info' | 'error' } | null>(null);

  const showToast = (message: string, type: 'success' | 'info' | 'error' = 'success') => {
    setToast({ message, type });
    setTimeout(() => {
      setToast(null);
    }, 4000);
  };

  const loadData = async () => {
    setIsRefreshing(true);
    try {
      // 1. Fetch Empresas
      const resEmpresas = await fetch('/api/v1/empresas', { headers: { 'x-tlm-user-id': String(currentUser?.id_usuario || '') } });
      const dataEmpresas = await resEmpresas.json();
      const uniqueEmpresas = (Array.isArray(dataEmpresas) ? dataEmpresas : []).filter(
        (e: Empresa, index: number, self: Empresa[]) => index === self.findIndex((t) => t.id_empresa === e.id_empresa)
      );
      setEmpresas(uniqueEmpresas);
      let empresaVigente = activeEmpresa && uniqueEmpresas.find((e: Empresa) => e.id_empresa === activeEmpresa.id_empresa);
      if (!empresaVigente && uniqueEmpresas.length > 0) {
        let guardada: string | null = null;
        try { guardada = localStorage.getItem('tlm_empresa_activa'); } catch {}
        empresaVigente = uniqueEmpresas.find((e: Empresa) => String(e.id_empresa) === guardada) || uniqueEmpresas[0];
        setActiveEmpresa(empresaVigente);
        // el efecto dependiente de la empresa volverá a cargar sus datos
        if (empresaVigente.id_empresa !== activeEmpresa?.id_empresa) return;
      }
      if (!empresaVigente) {
        setActiveEmpresa(null);
        setFacturas([]);
        return;
      }

      // 2. Fetch Facturas
      const empId = empresaVigente.id_empresa;
      const resFacturas = await fetch(`/api/v1/facturas?id_empresa=${empId}`);
      const dataFacturas = await resFacturas.json();
      const uniqueFacturas = (Array.isArray(dataFacturas) ? dataFacturas : []).filter(
        (f: Factura, index: number, self: Factura[]) => index === self.findIndex((t) => t.id_factura === f.id_factura)
      );
      setFacturas(uniqueFacturas);

      // 3. Fetch KPIs
      const resKpis = await fetch(`/api/v1/facturas/kpis/resumen?id_empresa=${empId}`);
      const dataKpis = await resKpis.json();
      setKpis(dataKpis);

      // 4. Fetch Cuentas PUC & Balance
      const resPuc = await fetch(`/api/v1/contabilidad/puc?id_empresa=${empId}`);
      const dataPuc = await resPuc.json();
      setCuentasPUC(Array.isArray(dataPuc) ? dataPuc : []);

      const resBalance = await fetch(`/api/v1/contabilidad/balance?id_empresa=${empId}`);
      const dataBalance = await resBalance.json();
      setBalanceTerceros(Array.isArray(dataBalance) ? dataBalance : []);

      // 5. Fetch F350 Report
      const resF350 = await fetch(`/api/v1/impuestos/f350?id_empresa=${empId}&desde=${filtrosPeriodo.desde}&hasta=${filtrosPeriodo.hasta}`);
      const dataF350 = await resF350.json();
      setF350Report(dataF350);

      // 6. Fetch Usuarios
      const resUsuarios = await fetch('/api/v1/auth/usuarios');
      const dataUsuarios = await resUsuarios.json();
      const uniqueUsuarios = (Array.isArray(dataUsuarios) ? dataUsuarios : []).filter(
        (u: Usuario, index: number, self: Usuario[]) => index === self.findIndex((t) => t.id_usuario === u.id_usuario)
      );
      setUsuarios(uniqueUsuarios);

      // 7. Initial Conciliacion run
      const resConcil = await fetch('/api/v1/conciliacion/ejecutar', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tolerancia: 0 })
      });
      const dataConcil = await resConcil.json();
      setConciliacionSummary(dataConcil);

      // 8. Fetch Branding Config & Primary/Sidebar Colors
      try {
        const resBranding = await fetch('/api/v1/sistema/branding');
        if (resBranding.ok) {
          const dataBranding = await resBranding.json();
          if (dataBranding) {
            if (dataBranding.customLogoUrl !== undefined && !localStorage.getItem('tlm_custom_logo')) {
              setCustomLogoUrl(dataBranding.customLogoUrl);
            }
            if (dataBranding.temaAcento && !localStorage.getItem('tlm_primary_color')) {
              setPrimaryColor(dataBranding.temaAcento);
              document.documentElement.style.setProperty('--tlm-primary', dataBranding.temaAcento);
            }
            if (dataBranding.sidebarColor && !localStorage.getItem('tlm_sidebar_color')) {
              setSidebarColor(dataBranding.sidebarColor);
              document.documentElement.style.setProperty('--tlm-sidebar-bg', dataBranding.sidebarColor);
            }
          }
        }
      } catch (e) {
        // Fallback to local storage
      }

    } catch (err) {
      console.error("Error cargando datos de la Consola TLM:", err);
    } finally {
      setIsRefreshing(false);
    }
  };

  // Solicitudes de acceso: el administrador recibe el aviso dentro de la app (cada 60 s)
  const pendientesVistos = useRef<Set<number> | null>(null);
  useEffect(() => {
    if (currentUser?.rol !== 'Administrador') return;
    const revisar = async () => {
      try {
        const res = await fetch('/api/v1/auth/usuarios');
        const lista: Usuario[] = await res.json();
        if (!Array.isArray(lista)) return;
        const pendientes = lista.filter(u => !u.activo);
        if (pendientesVistos.current) {
          pendientes
            .filter(u => !pendientesVistos.current!.has(u.id_usuario))
            .forEach(u => showToast(`Nueva solicitud de acceso: ${u.nombre_completo}`, 'info'));
        }
        pendientesVistos.current = new Set(pendientes.map(u => u.id_usuario));
        setUsuarios(lista);
      } catch { /* sin conexión: se reintenta en el siguiente ciclo */ }
    };
    revisar();
    const intervalo = setInterval(revisar, 60000);
    return () => clearInterval(intervalo);
  }, [currentUser?.id_usuario]);

  // Al abrir la página: recupera la sesión existente o muestra el inicio de sesión
  useEffect(() => {
    fetch('/api/v1/auth/sesion')
      .then(res => (res.ok ? res.json() : null))
      .then(user => {
        if (user) handleSelectUser(user);
        else setIsAuthModalOpen(true);
      })
      .catch(() => setIsAuthModalOpen(true));
  }, []);

  useEffect(() => {
    if (currentUser) loadData();
  }, [activeEmpresa?.id_empresa, currentUser?.id_usuario]);

  useEffect(() => {
    if (activeEmpresa) { try { localStorage.setItem('tlm_empresa_activa', String(activeEmpresa.id_empresa)); } catch {} }
  }, [activeEmpresa?.id_empresa]);

  // El periodo filtra también el Formulario 350
  useEffect(() => {
    if (!currentUser || !activeEmpresa) return;
    fetch(`/api/v1/impuestos/f350?id_empresa=${activeEmpresa.id_empresa}&desde=${filtrosPeriodo.desde}&hasta=${filtrosPeriodo.hasta}`)
      .then(r => r.json()).then(setF350Report).catch(() => {});
  }, [filtrosPeriodo.desde, filtrosPeriodo.hasta]);

  const handleCrearEmpresa = async (datos: { nombre_comercial: string; nit: string; software_erp: string; logo_url?: string }) => {
    const res = await fetch('/api/v1/empresas', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-tlm-user-id': String(currentUser?.id_usuario || '') },
      body: JSON.stringify(datos)
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.detail || 'No se pudo crear la empresa.');
    const nueva: Empresa = data.empresa || data;
    setEmpresas(prev => [...prev.filter(e => e.id_empresa !== nueva.id_empresa), nueva]);
    setActiveEmpresa(nueva);
    showToast(`Cliente "${nueva.nombre_comercial}" creado. Ya puede cargar su información contable.`, 'success');
  };

  // Actions
  const handleUploadXml = async (files: FileList): Promise<{ archivos_procesados: number; xmls_extraidos: number; facturas_creadas: number; facturas_duplicadas?: number; facturas_nuevas?: number; pdfs_originales?: number }> => {
    let archivosConfirmados = 0;
    try {
      const lotes = crearLotesArchivos(files);
      const total = {
        archivos_procesados: 0,
        xmls_extraidos: 0,
        facturas_creadas: 0,
        facturas_duplicadas: 0,
        facturas_nuevas: 0,
        pdfs_originales: 0,
        ventas: 0,
        compras: 0,
        fallos_archivado: 0
      };

      for (let i = 0; i < lotes.length; i++) {
        const lote = lotes[i];
        const formData = new FormData();
        formData.append('id_empresa', (activeEmpresa?.id_empresa || 1).toString());
        lote.forEach(file => formData.append('archivos', file));

        const res = await fetch('/api/v1/facturas/upload', {
          method: 'POST',
          headers: { 'x-tlm-user-id': String(currentUser?.id_usuario || '') },
          body: formData
        });
        const responseText = await res.text();
        let data: ResultadoCargaLote;
        try {
          data = JSON.parse(responseText) as ResultadoCargaLote;
        } catch {
          data = {};
        }

        if (!res.ok) throw new Error(data.detail || `El servidor respondió con error ${res.status}.`);
        const procesados = Number(data.archivos_procesados ?? 0);
        if (procesados !== lote.length) {
          throw new Error(`El servidor recibió ${procesados} de ${lote.length} archivo(s) de este lote.`);
        }

        total.archivos_procesados += procesados;
        archivosConfirmados += procesados;
        total.xmls_extraidos += Number(data.xmls_extraidos ?? 0);
        total.facturas_creadas += Number(data.facturas_creadas ?? 0);
        total.facturas_duplicadas += Number(data.facturas_duplicadas ?? 0);
        total.facturas_nuevas += Number(data.facturas_nuevas ?? 0);
        total.pdfs_originales += Number(data.pdfs_originales ?? 0);
        total.ventas += Number(data.ventas ?? 0);
        total.compras += Number(data.compras ?? 0);
        total.fallos_archivado += (data.archivados || []).filter((a: any) => !a.ok).length;
      }

      if (total.archivos_procesados !== files.length) {
        throw new Error(`Se procesaron ${total.archivos_procesados} de ${files.length} archivos.`);
      }

      if (total.facturas_creadas > 0) {
        showToast(`Se procesaron ${total.archivos_procesados} archivo(s): ${total.facturas_creadas} facturas (${total.ventas} ventas, ${total.compras} compras)${total.fallos_archivado ? `. ${total.fallos_archivado} original(es) no se pudieron guardar en la carpeta de la empresa` : '. Originales guardados en la carpeta de la empresa'}.`, total.fallos_archivado ? 'info' : 'success');
      } else {
        showToast(`Se procesaron ${total.archivos_procesados} archivo(s), pero no se detectaron nuevas facturas válidas.`, 'info');
      }
      await loadData();
      return {
        ...total
      };
    } catch (err) {
      const detalle = err instanceof Error ? err.message : 'Error desconocido.';
      showToast(`Error procesando archivos XML / ZIP (${archivosConfirmados} de ${files.length} confirmados): ${detalle}`, 'error');
      throw err instanceof Error ? err : new Error(detalle);
    }
  };

  const handleSeedDemo = async () => {
    try {
      const res = await fetch('/api/v1/facturas/seed-demo', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id_empresa: activeEmpresa?.id_empresa || 1 })
      });
      const data = await res.json();
      showToast(data.mensaje || 'Facturas demo cargadas con éxito.');
      loadData();
    } catch (err) {
      showToast('Error cargando facturas demo.', 'error');
    }
  };

  const handleImportFromGoogleDrive = async () => {
    try {
      const res = await fetch('/api/v1/sistema/google-drive-import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id_empresa: activeEmpresa?.id_empresa || 1 })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.detail || 'Error importando desde Google Drive');
      showToast(data.mensaje || '¡Factura importada exitosamente desde Google Drive!');
      loadData();
    } catch (err: any) {
      showToast(err.message || 'Error importando desde Google Drive.', 'error');
    }
  };

  const handleUpdateFactura = async (id: number, field: string, value: any) => {
    try {
      let endpoint = `/api/v1/facturas/${id}/${field}`;
      let body: any = {};

      if (field === 'estado') {
        body = { estado: value };
      } else if (field === 'cuenta') {
        body = { cuenta_gasto: value };
      } else if (field === 'retencion') {
        body = value;
      }

      await fetch(endpoint, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });

      loadData();
      showToast('Factura actualizada y recalculada en el motor fiscal.');
    } catch (err) {
      showToast('Error al actualizar factura.', 'error');
    }
  };

  const handleDeleteFactura = async (id: number) => {
    if (!confirm('¿Desea eliminar este comprobante contable?')) return;
    try {
      setFacturas(prev => prev.filter(f => f.id_factura !== id));
      const res = await fetch(`/api/v1/facturas/${id}`, { method: 'DELETE' });
      if (!res.ok) throw new Error('Error al eliminar');
      showToast('Factura eliminada.');
      await loadData();
    } catch (err) {
      showToast('Error al eliminar factura.', 'error');
      await loadData();
    }
  };

  const handleBulkDelete = async (ids: number[]) => {
    try {
      setFacturas(prev => prev.filter(f => !ids.includes(f.id_factura)));
      const res = await fetch('/api/v1/facturas/bulk-delete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids })
      });
      if (!res.ok) throw new Error('Error en borrado');
      showToast(`${ids.length} facturas eliminadas.`);
      await loadData();
    } catch (err) {
      showToast('Error en borrado masivo.', 'error');
      await loadData();
    }
  };

  const handleClearAllFacturas = async () => {
    try {
      const empId = activeEmpresa ? activeEmpresa.id_empresa : 1;
      setFacturas(prev => prev.filter(f => f.id_empresa !== empId));
      const res = await fetch(`/api/v1/facturas/limpiar-todo?id_empresa=${empId}`, { method: 'DELETE' });
      const data = await res.json();
      showToast(data.mensaje || 'Comprobantes eliminados.');
      await loadData();
    } catch (err) {
      showToast('Error limpiando facturas.', 'error');
      await loadData();
    }
  };

  const handleExecuteReconciliation = async (tolerance: number) => {
    setIsConciliating(true);
    try {
      const res = await fetch('/api/v1/conciliacion/ejecutar', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tolerancia: tolerance })
      });
      const data = await res.json();
      setConciliacionSummary(data);
      showToast(`Conciliación ejecutada con tolerancia $${tolerance} COP.`);
    } catch (err) {
      showToast('Error ejecutando conciliación.', 'error');
    } finally {
      setIsConciliating(false);
    }
  };

  const handleGenerateFlatFile = async () => {
    try {
      const res = await fetch('/api/v1/conciliacion/generar-plano-gastos', { method: 'POST' });
      const data = await res.json();
      showToast(`¡Plano contable generado con ${data.total_ajustes} asientos para Siigo Nube!`);
    } catch (err) {
      showToast('Error generando plano contable.', 'error');
    }
  };

  const handleUploadExtracto = async (file: File, banco: string, idEmpresa: number) => {
    const formData = new FormData();
    formData.append('extracto', file);
    formData.append('banco', banco);
    formData.append('id_empresa', idEmpresa.toString());
    const res = await fetch('/api/v1/conciliacion/upload-extracto', {
      method: 'POST',
      body: formData
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.detail || 'Error procesando extracto');
    showToast(data.mensaje || `Extracto de ${banco} cargado: ${data.movimientos_importados} movimientos.`);
    loadData();
    return data;
  };

  const handleApproveUser = async (id: number) => {
    try {
      setUsuarios(prev => prev.map(u => u.id_usuario === id ? { ...u, activo: true } : u));
      await fetch(`/api/v1/auth/usuarios/${id}/aprobar`, { method: 'PATCH' });
      showToast('Usuario aprobado y activado en la plataforma.');
      await loadData();
    } catch (err) {
      showToast('Error aprobando usuario.', 'error');
      await loadData();
    }
  };

  const handleDeleteUser = async (id: number) => {
    if (!confirm('¿Eliminar este usuario de la plataforma?')) return;
    try {
      setUsuarios(prev => prev.filter(u => u.id_usuario !== id));
      const res = await fetch(`/api/v1/auth/usuarios/${id}`, { method: 'DELETE' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.detail || 'Error eliminando usuario');
      showToast(data.mensaje || 'Usuario eliminado.');
      await loadData();
    } catch (err: any) {
      showToast(err.message || 'Error eliminando usuario.', 'error');
      await loadData();
    }
  };

  const handleToggleAdmin = async (id: number) => {
    try {
      const res = await fetch(`/api/v1/auth/usuarios/${id}/toggle-admin`, { method: 'PATCH' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.detail || 'Error modificando permisos de administrador');
      showToast(data.mensaje || 'Estado de administrador actualizado.');
      await loadData();
    } catch (err: any) {
      showToast(err.message || 'Error modificando estado de administrador.', 'error');
      await loadData();
    }
  };

  const handleToggleActivo = async (id: number) => {
    try {
      setUsuarios(prev => prev.map(u => u.id_usuario === id ? { ...u, activo: !u.activo } : u));
      const res = await fetch(`/api/v1/auth/usuarios/${id}/toggle-activo`, { method: 'PATCH' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.detail || 'Error al cambiar estado de acceso');
      showToast(data.mensaje || 'Estado de acceso actualizado.');
      await loadData();
    } catch (err: any) {
      showToast(err.message || 'Error al cambiar estado de acceso.', 'error');
      await loadData();
    }
  };

  const handleChangeRole = async (id: number, rol: 'Administrador' | 'Contador' | 'Analista' | 'Auditor' | 'Desarrollador') => {
    try {
      setUsuarios(prev => prev.map(u => u.id_usuario === id ? { ...u, rol } : u));
      const res = await fetch(`/api/v1/auth/usuarios/${id}/rol`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rol })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.detail || 'Error cambiando rol');
      showToast(data.mensaje || `Rol cambiado a ${rol}.`);
      await loadData();
    } catch (err: any) {
      showToast(err.message || 'Error cambiando rol.', 'error');
      await loadData();
    }
  };

  const handleUpdatePermisos = async (id: number, permisos: PermisosUsuario) => {
    try {
      const res = await fetch(`/api/v1/auth/usuarios/${id}/permisos`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ permisos })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.detail || 'Error actualizando permisos');
      showToast(data.mensaje || 'Permisos actualizados con éxito.');
      loadData();
    } catch (err: any) {
      showToast(err.message || 'Error actualizando permisos.', 'error');
    }
  };

  const handleUpdateEmpresas = async (id: number, empresas_ids: number[]) => {
    try {
      const res = await fetch(`/api/v1/auth/usuarios/${id}/empresas`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ empresas_ids })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.detail || 'Error asignando empresas');
      showToast(data.mensaje || 'Empresas autorizadas actualizadas.');
      loadData();
    } catch (err: any) {
      showToast(err.message || 'Error asignando empresas.', 'error');
    }
  };

  const handleSaveSiigoConfig = async (config: { siigo_username: string; siigo_access_key: string; siigo_document_id: number }) => {
    if (!activeEmpresa) return;
    try {
      await fetch(`/api/v1/empresas/${activeEmpresa.id_empresa}/siigo-config`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(config)
      });
      showToast('Configuración de credenciales Siigo guardada.');
      loadData();
    } catch (err) {
      showToast('Error guardando configuración.', 'error');
    }
  };

  const handleUpdateAvatar = async (id: number, avatar_url: string | null) => {
    try {
      const res = await fetch(`/api/v1/auth/usuarios/${id}/avatar`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ avatar_url })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.detail || 'Error actualizando imagen');
      showToast(data.mensaje || 'Identidad corporativa actualizada.');
      if (currentUser && currentUser.id_usuario === id) {
        setCurrentUser({ ...currentUser, avatar_url });
      }
      loadData();
    } catch (err: any) {
      showToast(err.message || 'Error al actualizar imagen corporativa.', 'error');
    }
  };

  const pendingInvoices = facturas.filter(f => f.estado_revision === 'PENDIENTE').length;

  if (!currentUser) {
    return (
      <div className="fixed inset-0 z-50 bg-gradient-to-br from-[#0f0a2e] via-[#1c1343] to-[#271a82] flex items-center justify-center p-4">
        {toast && (
          <div className={`fixed top-4 right-4 z-50 px-4 py-3 rounded-2xl shadow-xl text-xs font-bold text-white flex items-center gap-2 animate-in slide-in-from-top duration-200 ${
            toast.type === 'error' ? 'bg-red-600' : 'bg-emerald-600'
          }`}>
            <span>{toast.message}</span>
          </div>
        )}

        <div className="w-full max-w-md">
          <div className="text-center mb-6 animate-in fade-in slide-in-from-bottom duration-500">
            <div className="inline-flex items-center justify-center mb-4">
              <TlmLogo variant="full" theme="dark" size="lg" />
            </div>
            <h1 className="text-white font-black text-2xl tracking-tight">Consola TLM</h1>
            <p className="text-indigo-200/80 text-sm mt-1">Contabilidad Inteligente · Sociedad BIC</p>
          </div>

          <AuthModal
            isOpen={true}
            onClose={() => {}}
            currentUser={null}
            usuarios={usuarios.length > 0 ? usuarios : (currentUser ? [] : [])}
            onSelectUser={handleSelectUser}
            onLogout={cerrarSesion}
            onShowToast={showToast}
            onRefreshUsers={loadData}
            onUpdateAvatar={handleUpdateAvatar}
            initialTab="login"
          />
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-screen bg-[#F8F9FA] text-slate-900 font-sans antialiased overflow-hidden">
      {/* Toast Notification */}
      {nuevaEmpresaAbierta && (
        <NuevaEmpresaModal onClose={() => setNuevaEmpresaAbierta(false)} onCrear={handleCrearEmpresa} />
      )}

      {toast && (
        <div className={`fixed top-4 right-4 z-50 px-4 py-3 rounded-2xl shadow-xl text-xs font-bold text-white flex items-center gap-2 animate-in slide-in-from-top duration-200 ${
          toast.type === 'error' ? 'bg-red-600' : 'bg-[#271A82]'
        }`}>
          <span>{toast.message}</span>
        </div>
      )}

      {/* Main Collapsible Navigation Sidebar */}
      <Sidebar
        currentSection={currentSection}
        onSelectSection={setCurrentSection}
        collapsed={sidebarCollapsed}
        onToggleCollapse={() => setSidebarCollapsed(!sidebarCollapsed)}
        activeEmpresa={activeEmpresa}
        empresas={empresas}
        onSelectEmpresa={(e) => { setActiveEmpresa(e); setFacturas([]); }}
        onCrearEmpresa={() => setNuevaEmpresaAbierta(true)}
        pendingInvoicesCount={pendingInvoices}
        pendingAccesosCount={currentUser?.rol === 'Administrador' ? usuarios.filter(u => !u.activo).length : 0}
        customLogoUrl={customLogoUrl}
        currentUser={currentUser}
        primaryColor={primaryColor}
        sidebarColor={sidebarColor}
      />

      {/* Content Area */}
      <div className="flex-1 flex flex-col h-screen overflow-hidden">
        {/* Top Header */}
        <Header
          currentSection={currentSection}
          activeEmpresa={activeEmpresa}
          currentUser={currentUser}
          onRefreshData={loadData}
          isRefreshing={isRefreshing}
          onOpenBrandCustomizer={() => setIsBrandModalOpen(true)}
          onOpenAuthModal={() => setIsAuthModalOpen(true)}
          primaryColor={primaryColor}
        />

        {/* Banner de Advertencia de Cambio Obligatorio de Contraseña */}
        {currentUser?.requiere_cambio_password && (
          <div className="bg-gradient-to-r from-amber-600 via-amber-700 to-amber-800 text-white px-6 py-2.5 flex flex-col sm:flex-row sm:items-center justify-between gap-2 text-xs font-bold shadow-md shrink-0 border-b border-amber-500/50">
            <div className="flex items-center gap-2">
              <span className="w-2.5 h-2.5 rounded-full bg-white animate-pulse shrink-0"></span>
              <span>
                ⚠️ Acción de seguridad obligatoria: Has ingresado con una contraseña provisional asignada por el Administrador Maestro.
              </span>
            </div>
            <button
              onClick={() => setIsAuthModalOpen(true)}
              className="px-3.5 py-1.5 bg-white text-amber-950 font-black rounded-xl hover:bg-amber-100 transition shadow-xs cursor-pointer active:scale-95 shrink-0 self-start sm:self-auto"
            >
              Cambiar Contraseña Ahora (8+ Alfanumérica) →
            </button>
          </div>
        )}

        {/* Dynamic Main Body */}
        <main className="flex-1 overflow-y-auto p-6 lg:p-8">
          {!isRefreshing && empresas.length === 0 && (
            <div className="mb-6 bg-white border border-indigo-100 rounded-2xl p-8 text-center shadow-xs">
              <div className="text-lg font-black text-[#271a82]">Aún no tiene clientes asignados</div>
              <p className="text-sm text-slate-500 mt-1">Cree su primer cliente para empezar a cargar facturas, extractos y reportes en su propia carpeta.</p>
              <button onClick={() => setNuevaEmpresaAbierta(true)} className="mt-4 px-5 py-2.5 rounded-xl bg-[#271a82] hover:bg-[#1c1343] text-white text-sm font-bold cursor-pointer">Crear Mi Primer Cliente</button>
            </div>
          )}
          {currentSection === 'dashboard' && (
            <DashboardView
              facturas={facturas}
              kpis={kpis}
              onNavigate={setCurrentSection}
              onQuickUpload={handleSeedDemo}
              onOpenBrandCustomizer={() => setIsBrandModalOpen(true)}
              idEmpresa={activeEmpresa?.id_empresa}
              periodo={filtrosPeriodo}
            />
          )}

          {currentSection === 'facturas' && (
            <FacturasView
              facturas={facturas}
              cuentasPUC={cuentasPUC}
              activeEmpresa={activeEmpresa}
              esAdmin={currentUser?.rol === 'Administrador' || currentUser?.rol === 'Desarrollador'}
              filtros={filtrosPeriodo}
              onFiltrosChange={setFiltrosPeriodo}
              onRefresh={loadData}
              onShowToast={showToast}
              onUploadXml={handleUploadXml}
              onUploadXmlWithProgress={handleUploadXml}
              onSeedDemo={handleSeedDemo}
              onImportFromDrive={handleImportFromGoogleDrive}
              onUpdateFactura={handleUpdateFactura}
              onDeleteFactura={handleDeleteFactura}
              onBulkDelete={handleBulkDelete}
              onClearAll={handleClearAllFacturas}
              onInspectCufe={(f) => setSelectedCufeFactura(f)}
              onOpenSiigoPush={(facts) => setSiigoPushFacturas(facts)}
            />
          )}

          {currentSection === 'centro-fiscal' && (
            <CentroFiscalView
              report={f350Report}
              onNavigateToFacturas={() => setCurrentSection('facturas')}
            />
          )}

          {currentSection === 'conciliacion' && (
            <ConciliacionView
              idEmpresa={activeEmpresa?.id_empresa || 1}
              nombreEmpresa={activeEmpresa?.nombre_comercial}
              onShowToast={showToast}
            />
          )}

          {currentSection === 'cerebro' && (
            <CerebroContableView
              cuentasPUC={cuentasPUC}
              balanceTerceros={balanceTerceros}
              idEmpresa={activeEmpresa?.id_empresa}
              puedeEliminar={currentUser?.rol === 'Administrador' || currentUser?.rol === 'Desarrollador'}
              onRefresh={loadData}
              onShowToast={showToast}
            />
          )}

          {currentSection === 'accesos' && (() => {
            const canManage = currentUser?.rol === 'Administrador' || currentUser?.rol === 'Desarrollador' || currentUser?.permisos?.gestion_usuarios;
            if (!canManage) {
              setTimeout(() => setCurrentSection('dashboard'), 0);
              return (
                <div className="flex items-center justify-center h-full text-slate-400 text-sm">
                  No tiene permisos para acceder a la gestión de usuarios.
                </div>
              );
            }
            return (
              <AccesosView
                usuarios={usuarios}
                activeEmpresa={activeEmpresa}
                empresas={empresas}
                currentUser={currentUser}
                onApproveUser={handleApproveUser}
                onDeleteUser={handleDeleteUser}
                onToggleAdmin={handleToggleAdmin}
                onToggleActivo={handleToggleActivo}
                onChangeRole={handleChangeRole}
                onUpdatePermisos={handleUpdatePermisos}
                onUpdateEmpresas={handleUpdateEmpresas}
                onSaveSiigoConfig={handleSaveSiigoConfig}
                onUpdateAvatar={handleUpdateAvatar}
                onRefreshUsers={loadData}
                onShowToast={showToast}
                onSelectUser={handleSelectUser}
                primaryColor={primaryColor}
              />
            );
          })()}

          {currentSection === 'base-datos' && (() => {
            const canAccessRestrictedModules = currentUser?.rol === 'Administrador' || currentUser?.rol === 'Desarrollador';
            if (!canAccessRestrictedModules) {
              setTimeout(() => setCurrentSection('dashboard'), 0);
              return <div className="flex items-center justify-center h-full text-slate-400 text-sm">No tiene permisos para acceder a este módulo.</div>;
            }
            return (
              <BaseDatosCloudView
                currentUser={currentUser}
                onNavigateSection={setCurrentSection}
                onShowToast={showToast}
                primaryColor={primaryColor}
              />
            );
          })()}

          {currentSection === 'arquitectura' && (() => {
            const canAccessRestrictedModules = currentUser?.rol === 'Administrador' || currentUser?.rol === 'Desarrollador';
            if (!canAccessRestrictedModules) {
              setTimeout(() => setCurrentSection('dashboard'), 0);
              return <div className="flex items-center justify-center h-full text-slate-400 text-sm">No tiene permisos para acceder a este módulo.</div>;
            }
            return <ArquitecturaView />;
          })()}
        </main>
      </div>

      {/* CUFE & UBL Inspector Modal */}
      {selectedCufeFactura && (
        <CufeModal
          factura={selectedCufeFactura}
          onClose={() => setSelectedCufeFactura(null)}
        />
      )}

      {/* Siigo Nube API Push Modal */}
      {siigoPushFacturas && (
        <SiigoPushModal
          facturas={siigoPushFacturas}
          onClose={() => setSiigoPushFacturas(null)}
          onSuccess={() => {
            loadData();
            showToast('¡Comprobantes transmitidos exitosamente a Siigo Nube!');
          }}
        />
      )}

      {/* Brand Identity & Logo Customizer Modal */}
      <BrandCustomizerModal
        isOpen={isBrandModalOpen}
        onClose={() => setIsBrandModalOpen(false)}
        customLogoUrl={customLogoUrl}
        onSaveCustomLogo={handleSaveCustomLogo}
        primaryColor={primaryColor}
        sidebarColor={sidebarColor}
        currentUser={currentUser}
        onSwitchToJuan={() => {
          const juan = usuarios.find(u => u.id_usuario === 1 || u.email === 'automatizaciones@tlm.net.co') || usuarios[0];
          if (juan) {
            handleSelectUser(juan);
            showToast('Sesión cambiada a Juan Yaya (Administrador Maestro).');
          }
        }}
      />

      {/* Authentication & User Switcher Modal */}
      <AuthModal
        isOpen={isAuthModalOpen}
        onClose={() => setIsAuthModalOpen(false)}
        currentUser={currentUser}
        usuarios={usuarios}
        onSelectUser={handleSelectUser}
        onLogout={cerrarSesion}
        onShowToast={showToast}
        onRefreshUsers={loadData}
        onUpdateAvatar={handleUpdateAvatar}
        initialTab={currentUser?.requiere_cambio_password ? 'cambio_obligatorio' : 'login'}
      />
    </div>
  );
}
