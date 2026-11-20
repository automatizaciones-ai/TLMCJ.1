import React from 'react';
import { 
  LayoutDashboard, 
  FileSpreadsheet, 
  Receipt, 
  Scale, 
  BookOpen, 
  Users, 
  Cpu, 
  Database,
  ChevronLeft, 
  ChevronRight,
  ShieldCheck,
  Building2,
  ExternalLink
} from 'lucide-react';
import { Empresa, Usuario } from '../types/index.ts';
import { TlmLogo } from './TlmLogo.tsx';
import { EmpresaSelector, LogoEmpresa } from './EmpresaSelector.tsx';

interface SidebarProps {
  currentSection: string;
  onSelectSection: (section: string) => void;
  collapsed: boolean;
  onToggleCollapse: () => void;
  activeEmpresa: Empresa | null;
  empresas: Empresa[];
  onSelectEmpresa: (empresa: Empresa) => void;
  onCrearEmpresa?: () => void;
  pendingInvoicesCount: number;
  pendingAccesosCount?: number;
  customLogoUrl?: string | null;
  currentUser?: Usuario | null;
  primaryColor?: string;
  sidebarColor?: string;
}

function adjustHex(hex: string, percent: number): string {
  try {
    const clean = hex.startsWith('#') ? hex.slice(1) : hex;
    const num = parseInt(clean, 16);
    const amt = Math.round(2.55 * percent);
    const R = Math.min(255, Math.max(0, (num >> 16) + amt));
    const G = Math.min(255, Math.max(0, ((num >> 8) & 0x00FF) + amt));
    const B = Math.min(255, Math.max(0, (num & 0x0000FF) + amt));
    return `#${(0x1000000 + R * 0x10000 + G * 0x100 + B).toString(16).slice(1)}`;
  } catch {
    return hex;
  }
}

export const Sidebar: React.FC<SidebarProps> = ({
  currentSection,
  onSelectSection,
  collapsed,
  onToggleCollapse,
  activeEmpresa,
  empresas,
  onSelectEmpresa,
  onCrearEmpresa,
  pendingInvoicesCount,
  pendingAccesosCount = 0,
  customLogoUrl = null,
  currentUser = null,
  primaryColor = '#271a82',
  sidebarColor = '#1c1343'
}) => {
  const isAdminOrDeveloper = currentUser?.rol === 'Administrador' || currentUser?.rol === 'Desarrollador';
  const canManageUsers = Boolean(
    isAdminOrDeveloper || currentUser?.permisos?.gestion_usuarios
  );

  const menuItems = [
    { id: 'dashboard', label: 'Dashboard Directivo', icon: LayoutDashboard },
    { 
      id: 'facturas', 
      label: 'Cargue & Auditoría UBL', 
      icon: Receipt,
      badge: pendingInvoicesCount > 0 ? pendingInvoicesCount : null 
    },
    { id: 'centro-fiscal', label: 'Centro Fiscal (F350)', icon: FileSpreadsheet },
    { id: 'conciliacion', label: 'Conciliación Bancaria', icon: Scale },
    { id: 'cerebro', label: 'Cerebro Contable PUC', icon: BookOpen },
    ...(canManageUsers
      ? [{ id: 'accesos', label: 'Admin Usuarios & Cloud', icon: Users, badge: pendingAccesosCount > 0 ? pendingAccesosCount : null }]
      : []),
    ...(isAdminOrDeveloper
      ? [
          { id: 'base-datos', label: 'Base de Datos & Cloud', icon: Database, highlight: true },
          { id: 'arquitectura', label: 'Arquitectura & Escala', icon: Cpu }
        ]
      : [])
  ];

  const headerBg = adjustHex(sidebarColor, -12);
  const switcherBg = adjustHex(sidebarColor, -6);
  const footerBg = adjustHex(sidebarColor, -12);

  return (
    <aside 
      className={`h-screen text-white flex flex-col justify-between shadow-2xl transition-all duration-300 z-30 select-none border-r border-black/20 ${
        collapsed ? 'w-20' : 'w-72'
      }`}
      style={{ backgroundColor: sidebarColor }}
    >
      <div className="flex-1 overflow-y-auto">
        {/* Header Branding with Official TLM Logo */}
        <div 
          className="p-4 border-b border-white/10 flex items-center justify-between transition-colors duration-200"
          style={{ backgroundColor: headerBg }}
        >
          <div className="flex items-center gap-3 overflow-hidden">
            {collapsed ? (
              <TlmLogo variant="symbol" theme="dark" size="sm" customLogoUrl={customLogoUrl} />
            ) : (
              <TlmLogo
                variant="full"
                theme="dark"
                size="md"
                subtitle="Get Adviced"
                customLogoUrl={customLogoUrl}
              />
            )}
          </div>
          <button 
            onClick={onToggleCollapse}
            title={collapsed ? "Expandir Menú" : "Contraer Menú"}
            className="p-1.5 rounded-lg bg-black/20 hover:bg-black/40 text-white/80 hover:text-white transition cursor-pointer shrink-0"
          >
            {collapsed ? <ChevronRight className="w-4 h-4" /> : <ChevronLeft className="w-4 h-4" />}
          </button>
        </div>

        {/* Company Selector Switcher */}
        {!collapsed ? (
          <div 
            className="p-3 border-b border-white/10 transition-colors duration-200"
            style={{ backgroundColor: switcherBg }}
          >
            <div className="flex items-center justify-between mb-1.5">
              <label className="text-[10px] font-bold tracking-wider text-white/70 uppercase block">
                Empresa Activa / Contribuyente
              </label>
            </div>
            <EmpresaSelector
              empresas={empresas}
              activeEmpresa={activeEmpresa}
              onSelectEmpresa={onSelectEmpresa}
              onCrearEmpresa={onCrearEmpresa}
              fondo={adjustHex(sidebarColor, 8)}
            />
          </div>
        ) : (
          <div 
            className="p-3 border-b border-white/10 flex justify-center" 
            style={{ backgroundColor: switcherBg }}
            title={activeEmpresa?.nombre_comercial}
          >
            {activeEmpresa ? <LogoEmpresa empresa={activeEmpresa} activa tam="w-8 h-8" /> : <Building2 className="w-5 h-5 text-white/70" />}
          </div>
        )}

        {/* Navigation Items */}
        <nav className="p-3 space-y-1.5">
          {menuItems.map((item) => {
            const Icon = item.icon;
            const isActive = currentSection === item.id;
            return (
              <button
                key={item.id}
                onClick={() => onSelectSection(item.id)}
                title={item.label}
                className={`w-full flex items-center justify-between px-3.5 py-2.5 rounded-xl font-medium text-xs sm:text-sm transition-all duration-150 cursor-pointer ${
                  isActive
                    ? 'text-white shadow-lg border-l-4 border-[#e64519] font-bold'
                    : item.highlight
                    ? 'bg-black/25 text-white/90 hover:bg-black/40 hover:text-white border border-white/15'
                    : 'text-white/80 hover:bg-white/10 hover:text-white'
                }`}
                style={isActive ? { background: `linear-gradient(135deg, ${primaryColor}, color-mix(in srgb, ${primaryColor} 78%, ${sidebarColor}))` } : undefined}
              >
                <div className="flex items-center gap-3">
                  <Icon className={`w-5 h-5 flex-shrink-0 ${isActive ? 'text-[#fa9d1c]' : item.highlight ? 'text-[#e64519]' : 'text-white/70'}`} />
                  {!collapsed && <span className="truncate">{item.label}</span>}
                </div>
                {!collapsed && item.badge && (
                  <span className="px-2 py-0.5 text-xs font-bold rounded-full bg-[#e64519] text-white animate-pulse">
                    {item.badge}
                  </span>
                )}
              </button>
            );
          })}
        </nav>
      </div>

      {/* Footer Status & Official Links */}
      <div 
        className="p-3 border-t border-white/10 space-y-2 transition-colors duration-200"
        style={{ backgroundColor: footerBg }}
      >
        {!collapsed ? (
          <div className="flex items-center justify-between px-1 text-[10px] text-white/70">
            <span className="flex items-center gap-1 font-semibold text-white/90">
              <ShieldCheck className="w-3 h-3 text-[#fa9d1c]" /> Sociedad BIC
            </span>
            <a
              href="https://www.tlmcol.com/"
              target="_blank"
              rel="noreferrer"
              className="hover:text-white flex items-center gap-0.5 text-[#fa9d1c] transition"
            >
              tlmcol.com <ExternalLink className="w-2.5 h-2.5" />
            </a>
          </div>
        ) : (
          <div className="flex flex-col items-center gap-2 py-2">
            <span className="w-2 h-2 rounded-full bg-emerald-400" title="Siigo Nube Online"></span>
          </div>
        )}
      </div>
    </aside>
  );
};
