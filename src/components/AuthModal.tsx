import React, { useState, useEffect } from 'react';
import { Usuario } from '../types/index.ts';
import { X, User, Lock, Mail, ShieldCheck, CircleCheck as CheckCircle2, CircleAlert as AlertCircle, LogOut, KeyRound, ArrowRight, UserPlus, LogIn, Check, Camera, Upload, Trash2, Sparkles, ShieldAlert, Key, RefreshCw, Send, Eye, EyeOff, Clock, Shield } from 'lucide-react';
import { TlmLogo } from './TlmLogo.tsx';

interface AuthModalProps {
  isOpen: boolean;
  onClose: () => void;
  currentUser: Usuario | null;
  usuarios: Usuario[];
  onSelectUser: (usuario: Usuario) => void;
  onLogout: () => void;
  onShowToast: (msg: string, type?: 'success' | 'info' | 'error') => void;
  onRefreshUsers: () => void;
  onUpdateAvatar?: (id: number, avatarUrl: string | null) => Promise<void> | void;
  initialTab?: 'login' | 'register' | 'switch' | 'avatar' | 'cambio_obligatorio' | 'recuperar' | 'seguridad';
}

export const AuthModal: React.FC<AuthModalProps> = ({
  isOpen,
  onClose,
  currentUser,
  usuarios,
  onSelectUser,
  onLogout,
  onShowToast,
  onRefreshUsers,
  onUpdateAvatar,
  initialTab = 'login'
}) => {
  const [tab, setTab] = useState<'login' | 'register' | 'switch' | 'avatar' | 'cambio_obligatorio' | 'recuperar' | 'seguridad'>(initialTab);
  
  // Login Form State
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  // Forced Password Change State (First login with provisional password)
  const [mustChangeUser, setMustChangeUser] = useState<Usuario | null>(null);
  const [nuevaPassword, setNuevaPassword] = useState('');
  const [confirmarPassword, setConfirmarPassword] = useState('');
  const [showNuevaPassword, setShowNuevaPassword] = useState(false);

  // Password Recovery via OTP Code
  const [recoveryEmail, setRecoveryEmail] = useState('');
  const [recoveryStep, setRecoveryStep] = useState<1 | 2>(1);
  const [recoveryCode, setRecoveryCode] = useState('');
  const [simulatedOtpCode, setSimulatedOtpCode] = useState<string | null>(null);
  const [recoveryNuevaPassword, setRecoveryNuevaPassword] = useState('');
  const [recoveryConfirmarPassword, setRecoveryConfirmarPassword] = useState('');

  // Voluntary Password Change (when logged in)
  const [voluntarioActualPassword, setVoluntarioActualPassword] = useState('');
  const [voluntarioNuevaPassword, setVoluntarioNuevaPassword] = useState('');
  const [voluntarioConfirmarPassword, setVoluntarioConfirmarPassword] = useState('');

  // Register Form State
  const [nombreCompleto, setNombreCompleto] = useState('');
  
  // Avatar Customization State
  const [avatarInputUrl, setAvatarInputUrl] = useState('');
  const [isSavingAvatar, setIsSavingAvatar] = useState(false);

  // Verificación estricta de Juan Yaya / Administrador Maestro / Desarrollador
  const isJuanOrAdmin = Boolean(
    currentUser && (
      currentUser.rol === 'Administrador' ||
      currentUser.id_usuario === 1 ||
      currentUser.email?.toLowerCase().includes('automatizaciones@tlm.net.co') ||
      currentUser.email?.toLowerCase().includes('juan.yaya') ||
      currentUser.permisos?.administrador === true
    )
  );

  useEffect(() => {
    if (isOpen) {
      if (currentUser?.requiere_cambio_password) {
        setMustChangeUser(currentUser);
        setTab('cambio_obligatorio');
      } else if (!currentUser) {
        // Cuando no ha ingresado (se van a logear): solo login, recuperar o register
        if (initialTab === 'recuperar' || initialTab === 'register') {
          setTab(initialTab);
        } else {
          setTab('login');
        }
      } else {
        // Cuando ya ha ingresado: si no es admin y pidió switch, ir a seguridad o avatar
        if (initialTab === 'switch' && !isJuanOrAdmin) {
          setTab('seguridad');
        } else {
          setTab(initialTab);
        }
      }
      setErrorMsg(null);
    }
  }, [isOpen, currentUser, initialTab, isJuanOrAdmin]);

  const getCleanInitials = (name?: string | null): string => {
    if (!name) return 'JY';
    const cleaned = name.replace(/[¿?¡!]/g, '').trim();
    if (cleaned.toLowerCase().includes('juan') && cleaned.toLowerCase().includes('yaya')) {
      return 'JY';
    }
    const parts = cleaned.split(/\s+/).filter(Boolean);
    if (parts.length >= 2) {
      return (parts[0][0] + parts[1][0]).toUpperCase();
    }
    return (cleaned.slice(0, 2) || 'JY').toUpperCase();
  };

  const handleUploadAvatarFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file && currentUser && onUpdateAvatar) {
      const reader = new FileReader();
      reader.onload = async () => {
        const dataUrl = reader.result as string;
        setIsSavingAvatar(true);
        try {
          await onUpdateAvatar(currentUser.id_usuario, dataUrl);
          onShowToast('¡Imagen corporativa actualizada con éxito!');
        } catch (err: any) {
          setErrorMsg(err.message || 'Error al guardar imagen');
        } finally {
          setIsSavingAvatar(false);
        }
      };
      reader.readAsDataURL(file);
    }
  };

  const handleSetOfficialTlmAvatar = async () => {
    if (currentUser && onUpdateAvatar) {
      setIsSavingAvatar(true);
      try {
        await onUpdateAvatar(currentUser.id_usuario, '/avatar_corporativo_tlm.svg');
        onShowToast('¡Emblema corporativo TLM asignado como avatar!');
      } catch (err: any) {
        setErrorMsg(err.message || 'Error al asignar emblema');
      } finally {
        setIsSavingAvatar(false);
      }
    }
  };

  const handleResetToInitialsJY = async () => {
    if (currentUser && onUpdateAvatar) {
      setIsSavingAvatar(true);
      try {
        await onUpdateAvatar(currentUser.id_usuario, null);
        onShowToast('¡Imagen removida! Se mostrarán únicamente las iniciales JY.');
      } catch (err: any) {
        setErrorMsg(err.message || 'Error al restablecer iniciales');
      } finally {
        setIsSavingAvatar(false);
      }
    }
  };

  const handleSaveAvatarUrl = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!avatarInputUrl.trim() || !currentUser || !onUpdateAvatar) return;
    setIsSavingAvatar(true);
    try {
      await onUpdateAvatar(currentUser.id_usuario, avatarInputUrl.trim());
      setAvatarInputUrl('');
      onShowToast('¡URL de imagen corporativa aplicada!');
    } catch (err: any) {
      setErrorMsg(err.message || 'Error al asignar URL');
    } finally {
      setIsSavingAvatar(false);
    }
  };

  // 1. INICIAR SESIÓN
  const handleLoginSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrorMsg(null);
    setIsLoading(true);

    try {
      const res = await fetch('/api/v1/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: email.trim(), password })
      });

      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.detail || 'Error al iniciar sesión');
      }

      const targetUser = data.usuario || usuarios.find(u => u.email.toLowerCase() === email.trim().toLowerCase());

      // DETECCIÓN DE CONTRASEÑA PROVISIONAL -> EXIGIR CAMBIO OBLIGATORIO
      if (data.requiere_cambio_password || targetUser?.requiere_cambio_password) {
        setMustChangeUser(targetUser || {
          id_usuario: data.usuario_id,
          nombre_completo: data.usuario_nombre,
          email: data.email,
          rol: data.rol,
          activo: true,
          empresas_ids: data.empresas_ids,
          requiere_cambio_password: true
        });
        setNuevaPassword('');
        setConfirmarPassword('');
        setTab('cambio_obligatorio');
        onShowToast('⚠️ Contraseña provisional asignada por el Administrador. Debes cambiarla obligatoriamente.', 'info');
        return;
      }

      const finalUser: Usuario = targetUser || {
        id_usuario: data.usuario_id || 1,
        nombre_completo: data.usuario_nombre || 'Usuario TLM',
        email: data.email || email.trim(),
        rol: data.rol || 'Analista',
        activo: true,
        empresas_ids: data.empresas_ids || [1],
        avatar_url: data.avatar_url || null,
        requiere_cambio_password: false
      };

      onSelectUser(finalUser);
      onShowToast(`¡Bienvenido/a ${finalUser.nombre_completo}! Accediendo a la Consola...`);
      onClose();
    } catch (err: any) {
      setErrorMsg(err.message || 'Error de conexión');
    } finally {
      setIsLoading(false);
    }
  };

  // 2. CAMBIO OBLIGATORIO DE CONTRASEÑA (PRIMER INGRESO)
  const handleForcedPasswordSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrorMsg(null);

    if (!mustChangeUser) {
      setErrorMsg("No hay ningún usuario seleccionado para el cambio.");
      return;
    }

    if (nuevaPassword.length < 8) {
      setErrorMsg("La contraseña debe tener mínimo 8 caracteres.");
      return;
    }
    if (!/[a-zA-Z]/.test(nuevaPassword) || !/[0-9]/.test(nuevaPassword)) {
      setErrorMsg("La contraseña debe ser alfanumérica (debe contener letras y números).");
      return;
    }
    if (nuevaPassword !== confirmarPassword) {
      setErrorMsg("La confirmación de la contraseña no coincide.");
      return;
    }

    setIsLoading(true);
    try {
      const res = await fetch('/api/v1/auth/cambiar-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          usuario_id: mustChangeUser.id_usuario,
          email: mustChangeUser.email,
          nueva_password: nuevaPassword,
          confirmar_password: confirmarPassword
        })
      });

      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.detail || 'Error al actualizar contraseña.');
      }

      onShowToast('¡Contraseña actualizada con éxito! Cumple con la política alfanumérica de 8+ caracteres.');
      await onRefreshUsers();

      const updatedUser: Usuario = {
        ...mustChangeUser,
        requiere_cambio_password: false,
        ultimo_cambio_password: new Date().toISOString()
      };
      onSelectUser(updatedUser);
      onClose();
    } catch (err: any) {
      setErrorMsg(err.message || 'Error al actualizar contraseña');
    } finally {
      setIsLoading(false);
    }
  };

  // 3. RECUPERAR CONTRASEÑA: SOLICITAR CÓDIGO OTP
  const handleRequestRecoveryCode = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrorMsg(null);
    if (!recoveryEmail.trim()) {
      setErrorMsg("Ingresa tu correo corporativo.");
      return;
    }

    setIsLoading(true);
    try {
      const res = await fetch('/api/v1/auth/recuperar-password/solicitar-codigo', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: recoveryEmail.trim() })
      });

      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.detail || 'Error al solicitar código.');
      }

      setSimulatedOtpCode(data.codigo_simulado || null);
      setRecoveryCode(data.codigo_simulado || '');
      setRecoveryStep(2);
      onShowToast(data.mensaje || `Código enviado al correo ${recoveryEmail.trim()}.`);
    } catch (err: any) {
      setErrorMsg(err.message || 'Error de comunicación');
    } finally {
      setIsLoading(false);
    }
  };

  // 4. RECUPERAR CONTRASEÑA: VERIFICAR CÓDIGO Y ESTABLECER NUEVA CONTRASEÑA
  const handleVerifyOtpAndReset = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrorMsg(null);

    if (!recoveryCode.trim()) {
      setErrorMsg("Ingresa el código de seguridad recibido.");
      return;
    }
    if (recoveryNuevaPassword.length < 8) {
      setErrorMsg("La nueva contraseña debe tener mínimo 8 caracteres.");
      return;
    }
    if (!/[a-zA-Z]/.test(recoveryNuevaPassword) || !/[0-9]/.test(recoveryNuevaPassword)) {
      setErrorMsg("La contraseña debe ser alfanumérica (debe contener letras y números).");
      return;
    }
    if (recoveryNuevaPassword !== recoveryConfirmarPassword) {
      setErrorMsg("Las contraseñas no coinciden.");
      return;
    }

    setIsLoading(true);
    try {
      const res = await fetch('/api/v1/auth/recuperar-password/verificar-y-cambiar', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: recoveryEmail.trim(),
          codigo: recoveryCode.trim(),
          nueva_password: recoveryNuevaPassword,
          confirmar_password: recoveryConfirmarPassword
        })
      });

      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.detail || 'Error al restablecer contraseña');
      }

      onShowToast('¡Contraseña recuperada y actualizada con éxito! Accediendo...');
      await onRefreshUsers();

      if (data.usuario) {
        onSelectUser(data.usuario);
        onClose();
      } else {
        const u = usuarios.find(x => x.email.toLowerCase() === recoveryEmail.trim().toLowerCase());
        if (u) onSelectUser({ ...u, requiere_cambio_password: false });
        onClose();
      }
    } catch (err: any) {
      setErrorMsg(err.message || 'Error al verificar código');
    } finally {
      setIsLoading(false);
    }
  };

  // 5. CAMBIO VOLUNTARIO DE CONTRASEÑA (DESDE EL PERFIL)
  const handleVoluntaryPasswordChange = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrorMsg(null);
    if (!currentUser) return;

    if (voluntarioNuevaPassword.length < 8) {
      setErrorMsg("La nueva contraseña debe tener mínimo 8 caracteres.");
      return;
    }
    if (!/[a-zA-Z]/.test(voluntarioNuevaPassword) || !/[0-9]/.test(voluntarioNuevaPassword)) {
      setErrorMsg("La contraseña debe ser alfanumérica (debe contener letras y números).");
      return;
    }
    if (voluntarioNuevaPassword !== voluntarioConfirmarPassword) {
      setErrorMsg("Las contraseñas no coinciden.");
      return;
    }

    setIsLoading(true);
    try {
      const res = await fetch('/api/v1/auth/cambiar-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          usuario_id: currentUser.id_usuario,
          email: currentUser.email,
          password_actual: voluntarioActualPassword,
          nueva_password: voluntarioNuevaPassword,
          confirmar_password: voluntarioConfirmarPassword
        })
      });

      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.detail || 'Error al actualizar contraseña');
      }

      onShowToast('¡Contraseña actualizada exitosamente! Guardada con estándar alfanumérico.');
      setVoluntarioActualPassword('');
      setVoluntarioNuevaPassword('');
      setVoluntarioConfirmarPassword('');
      await onRefreshUsers();
      onClose();
    } catch (err: any) {
      setErrorMsg(err.message || 'Error al cambiar contraseña');
    } finally {
      setIsLoading(false);
    }
  };

  // 6. REGISTRO
  const handleRegisterSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrorMsg(null);
    setIsLoading(true);

    try {
      const res = await fetch('/api/v1/auth/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ nombre_completo: nombreCompleto, email, password })
      });

      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.detail || 'Error al registrar usuario');
      }

      onShowToast(data.mensaje || 'Registro completado. Cuenta en cola de aprobación.');
      onRefreshUsers();
      setTab('login');
      setEmail('');
      setPassword('');
      setNombreCompleto('');
    } catch (err: any) {
      setErrorMsg(err.message || 'Error de registro');
    } finally {
      setIsLoading(false);
    }
  };

  if (!isOpen) return null;

  // COMPONENTE VISUAL DE POLÍTICA DE CONTRASEÑA EN TIEMPO REAL
  const renderPolicyBadges = (pwd: string, confirmPwd?: string) => {
    const hasMin8 = pwd.length >= 8;
    const hasLetters = /[a-zA-Z]/.test(pwd);
    const hasNumbers = /[0-9]/.test(pwd);
    const isMatching = confirmPwd !== undefined ? (pwd.length > 0 && pwd === confirmPwd) : true;
    const isAllOk = hasMin8 && hasLetters && hasNumbers && isMatching;

    return (
      <div className="p-3 bg-slate-50 border border-slate-200 rounded-xl space-y-2 text-xs">
        <div className="text-[11px] font-bold text-slate-700 flex items-center justify-between">
          <span>Estándar de Seguridad Alfanumérica TLM:</span>
          <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full ${
            isAllOk ? 'bg-emerald-100 text-emerald-800 border border-emerald-300' : 'bg-amber-100 text-amber-800 border border-amber-300'
          }`}>
            {isAllOk ? '✓ Política Cumplida' : 'Pendiente de Validar'}
          </span>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-1.5 text-[11px]">
          <div className={`flex items-center gap-1.5 ${hasMin8 ? 'text-emerald-700 font-bold' : 'text-slate-500'}`}>
            <span className={`w-4 h-4 rounded-full flex items-center justify-center text-[10px] shrink-0 ${
              hasMin8 ? 'bg-emerald-500 text-white' : 'bg-slate-200 text-slate-600'
            }`}>
              {hasMin8 ? '✓' : '•'}
            </span>
            <span>Mínimo 8 caracteres ({pwd.length}/8)</span>
          </div>

          <div className={`flex items-center gap-1.5 ${hasLetters ? 'text-emerald-700 font-bold' : 'text-slate-500'}`}>
            <span className={`w-4 h-4 rounded-full flex items-center justify-center text-[10px] shrink-0 ${
              hasLetters ? 'bg-emerald-500 text-white' : 'bg-slate-200 text-slate-600'
            }`}>
              {hasLetters ? '✓' : '•'}
            </span>
            <span>Contiene letras (a-z, A-Z)</span>
          </div>

          <div className={`flex items-center gap-1.5 ${hasNumbers ? 'text-emerald-700 font-bold' : 'text-slate-500'}`}>
            <span className={`w-4 h-4 rounded-full flex items-center justify-center text-[10px] shrink-0 ${
              hasNumbers ? 'bg-emerald-500 text-white' : 'bg-slate-200 text-slate-600'
            }`}>
              {hasNumbers ? '✓' : '•'}
            </span>
            <span>Contiene números (0-9)</span>
          </div>

          {confirmPwd !== undefined && (
            <div className={`flex items-center gap-1.5 ${isMatching && pwd.length > 0 ? 'text-emerald-700 font-bold' : 'text-slate-500'}`}>
              <span className={`w-4 h-4 rounded-full flex items-center justify-center text-[10px] shrink-0 ${
                isMatching && pwd.length > 0 ? 'bg-emerald-500 text-white' : 'bg-slate-200 text-slate-600'
              }`}>
                {isMatching && pwd.length > 0 ? '✓' : '•'}
              </span>
              <span>Confirmación coincide</span>
            </div>
          )}
        </div>
      </div>
    );
  };

  return (
    <div className="fixed inset-0 z-50 bg-slate-900/70 backdrop-blur-xs flex items-center justify-center p-4">
      <div className="bg-white rounded-2xl shadow-2xl max-w-lg w-full overflow-hidden border border-slate-200 flex flex-col animate-in fade-in zoom-in-95 duration-150">
        {/* Header */}
        <div className="bg-gradient-to-r from-[#1c1343] to-[#271a82] p-5 text-white flex items-center justify-between border-b border-indigo-900/50">
          <div className="flex items-center gap-3">
            <TlmLogo variant="symbol" theme="dark" size="sm" />
            <div>
              <h3 className="font-bold text-base leading-tight">Acceso & Seguridad de Credenciales</h3>
              <p className="text-xs text-indigo-200">Consola TLM · Estándar Alfanumérico & Recuperación OTP</p>
            </div>
          </div>
          {/* Prevent closing if forced password change is mandatory */}
          {tab !== 'cambio_obligatorio' && (
            <button
              onClick={onClose}
              className="p-1.5 rounded-lg bg-white/10 hover:bg-white/20 text-white transition cursor-pointer"
            >
              <X className="w-4 h-4" />
            </button>
          )}
        </div>

        {/* Current Active User Status Bar */}
        {currentUser && tab !== 'cambio_obligatorio' && (
          <div className="bg-[#f8f9fa] border-b border-slate-200 p-3.5 px-6 flex items-center justify-between">
            <div className="flex items-center gap-2.5">
              <div className="w-8 h-8 rounded-full bg-gradient-to-br from-[#271a82] to-[#fa9d1c] text-white flex items-center justify-center font-bold text-xs overflow-hidden shrink-0 shadow-xs ring-1 ring-[#271a82]/20">
                {currentUser.avatar_url ? (
                  <img
                    src={currentUser.avatar_url}
                    alt={currentUser.nombre_completo}
                    className="w-full h-full object-cover"
                  />
                ) : (
                  getCleanInitials(currentUser.nombre_completo)
                )}
              </div>
              <div>
                <span className="text-[11px] text-slate-500 block leading-tight font-medium">Sesión activa actualmente:</span>
                <span className="text-xs font-bold text-slate-800">{currentUser.nombre_completo}</span>
                <span className="ml-2 text-[10px] bg-emerald-100 text-emerald-800 font-bold px-1.5 py-0.2 rounded">
                  {currentUser.rol}
                </span>
              </div>
            </div>

            <button
              onClick={() => {
                onLogout();
                onShowToast('Sesión cerrada.');
              }}
              title="Cerrar Sesión"
              className="text-xs text-red-600 hover:text-red-700 font-bold flex items-center gap-1 hover:underline cursor-pointer"
            >
              <LogOut className="w-3.5 h-3.5" /> Salir
            </button>
          </div>
        )}

        {/* Navigation Tabs (Hidden during forced password change) */}
        {tab !== 'cambio_obligatorio' && (
          <div className="flex border-b border-slate-200 bg-slate-100/80 p-2 gap-1.5 overflow-x-auto scroll-smooth">
            {/* 1. Cuando se van a logear (sin sesión iniciada): solo Iniciar Sesión, Recuperar Clave y Registrarse */}
            {!currentUser ? (
              <>
                <button
                  onClick={() => { setTab('login'); setErrorMsg(null); }}
                  className={`px-3.5 py-2 text-xs font-bold rounded-xl transition cursor-pointer flex items-center gap-1.5 shrink-0 whitespace-nowrap ${
                    tab === 'login'
                      ? 'bg-white text-[#271a82] shadow-xs border border-slate-200 ring-1 ring-slate-900/5'
                      : 'text-slate-600 hover:text-slate-900 hover:bg-white/60'
                  }`}
                >
                  <LogIn className="w-3.5 h-3.5 text-[#e64519]" />
                  Iniciar Sesión
                </button>

                <button
                  onClick={() => { setTab('recuperar'); setErrorMsg(null); setRecoveryStep(1); }}
                  className={`px-3.5 py-2 text-xs font-bold rounded-xl transition cursor-pointer flex items-center gap-1.5 shrink-0 whitespace-nowrap ${
                    tab === 'recuperar'
                      ? 'bg-white text-[#271a82] shadow-xs border border-slate-200 ring-1 ring-slate-900/5'
                      : 'text-slate-600 hover:text-slate-900 hover:bg-white/60'
                  }`}
                >
                  <KeyRound className="w-3.5 h-3.5 text-[#fa9d1c]" />
                  Recuperar Mi Clave
                </button>

                <button
                  onClick={() => { setTab('register'); setErrorMsg(null); }}
                  className={`px-3.5 py-2 text-xs font-bold rounded-xl transition cursor-pointer flex items-center gap-1.5 shrink-0 whitespace-nowrap ${
                    tab === 'register'
                      ? 'bg-white text-[#271a82] shadow-xs border border-slate-200 ring-1 ring-slate-900/5'
                      : 'text-slate-600 hover:text-slate-900 hover:bg-white/60'
                  }`}
                >
                  <UserPlus className="w-3.5 h-3.5 text-[#777eec]" />
                  Registrarse
                </button>
              </>
            ) : (
              <>
                {/* 2. Cuando ya ha ingresado: Mi Contraseña y Editar Avatar */}
                <button
                  onClick={() => { setTab('seguridad'); setErrorMsg(null); }}
                  className={`px-3.5 py-2 text-xs font-bold rounded-xl transition cursor-pointer flex items-center gap-1.5 shrink-0 whitespace-nowrap ${
                    tab === 'seguridad'
                      ? 'bg-white text-[#271a82] shadow-xs border border-slate-200 ring-1 ring-slate-900/5'
                      : 'text-slate-600 hover:text-slate-900 hover:bg-white/60'
                  }`}
                >
                  <Shield className="w-3.5 h-3.5 text-emerald-600" />
                  Mi Contraseña
                </button>

                {/* Editar el avatar solo cuando ya haya ingresado */}
                <button
                  onClick={() => { setTab('avatar'); setErrorMsg(null); }}
                  className={`px-3.5 py-2 text-xs font-bold rounded-xl transition cursor-pointer flex items-center gap-1.5 shrink-0 whitespace-nowrap ${
                    tab === 'avatar'
                      ? 'bg-white text-[#271a82] shadow-xs border border-slate-200 ring-1 ring-slate-900/5'
                      : 'text-slate-600 hover:text-slate-900 hover:bg-white/60'
                  }`}
                >
                  <Camera className="w-3.5 h-3.5 text-[#e64519]" />
                  Editar Avatar / JY
                </button>

                {/* 3. El resto de las funciones son solo para Juan el administrador y el desarrollador */}
                {isJuanOrAdmin && (
                  <>
                    <button
                      onClick={() => { setTab('switch'); setErrorMsg(null); }}
                      className={`px-3.5 py-2 text-xs font-bold rounded-xl transition cursor-pointer flex items-center gap-1.5 shrink-0 whitespace-nowrap ${
                        tab === 'switch'
                          ? 'bg-white text-[#271a82] shadow-xs border border-slate-200 ring-1 ring-slate-900/5'
                          : 'text-slate-600 hover:text-slate-900 hover:bg-white/60'
                      }`}
                    >
                      <User className="w-3.5 h-3.5 text-[#fa9d1c]" />
                      Cambio de Rol ({usuarios.length})
                    </button>

                    <button
                      onClick={() => { setTab('register'); setErrorMsg(null); }}
                      className={`px-3.5 py-2 text-xs font-bold rounded-xl transition cursor-pointer flex items-center gap-1.5 shrink-0 whitespace-nowrap ${
                        tab === 'register'
                          ? 'bg-white text-[#271a82] shadow-xs border border-slate-200 ring-1 ring-slate-900/5'
                          : 'text-slate-600 hover:text-slate-900 hover:bg-white/60'
                      }`}
                    >
                      <UserPlus className="w-3.5 h-3.5 text-[#777eec]" />
                      Crear Usuario
                    </button>
                  </>
                )}
              </>
            )}
          </div>
        )}

        {/* Content Body */}
        <div className="p-6 space-y-4 max-h-[68vh] overflow-y-auto overscroll-contain">
          {errorMsg && (
            <div className="p-3 bg-red-50 border border-red-200 text-red-700 text-xs rounded-xl flex items-center gap-2">
              <AlertCircle className="w-4 h-4 shrink-0 text-red-500" />
              <span>{errorMsg}</span>
            </div>
          )}

          {/* TAB 1: LOGIN FORM */}
          {tab === 'login' && (
            <form onSubmit={handleLoginSubmit} className="space-y-4">
              <div>
                <label className="block text-xs font-bold text-slate-700 mb-1">Correo Electrónico Corporativo</label>
                <div className="relative">
                  <Mail className="w-4 h-4 text-slate-400 absolute left-3 top-3 pointer-events-none" />
                  <input
                    type="email"
                    required
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder="automatizaciones@tlm.net.co"
                    className="w-full bg-[#f8f9fa] border border-slate-300 rounded-xl pl-9 pr-3 py-2 text-xs text-slate-800 focus:outline-none focus:border-[#271a82]"
                  />
                </div>
              </div>

              <div>
                <div className="flex items-center justify-between mb-1">
                  <label className="block text-xs font-bold text-slate-700">Contraseña</label>
                  <button
                    type="button"
                    onClick={() => {
                      setRecoveryEmail(email || '');
                      setRecoveryStep(1);
                      setTab('recuperar');
                      setErrorMsg(null);
                    }}
                    className="text-[11px] text-[#271a82] hover:text-[#e64519] font-bold hover:underline cursor-pointer"
                  >
                    ¿Olvidaste tu contraseña?
                  </button>
                </div>
                <div className="relative">
                  <Lock className="w-4 h-4 text-slate-400 absolute left-3 top-3 pointer-events-none" />
                  <input
                    type={showPassword ? "text" : "password"}
                    required
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder="••••••••••••"
                    className="w-full bg-[#f8f9fa] border border-slate-300 rounded-xl pl-9 pr-10 py-2 text-xs text-slate-800 focus:outline-none focus:border-[#271a82]"
                  />
                  <button
                    type="button"
                    onClick={() => setShowPassword(!showPassword)}
                    className="absolute right-3 top-2.5 text-slate-400 hover:text-slate-600 cursor-pointer"
                  >
                    {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                  </button>
                </div>
              </div>

              <div className="pt-1">
                <button
                  type="submit"
                  disabled={isLoading}
                  className="w-full py-2.5 rounded-xl bg-[#271a82] hover:bg-[#1c1343] text-white font-bold text-xs shadow-md transition active:scale-95 cursor-pointer flex items-center justify-center gap-2 disabled:opacity-50"
                >
                  <LogIn className="w-4 h-4 text-[#fa9d1c]" />
                  {isLoading ? 'Autenticando...' : 'Iniciar Sesión en Consola TLM'}
                </button>
              </div>

              <div className="pt-2 text-center">
                <span className="text-xs text-slate-500">
                  ¿No tienes una cuenta aún?{' '}
                  <button
                    type="button"
                    onClick={() => { setTab('register'); setErrorMsg(null); }}
                    className="text-[#271a82] hover:text-[#e64519] font-bold hover:underline cursor-pointer"
                  >
                    Regístrate aquí
                  </button>
                </span>
              </div>
            </form>
          )}

          {/* TAB 2: CAMBIO OBLIGATORIO DE CONTRASEÑA (PRIMER INGRESO CON PROVISIONAL) */}
          {tab === 'cambio_obligatorio' && mustChangeUser && (
            <form onSubmit={handleForcedPasswordSubmit} className="space-y-4">
              <div className="p-4 bg-amber-50 border border-amber-200 rounded-2xl flex items-start gap-3 text-amber-950">
                <div className="p-2 bg-amber-500 text-white rounded-xl shrink-0 mt-0.5">
                  <ShieldAlert className="w-5 h-5" />
                </div>
                <div>
                  <h4 className="text-xs font-black uppercase tracking-wider text-amber-900">
                    Cambio Obligatorio de Contraseña (Primer Ingreso)
                  </h4>
                  <p className="text-xs text-amber-800 mt-1 leading-relaxed">
                    El Administrador Maestro asignó una <strong>contraseña provisional</strong> para <strong>{mustChangeUser.nombre_completo}</strong> ({mustChangeUser.email}).
                    Por normativa de ciberseguridad corporativa, debes cambiarla obligatoriamente por una contraseña personal <strong>alfanumérica de mínimo 8 caracteres</strong> para continuar.
                  </p>
                </div>
              </div>

              <div>
                <label className="block text-xs font-bold text-slate-700 mb-1">
                  Nueva Contraseña Personal
                </label>
                <div className="relative">
                  <Lock className="w-4 h-4 text-slate-400 absolute left-3 top-3 pointer-events-none" />
                  <input
                    type={showNuevaPassword ? "text" : "password"}
                    required
                    value={nuevaPassword}
                    onChange={(e) => setNuevaPassword(e.target.value)}
                    placeholder="Mínimo 8 caracteres alfanumérica (Ej. JuanSeguro2026)"
                    className="w-full bg-[#f8f9fa] border border-slate-300 rounded-xl pl-9 pr-10 py-2.5 text-xs text-slate-800 focus:outline-none focus:border-[#271a82]"
                  />
                  <button
                    type="button"
                    onClick={() => setShowNuevaPassword(!showNuevaPassword)}
                    className="absolute right-3 top-3 text-slate-400 hover:text-slate-600 cursor-pointer"
                  >
                    {showNuevaPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                  </button>
                </div>
              </div>

              <div>
                <label className="block text-xs font-bold text-slate-700 mb-1">
                  Confirmar Nueva Contraseña
                </label>
                <div className="relative">
                  <CheckCircle2 className="w-4 h-4 text-slate-400 absolute left-3 top-3 pointer-events-none" />
                  <input
                    type={showNuevaPassword ? "text" : "password"}
                    required
                    value={confirmarPassword}
                    onChange={(e) => setConfirmarPassword(e.target.value)}
                    placeholder="Repite exactamente tu nueva contraseña"
                    className="w-full bg-[#f8f9fa] border border-slate-300 rounded-xl pl-9 pr-3 py-2.5 text-xs text-slate-800 focus:outline-none focus:border-[#271a82]"
                  />
                </div>
              </div>

              {/* Indicador interactivo de cumplimiento de políticas */}
              {renderPolicyBadges(nuevaPassword, confirmarPassword)}

              <div className="pt-2">
                <button
                  type="submit"
                  disabled={isLoading || nuevaPassword.length < 8 || !/[a-zA-Z]/.test(nuevaPassword) || !/[0-9]/.test(nuevaPassword) || nuevaPassword !== confirmarPassword}
                  className="w-full py-3 rounded-xl bg-[#271a82] hover:bg-[#1c1343] text-white font-bold text-xs shadow-md transition active:scale-95 cursor-pointer flex items-center justify-center gap-2 disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  <ShieldCheck className="w-4 h-4 text-[#fa9d1c]" />
                  {isLoading ? 'Actualizando y asegurando cuenta...' : 'Guardar Nueva Contraseña & Acceder a la Consola'}
                </button>
              </div>
            </form>
          )}

          {/* TAB 3: RECUPERACIÓN DE CONTRASEÑA MEDIANTE CÓDIGO OTP */}
          {tab === 'recuperar' && (
            <div className="space-y-4">
              <div className="p-3.5 bg-indigo-50/70 border border-indigo-200 rounded-xl flex items-center gap-3">
                <div className="w-9 h-9 rounded-xl bg-[#271a82] text-white flex items-center justify-center shrink-0">
                  <KeyRound className="w-4 h-4 text-[#fa9d1c]" />
                </div>
                <div>
                  <h4 className="text-xs font-bold text-indigo-950">Recuperación Segura por Correo Corporativo</h4>
                  <p className="text-[11px] text-indigo-800">
                    Generación de código OTP de 6 dígitos enviado directamente a tu correo corporativo.
                  </p>
                </div>
              </div>

              {/* PASO 1: SOLICITAR CÓDIGO */}
              {recoveryStep === 1 && (
                <form onSubmit={handleRequestRecoveryCode} className="space-y-4">
                  <div>
                    <label className="block text-xs font-bold text-slate-700 mb-1">
                      Correo Electrónico Corporativo Registrado
                    </label>
                    <div className="relative">
                      <Mail className="w-4 h-4 text-slate-400 absolute left-3 top-3 pointer-events-none" />
                      <input
                        type="email"
                        required
                        value={recoveryEmail}
                        onChange={(e) => setRecoveryEmail(e.target.value)}
                        placeholder="Ej. juan.yaya@tlm.net.co o automatizaciones@tlm.net.co"
                        className="w-full bg-[#f8f9fa] border border-slate-300 rounded-xl pl-9 pr-3 py-2 text-xs text-slate-800 focus:outline-none focus:border-[#271a82]"
                      />
                    </div>
                  </div>

                  <div className="p-3 bg-slate-50 border border-slate-200 rounded-xl text-[11px] text-slate-600 flex items-center gap-2">
                    <Clock className="w-4 h-4 text-[#fa9d1c] shrink-0" />
                    <span>El código de seguridad generado tendrá una validez de 15 minutos para mayor protección.</span>
                  </div>

                  <div className="flex items-center gap-2 pt-1">
                    <button
                      type="button"
                      onClick={() => setTab('login')}
                      className="px-4 py-2.5 rounded-xl border border-slate-300 text-slate-700 font-bold text-xs hover:bg-slate-50 transition cursor-pointer"
                    >
                      Volver
                    </button>
                    <button
                      type="submit"
                      disabled={isLoading}
                      className="flex-1 py-2.5 rounded-xl bg-[#271a82] hover:bg-[#1c1343] text-white font-bold text-xs shadow-md transition active:scale-95 cursor-pointer flex items-center justify-center gap-2 disabled:opacity-50"
                    >
                      <Send className="w-3.5 h-3.5 text-[#fa9d1c]" />
                      {isLoading ? 'Generando código...' : 'Generar & Enviar Código al Correo'}
                    </button>
                  </div>
                </form>
              )}

              {/* PASO 2: VERIFICAR CÓDIGO & ESTABLECER NUEVA CONTRASEÑA */}
              {recoveryStep === 2 && (
                <form onSubmit={handleVerifyOtpAndReset} className="space-y-4">
                  {!simulatedOtpCode && (
                    <div className="p-3.5 bg-indigo-50 border border-indigo-200 rounded-2xl flex items-start gap-3 text-xs text-indigo-950">
                      <Mail className="w-4 h-4 mt-0.5 text-indigo-700 shrink-0" />
                      <span>Enviamos un código de 6 dígitos a <b>{recoveryEmail}</b>. Es válido por 15 minutos; si no lo ve, revise la carpeta de spam.</span>
                    </div>
                  )}
                  {/* Modo demostración (sin servidor de correo): el código se muestra en pantalla */}
                  {simulatedOtpCode && (
                    <div className="p-3.5 bg-emerald-50 border border-emerald-300 rounded-2xl flex items-start gap-3">
                      <div className="p-1.5 bg-emerald-600 text-white rounded-lg shrink-0 mt-0.5">
                        <Mail className="w-4 h-4" />
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="text-[11px] font-bold text-emerald-950 uppercase tracking-wide">
                          Correo Corporativo Entregado a: {recoveryEmail}
                        </div>
                        <div className="text-xs text-emerald-900 mt-0.5">
                          Tu código de seguridad confidencial TLM es:
                        </div>
                        <div className="mt-1.5 flex items-center gap-2">
                          <span className="font-mono text-base font-black tracking-widest bg-white border border-emerald-300 text-emerald-800 px-3 py-1 rounded-lg shadow-2xs">
                            {simulatedOtpCode}
                          </span>
                          <span className="text-[10px] text-emerald-700 bg-emerald-100/80 px-2 py-0.5 rounded font-medium">
                            Válido por 15 min
                          </span>
                        </div>
                      </div>
                    </div>
                  )}

                  <div>
                    <label className="block text-xs font-bold text-slate-700 mb-1">
                      Código de Seguridad (6 Dígitos)
                    </label>
                    <input
                      type="text"
                      maxLength={6}
                      required
                      value={recoveryCode}
                      onChange={(e) => setRecoveryCode(e.target.value.replace(/\D/g, ''))}
                      placeholder="123456"
                      className="w-full bg-[#f8f9fa] border border-slate-300 rounded-xl px-3 py-2 text-center text-sm font-mono tracking-widest font-black text-slate-900 focus:outline-none focus:border-[#271a82]"
                    />
                  </div>

                  <div>
                    <label className="block text-xs font-bold text-slate-700 mb-1">
                      Nueva Contraseña Personal
                    </label>
                    <input
                      type="password"
                      required
                      value={recoveryNuevaPassword}
                      onChange={(e) => setRecoveryNuevaPassword(e.target.value)}
                      placeholder="Mínimo 8 caracteres alfanumérica"
                      className="w-full bg-[#f8f9fa] border border-slate-300 rounded-xl px-3 py-2 text-xs text-slate-800 focus:outline-none focus:border-[#271a82]"
                    />
                  </div>

                  <div>
                    <label className="block text-xs font-bold text-slate-700 mb-1">
                      Confirmar Nueva Contraseña
                    </label>
                    <input
                      type="password"
                      required
                      value={recoveryConfirmarPassword}
                      onChange={(e) => setRecoveryConfirmarPassword(e.target.value)}
                      placeholder="Repite la nueva contraseña"
                      className="w-full bg-[#f8f9fa] border border-slate-300 rounded-xl px-3 py-2 text-xs text-slate-800 focus:outline-none focus:border-[#271a82]"
                    />
                  </div>

                  {renderPolicyBadges(recoveryNuevaPassword, recoveryConfirmarPassword)}

                  <div className="flex items-center gap-2 pt-1">
                    <button
                      type="button"
                      onClick={() => setRecoveryStep(1)}
                      className="px-3.5 py-2.5 rounded-xl border border-slate-300 text-slate-700 font-bold text-xs hover:bg-slate-50 transition cursor-pointer"
                    >
                      Atrás
                    </button>
                    <button
                      type="submit"
                      disabled={isLoading || recoveryNuevaPassword.length < 8 || !/[a-zA-Z]/.test(recoveryNuevaPassword) || !/[0-9]/.test(recoveryNuevaPassword) || recoveryNuevaPassword !== recoveryConfirmarPassword}
                      className="flex-1 py-2.5 rounded-xl bg-emerald-600 hover:bg-emerald-700 text-white font-bold text-xs shadow-md transition active:scale-95 cursor-pointer flex items-center justify-center gap-2 disabled:opacity-40 disabled:cursor-not-allowed"
                    >
                      <CheckCircle2 className="w-4 h-4 text-white" />
                      {isLoading ? 'Verificando y cambiando...' : 'Verificar Código & Restablecer Clave'}
                    </button>
                  </div>
                </form>
              )}
            </div>
          )}

          {/* TAB 4: CAMBIO VOLUNTARIO DE CONTRASEÑA (USUARIO CONECTADO) */}
          {tab === 'seguridad' && currentUser && (
            <form onSubmit={handleVoluntaryPasswordChange} className="space-y-4">
              <div className="p-3.5 bg-emerald-50/70 border border-emerald-200 rounded-xl flex items-center gap-3">
                <div className="w-9 h-9 rounded-xl bg-emerald-600 text-white flex items-center justify-center shrink-0">
                  <ShieldCheck className="w-5 h-5" />
                </div>
                <div>
                  <h4 className="text-xs font-bold text-emerald-950">Seguridad & Contraseña Personal</h4>
                  <p className="text-[11px] text-emerald-800">
                    Actualiza tu clave en cualquier momento cumpliendo la política alfanumérica de 8+ caracteres.
                  </p>
                </div>
              </div>

              <div>
                <label className="block text-xs font-bold text-slate-700 mb-1">Contraseña Actual</label>
                <input
                  type="password"
                  value={voluntarioActualPassword}
                  onChange={(e) => setVoluntarioActualPassword(e.target.value)}
                  placeholder="Ingresa tu contraseña actual"
                  className="w-full bg-[#f8f9fa] border border-slate-300 rounded-xl px-3 py-2 text-xs text-slate-800 focus:outline-none focus:border-[#271a82]"
                />
              </div>

              <div>
                <label className="block text-xs font-bold text-slate-700 mb-1">Nueva Contraseña Alfanumérica</label>
                <input
                  type="password"
                  required
                  value={voluntarioNuevaPassword}
                  onChange={(e) => setVoluntarioNuevaPassword(e.target.value)}
                  placeholder="Mínimo 8 caracteres (letras y números)"
                  className="w-full bg-[#f8f9fa] border border-slate-300 rounded-xl px-3 py-2 text-xs text-slate-800 focus:outline-none focus:border-[#271a82]"
                />
              </div>

              <div>
                <label className="block text-xs font-bold text-slate-700 mb-1">Confirmar Nueva Contraseña</label>
                <input
                  type="password"
                  required
                  value={voluntarioConfirmarPassword}
                  onChange={(e) => setVoluntarioConfirmarPassword(e.target.value)}
                  placeholder="Repite la nueva contraseña"
                  className="w-full bg-[#f8f9fa] border border-slate-300 rounded-xl px-3 py-2 text-xs text-slate-800 focus:outline-none focus:border-[#271a82]"
                />
              </div>

              {renderPolicyBadges(voluntarioNuevaPassword, voluntarioConfirmarPassword)}

              <div className="pt-1">
                <button
                  type="submit"
                  disabled={isLoading || voluntarioNuevaPassword.length < 8 || !/[a-zA-Z]/.test(voluntarioNuevaPassword) || !/[0-9]/.test(voluntarioNuevaPassword) || voluntarioNuevaPassword !== voluntarioConfirmarPassword}
                  className="w-full py-2.5 rounded-xl bg-emerald-600 hover:bg-emerald-700 text-white font-bold text-xs shadow-md transition active:scale-95 cursor-pointer flex items-center justify-center gap-2 disabled:opacity-40"
                >
                  <Key className="w-4 h-4" />
                  {isLoading ? 'Actualizando clave...' : 'Actualizar Mi Contraseña'}
                </button>
              </div>
            </form>
          )}

          {/* TAB 5: CAMBIO DE ROL / SWITCH USER */}
          {tab === 'switch' && (
            <div className="space-y-3">
              {(() => {
                const canSwitchUsers = currentUser?.rol === 'Administrador' || currentUser?.rol === 'Desarrollador' || currentUser?.permisos?.gestion_usuarios;
                if (!canSwitchUsers) {
                  return (
                    <div className="p-4 bg-amber-50 border border-amber-200 rounded-xl flex items-start gap-3">
                      <ShieldAlert className="w-5 h-5 text-amber-600 shrink-0 mt-0.5" />
                      <div>
                        <h4 className="text-xs font-bold text-amber-900">Cambio de usuario restringido</h4>
                        <p className="text-[11px] text-amber-800 mt-1">
                          Solo los perfiles de Administrador y Desarrollador pueden cambiar de contexto de usuario. Su rol actual ({currentUser?.rol || 'Sin rol'}) no tiene esta facultad.
                        </p>
                      </div>
                    </div>
                  );
                }
                return (
                  <>
                    <p className="text-xs text-slate-500">
                      Selecciona cualquier usuario registrado para cambiar de contexto de trabajo y verificar permisos de rol:
                    </p>

                    <div className="space-y-2">
                      {usuarios.map((u, uIdx) => {
                        const isCurrent = currentUser?.id_usuario === u.id_usuario;
                        const hasPendingForcedChange = u.requiere_cambio_password === true;

                        return (
                          <div
                            key={`switch-user-${u.id_usuario}-${u.email || uIdx}`}
                            onClick={() => {
                              if (!u.activo) {
                                onShowToast(`Usuario pendiente de aprobación por el Administrador Maestro`, 'error');
                                return;
                              }
                              if (hasPendingForcedChange) {
                                setMustChangeUser(u);
                                setNuevaPassword('');
                                setConfirmarPassword('');
                                setTab('cambio_obligatorio');
                                onShowToast(`⚠️ ${u.nombre_completo} tiene una contraseña provisional pendiente de cambio.`, 'info');
                                return;
                              }
                              onSelectUser(u);
                              onShowToast(`Contexto cambiado a ${u.nombre_completo}`);
                              onClose();
                            }}
                            className={`p-3 rounded-xl border transition flex items-center justify-between cursor-pointer ${
                              isCurrent
                                ? 'bg-indigo-50 border-[#271a82] shadow-xs'
                                : u.activo
                                ? 'bg-white hover:bg-[#f8f9fa] border-slate-200'
                                : 'bg-amber-50/60 border-amber-200 opacity-70'
                            }`}
                          >
                            <div className="flex items-center gap-3">
                              <div className={`w-9 h-9 rounded-xl flex items-center justify-center font-bold text-xs shrink-0 overflow-hidden shadow-xs ring-1 ring-black/5 ${
                                u.rol === 'Administrador'
                                  ? 'bg-[#271a82] text-white'
                                  : u.rol === 'Desarrollador'
                                  ? 'bg-[#0f766e] text-white'
                                  : u.rol === 'Contador'
                                  ? 'bg-[#4059aa] text-white'
                                  : u.rol === 'Auditor'
                                  ? 'bg-[#fa9d1c] text-white'
                                  : 'bg-slate-700 text-white'
                              }`}>
                                {u.avatar_url ? (
                                  <img
                                    src={u.avatar_url}
                                    alt={u.nombre_completo}
                                    className="w-full h-full object-cover"
                                  />
                                ) : (
                                  getCleanInitials(u.nombre_completo)
                                )}
                              </div>

                              <div>
                                <div className="flex items-center gap-2">
                                  <span className="text-xs font-bold text-slate-800">{u.nombre_completo}</span>
                                  {isCurrent && (
                                    <span className="text-[10px] bg-[#271a82] text-white font-extrabold px-1.5 py-0.2 rounded">
                                      Activo
                                    </span>
                                  )}
                                </div>
                                <span className="text-[11px] text-slate-500 block">{u.email}</span>
                              </div>
                            </div>

                            <div className="text-right flex flex-col items-end gap-1">
                              <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full block ${
                                u.activo
                                  ? 'bg-emerald-100 text-emerald-800'
                                  : 'bg-amber-100 text-amber-800'
                              }`}>
                                {u.activo ? u.rol : 'Pendiente Aprobación'}
                              </span>
                              {hasPendingForcedChange && (
                                <span className="text-[10px] text-amber-700 font-bold bg-amber-50 border border-amber-200 px-1.5 py-0.2 rounded flex items-center gap-1">
                                  ⚠️ Debe cambiar clave
                                </span>
                              )}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </>
                );
              })()}
            </div>
          )}

          {/* TAB 6: IMAGEN CORPORATIVA / INICIALES JY */}
          {tab === 'avatar' && currentUser && (
            <div className="space-y-4">
              <div className="bg-gradient-to-r from-slate-50 to-indigo-50/50 border border-indigo-100 rounded-2xl p-4 flex items-center gap-4">
                <div className="w-16 h-16 rounded-2xl bg-gradient-to-br from-[#271a82] to-[#fa9d1c] text-white flex items-center justify-center font-black text-xl shadow-md overflow-hidden shrink-0 border-2 border-white ring-2 ring-indigo-200">
                  {currentUser.avatar_url ? (
                    <img
                      src={currentUser.avatar_url}
                      alt={currentUser.nombre_completo}
                      className="w-full h-full object-cover"
                    />
                  ) : (
                    getCleanInitials(currentUser.nombre_completo)
                  )}
                </div>
                <div>
                  <div className="text-sm font-bold text-slate-900">
                    {currentUser.nombre_completo}
                  </div>
                  <div className="text-xs text-slate-500 mt-0.5">
                    {currentUser.avatar_url 
                      ? '✓ Imagen corporativa activa y visible en el sistema' 
                      : '✓ Monograma limpio activo: Solo letras JY'}
                  </div>
                  <div className="mt-1 flex items-center gap-2">
                    <span className="text-[10px] bg-[#271a82] text-white font-bold px-2 py-0.5 rounded-full">
                      {currentUser.rol}
                    </span>
                    <span className="text-[10px] text-slate-400 font-mono">
                      ID #{currentUser.id_usuario}
                    </span>
                  </div>
                </div>
              </div>

              <div className="space-y-3 pt-1">
                <div className="text-xs font-bold text-slate-700 flex items-center gap-1.5">
                  <Sparkles className="w-3.5 h-3.5 text-[#fa9d1c]" />
                  <span>Personalizar Identidad: JY o Imagen Corporativa</span>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
                  {/* Opción 1: Solo Letras JY */}
                  <button
                    type="button"
                    disabled={isSavingAvatar}
                    onClick={handleResetToInitialsJY}
                    className="p-3 rounded-xl border border-slate-200 hover:border-[#271a82] hover:bg-white text-left transition flex items-start gap-2.5 cursor-pointer group shadow-2xs"
                  >
                    <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-[#271a82] to-[#4059aa] text-white flex items-center justify-center font-black text-xs shrink-0 shadow-xs">
                      JY
                    </div>
                    <div>
                      <div className="text-xs font-bold text-slate-800 group-hover:text-[#271a82]">
                        Solo Letras JY
                      </div>
                      <div className="text-[10px] text-slate-500">
                        Iniciales limpias de Juan Yaya
                      </div>
                    </div>
                  </button>

                  {/* Opción 2: Emblema Corporativo TLM */}
                  <button
                    type="button"
                    disabled={isSavingAvatar}
                    onClick={handleSetOfficialTlmAvatar}
                    className="p-3 rounded-xl border border-slate-200 hover:border-[#fa9d1c] hover:bg-white text-left transition flex items-start gap-2.5 cursor-pointer group shadow-2xs"
                  >
                    <div className="w-8 h-8 rounded-lg bg-[#160f38] p-1 flex items-center justify-center shrink-0 border border-[#fa9d1c] shadow-xs">
                      <img src="/avatar_corporativo_tlm.svg" alt="TLM" className="w-full h-full object-contain" />
                    </div>
                    <div>
                      <div className="text-xs font-bold text-slate-800 group-hover:text-[#fa9d1c]">
                        Emblema TLM Oficial
                      </div>
                      <div className="text-[10px] text-slate-500">
                        Imagen corporativa Sociedad BIC
                      </div>
                    </div>
                  </button>
                </div>

                {/* Opción 3: Subir archivo de imagen */}
                <div className="p-4 rounded-xl border-2 border-dashed border-indigo-200 hover:border-[#271a82] bg-indigo-50/30 transition text-center">
                  <label className="flex flex-col items-center justify-center cursor-pointer">
                    <div className="w-9 h-9 rounded-full bg-white shadow-xs border border-indigo-100 flex items-center justify-center text-[#271a82] mb-1.5">
                      <Upload className="w-4 h-4" />
                    </div>
                    <span className="text-xs font-bold text-slate-800">
                      Subir Imagen Corporativa / Foto de Perfil
                    </span>
                    <span className="text-[10px] text-slate-500 mt-0.5 max-w-xs">
                      Selecciona cualquier archivo de imagen (PNG, JPG, SVG) para colocar como avatar de {currentUser.nombre_completo}
                    </span>
                    <input
                      type="file"
                      accept="image/*"
                      onChange={handleUploadAvatarFile}
                      className="hidden"
                    />
                  </label>
                </div>

                {/* Opción 4: Enlace URL */}
                <form onSubmit={handleSaveAvatarUrl} className="pt-1">
                  <label className="block text-[11px] font-bold text-slate-600 mb-1">
                    O pegar URL de imagen corporativa externa:
                  </label>
                  <div className="flex gap-2">
                    <input
                      type="url"
                      value={avatarInputUrl}
                      onChange={(e) => setAvatarInputUrl(e.target.value)}
                      placeholder="https://ejemplo.com/foto_corporativa.png"
                      className="flex-1 bg-white border border-slate-300 rounded-xl px-3 py-2 text-xs text-slate-800 focus:outline-none focus:border-[#271a82]"
                    />
                    <button
                      type="submit"
                      disabled={isSavingAvatar || !avatarInputUrl.trim()}
                      className="px-3 py-2 bg-[#271a82] hover:bg-[#1c1343] text-white text-xs font-bold rounded-xl transition cursor-pointer disabled:opacity-50 shrink-0"
                    >
                      Guardar URL
                    </button>
                  </div>
                </form>
              </div>
            </div>
          )}

          {/* TAB 7: NUEVO REGISTRO */}
          {tab === 'register' && (
            <form onSubmit={handleRegisterSubmit} className="space-y-4">
              <div>
                <label className="block text-xs font-bold text-slate-700 mb-1">Nombre Completo</label>
                <div className="relative">
                  <User className="w-4 h-4 text-slate-400 absolute left-3 top-3 pointer-events-none" />
                  <input
                    type="text"
                    required
                    value={nombreCompleto}
                    onChange={(e) => setNombreCompleto(e.target.value)}
                    placeholder="Ej. Juan Pérez (Analista Contable)"
                    className="w-full bg-[#f8f9fa] border border-slate-300 rounded-xl pl-9 pr-3 py-2 text-xs text-slate-800 focus:outline-none focus:border-[#271a82]"
                  />
                </div>
              </div>

              <div>
                <label className="block text-xs font-bold text-slate-700 mb-1">Correo Electrónico Corporativo</label>
                <div className="relative">
                  <Mail className="w-4 h-4 text-slate-400 absolute left-3 top-3 pointer-events-none" />
                  <input
                    type="email"
                    required
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder="juan.perez@empresa.com"
                    className="w-full bg-[#f8f9fa] border border-slate-300 rounded-xl pl-9 pr-3 py-2 text-xs text-slate-800 focus:outline-none focus:border-[#271a82]"
                  />
                </div>
              </div>

              <div>
                <label className="block text-xs font-bold text-slate-700 mb-1">Contraseña Sugerida</label>
                <div className="relative">
                  <Lock className="w-4 h-4 text-slate-400 absolute left-3 top-3 pointer-events-none" />
                  <input
                    type="password"
                    required
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder="Mínimo 8 caracteres alfanumérica"
                    className="w-full bg-[#f8f9fa] border border-slate-300 rounded-xl pl-9 pr-3 py-2 text-xs text-slate-800 focus:outline-none focus:border-[#271a82]"
                  />
                </div>
              </div>

              <div className="p-3 bg-amber-50 border border-amber-200 rounded-xl text-[11px] text-amber-900">
                <span className="font-bold block mb-0.5">Seguridad y Gobierno Multi-Tenant TLM:</span>
                Las nuevas solicitudes entran en cola hasta que Juan Yaya (Administrador Maestro) las autorice o asigne credenciales oficiales.
              </div>

              <div className="pt-1">
                <button
                  type="submit"
                  disabled={isLoading}
                  className="w-full py-2.5 rounded-xl bg-[#e64519] hover:bg-[#c43610] text-white font-bold text-xs shadow-md transition active:scale-95 cursor-pointer flex items-center justify-center gap-2"
                >
                  <UserPlus className="w-4 h-4" />
                  {isLoading ? 'Registrando...' : 'Solicitar Registro de Usuario'}
                </button>
              </div>
            </form>
          )}
        </div>

        {/* Footer */}
        <div className="p-3.5 bg-slate-50 border-t border-slate-200 text-center">
          <span className="text-[11px] text-slate-500">
            Plataforma protegida con Row-Level Security y Tokens Bearer · TLM Get Adviced SAS BIC
          </span>
        </div>
      </div>
    </div>
  );
};
