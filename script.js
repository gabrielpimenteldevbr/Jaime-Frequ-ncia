/*
 * Jaime Freq — frequência escolar, reconhecimento facial, e-mail e integração JSON.
 * Bibliotecas externas: GSAP e face-api.js, carregadas pelo index.html.
 * Os dados escolares ficam no Supabase e são sincronizados em tempo real.
 */

(() => {
  "use strict";

  const LEGACY_STORAGE_KEY = "presenca_ai_escolar_v1";
  const DEVICE_STORAGE_KEY = "presenca_ai_device_id";
  const MIGRATION_KEY = "presenca_ai_legacy_migrated_v2";
  const APP_VERSION = "4.3.0";
  const ATTENDANCE_ALERT_THRESHOLD = 85;
  const SCHOOL_START_TIME = "07:30";
  const SCHOOL_END_TIME = "17:00";
  const MODEL_URL = "https://cdn.jsdelivr.net/gh/justadudewhohacks/face-api.js@master/weights";
  const AVATAR_CLASSES = 5;
  const VIEW_LABELS = {
    dashboard: "Início",
    students: "Alunos",
    classes: "Turmas",
    attendance: "Frequência",
    departures: "Saídas antecipadas",
    absences: "Frequência por aula",
    reports: "Relatórios",
    users: "Contas de acesso",
    settings: "Configurações"
  };

  const ROLE_DETAILS = {
    admin: { label: "Administrador", avatar: "AD" },
    coordenador: { label: "Coordenação", avatar: "CO" },
    lider: { label: "Líder de turma", avatar: "LT" },
    professor: { label: "Líder de turma", avatar: "LT" },
    pdt: { label: "PDT da turma", avatar: "PD" },
    tablet: { label: "Tablet da sala", avatar: "TB" }
  };

  const runtime = {
    state: null,
    accounts: [],
    accountsLoaded: false,
    db: null,
    session: null,
    role: null,
    realtimeChannel: null,
    syncRefreshTimer: null,
    enteringApplication: false,
    activeView: "dashboard",
    modelsLoaded: false,
    modelsPromise: null,
    tabletStream: null,
    enrollmentStream: null,
    pendingDescriptor: null,
    scanTimer: null,
    scanTween: null,
    recognitionTimer: null,
    recognitionBusy: false,
    recognitionCooldownUntil: 0,
    lastFeedbackText: "",
    activeModal: null,
    clockTimer: null,
    counterValues: Object.create(null)
  };

  const $ = (id) => document.getElementById(id);
  const $$ = (selector, parent = document) => Array.from(parent.querySelectorAll(selector));

  function createId(prefix) {
    if (globalThis.crypto && typeof globalThis.crypto.randomUUID === "function") {
      return `${prefix}_${globalThis.crypto.randomUUID()}`;
    }
    return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
  }

  function createInitialState() {
    return {
      version: APP_VERSION,
      settings: {
        schoolName: "Minha escola",
        lateTime: "07:15",
        threshold: 0.48,
        scanInterval: 1500,
        deviceId: getDeviceId()
      },
      classes: [],
      students: [],
      attendance: [],
      closures: [],
      professorQueue: [],
      schoolPeriods: [],
      earlyDepartures: []
    };
  }

  function getDeviceId() {
    try {
      const existing = localStorage.getItem(DEVICE_STORAGE_KEY);
      if (existing) return existing;
      const generated = createId("tablet");
      localStorage.setItem(DEVICE_STORAGE_KEY, generated);
      return generated;
    } catch {
      return createId("tablet");
    }
  }

  function classFromRow(row) {
    return { id: row.id, name: row.name, room: row.room || "", shift: row.shift, teacher: row.teacher || "", pdtName: row.pdt_name || "", pdtEmail: row.pdt_email || "", createdAt: row.created_at, updatedAt: row.updated_at };
  }

  function classToRow(entry) {
    return { id: entry.id, name: entry.name, room: entry.room || null, shift: entry.shift, teacher: entry.teacher || null, pdt_name: entry.pdtName || null, pdt_email: entry.pdtEmail || null, created_at: entry.createdAt || new Date().toISOString(), updated_at: entry.updatedAt || new Date().toISOString() };
  }

  function studentFromRow(row) {
    return { id: row.id, name: row.name, registration: row.registration, classId: row.class_id, guardian: row.guardian || "", biometricConsent: Boolean(row.biometric_consent), faceDescriptor: Array.isArray(row.face_descriptor) ? row.face_descriptor.map(Number) : null, active: row.active !== false, createdAt: row.created_at, updatedAt: row.updated_at };
  }

  function studentToRow(student) {
    return { id: student.id, name: student.name, registration: student.registration, class_id: student.classId, guardian: student.guardian || null, biometric_consent: Boolean(student.biometricConsent), face_descriptor: student.biometricConsent && Array.isArray(student.faceDescriptor) ? student.faceDescriptor : null, active: student.active !== false, created_at: student.createdAt || new Date().toISOString(), updated_at: student.updatedAt || new Date().toISOString() };
  }

  function attendanceFromRow(row) {
    return { id: row.id, studentId: row.student_id, studentName: row.student_name, registration: row.registration, classId: row.class_id, className: row.class_name, room: row.room || "", date: row.attendance_date, time: String(row.attendance_time || "").slice(0, 5), timestamp: row.recorded_at, status: row.status, method: row.method, similarity: row.similarity === null ? null : Number(row.similarity), note: row.note || "", deviceId: row.device_id || "" };
  }

  function attendanceToRow(record) {
    return { id: record.id, student_id: record.studentId, student_name: record.studentName, registration: record.registration, class_id: record.classId, class_name: record.className, room: record.room || null, attendance_date: record.date, attendance_time: record.time, recorded_at: record.timestamp, status: record.status, method: record.method, similarity: record.similarity, note: record.note || null, device_id: record.deviceId };
  }

  function closureFromRow(row) {
    return {
      id: row.id,
      classId: row.class_id,
      className: row.class_name,
      date: row.attendance_date,
      closedAt: row.closed_at,
      closedBy: row.closed_by || "",
      closedByEmail: row.closed_by_email,
      pdtName: row.pdt_name || "",
      pdtEmail: row.pdt_email,
      totalStudents: Number(row.total_students || 0),
      presentCount: Number(row.present_count || 0),
      absentCount: Number(row.absent_count || 0),
      absentStudents: Array.isArray(row.absent_students) ? row.absent_students : [],
      emailStatus: row.email_status,
      emailAttempts: Number(row.email_attempts || 0),
      emailSentAt: row.email_sent_at || "",
      emailError: row.email_error || "",
      acceptingLate: Boolean(row.accepting_late),
      revision: Math.max(1, Number(row.revision || 1)),
      lateOpenedAt: row.late_opened_at || "",
      lastRequeuedAt: row.last_requeued_at || ""
    };
  }

  function professorQueueFromRow(row) {
    return {
      callId: row.id_chamada,
      closureId: row.closure_id,
      studentId: row.student_id,
      classId: row.class_id,
      leaderId: row.id_lider,
      className: row.turma,
      status: row.status,
      date: row.data_chamada,
      syncStatus: row.sync_status,
      syncAttempts: Number(row.sync_attempts || 0),
      syncError: row.sync_error || "",
      syncedAt: row.synced_at || ""
    };
  }

  function schoolPeriodFromRow(row) {
    return {
      number: Number(row.lesson_number),
      label: row.label || `${row.lesson_number}ª aula`,
      startTime: String(row.start_time || "").slice(0, 5),
      endTime: String(row.end_time || "").slice(0, 5),
      updatedAt: row.updated_at || ""
    };
  }

  function earlyDepartureFromRow(row) {
    return {
      id: row.id,
      studentId: row.student_id,
      studentName: row.student_name,
      registration: row.registration,
      classId: row.class_id,
      className: row.class_name,
      date: row.departure_date,
      time: String(row.departure_time || "").slice(0, 5),
      missedLessons: Array.isArray(row.missed_lessons) ? row.missed_lessons : [],
      missedLessonCount: Number(row.missed_lesson_count || 0),
      reason: row.reason || "",
      recordedBy: row.recorded_by || "",
      recordedByEmail: row.recorded_by_email || "",
      createdAt: row.created_at || "",
      updatedAt: row.updated_at || ""
    };
  }

  function settingsFromRow(row) {
    return { schoolName: row?.school_name || "Minha escola", lateTime: String(row?.late_time || "07:15").slice(0, 5), threshold: Number(row?.threshold ?? 0.48), scanInterval: Number(row?.scan_interval ?? 1500), deviceId: getDeviceId() };
  }

  function settingsToRow(settings) {
    return { id: "main", school_name: settings.schoolName, late_time: settings.lateTime, threshold: Number(settings.threshold), scan_interval: Number(settings.scanInterval), updated_at: new Date().toISOString() };
  }

  function configuredSupabase() {
    const config = globalThis.PRESENCA_CONFIG || {};
    return /^https:\/\/[a-z0-9-]+\.supabase\.co$/i.test(String(config.supabaseUrl || "")) && /^(sb_publishable_|eyJ)/.test(String(config.supabasePublishableKey || ""));
  }

  function createDatabaseClient() {
    if (!configuredSupabase()) throw new Error("[ERRO] 4586-7467");
    if (!globalThis.supabase?.createClient) throw new Error("Dados não encontrados, verifique sua conexão.");
    const config = globalThis.PRESENCA_CONFIG;
    runtime.db = globalThis.supabase.createClient(config.supabaseUrl, config.supabasePublishableKey, {
      auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true }
    });
  }

  function setSyncStatus(status, label) {
    const badge = $("sync-status");
    if (!badge) return;
    badge.className = `status-pill status-${status}`;
    badge.innerHTML = `<span></span>${escapeHTML(label)}`;
  }

  function setAuthFeedback(message, type = "neutral") {
    const feedback = $("auth-feedback");
    feedback.className = `auth-feedback${type === "neutral" ? "" : ` feedback-${type}`}`;
    feedback.innerHTML = `<span class="feedback-dot"></span><span>${escapeHTML(message)}</span>`;
  }

  function showLoginScreen(message = "Entre para acessar os dados da escola.", type = "neutral") {
    $("auth-screen").hidden = false;
    $("auth-login-content").hidden = false;
    $("auth-setup-content").hidden = true;
    $("app-shell").hidden = true;
    $("tablet-screen").hidden = true;
    document.body.style.overflow = "";
    setAuthFeedback(message, type);
  }

  function showSetupScreen(message) {
    $("auth-screen").hidden = false;
    $("auth-login-content").hidden = true;
    $("auth-setup-content").hidden = false;
    $("app-shell").hidden = true;
    setAuthFeedback(message, "warning");
  }

  function databaseError(error, fallback) {
    if (!error) return new Error(fallback);
    if (error.code === "42P01" || error.code === "PGRST205") {
      return new Error("[ERRO] 42P01");
    }
    if (error.code === "PGRST202" || error.code === "42883" || /could not find the function|function .* does not exist/i.test(String(error.message || ""))) {
      return new Error("[ERRO] Não foi possível conectar ao servidor.");
    }
    if (error.code === "42501") return new Error("Sua conta não tem permissão para realizar esta ação.");
    if (error.code === "23505") return new Error("Já existe um registro com essas informações.");
    return new Error(error.message || fallback);
  }

  async function loadUserRole() {
    const userId = runtime.session?.user?.id;
    if (!userId) throw new Error("Sessão inválida. Entre novamente.");
    const { data, error } = await runtime.db.from("user_roles").select("role,class_id").eq("user_id", userId).maybeSingle();
    if (error) throw databaseError(error, "Não foi possível verificar as permissões da conta.");
    if (!data) throw new Error("Esta conta ainda não foi autorizada. Cadastre a função dela na tabela user_roles.");
    runtime.role = { name: data.role, classId: data.class_id || "" };
  }

  async function loadAllAttendance() {
    const pageSize = 1000;
    const rows = [];
    for (let from = 0; ; from += pageSize) {
      const { data, error } = await runtime.db
        .from("attendance")
        .select("*")
        .order("recorded_at", { ascending: false })
        .range(from, from + pageSize - 1);
      if (error) return { data: null, error };
      rows.push(...(data || []));
      if (!data || data.length < pageSize) return { data: rows, error: null };
    }
  }

  async function loadAllClosures() {
    const pageSize = 1000;
    const rows = [];
    for (let from = 0; ; from += pageSize) {
      const { data, error } = await runtime.db
        .from("attendance_closures")
        .select("*")
        .order("closed_at", { ascending: false })
        .range(from, from + pageSize - 1);
      if (error) return { data: null, error };
      rows.push(...(data || []));
      if (!data || data.length < pageSize) return { data: rows, error: null };
    }
  }

  async function loadAllProfessorQueue() {
    const pageSize = 1000;
    const rows = [];
    for (let from = 0; ; from += pageSize) {
      const { data, error } = await runtime.db
        .from("professor_attendance_outbox")
        .select("id_chamada,closure_id,student_id,class_id,id_lider,turma,status,data_chamada,sync_status,sync_attempts,sync_error,synced_at")
        .order("data_chamada", { ascending: false })
        .order("id_chamada", { ascending: true })
        .range(from, from + pageSize - 1);
      if (error) return { data: null, error };
      rows.push(...(data || []));
      if (!data || data.length < pageSize) return { data: rows, error: null };
    }
  }

  async function loadAllEarlyDepartures() {
    const pageSize = 1000;
    const rows = [];
    for (let from = 0; ; from += pageSize) {
      const { data, error } = await runtime.db
        .from("early_departures")
        .select("*")
        .order("departure_date", { ascending: false })
        .order("departure_time", { ascending: false })
        .range(from, from + pageSize - 1);
      if (error) return { data: null, error };
      rows.push(...(data || []));
      if (!data || data.length < pageSize) return { data: rows, error: null };
    }
  }

  async function loadRemoteState({ render = true } = {}) {
    setSyncStatus("loading", "Sincronizando");
    const [settingsResult, classesResult, studentsResult, attendanceResult, closuresResult, professorQueueResult, periodsResult, departuresResult] = await Promise.all([
      runtime.db.from("app_settings").select("*").eq("id", "main").maybeSingle(),
      runtime.db.from("classes").select("*").order("name", { ascending: true }),
      runtime.db.from("students").select("*").order("name", { ascending: true }),
      loadAllAttendance(),
      loadAllClosures(),
      loadAllProfessorQueue(),
      runtime.db.from("school_periods").select("*").order("lesson_number", { ascending: true }),
      loadAllEarlyDepartures()
    ]);
    const failed = [settingsResult, classesResult, studentsResult, attendanceResult, closuresResult, professorQueueResult, periodsResult, departuresResult]
      .find((result) => result.error);
    if (failed) {
      setSyncStatus("error", "Sem sincronização");
      throw databaseError(failed.error, "Não foi possível carregar os dados compartilhados.");
    }
    runtime.state = {
      version: APP_VERSION,
      settings: settingsFromRow(settingsResult.data),
      classes: (classesResult.data || []).map(classFromRow),
      students: (studentsResult.data || []).map(studentFromRow),
      attendance: (attendanceResult.data || []).map(attendanceFromRow),
      closures: (closuresResult.data || []).map(closureFromRow),
      professorQueue: (professorQueueResult.data || []).map(professorQueueFromRow),
      schoolPeriods: (periodsResult.data || []).map(schoolPeriodFromRow),
      earlyDepartures: (departuresResult.data || []).map(earlyDepartureFromRow)
    };
    if (render) renderEverything({ refreshSettings: true });
    setSyncStatus("ready", "Em tempo real");
    return runtime.state;
  }

  function scheduleRemoteRefresh() {
    clearTimeout(runtime.syncRefreshTimer);
    runtime.syncRefreshTimer = setTimeout(async () => {
      try { await loadRemoteState(); }
      catch (error) { showToast("Falha na sincronização", error.message, "error"); }
    }, 180);
  }

  function subscribeToRemoteChanges() {
    if (runtime.realtimeChannel) runtime.db.removeChannel(runtime.realtimeChannel);
    let channel = runtime.db.channel(`presenca-escolar-${runtime.session.user.id}`);
    for (const table of ["app_settings", "classes", "students", "attendance", "attendance_closures", "professor_attendance_outbox", "school_periods", "early_departures"]) {
      channel = channel.on("postgres_changes", { event: "*", schema: "public", table }, scheduleRemoteRefresh);
    }
    runtime.realtimeChannel = channel.subscribe((status) => {
      if (status === "SUBSCRIBED") setSyncStatus("ready", "Em tempo real");
      else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") setSyncStatus("error", "Reconectando");
    });
  }

  function legacyStateForMigration() {
    if (runtime.role?.name !== "admin") return null;
    try {
      if (localStorage.getItem(MIGRATION_KEY)) return null;
      const parsed = JSON.parse(localStorage.getItem(LEGACY_STORAGE_KEY) || "null");
      if (!parsed || !Array.isArray(parsed.classes) || !Array.isArray(parsed.students) || !Array.isArray(parsed.attendance)) return null;
      return parsed;
    } catch {
      return null;
    }
  }

  async function migrateLegacyDataIfRequested() {
    const legacy = legacyStateForMigration();
    if (!legacy || (!legacy.classes.length && !legacy.students.length && !legacy.attendance.length)) return;
    const remoteHasData = runtime.state.classes.length || runtime.state.students.length || runtime.state.attendance.length;
    if (remoteHasData) return;
    if (!confirm("Encontramos dados salvos neste navegador. Deseja enviá-los agora para o banco compartilhado?")) {
      localStorage.setItem(MIGRATION_KEY, "skipped");
      return;
    }
    setSyncStatus("loading", "Importando dados");
    const operations = [];
    if (legacy.classes.length) operations.push(await runtime.db.from("classes").upsert(legacy.classes.map(classToRow)));
    if (legacy.students.length) operations.push(await runtime.db.from("students").upsert(legacy.students.map(studentToRow)));
    if (legacy.attendance.length) operations.push(await runtime.db.from("attendance").upsert(legacy.attendance.map(attendanceToRow), { onConflict: "student_id,attendance_date", ignoreDuplicates: true }));
    if (legacy.settings) operations.push(await runtime.db.from("app_settings").upsert(settingsToRow({ ...runtime.state.settings, ...legacy.settings })));
    const failed = operations.find((result) => result.error);
    if (failed) throw databaseError(failed.error, "Não foi possível importar os dados deste navegador.");
    localStorage.removeItem(LEGACY_STORAGE_KEY);
    localStorage.setItem(MIGRATION_KEY, "completed");
    await loadRemoteState();
    showToast("Dados migrados", "Os cadastros e frequências locais agora estão disponíveis em todos os aparelhos.");
  }

  function applyAccountPermissions() {
    const roleName = runtime.role?.name || "tablet";
    const details = ROLE_DETAILS[roleName] || ROLE_DETAILS.tablet;
    const isTablet = roleName === "tablet";
    Object.keys(ROLE_DETAILS).forEach((role) => document.body.classList.toggle(`role-${role}`, role === roleName));
    $("profile-role").textContent = details.label;
    $("profile-email").textContent = runtime.session.user.email || "Conta conectada";
    $("profile-avatar").textContent = details.avatar;
    $("exit-tablet-button").querySelector("span").textContent = isTablet ? "Sair" : "Painel";
    $("header-finalize-button").hidden = !canFinalizeAttendance();
    $("attendance-finalize-button").hidden = !canFinalizeAttendance();
    $("tablet-finalize-button").hidden = !canFinalizeAttendance();
    $("add-student-button").hidden = !canManageSchool();
    $("add-class-button").hidden = !canManageSchool();
    $("header-tablet-button").hidden = !canOperateAttendance();
    $("sidebar-tablet-button").hidden = !canOperateAttendance();
    $("dashboard-open-tablet").hidden = !canOperateAttendance();
    $("add-account-button").hidden = !canManageAccounts();
    $("add-departure-button").hidden = !canManageSchool();
    $("edit-schedule-button").hidden = !canManageSchool();
  }

  function normalizeActiveViewForRole() {
    const roleName = runtime.role?.name;
    const allowed = roleName === "tablet" || roleName === "lider" || roleName === "professor"
      ? ["dashboard", "attendance"]
      : roleName === "pdt"
        ? ["dashboard", "attendance", "absences", "reports"]
        : roleName === "coordenador"
          ? ["dashboard", "students", "classes", "attendance", "departures", "absences", "reports", "users"]
          : Object.keys(VIEW_LABELS);
    if (!allowed.includes(runtime.activeView)) runtime.activeView = "dashboard";
  }

  async function enterApplication(session) {
    if (runtime.enteringApplication) return;
    runtime.enteringApplication = true;
    try {
      runtime.session = session;
      setAuthFeedback("Carregando dados compartilhados...", "warning");
      await loadUserRole();
      await loadRemoteState({ render: false });
      $("auth-screen").hidden = true;
      $("app-shell").hidden = false;
      applyAccountPermissions();
      normalizeActiveViewForRole();
      switchView(runtime.activeView, false);
      renderEverything({ refreshSettings: true });
      await migrateLegacyDataIfRequested();
      subscribeToRemoteChanges();
      if (runtime.role.name === "tablet") openTablet(runtime.role.classId);
      else animateView(runtime.activeView);
    } catch (error) {
      await runtime.db?.auth.signOut().catch(() => {});
      runtime.session = null;
      runtime.role = null;
      showLoginScreen(error.message, "error");
    } finally {
      runtime.enteringApplication = false;
    }
  }

  async function submitLogin(event) {
    event.preventDefault();
    const button = $("login-button");
    button.disabled = true;
    button.querySelector("span").textContent = "Entrando...";
    setAuthFeedback("Verificando sua conta...", "warning");
    try {
      const { data, error } = await runtime.db.auth.signInWithPassword({ email: $("login-email").value.trim(), password: $("login-password").value });
      if (error) {
        const message = String(error.message || "").toLocaleLowerCase("pt-BR");
        if (message.includes("email not confirmed")) throw new Error("Seu e-mail ainda não foi confirmado.");
        if (message.includes("invalid login credentials")) throw new Error("E-mail ou senha incorretos. Tente novamente ou entre contato com a gestão escolar.");
        throw new Error(`Não foi possível entrar: ${error.message || "erro de autenticação"}`);
      }
      await enterApplication(data.session);
    } catch (error) {
      showLoginScreen(error.message, "error");
    } finally {
      button.disabled = false;
      button.querySelector("span").textContent = "Entrar";
    }
  }

  async function signOut() {
    const channel = runtime.realtimeChannel;
    runtime.realtimeChannel = null;
    stopTabletCamera();
    if (channel) await runtime.db.removeChannel(channel);
    await runtime.db.auth.signOut();
    clearLocalSession("Você saiu do sistema com segurança.");
  }

  function clearLocalSession(message, type = "neutral") {
    stopTabletCamera();
    if (runtime.realtimeChannel) runtime.db?.removeChannel(runtime.realtimeChannel);
    runtime.realtimeChannel = null;
    runtime.session = null;
    runtime.role = null;
    runtime.accounts = [];
    runtime.accountsLoaded = false;
    runtime.state = createInitialState();
    document.body.classList.remove(...Object.keys(ROLE_DETAILS).map((role) => `role-${role}`));
    showLoginScreen(message, type);
  }

  function canManageSchool() {
    return runtime.role?.name === "admin" || runtime.role?.name === "coordenador";
  }

  function canManageAccounts() {
    return canManageSchool();
  }

  function canOperateAttendance() {
    return ["admin", "lider", "professor", "tablet"].includes(runtime.role?.name);
  }

  function canFinalizeAttendance() {
    return ["admin", "lider", "professor"].includes(runtime.role?.name);
  }

  function requireSchoolManager() {
    if (canManageSchool()) return true;
    showToast("Acesso restrito", "Somente a administração ou a coordenação pode alterar cadastros.", "error");
    return false;
  }

  function requireAdmin() {
    if (runtime.role?.name === "admin") return true;
    showToast("Acesso restrito", "Somente a administração pode realizar esta ação.", "error");
    return false;
  }

  function localDateKey(value = new Date()) {
    const date = value instanceof Date ? value : new Date(value);
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
  }

  function formatDate(value, options = {}) {
    const date = typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)
      ? new Date(`${value}T12:00:00`)
      : new Date(value);
    return new Intl.DateTimeFormat("pt-BR", { day: "2-digit", month: "2-digit", year: "numeric", ...options }).format(date);
  }

  function formatTime(value = new Date()) {
    const date = value instanceof Date ? value : new Date(value);
    return new Intl.DateTimeFormat("pt-BR", { hour: "2-digit", minute: "2-digit" }).format(date);
  }

  function escapeHTML(value) {
    return String(value ?? "").replace(/[&<>"']/g, (character) => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;"
    }[character]));
  }

  function initials(name) {
    return String(name || "?")
      .trim()
      .split(/\s+/)
      .filter(Boolean)
      .filter((part) => !/^(da|de|do|das|dos)$/i.test(part))
      .slice(0, 2)
      .map((part) => part[0].toLocaleUpperCase("pt-BR"))
      .join("") || "?";
  }

  function avatarClass(student) {
    let hash = 0;
    for (const character of String(student.id || student.name || "")) hash += character.charCodeAt(0);
    return `avatar-${hash % AVATAR_CLASSES}`;
  }

  function avatarMarkup(student) {
    return `<span class="student-avatar ${avatarClass(student)}">${escapeHTML(initials(student.name))}</span>`;
  }

  function iconMarkup(name) {
    return `<svg class="icon" aria-hidden="true"><use href="#i-${escapeHTML(name)}"></use></svg>`;
  }

  function getClass(classId) {
    return runtime.state.classes.find((entry) => entry.id === classId) || null;
  }

  function getStudent(studentId) {
    return runtime.state.students.find((entry) => entry.id === studentId) || null;
  }

  function activeStudents(classId = "") {
    return runtime.state.students.filter((student) => student.active !== false && (!classId || student.classId === classId));
  }

  function todaysAttendance(classId = "") {
    const today = localDateKey();
    return runtime.state.attendance.filter((entry) => entry.date === today && (!classId || entry.classId === classId));
  }

  function getClosure(classId, date = localDateKey()) {
    return runtime.state.closures.find((closure) => closure.classId === classId && closure.date === date) || null;
  }

  function storeClosure(row) {
    const closure = closureFromRow(row);
    const existing = runtime.state.closures.findIndex((item) => item.id === closure.id);
    if (existing >= 0) runtime.state.closures[existing] = closure;
    else runtime.state.closures.push(closure);
    return closure;
  }

  function missingStudents(classId, date = localDateKey()) {
    const presentIds = new Set(runtime.state.attendance
      .filter((record) => record.classId === classId && record.date === date)
      .map((record) => record.studentId));
    return activeStudents(classId).filter((student) => !presentIds.has(student.id)).sort(compareNames);
  }

  function emailStatusInfo(status) {
    if (status === "sent") return { text: "E-mail enviado", className: "badge-success" };
    if (status === "sending") return { text: "Enviando e-mail", className: "badge-blue" };
    if (status === "error") return { text: "Falha no e-mail", className: "badge-warning" };
    if (status === "paused") return { text: "Aguardando atrasados", className: "badge-warning" };
    return { text: "E-mail na fila", className: "badge-neutral" };
  }

  function compareNames(first, second) {
    return first.name.localeCompare(second.name, "pt-BR", { sensitivity: "base" });
  }

  function updateClock() {
    const now = new Date();
    const time = formatTime(now);
    $("live-clock").textContent = time;
    $("tablet-clock").textContent = time;

    const greeting = now.getHours() < 12 ? "Bom dia" : now.getHours() < 18 ? "Boa tarde" : "Boa noite";
    const fullDate = formatDate(now, { weekday: "long", day: "numeric", month: "long", year: undefined });
    $("dashboard-date").textContent = `${greeting} · ${fullDate}`;
    $("tablet-date").textContent = fullDate.toLocaleUpperCase("pt-BR");
    $("tablet-recent-date").textContent = formatDate(now, { year: undefined });
  }

  function animateView(viewName) {
    if (!globalThis.gsap || globalThis.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;
    const view = $(`view-${viewName}`);
    const items = $$(".page-heading, .metric-card, .panel, .class-card, .info-banner", view);
    if (!items.length) return;
    gsap.killTweensOf(items);
    gsap.fromTo(items, { autoAlpha: 0, y: 15 }, { autoAlpha: 1, y: 0, duration: 0.46, stagger: 0.055, ease: "power2.out", clearProps: "transform" });
  }

  function animateCounter(elementId, target, suffix = "") {
    const element = $(elementId);
    if (!element) return;
    const numericTarget = Number(target) || 0;
    if (!globalThis.gsap || globalThis.matchMedia?.("(prefers-reduced-motion: reduce)").matches) {
      element.textContent = `${numericTarget}${suffix}`;
      runtime.counterValues[elementId] = numericTarget;
      return;
    }
    const value = { count: runtime.counterValues[elementId] || 0 };
    gsap.to(value, {
      count: numericTarget,
      duration: 0.65,
      ease: "power2.out",
      overwrite: true,
      onUpdate() { element.textContent = `${Math.round(value.count)}${suffix}`; },
      onComplete() { runtime.counterValues[elementId] = numericTarget; }
    });
  }

  function switchView(viewName, shouldAnimate = true) {
    if (!VIEW_LABELS[viewName]) return;
    if (runtime.role?.name === "tablet" && ["students", "classes", "absences", "reports", "users", "settings"].includes(viewName)) {
      showToast("Acesso restrito", "A conta deste tablet só pode realizar e consultar a chamada da própria sala.", "warning");
      return;
    }
    if (["lider", "professor"].includes(runtime.role?.name) && ["students", "classes", "absences", "reports", "users", "settings"].includes(viewName)) {
      showToast("Acesso restrito", "O líder de turma utiliza apenas a chamada e o envio da frequência.", "warning");
      return;
    }
    if (runtime.role?.name === "pdt" && ["students", "classes", "users", "settings"].includes(viewName)) {
      showToast("Acesso restrito", "A PDT possui acesso de análise à frequência e ao ranking da própria turma.", "warning");
      return;
    }
    if (viewName === "settings" && runtime.role && runtime.role.name !== "admin") {
      showToast("Acesso restrito", "Somente o administrador pode alterar as configurações do sistema.", "warning");
      return;
    }
    if (viewName === "users" && !canManageAccounts()) {
      showToast("Acesso restrito", "Somente a administração ou a coordenação pode gerenciar contas.", "warning");
      return;
    }
    if (viewName === "absences" && !["admin", "coordenador", "pdt"].includes(runtime.role?.name)) {
      showToast("Acesso restrito", "O ranking de ausências é destinado à PDT e à coordenação.", "warning");
      return;
    }
    if (viewName === "departures" && !canManageSchool()) {
      showToast("Acesso restrito", "Somente a coordenação pode registrar saídas antecipadas.", "warning");
      return;
    }
    runtime.activeView = viewName;
    $$(".page-view").forEach((view) => view.classList.toggle("active", view.id === `view-${viewName}`));
    $$(".nav-item[data-view]").forEach((item) => item.classList.toggle("active", item.dataset.view === viewName));
    $("page-breadcrumb").textContent = VIEW_LABELS[viewName];
    if (viewName === "reports") renderReportPreview();
    if (viewName === "absences") renderAbsenceRanking();
    if (viewName === "departures") renderEarlyDepartures();
    if (viewName === "users") loadAccounts();
    closeMobileMenu();
    if (history.replaceState) history.replaceState(null, "", `#${viewName}`);
    if (shouldAnimate) animateView(viewName);
  }

  function openMobileMenu() {
    $("sidebar").classList.add("sidebar-open");
    $("sidebar-backdrop").classList.add("visible");
  }

  function closeMobileMenu() {
    $("sidebar").classList.remove("sidebar-open");
    $("sidebar-backdrop").classList.remove("visible");
  }

  function fillClassSelect(id, { includeAll = false, allLabel = "Todas as turmas", preferredValue = undefined } = {}) {
    const select = $(id);
    const previous = preferredValue === undefined ? select.value : preferredValue;
    const orderedClasses = [...runtime.state.classes].sort(compareNames);
    let html = includeAll ? `<option value="">${escapeHTML(allLabel)}</option>` : "";
    if (!includeAll && !orderedClasses.length) html = '<option value="">Cadastre uma turma</option>';
    html += orderedClasses.map((entry) => `<option value="${escapeHTML(entry.id)}">${escapeHTML(entry.name)}</option>`).join("");
    select.innerHTML = html;
    if (previous && orderedClasses.some((entry) => entry.id === previous)) select.value = previous;
    else if (includeAll) select.value = "";
    select.disabled = !orderedClasses.length;
  }

  function renderClassSelects() {
    const assignedClass = runtime.role?.classId || "";
    const filterOptions = { includeAll: !assignedClass, preferredValue: assignedClass || undefined };
    fillClassSelect("student-class-filter", filterOptions);
    fillClassSelect("attendance-class-filter", filterOptions);
    fillClassSelect("report-class-filter", filterOptions);
    fillClassSelect("absence-class-filter", filterOptions);
    fillClassSelect("departure-class-filter", { includeAll: true });
    fillClassSelect("departure-class");
    fillClassSelect("account-class");
    fillClassSelect("student-class", { preferredValue: assignedClass || undefined });
    fillClassSelect("tablet-class-select", { preferredValue: assignedClass || undefined });
    fillClassSelect("finalize-class-select", { preferredValue: assignedClass || undefined });

    for (const id of ["student-class-filter", "attendance-class-filter", "report-class-filter", "absence-class-filter", "tablet-class-select", "finalize-class-select"]) {
      if (assignedClass) $(id).disabled = true;
    }
  }

  function updateSchoolName() {
    const name = runtime.state.settings.schoolName.trim() || "Minha escola";
    $("sidebar-school-name").textContent = name;
    $("school-monogram").textContent = initials(name);
    document.title = `Jaime Freq — ${name}`;
  }

  function renderDashboard() {
    const students = activeStudents();
    const attendance = todaysAttendance();
    const closedToday = runtime.state.closures.filter((closure) => closure.date === localDateKey()).length;
    const enrolled = students.filter((student) => student.biometricConsent && Array.isArray(student.faceDescriptor)).length;
    const rate = students.length ? Math.round((attendance.length / students.length) * 100) : 0;

    animateCounter("metric-present", attendance.length);
    animateCounter("metric-students", students.length);
    animateCounter("metric-late", closedToday);
    animateCounter("metric-rate", rate, "%");

    $("nav-student-count").textContent = String(students.length);
    $("metric-present-foot").textContent = attendance.length ? `${attendance.length} ${attendance.length === 1 ? "aluno registrado" : "alunos registrados"} hoje` : "Nenhuma presença registrada";
    $("metric-biometric-foot").textContent = `${enrolled} ${enrolled === 1 ? "aluno com biometria" : "alunos com biometria facial"}`;
    $("metric-late-foot").textContent = `${closedToday} de ${runtime.state.classes.length} ${runtime.state.classes.length === 1 ? "turma" : "turmas"}`;

    const recent = [...attendance].sort((a, b) => b.timestamp.localeCompare(a.timestamp)).slice(0, 5);
    $("recent-attendance").innerHTML = recent.length ? recent.map((entry) => {
      const student = getStudent(entry.studentId) || { id: entry.studentId, name: entry.studentName };
      const method = entry.method === "reconhecimento_facial" ? "Reconhecimento facial" : "Registro anterior";
      return `<div class="activity-item">${avatarMarkup(student)}<div class="activity-copy"><strong>${escapeHTML(entry.studentName)}</strong><small>${escapeHTML(entry.className)} · ${method}</small></div><span class="activity-time">${escapeHTML(entry.time)}</span></div>`;
    }).join("") : `<div class="empty-state mini-empty">${iconMarkup("calendar")}<h3>Nenhuma presença registrada</h3><p>Abra a câmera da turma para iniciar a frequência.</p></div>`;

    const classes = [...runtime.state.classes].sort(compareNames).slice(0, 4);
    $("dashboard-classes").innerHTML = classes.length ? classes.map((entry, index) => {
      const total = activeStudents(entry.id).length;
      const present = attendance.filter((record) => record.classId === entry.id).length;
      const percentage = total ? Math.min(100, Math.round((present / total) * 100)) : 0;
      const color = index % 3 === 1 ? "progress-blue" : index % 3 === 2 ? "progress-purple" : "";
      return `<div class="class-progress-item"><div class="class-progress-heading"><strong>${escapeHTML(entry.name)}</strong><span>${present}/${total}</span></div><div class="progress-track"><span class="progress-fill ${color}" style="width: ${percentage}%"></span></div></div>`;
    }).join("") : '<p class="cell-muted">Cadastre uma turma para acompanhar a frequência.</p>';
  }

  function renderStudents() {
    const search = $("student-search").value.trim().toLocaleLowerCase("pt-BR");
    const classFilter = $("student-class-filter").value;
    const students = [...runtime.state.students].filter((student) => {
      const matchesClass = !classFilter || student.classId === classFilter;
      const haystack = `${student.name} ${student.registration}`.toLocaleLowerCase("pt-BR");
      return matchesClass && (!search || haystack.includes(search));
    }).sort(compareNames);

    $("student-result-count").textContent = `${students.length} ${students.length === 1 ? "aluno" : "alunos"}`;
    $("students-empty").hidden = students.length > 0;
    $("students-table-body").innerHTML = students.map((student) => {
      const entryClass = getClass(student.classId);
      const enrolled = student.biometricConsent && Array.isArray(student.faceDescriptor) && student.faceDescriptor.length === 128;
      const biometric = enrolled
        ? `<span class="badge badge-success">${iconMarkup("face")} Cadastrada</span>`
        : '<span class="badge badge-warning">Pendente</span>';
      const actions = canManageSchool()
        ? `<div class="table-actions"><button class="icon-button" data-action="edit-student" data-id="${escapeHTML(student.id)}" aria-label="Editar aluno">${iconMarkup("edit")}</button><button class="icon-button delete-action" data-action="delete-student" data-id="${escapeHTML(student.id)}" aria-label="Excluir aluno">${iconMarkup("trash")}</button></div>`
        : '<span class="cell-muted">Somente consulta</span>';
      return `<tr><td data-label="Aluno"><div class="student-name-cell">${avatarMarkup(student)}<div><strong>${escapeHTML(student.name)}</strong><small>${escapeHTML(student.guardian || "Aluno cadastrado")}</small></div></div></td><td data-label="Matrícula" class="cell-muted">${escapeHTML(student.registration)}</td><td data-label="Turma">${escapeHTML(entryClass?.name || "Sem turma")}</td><td data-label="Biometria">${biometric}</td><td data-label="Status"><span class="badge ${student.active !== false ? "badge-success" : "badge-neutral"}">${student.active !== false ? "Ativo" : "Inativo"}</span></td><td data-label="Ações">${actions}</td></tr>`;
    }).join("");
  }

  function renderClasses() {
    const classes = [...runtime.state.classes].sort(compareNames);
    const attendance = todaysAttendance();
    $("classes-empty").hidden = classes.length > 0;
    $("classes-grid").innerHTML = classes.map((entry) => {
      const students = activeStudents(entry.id);
      const present = attendance.filter((record) => record.classId === entry.id).length;
      const percentage = students.length ? Math.min(100, Math.round((present / students.length) * 100)) : 0;
      const closure = getClosure(entry.id);
      const actions = canManageSchool()
        ? `<div class="table-actions"><button class="icon-button" data-action="edit-class" data-id="${escapeHTML(entry.id)}" aria-label="Editar turma">${iconMarkup("edit")}</button><button class="icon-button delete-action" data-action="delete-class" data-id="${escapeHTML(entry.id)}" aria-label="Excluir turma">${iconMarkup("trash")}</button></div>`
        : "";
      const status = closure?.acceptingLate
        ? '<span class="badge badge-warning">Recebendo atrasados</span>'
        : closure
          ? '<span class="badge badge-success">Frequência finalizada</span>'
          : '<span class="badge badge-neutral">Frequência em andamento</span>';
      const pdt = entry.pdtName || entry.pdtEmail || "PDT ainda não cadastrada";
      const cameraAction = canOperateAttendance()
        ? `<button class="text-button" data-action="open-class-tablet" data-id="${escapeHTML(entry.id)}">${closure?.acceptingLate ? "Registrar atrasados" : closure ? "Ver fechamento" : "Abrir câmera"} ${iconMarkup("arrow")}</button>`
        : '<span class="cell-muted">Gestão da turma</span>';
      return `<article class="panel class-card"><div class="class-card-header"><span class="class-card-icon">${iconMarkup("school")}</span>${actions}</div><h2>${escapeHTML(entry.name)}</h2><p class="class-card-subtitle">${escapeHTML(entry.room || "Sala não informada")} · ${escapeHTML(entry.shift)}</p><div class="class-status-line">${status}</div><div class="class-card-stats"><span><strong>${present}/${students.length}</strong> presentes hoje</span><strong>${percentage}%</strong></div><div class="progress-track"><span class="progress-fill" style="width: ${percentage}%"></span></div><div class="class-pdt-line"><span>PDT</span><strong>${escapeHTML(pdt)}</strong></div><div class="class-card-footer"><small>${escapeHTML(entry.teacher || "Líder não informado")}</small>${cameraAction}</div></article>`;
    }).join("");
  }

  function filteredAttendance() {
    const selectedDate = $("attendance-date-filter").value;
    const selectedClass = $("attendance-class-filter").value;
    const selectedMethod = $("attendance-method-filter").value;
    return runtime.state.attendance.filter((entry) =>
      (!selectedDate || entry.date === selectedDate) &&
      (!selectedClass || entry.classId === selectedClass) &&
      (!selectedMethod || entry.method === selectedMethod)
    ).sort((a, b) => b.timestamp.localeCompare(a.timestamp));
  }

  function renderAttendance() {
    const attendance = filteredAttendance();
    $("attendance-result-count").textContent = `${attendance.length} ${attendance.length === 1 ? "registro" : "registros"}`;
    $("attendance-empty").hidden = attendance.length > 0;
    $("attendance-table-body").innerHTML = attendance.map((entry) => {
      const student = getStudent(entry.studentId) || { id: entry.studentId, name: entry.studentName };
      const status = entry.status === "atrasado"
        ? '<span class="badge badge-warning">Atrasado</span>'
        : '<span class="badge badge-success">Presente</span>';
      const method = entry.method === "reconhecimento_facial"
        ? `<span class="badge badge-blue">${iconMarkup("face")} Facial</span>`
        : '<span class="badge badge-neutral">Registro anterior</span>';
      const similarity = typeof entry.similarity === "number" ? `${entry.similarity.toFixed(1).replace(".", ",")}%` : "—";
      const deleteButton = canManageSchool() && !getClosure(entry.classId, entry.date)
        ? `<button class="icon-button delete-action" data-action="delete-attendance" data-id="${escapeHTML(entry.id)}" aria-label="Excluir registro">${iconMarkup("trash")}</button>`
        : "";
      return `<tr><td data-label="Aluno"><div class="student-name-cell">${avatarMarkup(student)}<div><strong>${escapeHTML(entry.studentName)}</strong><small>${escapeHTML(entry.registration)}</small></div></div></td><td data-label="Turma">${escapeHTML(entry.className)}</td><td data-label="Data / horário" class="cell-muted">${escapeHTML(formatDate(entry.date))} · ${escapeHTML(entry.time)}</td><td data-label="Status">${status}</td><td data-label="Método">${method}</td><td data-label="Similaridade">${escapeHTML(similarity)}</td><td data-label="Ações">${deleteButton}</td></tr>`;
    }).join("");
  }

  function renderTablet() {
    const classId = $("tablet-class-select").value;
    const students = activeStudents(classId);
    const attendance = todaysAttendance(classId).sort((a, b) => b.timestamp.localeCompare(a.timestamp));
    const percentage = students.length ? Math.min(100, Math.round((attendance.length / students.length) * 100)) : 0;

    $("tablet-present-count").textContent = String(attendance.length);
    $("tablet-class-total").textContent = `de ${students.length} ${students.length === 1 ? "aluno" : "alunos"}`;
    $("tablet-progress-fill").style.width = `${percentage}%`;
    $("tablet-recent-list").innerHTML = attendance.length ? attendance.slice(0, 7).map((entry) => {
      const student = getStudent(entry.studentId) || { id: entry.studentId, name: entry.studentName };
      return `<div class="tablet-recent-item">${avatarMarkup(student)}<div class="tablet-recent-copy"><strong>${escapeHTML(entry.studentName)}</strong><small>${entry.status === "atrasado" ? "Atrasado · " : ""}${entry.method === "manual" ? "Registro anterior" : "Reconhecimento facial"}</small></div><span class="tablet-recent-time">${escapeHTML(entry.time)}</span></div>`;
    }).join("") : '<p class="tablet-empty">Nenhuma chegada registrada nesta turma hoje.</p>';
    const closure = classId ? getClosure(classId) : null;
    const closureStatus = $("tablet-closure-status");
    closureStatus.hidden = !closure;
    closureStatus.classList.toggle("late-mode", Boolean(closure?.acceptingLate));
    $("tablet-heading").textContent = closure?.acceptingLate ? "Registre os atrasados." : "Aproxime seu rosto.";
    $("tablet-instruction").textContent = closure?.acceptingLate
      ? "Somente alunos que chegaram após o fechamento serão registrados como atrasados."
      : "Posicione-se dentro da marcação para registrar sua presença.";
    $("tablet-finalize-button").querySelector("span").textContent = closure?.acceptingLate ? "Encerrar atrasados" : closure ? "Opções" : "Finalizar";
    if (closure?.acceptingLate) {
      closureStatus.innerHTML = `${iconMarkup("clock")} Modo de atrasados aberto · relatório pausado`;
      $("start-camera-button").disabled = false;
      if (!runtime.tabletStream) setTabletFeedback("Inicie a câmera para reconhecer os alunos atrasados.", "warning");
    } else if (closure) {
      const status = emailStatusInfo(closure.emailStatus);
      closureStatus.innerHTML = `${iconMarkup("check")} Frequência finalizada · ${escapeHTML(status.text)}`;
      if (runtime.tabletStream) stopTabletCamera();
      $("start-camera-button").disabled = true;
      setTabletFeedback("Use Opções para registrar atrasados ou reenviar o relatório.", "success");
    } else {
      $("start-camera-button").disabled = false;
    }
  }

  function renderClosures() {
    const target = $("attendance-closures-list");
    const date = $("attendance-date-filter").value || localDateKey();
    const classFilter = $("attendance-class-filter").value;
    const closures = runtime.state.closures
      .filter((closure) => closure.date === date && (!classFilter || closure.classId === classFilter))
      .sort((first, second) => second.closedAt.localeCompare(first.closedAt));

    if (!closures.length) {
      target.innerHTML = '<div class="closure-empty">Nenhuma turma foi finalizada nesta data.</div>';
      return;
    }

    target.innerHTML = closures.map((closure) => {
      const status = emailStatusInfo(closure.emailStatus);
      const liveMissing = closure.acceptingLate ? missingStudents(closure.classId, closure.date) : null;
      const absentCount = liveMissing ? liveMissing.length : closure.absentCount;
      const presentCount = liveMissing ? Math.max(0, activeStudents(closure.classId).length - liveMissing.length) : closure.presentCount;
      const absentList = liveMissing || closure.absentStudents;
      const missing = absentCount
        ? absentList.map((student) => escapeHTML(student.nome || student.name)).join(", ")
        : "Nenhum aluno ausente";
      const professorRows = (runtime.state.professorQueue || [])
        .filter((entry) => entry.closureId === closure.id);
      const synchronizedCount = professorRows.filter((entry) => entry.syncStatus === "sent").length;
      const errorRows = professorRows.filter((entry) => entry.syncStatus === "error");
      const professorDescription = closure.acceptingLate
        ? "Professor: atualização após encerrar os atrasados"
        : !professorRows.length
          ? "Professor: preparando os registros individuais"
          : errorRows.length
            ? `Professor: ${synchronizedCount}/${professorRows.length} enviados · ${errorRows.length} com erro`
            : synchronizedCount === professorRows.length
              ? `Professor: ${synchronizedCount}/${professorRows.length} alunos sincronizados`
              : `Professor: ${synchronizedCount}/${professorRows.length} enviados · aguardando integração`;
      const canAct = canFinalizeAttendance() && closure.date === localDateKey();
      const sending = closure.emailStatus === "sending";
      const operationActions = canAct
        ? closure.acceptingLate
          ? `<button class="button button-primary button-compact" data-action="finalize-late" data-id="${escapeHTML(closure.classId)}">${iconMarkup("check")}Finalizar atrasados</button>`
          : `<button class="button button-dark button-compact" data-action="open-late" data-id="${escapeHTML(closure.classId)}" ${sending ? "disabled" : ""}>${iconMarkup("clock")}Registrar atrasados</button><button class="button button-secondary button-compact" data-action="resend-report" data-id="${escapeHTML(closure.classId)}" ${sending ? "disabled" : ""}>${iconMarkup("refresh")}Reenviar</button>`
        : "";
      const exportAction = professorRows.length && !closure.acceptingLate
        ? `<button class="button button-secondary button-compact" data-action="download-professor-json" data-id="${escapeHTML(closure.id)}">${iconMarkup("download")}JSON do professor</button>`
        : "";
      const actions = operationActions || exportAction
        ? `<div class="closure-actions">${operationActions}${exportAction}</div>`
        : "";
      const mode = closure.acceptingLate ? " · recebendo atrasados" : "";
      return `<article class="closure-card ${closure.acceptingLate ? "closure-card-late" : ""}"><div class="closure-card-top"><div><strong>${escapeHTML(closure.className)}</strong><span>Finalizada às ${escapeHTML(formatTime(closure.closedAt))}${escapeHTML(mode)}</span></div><span class="badge ${status.className}">${escapeHTML(status.text)}</span></div><p><strong>${presentCount}</strong> presentes · <strong>${absentCount}</strong> ausentes · revisão ${closure.revision}${closure.acceptingLate ? " (prévia)" : ""}</p><small>${missing}</small><span class="closure-destination">PDT: ${escapeHTML(closure.pdtEmail)}</span><span class="professor-sync-line${errorRows.length ? " professor-sync-error" : ""}">${escapeHTML(professorDescription)}</span>${closure.emailError ? `<span class="closure-error">${escapeHTML(closure.emailError)}</span>` : ""}${errorRows[0]?.syncError ? `<span class="closure-error">${escapeHTML(errorRows[0].syncError)}</span>` : ""}${actions}</article>`;
    }).join("");
  }

  function sortedSchoolPeriods() {
    return [...(runtime.state.schoolPeriods || [])].sort((first, second) => first.number - second.number);
  }

  function missedPeriodsForTime(time) {
    if (!/^\d{2}:\d{2}$/.test(String(time || ""))) return [];
    return sortedSchoolPeriods().filter((period) => time < period.endTime);
  }

  function scheduleBreakLabel(previousEnd, nextStart) {
    if (previousEnd === nextStart) return "";
    if (previousEnd === "12:00") return `Almoço · ${previousEnd} às ${nextStart}`;
    if (previousEnd === "09:10" || previousEnd === "14:55") return `Intervalo · ${previousEnd} às ${nextStart}`;
    return `Pausa · ${previousEnd} às ${nextStart}`;
  }

  function renderSchoolSchedule() {
    const target = $("schedule-summary-list");
    if (!target) return;
    const periods = sortedSchoolPeriods();
    if (!periods.length) {
      target.innerHTML = '<p class="cell-muted">Execute atualizacao-v4-3.sql para carregar a grade.</p>';
      return;
    }
    const rows = [];
    periods.forEach((period, index) => {
      if (index) {
        const breakLabel = scheduleBreakLabel(periods[index - 1].endTime, period.startTime);
        if (breakLabel) rows.push(`<span class="schedule-break">${escapeHTML(breakLabel)}</span>`);
      }
      rows.push(`<div class="schedule-summary-item"><span>${period.number}</span><strong>${escapeHTML(period.label)}</strong><small>${escapeHTML(period.startTime)}–${escapeHTML(period.endTime)}</small></div>`);
    });
    target.innerHTML = rows.join("");
  }

  function filteredEarlyDepartures() {
    const selectedDate = $("departure-date-filter")?.value || "";
    const selectedClass = $("departure-class-filter")?.value || "";
    return (runtime.state.earlyDepartures || []).filter((entry) =>
      (!selectedDate || entry.date === selectedDate) &&
      (!selectedClass || entry.classId === selectedClass)
    ).sort((first, second) =>
      second.date.localeCompare(first.date) || second.time.localeCompare(first.time)
    );
  }

  function missedLessonTags(entry) {
    const lessons = Array.isArray(entry.missedLessons) ? entry.missedLessons : [];
    if (!lessons.length) return '<span class="cell-muted">Nenhuma</span>';
    return `<div class="lesson-tags">${lessons.map((lesson) => `<span class="lesson-tag">${escapeHTML(lesson.aula || `${lesson.numero}ª aula`)}</span>`).join("")}</div>`;
  }

  function renderEarlyDepartures() {
    if (!$("departures-table-body")) return;
    renderSchoolSchedule();
    const rows = filteredEarlyDepartures();
    const missedCount = rows.reduce((total, entry) => total + entry.missedLessonCount, 0);
    $("departure-record-count").textContent = String(rows.length);
    $("departure-missed-count").textContent = String(missedCount);
    $("departure-result-count").textContent = `${rows.length} ${rows.length === 1 ? "registro" : "registros"}`;
    $("departures-empty").hidden = rows.length > 0;
    $("departures-table-body").innerHTML = rows.map((entry) => {
      const student = getStudent(entry.studentId) || { id: entry.studentId, name: entry.studentName };
      const actions = canManageSchool()
        ? `<div class="table-actions"><button class="icon-button" data-action="edit-departure" data-id="${escapeHTML(entry.id)}" aria-label="Corrigir saída">${iconMarkup("edit")}</button><button class="icon-button delete-action" data-action="delete-departure" data-id="${escapeHTML(entry.id)}" aria-label="Excluir saída">${iconMarkup("trash")}</button></div>`
        : "";
      return `<tr><td data-label="Aluno"><div class="student-name-cell">${avatarMarkup(student)}<div><strong>${escapeHTML(entry.studentName)}</strong><small>${escapeHTML(entry.registration)}</small></div></div></td><td data-label="Turma">${escapeHTML(entry.className)}</td><td data-label="Saída" class="cell-muted">${escapeHTML(formatDate(entry.date))} · <strong>${escapeHTML(entry.time)}</strong></td><td data-label="Aulas perdidas"><div class="lesson-count-cell"><strong class="absence-count">${entry.missedLessonCount}</strong>${missedLessonTags(entry)}</div></td><td data-label="Motivo">${escapeHTML(entry.reason || "Não informado")}</td><td data-label="Registrado por" class="cell-muted">${escapeHTML(entry.recordedByEmail)}</td><td data-label="Ações">${actions}</td></tr>`;
    }).join("");
  }

  function attendancePercentageData({ startDate = "", endDate = "", classId = "" } = {}) {
    const closures = runtime.state.closures.filter((closure) =>
      !closure.acceptingLate &&
      (!startDate || closure.date >= startDate) &&
      (!endDate || closure.date <= endDate) &&
      (!classId || closure.classId === classId)
    );
    const lessonsPerDay = sortedSchoolPeriods().length || 9;
    const ranking = new Map();
    const attendanceByClassDate = new Map();
    const departuresByStudentDate = new Map();

    for (const record of runtime.state.attendance) {
      if ((startDate && record.date < startDate) || (endDate && record.date > endDate) || (classId && record.classId !== classId)) continue;
      const key = `${record.classId}|${record.date}`;
      if (!attendanceByClassDate.has(key)) attendanceByClassDate.set(key, []);
      attendanceByClassDate.get(key).push(record);
    }
    for (const departure of runtime.state.earlyDepartures || []) {
      departuresByStudentDate.set(`${departure.classId}|${departure.date}|${departure.studentId}`, departure);
    }

    for (const closure of closures) {
      const roster = new Map();
      for (const missing of closure.absentStudents || []) {
        const registration = String(missing.matricula || missing.registration || "Sem matrícula");
        const id = String(missing.id || `${closure.classId}:${registration}`);
        roster.set(id, {
          id,
          name: String(missing.nome || missing.name || "Aluno não identificado"),
          registration,
          absent: true
        });
      }

      (attendanceByClassDate.get(`${closure.classId}|${closure.date}`) || [])
        .forEach((record) => {
          roster.set(record.studentId, {
            id: record.studentId,
            name: record.studentName,
            registration: record.registration,
            absent: false
          });
        });

      for (const student of roster.values()) {
        const key = `${closure.classId}:${student.id}`;
        const current = ranking.get(key) || {
          id: student.id,
          name: student.name,
          registration: student.registration,
          classId: closure.classId,
          className: closure.className,
          totalLessons: 0,
          missedLessons: 0,
          fullDayAbsences: 0,
          earlyDepartureCount: 0,
          lastAbsence: ""
        };
        current.totalLessons += lessonsPerDay;

        let missedToday = 0;
        if (student.absent) {
          missedToday = lessonsPerDay;
          current.fullDayAbsences += 1;
        } else {
          const departure = departuresByStudentDate.get(`${closure.classId}|${closure.date}|${student.id}`);
          if (departure) {
            missedToday = Math.min(lessonsPerDay, departure.missedLessonCount);
            current.earlyDepartureCount += 1;
          }
        }

        current.missedLessons += missedToday;
        if (missedToday > 0 && (!current.lastAbsence || closure.date > current.lastAbsence)) {
          current.lastAbsence = closure.date;
        }
        ranking.set(key, current);
      }
    }

    const rows = [...ranking.values()].map((row) => {
      const attendedLessons = Math.max(0, row.totalLessons - row.missedLessons);
      const attendancePercentage = row.totalLessons
        ? Number(((attendedLessons / row.totalLessons) * 100).toFixed(1))
        : 0;
      return {
        ...row,
        attendedLessons,
        attendancePercentage,
        alert: attendancePercentage < ATTENDANCE_ALERT_THRESHOLD
      };
    }).sort((first, second) =>
      second.missedLessons - first.missedLessons ||
      first.attendancePercentage - second.attendancePercentage ||
      first.name.localeCompare(second.name, "pt-BR")
    );

    return {
      closures,
      rows,
      missedLessons: rows.reduce((total, row) => total + row.missedLessons, 0),
      alerts: rows.filter((row) => row.alert),
      lessonsPerDay
    };
  }

  function absenceRankingData() {
    return attendancePercentageData({
      startDate: $("absence-start-date")?.value || "",
      endDate: $("absence-end-date")?.value || "",
      classId: $("absence-class-filter")?.value || runtime.role?.classId || ""
    });
  }

  function formatAttendancePercentage(value) {
    return `${Number(value || 0).toFixed(1).replace(".", ",")}%`;
  }

  function renderAbsenceRanking() {
    if (!$("absence-ranking-body")) return;
    const data = absenceRankingData();
    const top = data.rows.find((row) => row.missedLessons > 0) || null;
    $("absence-closure-count").textContent = String(data.closures.length);
    $("absence-occurrence-count").textContent = String(data.missedLessons);
    $("absence-alert-count").textContent = String(data.alerts.length);
    $("absence-top-student").textContent = top?.name || "Nenhum aluno";
    $("absence-top-count").textContent = top ? `${top.missedLessons} ${top.missedLessons === 1 ? "falta em aula" : "faltas em aulas"}` : "Sem faltas no período";
    $("absence-ranking-empty").hidden = data.rows.length > 0;

    $("absence-ranking-body").innerHTML = data.rows.map((row, index) => {
      const student = getStudent(row.id) || { id: row.id, name: row.name };
      const status = row.alert
        ? '<span class="badge badge-danger">Abaixo de 85%</span>'
        : '<span class="badge badge-success">Regular</span>';
      const lastAbsence = row.lastAbsence ? formatDate(row.lastAbsence) : "Sem faltas";
      return `<tr><td data-label="Posição"><span class="rank-position ${index < 3 ? "rank-top" : ""}">${index + 1}º</span></td><td data-label="Aluno"><div class="student-name-cell">${avatarMarkup(student)}<div><strong>${escapeHTML(row.name)}</strong><small>${escapeHTML(row.registration)}</small></div></div></td><td data-label="Turma">${escapeHTML(row.className)}</td><td data-label="Aulas dadas">${row.totalLessons}</td><td data-label="Faltas"><strong class="absence-count">${row.missedLessons}</strong></td><td data-label="Frequência"><span class="attendance-percent ${row.alert ? "attention" : ""}">${escapeHTML(formatAttendancePercentage(row.attendancePercentage))}</span></td><td data-label="Situação">${status}</td><td data-label="Última falta" class="cell-muted">${escapeHTML(lastAbsence)}</td></tr>`;
    }).join("");

    const priorityRows = (data.alerts.length
      ? [...data.alerts].sort((first, second) => first.attendancePercentage - second.attendancePercentage || second.missedLessons - first.missedLessons)
      : data.rows.filter((row) => row.missedLessons > 0)
    ).slice(0, 5);
    const maximum = Math.max(1, ...priorityRows.map((row) => row.missedLessons));
    $("absence-top-list").innerHTML = priorityRows.length
      ? priorityRows.map((row, index) => `<div class="absence-bar-item"><div><span>${index + 1}</span><strong>${escapeHTML(row.name)}</strong><small>${escapeHTML(formatAttendancePercentage(row.attendancePercentage))} · ${row.missedLessons} falta(s)</small></div><div class="absence-bar-track"><span style="width:${Math.max(8, Math.round((row.missedLessons / maximum) * 100))}%"></span></div></div>`).join("")
      : `<p class="cell-muted">${data.rows.length ? "Todos os alunos estão com 100% no período." : "Finalize uma chamada para calcular a frequência por aula."}</p>`;
  }

  function roleLabel(role) {
    return ROLE_DETAILS[role]?.label || role || "Sem perfil";
  }

  function renderAccounts() {
    if (!$("accounts-table-body")) return;
    const accounts = [...runtime.accounts].sort((first, second) => first.email.localeCompare(second.email, "pt-BR"));
    $("account-result-count").textContent = `${accounts.length} ${accounts.length === 1 ? "conta" : "contas"}`;
    $("accounts-empty").hidden = !runtime.accountsLoaded || accounts.length > 0;
    $("accounts-table-body").innerHTML = accounts.map((account) => {
      const entryClass = getClass(account.classId);
      const access = ["admin", "coordenador"].includes(account.role) ? "Toda a escola" : entryClass?.name || "Turma não encontrada";
      const createdAt = account.createdAt ? formatDate(account.createdAt) : "Data indisponível";
      return `<tr><td data-label="Pessoa / e-mail"><div class="student-name-cell"><span class="student-avatar avatar-2">${escapeHTML(initials(account.name || account.email))}</span><div><strong>${escapeHTML(account.name || "Nome não informado")}</strong><small>${escapeHTML(account.email)}</small></div></div></td><td data-label="Perfil"><span class="badge badge-blue">${escapeHTML(roleLabel(account.role))}</span></td><td data-label="Acesso">${escapeHTML(access)}</td><td data-label="Criada em" class="cell-muted">${escapeHTML(createdAt)}</td><td data-label="Último acesso" class="cell-muted">${account.lastSignInAt ? escapeHTML(formatDate(account.lastSignInAt)) : "Nunca acessou"}</td></tr>`;
    }).join("");
  }

  async function managementFunctionError(error) {
    let message = error?.message || "Não foi possível acessar o gerenciamento de contas.";
    try {
      const details = await error?.context?.json?.();
      if (details?.error) message = details.error;
    } catch {
      // A resposta nem sempre contém JSON.
    }
    if (/not found|failed to send|functionsfetcherror/i.test(message)) {
      message = "O gerenciamento de contas está temporariamente indisponível. Tente novamente mais tarde ou entre em contato com a administração.";
    }
    return new Error(message);
  }

  async function invokeUserManagement(body) {
    const { data, error } = await runtime.db.functions.invoke("manage-users", { body });
    if (error) throw await managementFunctionError(error);
    if (!data?.ok) throw new Error(data?.error || "O Supabase não concluiu a operação.");
    return data;
  }

  async function loadAccounts(force = false) {
    if (!canManageAccounts() || !$("accounts-loading")) return;
    if (runtime.accountsLoaded && !force) {
      renderAccounts();
      return;
    }
    const loading = $("accounts-loading");
    const refreshButton = $("refresh-accounts-button");
    loading.hidden = false;
    refreshButton.disabled = true;
    try {
      const data = await invokeUserManagement({ action: "list" });
      runtime.accounts = (data.users || []).map((account) => ({
        id: account.id,
        name: account.name || "",
        email: account.email || "",
        role: account.role,
        classId: account.class_id || "",
        createdAt: account.created_at || "",
        lastSignInAt: account.last_sign_in_at || ""
      }));
      runtime.accountsLoaded = true;
      renderAccounts();
    } catch (error) {
      showToast("Contas indisponíveis", error.message, "error");
    } finally {
      loading.hidden = true;
      refreshButton.disabled = false;
    }
  }

  function updateAccountClassField() {
    const requiresClass = ["lider", "pdt"].includes($("account-role").value);
    $("account-class-field").hidden = !requiresClass;
    $("account-class").required = requiresClass;
    $("account-class").disabled = !requiresClass || !runtime.state.classes.length;
  }

  function openAccountModal() {
    if (!canManageAccounts()) return showToast("Acesso restrito", "Somente a coordenação pode criar contas.", "error");
    if (!runtime.state.classes.length && runtime.role?.name !== "admin") {
      return showToast("Cadastre uma turma primeiro", "A conta de líder ou PDT precisa ser vinculada a uma turma.", "warning");
    }
    $("account-form").reset();
    $("account-role").innerHTML = [
      '<option value="lider">Líder de turma</option>',
      '<option value="pdt">PDT da turma</option>',
      runtime.role?.name === "admin" ? '<option value="coordenador">Coordenação</option>' : ""
    ].join("");
    fillClassSelect("account-class");
    updateAccountClassField();
    openModal("account-modal");
  }

  async function createAccount(event) {
    event.preventDefault();
    if (!canManageAccounts()) return;
    const name = $("account-name").value.trim();
    const email = $("account-email").value.trim().toLowerCase();
    const password = $("account-password").value;
    const role = $("account-role").value;
    const classId = ["lider", "pdt"].includes(role) ? $("account-class").value : "";
    if (name.length < 3) return showToast("Nome incompleto", "Informe o nome completo da pessoa.", "warning");
    if (password.length < 8) return showToast("Senha muito curta", "Use pelo menos 8 caracteres.", "warning");
    if (["lider", "pdt"].includes(role) && !getClass(classId)) return showToast("Turma obrigatória", "Selecione a turma desta conta.", "warning");

    const button = $("account-submit-button");
    button.disabled = true;
    try {
      const data = await invokeUserManagement({ action: "create", name, email, password, role, classId: classId || null });
      const account = data.user;
      runtime.accounts = runtime.accounts.filter((item) => item.id !== account.id);
      runtime.accounts.push({
        id: account.id,
        name: account.name || name,
        email: account.email || email,
        role: account.role,
        classId: account.class_id || "",
        createdAt: account.created_at || new Date().toISOString(),
        lastSignInAt: account.last_sign_in_at || ""
      });
      runtime.accountsLoaded = true;
      renderAccounts();
      closeModal();
      showToast("Conta criada", `${email} já pode entrar. Entregue a senha diretamente à pessoa.`);
    } catch (error) {
      showToast("Não foi possível criar a conta", error.message, "error");
    } finally {
      button.disabled = false;
    }
  }

  function renderSettings() {
    $("setting-school-name").value = runtime.state.settings.schoolName;
    $("setting-late-time").value = runtime.state.settings.lateTime;
    $("setting-threshold").value = String(runtime.state.settings.threshold);
    $("setting-scan-interval").value = String(runtime.state.settings.scanInterval);
    $("threshold-display").textContent = Number(runtime.state.settings.threshold).toFixed(2).replace(".", ",");
  }

  function renderEverything({ refreshSettings = false } = {}) {
    renderClassSelects();
    updateSchoolName();
    renderDashboard();
    renderStudents();
    renderClasses();
    renderAttendance();
    renderTablet();
    renderClosures();
    renderEarlyDepartures();
    renderAbsenceRanking();
    renderAccounts();
    if (runtime.activeModal === "finalize-modal") updateFinalizePreview();
    if (runtime.activeModal === "departure-modal") {
      refreshDepartureStudents();
      updateDeparturePreview();
    }
    if (refreshSettings) renderSettings();
    if (runtime.activeView === "reports") renderReportPreview();
  }

  function openModal(modalId) {
    closeModal({ animate: false });
    const layer = $("modal-layer");
    const modal = $(modalId);
    runtime.activeModal = modalId;
    layer.hidden = false;
    modal.hidden = false;
    document.body.style.overflow = "hidden";
    if (globalThis.gsap) {
      gsap.fromTo(layer.querySelector(".modal-backdrop"), { autoAlpha: 0 }, { autoAlpha: 1, duration: 0.2 });
      gsap.fromTo(modal, { autoAlpha: 0, y: 16, scale: 0.985 }, { autoAlpha: 1, y: 0, scale: 1, duration: 0.32, ease: "power2.out", clearProps: "transform" });
    }
    setTimeout(() => modal.querySelector('input:not([type="hidden"]), select, button')?.focus(), 70);
  }

  function closeModal({ animate = true } = {}) {
    const layer = $("modal-layer");
    const modalId = runtime.activeModal;
    if (!modalId) return;
    runtime.activeModal = null;
    stopEnrollmentCamera();
    runtime.pendingDescriptor = null;
    const modal = $(modalId);
    const finish = () => {
      if (runtime.activeModal) return;
      layer.hidden = true;
      modal.hidden = true;
      document.body.style.overflow = $("tablet-screen").hidden ? "" : "hidden";
    };
    if (animate && globalThis.gsap) gsap.to(modal, { autoAlpha: 0, y: 8, duration: 0.16, onComplete: finish });
    else finish();
  }

  function openStudentModal(studentId = "") {
    if (!requireSchoolManager()) return;
    if (!runtime.state.classes.length) {
      showToast("Cadastre uma turma primeiro", "É necessário ter pelo menos uma turma antes de adicionar alunos.", "warning");
      switchView("classes");
      return;
    }
    const student = studentId ? getStudent(studentId) : null;
    $("student-form").reset();
    $("student-edit-id").value = student?.id || "";
    $("student-modal-title").textContent = student ? "Editar aluno" : "Novo aluno";
    $("student-name").value = student?.name || "";
    $("student-registration").value = student?.registration || "";
    $("student-guardian").value = student?.guardian || "";
    $("student-consent").checked = Boolean(student?.biometricConsent);
    fillClassSelect("student-class", { preferredValue: student?.classId || "" });
    openModal("student-modal");
    runtime.pendingDescriptor = Array.isArray(student?.faceDescriptor) ? [...student.faceDescriptor] : null;
    updateEnrollmentStatus();
  }

  function updateEnrollmentStatus(message = "") {
    const status = $("enrollment-status");
    const hasDescriptor = Array.isArray(runtime.pendingDescriptor) && runtime.pendingDescriptor.length === 128;
    status.classList.toggle("enrolled", hasDescriptor);
    status.innerHTML = `${iconMarkup(hasDescriptor ? "check" : "face")}<span>${escapeHTML(message || (hasDescriptor ? "Biometria facial cadastrada com sucesso" : "Nenhuma biometria cadastrada"))}</span>`;
    const label = $("capture-face-button").querySelector("span");
    label.textContent = runtime.enrollmentStream ? "Capturar rosto agora" : hasDescriptor ? "Atualizar rosto" : "Cadastrar rosto";
  }

  async function saveStudent(event) {
    event.preventDefault();
    if (!requireSchoolManager()) return;
    const id = $("student-edit-id").value;
    const existing = id ? getStudent(id) : null;
    const name = $("student-name").value.trim();
    const registration = $("student-registration").value.trim();
    const classId = $("student-class").value;
    const consent = $("student-consent").checked;

    if (name.length < 3) return showToast("Nome incompleto", "Informe o nome completo do aluno.", "warning");
    if (!getClass(classId)) return showToast("Turma inválida", "Selecione uma turma cadastrada.", "warning");
    if (runtime.state.students.some((student) => student.id !== id && student.registration.toLocaleLowerCase("pt-BR") === registration.toLocaleLowerCase("pt-BR"))) {
      return showToast("Matrícula já cadastrada", "Cada aluno deve possuir uma matrícula diferente.", "error");
    }
    if (runtime.pendingDescriptor && !consent) {
      return showToast("Consentimento obrigatório", "Autorize o tratamento biométrico para manter o reconhecimento facial.", "warning");
    }

    const student = {
      id: existing?.id || createId("student"),
      name,
      registration,
      classId,
      guardian: $("student-guardian").value.trim(),
      biometricConsent: consent,
      faceDescriptor: consent && runtime.pendingDescriptor ? [...runtime.pendingDescriptor] : null,
      active: existing?.active !== false,
      createdAt: existing?.createdAt || new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };

    const submitButton = $("student-form").querySelector('button[type="submit"]');
    submitButton.disabled = true;
    setSyncStatus("loading", "Salvando aluno");
    try {
      const { error } = await runtime.db.from("students").upsert(studentToRow(student));
      if (error) throw databaseError(error, "Não foi possível salvar o aluno.");
      if (existing) runtime.state.students = runtime.state.students.map((entry) => entry.id === id ? student : entry);
      else runtime.state.students.push(student);
      renderEverything();
      closeModal();
      setSyncStatus("ready", "Em tempo real");
      showToast(existing ? "Aluno atualizado" : "Aluno cadastrado", `${student.name} foi ${existing ? "atualizado" : "adicionado"} para todos os aparelhos.`);
    } catch (error) {
      setSyncStatus("error", "Erro ao salvar");
      showToast("Falha ao salvar aluno", error.message, "error");
    } finally {
      submitButton.disabled = false;
    }
  }

  async function deleteStudent(studentId) {
    if (!requireSchoolManager()) return;
    const student = getStudent(studentId);
    if (!student) return;
    if (!confirm(`Excluir ${student.name}? A biometria será apagada. Os registros de frequência anteriores serão mantidos.`)) return;
    try {
      setSyncStatus("loading", "Excluindo aluno");
      const { error } = await runtime.db.from("students").delete().eq("id", studentId);
      if (error) throw databaseError(error, "Não foi possível excluir o aluno.");
      runtime.state.students = runtime.state.students.filter((entry) => entry.id !== studentId);
      renderEverything();
      setSyncStatus("ready", "Em tempo real");
      showToast("Aluno excluído", "O cadastro e a biometria facial foram removidos do banco compartilhado.");
    } catch (error) {
      setSyncStatus("error", "Erro ao excluir");
      showToast("Falha ao excluir aluno", error.message, "error");
    }
  }

  function openClassModal(classId = "") {
    if (!requireSchoolManager()) return;
    const entry = classId ? getClass(classId) : null;
    $("class-form").reset();
    $("class-edit-id").value = entry?.id || "";
    $("class-modal-title").textContent = entry ? "Editar turma" : "Nova turma";
    $("class-name").value = entry?.name || "";
    $("class-room").value = entry?.room || "";
    $("class-shift").value = entry?.shift || "Manhã";
    $("class-teacher").value = entry?.teacher || "";
    $("class-pdt-name").value = entry?.pdtName || "";
    $("class-pdt-email").value = entry?.pdtEmail || "";
    openModal("class-modal");
  }

  async function saveClass(event) {
    event.preventDefault();
    if (!requireSchoolManager()) return;
    const id = $("class-edit-id").value;
    const existing = id ? getClass(id) : null;
    const name = $("class-name").value.trim();
    const pdtEmail = $("class-pdt-email").value.trim().toLocaleLowerCase("pt-BR");
    if (name.length < 2) return showToast("Nome incompleto", "Informe o nome da turma.", "warning");
    if (pdtEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(pdtEmail)) {
      return showToast("E-mail inválido", "Informe um endereço de e-mail válido para a PDT.", "warning");
    }
    if (runtime.state.classes.some((entry) => entry.id !== id && entry.name.toLocaleLowerCase("pt-BR") === name.toLocaleLowerCase("pt-BR"))) {
      return showToast("Turma já existente", "Escolha outro nome para esta turma.", "error");
    }

    const entry = {
      id: existing?.id || createId("class"),
      name,
      room: $("class-room").value.trim(),
      shift: $("class-shift").value,
      teacher: $("class-teacher").value.trim(),
      pdtName: $("class-pdt-name").value.trim(),
      pdtEmail,
      createdAt: existing?.createdAt || new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };

    const submitButton = $("class-form").querySelector('button[type="submit"]');
    submitButton.disabled = true;
    try {
      setSyncStatus("loading", "Salvando turma");
      const { error } = await runtime.db.from("classes").upsert(classToRow(entry));
      if (error) throw databaseError(error, "Não foi possível salvar a turma.");
      if (existing) runtime.state.classes = runtime.state.classes.map((item) => item.id === id ? entry : item);
      else runtime.state.classes.push(entry);
      renderEverything();
      closeModal();
      setSyncStatus("ready", "Em tempo real");
      showToast(existing ? "Turma atualizada" : "Turma cadastrada", `${entry.name} já está disponível em todos os aparelhos.`);
    } catch (error) {
      setSyncStatus("error", "Erro ao salvar");
      showToast("Falha ao salvar turma", error.message, "error");
    } finally {
      submitButton.disabled = false;
    }
  }

  async function deleteClass(classId) {
    if (!requireSchoolManager()) return;
    const entry = getClass(classId);
    if (!entry) return;
    const linkedStudents = runtime.state.students.filter((student) => student.classId === classId);
    if (linkedStudents.length) {
      return showToast("Turma possui alunos", `Transfira ou exclua os ${linkedStudents.length} alunos antes de remover esta turma.`, "warning");
    }
    if (!confirm(`Excluir a turma ${entry.name}? O histórico de frequência será preservado.`)) return;
    try {
      setSyncStatus("loading", "Excluindo turma");
      const { error } = await runtime.db.from("classes").delete().eq("id", classId);
      if (error) throw databaseError(error, "Não foi possível excluir a turma.");
      runtime.state.classes = runtime.state.classes.filter((item) => item.id !== classId);
      if ($("tablet-class-select").value === classId) stopTabletCamera();
      renderEverything();
      setSyncStatus("ready", "Em tempo real");
      showToast("Turma excluída", `${entry.name} foi removida do banco compartilhado.`);
    } catch (error) {
      setSyncStatus("error", "Erro ao excluir");
      showToast("Falha ao excluir turma", error.message, "error");
    }
  }

  function defaultDepartureTime() {
    const now = new Date();
    const time = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
    if (time < SCHOOL_START_TIME) return SCHOOL_START_TIME;
    if (time >= SCHOOL_END_TIME) return "16:59";
    return time;
  }

  function refreshDepartureStudents(preferredStudentId = "") {
    const select = $("departure-student");
    if (!select) return;
    const previous = preferredStudentId || select.value;
    const classId = $("departure-class").value;
    const date = $("departure-date").value;
    const presentIds = new Set(runtime.state.attendance
      .filter((record) => record.classId === classId && record.date === date)
      .map((record) => record.studentId));
    const students = activeStudents(classId)
      .filter((student) => presentIds.has(student.id))
      .sort(compareNames);
    const editing = (runtime.state.earlyDepartures || []).find((entry) => entry.id === $("departure-edit-id").value);
    $("departure-class").disabled = Boolean(editing) || !runtime.state.classes.length;
    $("departure-date").disabled = Boolean(editing);
    if (editing && !students.some((student) => student.id === editing.studentId)) {
      students.push({ id: editing.studentId, name: editing.studentName, registration: editing.registration });
    }
    select.innerHTML = students.length
      ? students.map((student) => `<option value="${escapeHTML(student.id)}">${escapeHTML(student.name)} · ${escapeHTML(student.registration)}</option>`).join("")
      : '<option value="">Nenhum aluno presente nesta data</option>';
    if (previous && students.some((student) => student.id === previous)) select.value = previous;
    select.disabled = !students.length || Boolean(editing);
    $("departure-student-help").textContent = students.length
      ? "A lista mostra somente alunos que registraram presença na data selecionada."
      : "Nenhum aluno desta turma possui presença registrada nessa data.";
    $("departure-submit-button").disabled = !students.length;
  }

  function updateDeparturePreview() {
    const preview = $("departure-preview");
    if (!preview) return;
    const time = $("departure-time").value;
    const periods = missedPeriodsForTime(time);
    const validTime = time >= SCHOOL_START_TIME && time < SCHOOL_END_TIME;
    preview.classList.toggle("has-misses", validTime && periods.length > 0);
    if (!time) {
      preview.innerHTML = `<span class="departure-preview-icon">${iconMarkup("calendar")}</span><div><strong>Informe o horário para calcular</strong><span>As aulas restantes aparecerão aqui.</span></div>`;
      return;
    }
    if (!validTime || !periods.length) {
      preview.innerHTML = `<span class="departure-preview-icon">${iconMarkup("alert")}</span><div><strong>Horário fora da regra</strong><span>A saída antecipada deve ocorrer entre 07:30 e 16:59.</span></div>`;
      return;
    }
    const names = periods.map((period) => period.label).join(", ");
    preview.innerHTML = `<span class="departure-preview-icon">${iconMarkup("calendar")}</span><div><strong>${periods.length} ${periods.length === 1 ? "falta será lançada" : "faltas serão lançadas"}</strong><span>${escapeHTML(names)}</span></div>`;
  }

  function openDepartureModal(departureId = "") {
    if (!requireSchoolManager()) return;
    if (sortedSchoolPeriods().length !== 9) {
      return showToast("Grade indisponível", "Execute atualizacao-v4-3.sql antes de registrar uma saída.", "warning");
    }
    if (!runtime.state.classes.length) {
      return showToast("Nenhuma turma", "Cadastre uma turma antes de registrar uma saída.", "warning");
    }

    const entry = departureId
      ? (runtime.state.earlyDepartures || []).find((item) => item.id === departureId)
      : null;
    $("departure-form").reset();
    $("departure-edit-id").value = entry?.id || "";
    $("departure-date").max = localDateKey();
    $("departure-date").value = entry?.date || $("departure-date-filter").value || localDateKey();
    $("departure-time").value = entry?.time || defaultDepartureTime();
    $("departure-reason").value = entry?.reason || "";
    fillClassSelect("departure-class", { preferredValue: entry?.classId || $("departure-class-filter").value || undefined });
    $("departure-class").disabled = Boolean(entry);
    $("departure-date").disabled = Boolean(entry);
    $("departure-modal-title").textContent = entry ? "Corrigir saída" : "Registrar saída";
    refreshDepartureStudents(entry?.studentId || "");
    updateDeparturePreview();
    openModal("departure-modal");
  }

  async function saveEarlyDeparture(event) {
    event.preventDefault();
    if (!canManageSchool()) return;
    const studentId = $("departure-student").value;
    const date = $("departure-date").value;
    const time = $("departure-time").value;
    const reason = $("departure-reason").value.trim();
    if (!studentId) return showToast("Aluno obrigatório", "Selecione um aluno que registrou presença.", "warning");
    if (!date || date > localDateKey()) return showToast("Data inválida", "A saída não pode ser registrada em uma data futura.", "warning");
    if (time < SCHOOL_START_TIME || time >= SCHOOL_END_TIME) return showToast("Horário inválido", "Informe um horário entre 07:30 e 16:59.", "warning");
    const arrival = runtime.state.attendance.find((record) => record.studentId === studentId && record.date === date);
    if (arrival && time < arrival.time) return showToast("Horário inválido", `A saída não pode ser anterior à presença registrada às ${arrival.time}.`, "warning");

    const button = $("departure-submit-button");
    button.disabled = true;
    try {
      setSyncStatus("loading", "Registrando saída");
      const { data, error } = await runtime.db.rpc("record_early_departure", {
        p_student_id: studentId,
        p_departure_time: time,
        p_date: date,
        p_reason: reason || null
      });
      if (error) throw databaseError(error, "Não foi possível registrar a saída antecipada.");
      if (!data) throw new Error("O banco não retornou o registro da saída.");
      const saved = earlyDepartureFromRow(data);
      runtime.state.earlyDepartures = (runtime.state.earlyDepartures || []).filter((entry) => entry.id !== saved.id && !(entry.studentId === saved.studentId && entry.date === saved.date));
      runtime.state.earlyDepartures.push(saved);
      closeModal();
      renderEverything();
      setSyncStatus("ready", "Em tempo real");
      showToast("Saída registrada", `${saved.studentName}: ${saved.missedLessonCount} ${saved.missedLessonCount === 1 ? "falta lançada" : "faltas lançadas"}.`);
    } catch (error) {
      setSyncStatus("error", "Erro ao registrar");
      showToast("Não foi possível salvar", error.message, "error");
      button.disabled = false;
    }
  }

  async function deleteEarlyDeparture(departureId) {
    if (!requireSchoolManager()) return;
    const entry = (runtime.state.earlyDepartures || []).find((item) => item.id === departureId);
    if (!entry) return;
    if (!confirm(`Excluir a saída de ${entry.studentName} em ${formatDate(entry.date)} às ${entry.time}? As ${entry.missedLessonCount} falta(s) deixarão de entrar no cálculo.`)) return;
    try {
      setSyncStatus("loading", "Excluindo saída");
      const { data, error } = await runtime.db.rpc("delete_early_departure", { p_departure_id: departureId });
      if (error) throw databaseError(error, "Não foi possível excluir a saída.");
      if (!data) throw new Error("O registro não foi encontrado no banco.");
      runtime.state.earlyDepartures = runtime.state.earlyDepartures.filter((item) => item.id !== departureId);
      renderEverything();
      setSyncStatus("ready", "Em tempo real");
      showToast("Saída excluída", "O percentual de frequência foi recalculado.");
    } catch (error) {
      setSyncStatus("error", "Erro ao excluir");
      showToast("Não foi possível excluir", error.message, "error");
    }
  }

  function openScheduleModal() {
    if (!requireSchoolManager()) return;
    const periods = sortedSchoolPeriods();
    if (periods.length !== 9) {
      return showToast("Grade indisponível", "Execute atualizacao-v4-3.sql para criar as nove aulas.", "warning");
    }
    $("schedule-error").hidden = true;
    $("schedule-submit-button").disabled = false;
    $("schedule-editor-list").innerHTML = periods.map((period) => `
      <div class="schedule-editor-row" data-lesson-number="${period.number}">
        <strong>${escapeHTML(period.label)}</strong>
        <label class="form-field"><span>Início</span><input class="schedule-start" type="time" value="${escapeHTML(period.startTime)}" required></label>
        <label class="form-field"><span>Fim</span><input class="schedule-end" type="time" value="${escapeHTML(period.endTime)}" required></label>
      </div>
    `).join("");
    openModal("schedule-modal");
  }

  function readScheduleEditor() {
    const periods = $$(".schedule-editor-row", $("schedule-editor-list")).map((row) => ({
      lesson_number: Number(row.dataset.lessonNumber),
      start_time: row.querySelector(".schedule-start").value,
      end_time: row.querySelector(".schedule-end").value
    })).sort((first, second) => first.lesson_number - second.lesson_number);
    if (periods.length !== 9) throw new Error("A grade precisa conter exatamente nove aulas.");
    let previousEnd = "";
    periods.forEach((period, index) => {
      if (period.lesson_number !== index + 1 || !period.start_time || !period.end_time) {
        throw new Error("Preencha o início e o fim das nove aulas.");
      }
      if (period.start_time >= period.end_time) {
        throw new Error(`O início da ${period.lesson_number}ª aula precisa ser anterior ao fim.`);
      }
      if (previousEnd && period.start_time < previousEnd) {
        throw new Error(`A ${period.lesson_number}ª aula não pode começar antes do término da aula anterior.`);
      }
      previousEnd = period.end_time;
    });
    if (periods[0].start_time !== SCHOOL_START_TIME || periods[8].end_time !== SCHOOL_END_TIME) {
      throw new Error("A grade integral deve começar às 07:30 e terminar às 17:00.");
    }
    return periods;
  }

  async function saveSchoolSchedule(event) {
    event.preventDefault();
    if (!canManageSchool()) return;
    const errorBox = $("schedule-error");
    let periods;
    try {
      periods = readScheduleEditor();
      errorBox.hidden = true;
    } catch (error) {
      errorBox.textContent = error.message;
      errorBox.hidden = false;
      return;
    }

    const button = $("schedule-submit-button");
    button.disabled = true;
    try {
      setSyncStatus("loading", "Salvando grade");
      const { data, error } = await runtime.db.rpc("update_school_periods", { p_periods: periods });
      if (error) throw databaseError(error, "Não foi possível salvar a grade de aulas.");
      if (!Array.isArray(data) || data.length !== 9) throw new Error("O banco não retornou as nove aulas atualizadas.");
      runtime.state.schoolPeriods = data.map(schoolPeriodFromRow);
      closeModal();
      renderEverything();
      setSyncStatus("ready", "Em tempo real");
      showToast("Grade atualizada", "Os próximos registros de saída usarão os novos horários. O histórico anterior foi preservado.");
    } catch (error) {
      setSyncStatus("error", "Erro ao salvar grade");
      errorBox.textContent = error.message;
      errorBox.hidden = false;
      button.disabled = false;
    }
  }

  function openFinalizeModal(preferredClassId = "") {
    if (!canFinalizeAttendance()) {
      return showToast("Acesso restrito", "Somente o líder da turma pode finalizar e enviar a frequência.", "error");
    }
    if (!runtime.state.classes.length) {
      return showToast("Nenhuma turma disponível", "Cadastre ou vincule uma turma antes de finalizar a frequência.", "warning");
    }

    $("finalize-form").reset();
    fillClassSelect("finalize-class-select", {
      preferredValue: runtime.role?.classId || preferredClassId || $("attendance-class-filter").value || $("tablet-class-select").value
    });
    $("finalize-class-select").disabled = Boolean(runtime.role?.classId);
    openModal("finalize-modal");
    updateFinalizePreview();
  }

  function updateFinalizePreview() {
    const classId = $("finalize-class-select").value;
    const entry = getClass(classId);
    const students = activeStudents(classId);
    const attendance = todaysAttendance(classId);
    const presentIds = new Set(attendance.map((record) => record.studentId));
    const presentCount = students.filter((student) => presentIds.has(student.id)).length;
    const absent = missingStudents(classId);
    const closure = classId ? getClosure(classId) : null;
    const destination = entry?.pdtEmail || "";

    $("finalize-total-count").textContent = String(students.length);
    $("finalize-present-count").textContent = String(presentCount);
    $("finalize-absent-count").textContent = String(absent.length);
    $("finalize-pdt-name").textContent = entry?.pdtName || "PDT da turma";
    $("finalize-pdt-email").textContent = destination || "Nenhum e-mail cadastrado";
    $("finalize-absent-list").innerHTML = absent.length
      ? absent.map((student) => `<li><strong>${escapeHTML(student.name)}</strong><span>${escapeHTML(student.registration)}</span></li>`).join("")
      : '<li class="finalize-none">Nenhum aluno ausente até o momento.</li>';

    const warning = $("finalize-email-warning");
    const submitButton = $("finalize-submit-button");
    const secondaryActions = $("finalize-secondary-actions");
    const openLateButton = $("finalize-open-late-button");
    const resendButton = $("finalize-resend-button");
    let warningText = "";
    if (!entry) warningText = "Selecione uma turma para continuar.";
    else if (!students.length) warningText = "Esta turma não possui alunos ativos cadastrados.";
    else if (!destination) warningText = "Cadastre o e-mail da PDT em Turmas antes de finalizar.";

    $("finalize-modal-eyebrow").textContent = "ENCERRAR CHAMADA";
    $("finalize-modal-title").textContent = "Finalizar frequência";
    $("finalize-note").textContent = "Depois de finalizar, a PDT e o professor receberão a frequência. Se alguém chegar depois, use Registrar atrasados.";
    submitButton.hidden = false;
    submitButton.innerHTML = `${iconMarkup("check")}Finalizar e enviar`;
    secondaryActions.hidden = true;

    if (closure?.acceptingLate) {
      $("finalize-modal-eyebrow").textContent = "ATUALIZAR CHAMADA";
      $("finalize-modal-title").textContent = "Finalizar atrasados";
      $("finalize-note").textContent = "O banco atualizará os ausentes, o e-mail da PDT e a situação dos alunos no sistema do professor.";
      submitButton.innerHTML = `${iconMarkup("check")}Finalizar atrasados e enviar`;
    } else if (closure) {
      const emailStatus = emailStatusInfo(closure.emailStatus);
      $("finalize-modal-eyebrow").textContent = "FREQUÊNCIA ENCERRADA";
      $("finalize-modal-title").textContent = "Opções do fechamento";
      $("finalize-note").textContent = `Relatório na revisão ${closure.revision}. Escolha Registrar atrasados para reabrir somente a câmera, ou Reenviar para colocar o mesmo relatório novamente na fila.`;
      submitButton.hidden = true;
      secondaryActions.hidden = false;
      openLateButton.disabled = closure.emailStatus === "sending" || Boolean(warningText);
      resendButton.disabled = closure.emailStatus === "sending" || Boolean(warningText);
      if (closure.emailStatus === "sending") warningText = `${emailStatus.text}. Aguarde alguns instantes antes de alterar o fechamento.`;
    }

    warning.textContent = warningText;
    warning.hidden = !warningText;
    submitButton.disabled = Boolean(warningText);
  }

  function classLateTime(classEntry) {
    if (classEntry?.shift === "Tarde") return "13:15";
    if (classEntry?.shift === "Noite") return "19:15";
    return runtime.state.settings.lateTime;
  }

  async function registerAttendance(student, { method, similarity = null, note = "" } = {}) {
    const now = new Date();
    const date = localDateKey(now);
    if (method !== "reconhecimento_facial") {
      throw new Error("A presença só pode ser registrada por reconhecimento facial.");
    }
    const closure = getClosure(student.classId, date);
    if (closure && !closure.acceptingLate) {
      throw new Error("A frequência desta turma está fechada. Use Registrar atrasados para reabrir somente a câmera.");
    }
    const duplicate = runtime.state.attendance.find((entry) => entry.studentId === student.id && entry.date === date);
    if (duplicate) return { created: false, record: duplicate };

    const entryClass = getClass(student.classId);
    if (!entryClass) throw new Error("A turma deste aluno não está mais disponível.");
    const time = formatTime(now);
    const record = {
      id: createId("attendance"),
      studentId: student.id,
      studentName: student.name,
      registration: student.registration,
      classId: entryClass.id,
      className: entryClass.name,
      room: entryClass.room,
      date,
      time,
      timestamp: now.toISOString(),
      status: closure?.acceptingLate || time > classLateTime(entryClass) ? "atrasado" : "presente",
      method,
      similarity: typeof similarity === "number" ? Number(similarity.toFixed(1)) : null,
      note: String(closure?.acceptingLate ? note || "Registrado após o fechamento inicial" : note || "").trim(),
      deviceId: runtime.state.settings.deviceId
    };
    setSyncStatus("loading", "Registrando presença");
    const { error } = await runtime.db.from("attendance").insert(attendanceToRow(record));
    if (error?.code === "23505") {
      const { data } = await runtime.db.from("attendance").select("*").eq("student_id", student.id).eq("attendance_date", date).maybeSingle();
      const existing = data ? attendanceFromRow(data) : runtime.state.attendance.find((entry) => entry.studentId === student.id && entry.date === date);
      if (existing && !runtime.state.attendance.some((entry) => entry.id === existing.id)) runtime.state.attendance.push(existing);
      renderEverything();
      setSyncStatus("ready", "Em tempo real");
      return { created: false, record: existing || { ...record, time } };
    }
    if (error) {
      setSyncStatus("error", "Erro ao registrar");
      throw databaseError(error, "Não foi possível registrar a presença.");
    }
    runtime.state.attendance.push(record);
    renderEverything();
    setSyncStatus("ready", "Em tempo real");
    return { created: true, record };
  }

  async function submitFinalizeAttendance(event) {
    event.preventDefault();
    if (!canFinalizeAttendance()) {
      return showToast("Acesso restrito", "Somente o líder da turma pode finalizar e enviar a frequência.", "error");
    }
    const classId = $("finalize-class-select").value;
    const entry = getClass(classId);
    if (!entry) return showToast("Turma inválida", "Selecione uma turma disponível.", "warning");
    if (!entry.pdtEmail) return showToast("PDT sem e-mail", "Cadastre o e-mail da PDT antes de finalizar a frequência.", "warning");
    const currentClosure = getClosure(classId);
    if (currentClosure?.acceptingLate) return finalizeLateArrivals(classId);
    if (currentClosure) return showToast("Frequência já finalizada", "Use Registrar atrasados ou Reenviar relatório.", "warning");

    const submitButton = $("finalize-submit-button");
    submitButton.disabled = true;
    try {
      setSyncStatus("loading", "Finalizando frequência");
      const { data, error } = await runtime.db.rpc("finalize_attendance", {
        p_class_id: classId,
        p_date: localDateKey()
      });
      if (error) throw databaseError(error, error.message || "Não foi possível finalizar a frequência.");
      if (!data) throw new Error("O banco de dados não retornou o encerramento da turma.");

      const closure = storeClosure(data);

      if ($("tablet-class-select").value === classId && runtime.tabletStream) {
        stopTabletCamera();
      }
      renderEverything();
      closeModal();
      setSyncStatus("ready", "Em tempo real");
      showToast("Frequência finalizada", `${entry.name}: ${closure.absentCount} ausente(s). O e-mail da PDT e os registros do professor entraram nas filas automáticas.`);
    } catch (error) {
      setSyncStatus("error", "Falha ao finalizar");
      showToast("Não foi possível finalizar", error.message, "error");
    } finally {
      updateFinalizePreview();
    }
  }

  async function openLateArrivals(classId = $("finalize-class-select").value) {
    if (!canFinalizeAttendance()) return showToast("Acesso restrito", "Somente o líder da turma pode registrar atrasados.", "error");
    const entry = getClass(classId);
    const closure = getClosure(classId);
    if (!entry || !closure) return showToast("Fechamento não encontrado", "Finalize a frequência antes de registrar atrasados.", "warning");
    if (closure.acceptingLate) {
      closeModal();
      return openTablet(classId);
    }

    const buttons = [$("finalize-open-late-button"), $("finalize-resend-button")].filter(Boolean);
    buttons.forEach((button) => { button.disabled = true; });
    try {
      setSyncStatus("loading", "Abrindo atrasados");
      const { data, error } = await runtime.db.rpc("open_late_arrivals", {
        p_class_id: classId,
        p_date: localDateKey()
      });
      if (error) throw databaseError(error, "Não foi possível abrir o registro de atrasados.");
      if (!data) throw new Error("O banco não retornou o fechamento atualizado.");
      storeClosure(data);
      renderEverything();
      closeModal();
      setSyncStatus("ready", "Em tempo real");
      showToast("Registro de atrasados aberto", `${entry.name}: a câmera aceitará somente atrasados e o relatório ficou pausado.`);
      openTablet(classId);
    } catch (error) {
      setSyncStatus("error", "Falha ao abrir atrasados");
      showToast("Não foi possível registrar atrasados", error.message, "error");
      buttons.forEach((button) => { button.disabled = false; });
    }
  }

  async function finalizeLateArrivals(classId = $("finalize-class-select").value) {
    if (!canFinalizeAttendance()) return showToast("Acesso restrito", "Somente o líder da turma pode finalizar os atrasados.", "error");
    const entry = getClass(classId);
    const closure = getClosure(classId);
    if (!entry || !closure?.acceptingLate) return showToast("Atrasados não estão abertos", "Abra o registro de atrasados antes de finalizar esta etapa.", "warning");

    const submitButton = $("finalize-submit-button");
    submitButton.disabled = true;
    try {
      setSyncStatus("loading", "Finalizando atrasados");
      const { data, error } = await runtime.db.rpc("finalize_late_arrivals", {
        p_class_id: classId,
        p_date: localDateKey()
      });
      if (error) throw databaseError(error, "Não foi possível finalizar os atrasados.");
      if (!data) throw new Error("O banco não retornou o relatório atualizado.");
      const updatedClosure = storeClosure(data);
      if ($("tablet-class-select").value === classId && runtime.tabletStream) stopTabletCamera();
      renderEverything();
      closeModal();
      setSyncStatus("ready", "Em tempo real");
      showToast("Atrasados finalizados", `${entry.name}: revisão ${updatedClosure.revision}, com ${updatedClosure.absentCount} ausente(s). A PDT e o sistema do professor receberão a atualização.`);
    } catch (error) {
      setSyncStatus("error", "Falha ao finalizar atrasados");
      showToast("Não foi possível finalizar os atrasados", error.message, "error");
      updateFinalizePreview();
    }
  }

  async function resendAttendanceReport(classId = $("finalize-class-select").value) {
    if (!canFinalizeAttendance()) return showToast("Acesso restrito", "Somente o líder da turma pode reenviar o relatório.", "error");
    const entry = getClass(classId);
    const closure = getClosure(classId);
    if (!entry || !closure) return showToast("Fechamento não encontrado", "Finalize a frequência antes de reenviar.", "warning");
    if (closure.acceptingLate) return showToast("Finalize os atrasados", "Encerre o modo de atrasados antes de reenviar o relatório.", "warning");
    if (!confirm(`Reenviar o relatório de ${entry.name} para ${entry.pdtEmail}?`)) return;

    const buttons = [$("finalize-open-late-button"), $("finalize-resend-button")].filter(Boolean);
    buttons.forEach((button) => { button.disabled = true; });
    try {
      setSyncStatus("loading", "Reenviando relatório");
      const { data, error } = await runtime.db.rpc("resend_attendance_report", {
        p_class_id: classId,
        p_date: localDateKey()
      });
      if (error) throw databaseError(error, "Não foi possível reenviar o relatório.");
      if (!data) throw new Error("O banco não retornou o relatório colocado na fila.");
      const updatedClosure = storeClosure(data);
      renderEverything();
      closeModal();
      setSyncStatus("ready", "Em tempo real");
      showToast("Relatório na fila", `${entry.name}: revisão ${updatedClosure.revision} será enviada novamente para a PDT.`);
    } catch (error) {
      setSyncStatus("error", "Falha ao reenviar");
      showToast("Não foi possível reenviar", error.message, "error");
      buttons.forEach((button) => { button.disabled = false; });
    }
  }

  async function deleteAttendance(recordId) {
    if (!requireSchoolManager()) return;
    const record = runtime.state.attendance.find((entry) => entry.id === recordId);
    if (!record) return;
    if (getClosure(record.classId, record.date)) {
      return showToast("Frequência finalizada", "Registros de uma turma já encerrada não podem ser alterados.", "warning");
    }
    if (!confirm(`Excluir a presença de ${record.studentName} registrada em ${formatDate(record.date)} às ${record.time}?`)) return;
    try {
      setSyncStatus("loading", "Excluindo registro");
      const { error } = await runtime.db.from("attendance").delete().eq("id", recordId);
      if (error) throw databaseError(error, "Não foi possível excluir a presença.");
      runtime.state.attendance = runtime.state.attendance.filter((entry) => entry.id !== recordId);
      renderEverything();
      setSyncStatus("ready", "Em tempo real");
      showToast("Presença removida", "O registro foi excluído do histórico compartilhado.");
    } catch (error) {
      setSyncStatus("error", "Erro ao excluir");
      showToast("Falha ao excluir presença", error.message, "error");
    }
  }

  function buildReport({ startDate = "", endDate = "", classId = "" } = {}) {
    const records = runtime.state.attendance.filter((record) =>
      (!startDate || record.date >= startDate) &&
      (!endDate || record.date <= endDate) &&
      (!classId || record.classId === classId)
    ).sort((first, second) => first.timestamp.localeCompare(second.timestamp));
    const closures = runtime.state.closures.filter((closure) =>
      (!startDate || closure.date >= startDate) &&
      (!endDate || closure.date <= endDate) &&
      (!classId || closure.classId === classId)
    ).sort((first, second) => first.closedAt.localeCompare(second.closedAt));
    const departures = (runtime.state.earlyDepartures || []).filter((entry) =>
      (!startDate || entry.date >= startDate) &&
      (!endDate || entry.date <= endDate) &&
      (!classId || entry.classId === classId)
    ).sort((first, second) => first.date.localeCompare(second.date) || first.time.localeCompare(second.time));
    const lessonAnalysis = attendancePercentageData({ startDate, endDate, classId });

    const groups = new Map();
    for (const record of records) {
      if (!groups.has(record.classId)) groups.set(record.classId, { turma: record.className, sala: record.room || null, registros: 0 });
      groups.get(record.classId).registros += 1;
    }

    return {
      sistema: "Jaime Freq — Frequência Escolar Inteligente",
      versao: APP_VERSION,
      escola: runtime.state.settings.schoolName,
      gerado_em: new Date().toISOString(),
      periodo: { data_inicial: startDate || null, data_final: endDate || null },
      filtro_turma: classId ? getClass(classId)?.name || null : null,
      resumo: {
        total_registros: records.length,
        alunos_unicos: new Set(records.map((record) => record.studentId)).size,
        presencas_no_horario: records.filter((record) => record.status === "presente").length,
        atrasos: records.filter((record) => record.status === "atrasado").length,
        reconhecimentos_faciais: records.filter((record) => record.method === "reconhecimento_facial").length,
        registros_anteriores: records.filter((record) => record.method !== "reconhecimento_facial").length,
        turmas_finalizadas: lessonAnalysis.closures.length,
        turmas_recebendo_atrasados: closures.filter((closure) => closure.acceptingLate).length,
        total_ausencias: closures.reduce((total, closure) => total + closure.absentCount, 0),
        total_ausencias_integrais: closures.reduce((total, closure) => total + closure.absentCount, 0),
        saidas_antecipadas: departures.length,
        faltas_em_aulas: lessonAnalysis.missedLessons,
        alunos_abaixo_de_85_por_cento: lessonAnalysis.alerts.length
      },
      criterio_frequencia: {
        aulas_por_dia: lessonAnalysis.lessonsPerDay,
        percentual_minimo: ATTENDANCE_ALERT_THRESHOLD,
        formula: "(aulas dadas - faltas em aulas) / aulas dadas × 100",
        regra_saida: "Ao sair durante uma aula, a aula atual e as seguintes contam como falta. Intervalos e almoço não contam.",
        observacao: "Somente chamadas finalizadas entram no percentual. Uma saída antecipada não transforma a presença diária enviada ao professor em falta integral."
      },
      grade_horaria: sortedSchoolPeriods().map((period) => ({
        numero: period.number,
        aula: period.label,
        inicio: period.startTime,
        fim: period.endTime
      })),
      turmas: Array.from(groups.values()),
      encerramentos: closures.map((closure) => ({
        turma: closure.className,
        data: closure.date,
        finalizada_em: closure.closedAt,
        total_alunos: closure.totalStudents,
        presentes: closure.presentCount,
        ausentes: closure.absentCount,
        revisao: closure.revision,
        recebendo_atrasados: closure.acceptingLate,
        alunos_ausentes: closure.absentStudents.map((student) => ({
          nome: student.nome,
          matricula: student.matricula
        })),
        email_pdt: closure.pdtEmail,
        status_email: closure.emailStatus,
        email_enviado_em: closure.emailSentAt || null
      })),
      frequencias: records.map((record) => ({
        id: record.id,
        aluno: { id: record.studentId, nome: record.studentName, matricula: record.registration },
        turma: record.className,
        sala: record.room || null,
        data: record.date,
        horario: record.time,
        data_hora: record.timestamp,
        situacao: record.status,
        metodo: record.method,
        similaridade_percentual: record.similarity,
        observacao: record.note || null,
        dispositivo: record.deviceId
      })),
      saidas_antecipadas: departures.map((entry) => ({
        id: entry.id,
        aluno: { id: entry.studentId, nome: entry.studentName, matricula: entry.registration },
        turma: entry.className,
        data: entry.date,
        horario_saida: entry.time,
        quantidade_faltas: entry.missedLessonCount,
        aulas_perdidas: entry.missedLessons.map((lesson) => ({
          numero: Number(lesson.numero),
          aula: lesson.aula,
          inicio: lesson.inicio,
          fim: lesson.fim
        })),
        motivo: entry.reason || null,
        registrado_por: entry.recordedByEmail
      })),
      frequencia_por_aluno: lessonAnalysis.rows.map((row) => ({
        aluno: { id: row.id, nome: row.name, matricula: row.registration },
        turma: row.className,
        aulas_dadas: row.totalLessons,
        aulas_frequentadas: row.attendedLessons,
        faltas_em_aulas: row.missedLessons,
        faltas_dia_inteiro: row.fullDayAbsences,
        saidas_antecipadas: row.earlyDepartureCount,
        percentual_frequencia: row.attendancePercentage,
        alerta_abaixo_de_85: row.alert,
        ultima_falta: row.lastAbsence || null
      })),
      privacidade: "Este relatório não contém fotografias, imagens da câmera nem descritores biométricos."
    };
  }

  function reportFilters() {
    return {
      startDate: $("report-start-date").value,
      endDate: $("report-end-date").value,
      classId: $("report-class-filter").value
    };
  }

  function renderReportPreview() {
    const filters = reportFilters();
    if (filters.startDate && filters.endDate && filters.startDate > filters.endDate) {
      $("json-preview").textContent = "A data inicial não pode ser posterior à data final.";
      $("report-record-count").textContent = "Período inválido";
      return null;
    }
    const report = buildReport(filters);
    $("report-record-count").textContent = `${report.resumo.total_registros} ${report.resumo.total_registros === 1 ? "registro" : "registros"}`;
    $("json-preview").textContent = JSON.stringify(report, null, 2);
    return report;
  }

  function downloadReport({ useReportFilters = false } = {}) {
    const filters = useReportFilters ? reportFilters() : {
      startDate: $("attendance-date-filter").value || localDateKey(),
      endDate: $("attendance-date-filter").value || localDateKey(),
      classId: runtime.activeView === "attendance" ? $("attendance-class-filter").value : ""
    };
    if (filters.startDate && filters.endDate && filters.startDate > filters.endDate) {
      return showToast("Período inválido", "A data inicial precisa ser anterior ou igual à data final.", "error");
    }
    const report = buildReport(filters);
    const serialized = JSON.stringify(report, null, 2);
    const blob = new Blob([serialized], { type: "application/json;charset=utf-8" });
    const temporaryUrl = URL.createObjectURL(blob);
    const link = document.createElement("a");
    const suffix = filters.startDate === filters.endDate ? filters.startDate : `${filters.startDate || "inicio"}_a_${filters.endDate || "hoje"}`;
    link.href = temporaryUrl;
    link.download = `frequencia_escolar_${suffix || localDateKey()}.json`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(temporaryUrl), 1000);
    showToast("Arquivo JSON gerado", `${report.resumo.total_registros} ${report.resumo.total_registros === 1 ? "registro exportado" : "registros exportados"} com sucesso.`);
    return report;
  }

  function professorPayload(entry) {
    if (!["presente", "faltou"].includes(entry.status)) {
      throw new Error("A integração aceita somente presente ou faltou.");
    }

    return {
      id_chamada: entry.callId,
      id_lider: entry.leaderId,
      turma: entry.className,
      status: entry.status,
      data_chamada: entry.date
    };
  }

  function professorPayloads(closureId) {
    return (runtime.state.professorQueue || [])
      .filter((entry) => entry.closureId === closureId)
      .sort((first, second) => first.callId.localeCompare(second.callId))
      .map(professorPayload);
  }

  function downloadProfessorJSON(closureId) {
    const closure = runtime.state.closures.find((entry) => entry.id === closureId);
    if (!closure || closure.acceptingLate) {
      return showToast("Frequência indisponível", "Finalize os atrasados antes de baixar o JSON do professor.", "warning");
    }

    const records = professorPayloads(closureId);
    if (!records.length) {
      return showToast("JSON ainda indisponível", "Aguarde a criação dos registros individuais e tente novamente.", "warning");
    }

    const classSlug = closure.className.normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[^a-zA-Z0-9_-]+/g, "_");
    const blob = new Blob([JSON.stringify(records, null, 2)], {
      type: "application/json;charset=utf-8"
    });
    const temporaryUrl = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = temporaryUrl;
    link.download = `chamadas_professor_${classSlug || "turma"}_${closure.date}.json`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(temporaryUrl), 1000);
    showToast("JSON do professor gerado", `${records.length} aluno(s), com status presente ou faltou.`);
    return records;
  }

  function setModelStatus(status, label) {
    const badge = $("model-status");
    badge.className = `status-pill status-${status}`;
    badge.innerHTML = `<span></span>${escapeHTML(label)}`;
    $("load-models-button").disabled = status === "loading" || status === "ready";
    if (status === "ready") $("load-models-button").innerHTML = `${iconMarkup("check")} Modelos carregados`;
  }

  async function loadFaceModels() {
    if (runtime.modelsLoaded) return;
    if (runtime.modelsPromise) return runtime.modelsPromise;
    if (!globalThis.faceapi) {
      setModelStatus("error", "IA indisponível");
      throw new Error("A biblioteca facial não foi carregada. Verifique a conexão com a internet e recarregue a página.");
    }

    setModelStatus("loading", "Carregando IA");
    setTabletFeedback("Carregando modelos de reconhecimento facial...", "warning");
    runtime.modelsPromise = Promise.all([
      faceapi.nets.tinyFaceDetector.loadFromUri(MODEL_URL),
      faceapi.nets.faceLandmark68TinyNet.loadFromUri(MODEL_URL),
      faceapi.nets.faceRecognitionNet.loadFromUri(MODEL_URL)
    ]).then(() => {
      runtime.modelsLoaded = true;
      setModelStatus("ready", "IA pronta");
      showToast("Reconhecimento facial pronto", "Os modelos de inteligência artificial foram carregados.");
    }).catch((error) => {
      runtime.modelsPromise = null;
      runtime.modelsLoaded = false;
      setModelStatus("error", "Falha na IA");
      throw new Error(`Não foi possível baixar os modelos faciais. Confira sua conexão. ${error.message || ""}`.trim());
    });
    return runtime.modelsPromise;
  }

  async function openCamera(video) {
    if (!navigator.mediaDevices || typeof navigator.mediaDevices.getUserMedia !== "function") {
      throw new Error("A câmera não está disponível. Abra o projeto em localhost ou HTTPS e permita o acesso à câmera.");
    }
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: { facingMode: "user", width: { ideal: 960 }, height: { ideal: 720 } }
      });
      video.srcObject = stream;
      await video.play();
      return stream;
    } catch (error) {
      stream?.getTracks().forEach((track) => track.stop());
      if (error.name === "NotAllowedError" || error.name === "SecurityError") {
        throw new Error("Acesso à câmera negado. Permita o uso da câmera nas configurações do navegador.");
      }
      if (error.name === "NotFoundError") throw new Error("Nenhuma câmera foi encontrada neste aparelho.");
      if (error.name === "NotReadableError") throw new Error("A câmera está sendo utilizada por outro aplicativo.");
      throw new Error(`Não foi possível iniciar a câmera. ${error.message || ""}`.trim());
    }
  }

  function stopStream(stream) {
    if (stream) stream.getTracks().forEach((track) => track.stop());
  }

  async function captureStudentFace() {
    if (!$("student-consent").checked) {
      return showToast("Consentimento necessário", "Marque a autorização para o tratamento biométrico antes de cadastrar o rosto.", "warning");
    }
    const button = $("capture-face-button");
    button.disabled = true;

    try {
      await loadFaceModels();
      if (!runtime.enrollmentStream) {
        runtime.enrollmentStream = await openCamera($("enrollment-video"));
        $("enrollment-video").hidden = false;
        updateEnrollmentStatus("Posicione apenas um rosto diante da câmera.");
        showToast("Câmera pronta", "Posicione o rosto e toque novamente em Capturar rosto agora.");
        return;
      }

      updateEnrollmentStatus("Analisando o rosto, aguarde...");
      const detections = await faceapi.detectAllFaces(
        $("enrollment-video"),
        new faceapi.TinyFaceDetectorOptions({ inputSize: 416, scoreThreshold: 0.55 })
      ).withFaceLandmarks(true).withFaceDescriptors();

      if (!detections.length) {
        updateEnrollmentStatus("Rosto não encontrado. Melhore a iluminação e tente novamente.");
        return showToast("Rosto não encontrado", "Olhe diretamente para a câmera em um ambiente iluminado.", "warning");
      }
      if (detections.length > 1) {
        updateEnrollmentStatus("Apenas uma pessoa deve aparecer na câmera.");
        return showToast("Mais de um rosto detectado", "Deixe somente o aluno a ser cadastrado diante da câmera.", "warning");
      }

      runtime.pendingDescriptor = Array.from(detections[0].descriptor);
      stopEnrollmentCamera();
      updateEnrollmentStatus();
      showToast("Rosto cadastrado", "A representação biométrica foi capturada. Salve o aluno para concluir.");
    } catch (error) {
      updateEnrollmentStatus("Não foi possível concluir o cadastro facial.");
      showToast("Falha no cadastro facial", error.message, "error");
    } finally {
      button.disabled = false;
      updateEnrollmentStatus();
    }
  }

  function stopEnrollmentCamera() {
    stopStream(runtime.enrollmentStream);
    runtime.enrollmentStream = null;
    const video = $("enrollment-video");
    if (video) {
      video.srcObject = null;
      video.hidden = true;
    }
  }

  function setTabletFeedback(message, type = "neutral") {
    if (runtime.lastFeedbackText === `${type}:${message}`) return;
    runtime.lastFeedbackText = `${type}:${message}`;
    const feedback = $("tablet-feedback");
    feedback.className = `tablet-feedback${type === "neutral" ? "" : ` feedback-${type}`}`;
    feedback.innerHTML = `<span class="feedback-dot"></span><span>${escapeHTML(message)}</span>`;
  }

  function openTablet(classId = "") {
    if (!canOperateAttendance()) {
      return showToast("Acesso restrito", "Somente o líder da turma pode abrir a câmera da chamada.", "error");
    }
    closeMobileMenu();
    closeModal();
    if (classId) fillClassSelect("tablet-class-select", { preferredValue: classId });
    $("tablet-screen").hidden = false;
    document.body.style.overflow = "hidden";
    renderTablet();
    if (globalThis.gsap) {
      gsap.fromTo($("tablet-screen"), { autoAlpha: 0 }, { autoAlpha: 1, duration: 0.28 });
      gsap.fromTo($$(".tablet-main > *, .tablet-sidebar > *"), { autoAlpha: 0, y: 11 }, { autoAlpha: 1, y: 0, duration: 0.42, stagger: 0.045, clearProps: "transform", ease: "power2.out" });
    }
    if (!runtime.state.classes.length) setTabletFeedback("Cadastre uma turma no painel antes de iniciar a chamada.", "warning");
  }

  function closeTablet() {
    if (runtime.role?.name === "tablet") {
      signOut();
      return;
    }
    stopTabletCamera();
    $("tablet-screen").hidden = true;
    document.body.style.overflow = "";
    renderEverything();
    animateView(runtime.activeView);
  }

  function enrolledStudents(classId) {
    return activeStudents(classId).filter((student) =>
      student.biometricConsent &&
      Array.isArray(student.faceDescriptor) &&
      student.faceDescriptor.length === 128
    );
  }

  async function startTabletCamera() {
    if (runtime.tabletStream) {
      stopTabletCamera();
      return;
    }
    const classId = $("tablet-class-select").value;
    if (!classId) return showToast("Selecione uma turma", "Cadastre e selecione uma turma para iniciar a chamada.", "warning");
    const closure = getClosure(classId);
    if (closure && !closure.acceptingLate) {
      setTabletFeedback("A frequência está fechada. Abra Opções para registrar atrasados.", "warning");
      return showToast("Frequência finalizada", "Use Registrar atrasados para reabrir somente a câmera.", "warning");
    }
    if (!enrolledStudents(classId).length) {
      setTabletFeedback("Esta turma ainda não possui alunos com biometria cadastrada.", "warning");
      return showToast("Nenhum rosto cadastrado", "Edite um aluno desta turma, autorize a biometria e cadastre seu rosto.", "warning");
    }

    const button = $("start-camera-button");
    button.disabled = true;
    try {
      await loadFaceModels();
      runtime.tabletStream = await openCamera($("tablet-video"));
      $("camera-frame").classList.remove("camera-off");
      $("camera-frame").classList.add("scanning");
      $("camera-placeholder").hidden = true;
      button.innerHTML = `${iconMarkup("close")}<span>Parar câmera</span>`;
      setTabletFeedback(closure?.acceptingLate ? "Câmera ativa. Aproxime o rosto para registrar o atraso." : "Câmera ativa. Aproxime o rosto para registrar a presença.", "success");

      if (globalThis.gsap) {
        runtime.scanTween?.kill();
        runtime.scanTween = gsap.fromTo($("scan-line"), { top: "17%" }, { top: "82%", duration: 2, ease: "sine.inOut", repeat: -1, yoyo: true });
      }
      queueRecognition(300);
    } catch (error) {
      stopTabletCamera();
      setTabletFeedback(error.message, "error");
      showToast("Não foi possível iniciar", error.message, "error");
    } finally {
      button.disabled = false;
    }
  }

  function stopTabletCamera() {
    clearTimeout(runtime.scanTimer);
    clearTimeout(runtime.recognitionTimer);
    runtime.scanTimer = null;
    runtime.recognitionTimer = null;
    runtime.recognitionBusy = false;
    runtime.recognitionCooldownUntil = 0;
    runtime.scanTween?.kill();
    runtime.scanTween = null;
    stopStream(runtime.tabletStream);
    runtime.tabletStream = null;
    $("tablet-video").srcObject = null;
    $("camera-frame").classList.add("camera-off");
    $("camera-frame").classList.remove("scanning");
    $("camera-placeholder").hidden = false;
    $("recognition-result").hidden = true;
    $("start-camera-button").innerHTML = `${iconMarkup("camera")}<span>Iniciar câmera</span>`;
    setTabletFeedback("Selecione uma turma e inicie a câmera.");
  }

  function queueRecognition(delay = runtime.state.settings.scanInterval) {
    clearTimeout(runtime.scanTimer);
    if (!runtime.tabletStream) return;
    runtime.scanTimer = setTimeout(runRecognitionCycle, Math.max(250, Number(delay) || 1500));
  }

  async function runRecognitionCycle() {
    if (!runtime.tabletStream || runtime.recognitionBusy) return;
    if (Date.now() < runtime.recognitionCooldownUntil) {
      queueRecognition(450);
      return;
    }
    runtime.recognitionBusy = true;

    try {
      const classId = $("tablet-class-select").value;
      const students = enrolledStudents(classId);
      if (!students.length) {
        setTabletFeedback("Nenhum aluno desta turma possui biometria cadastrada.", "warning");
        return;
      }

      const detections = await faceapi.detectAllFaces(
        $("tablet-video"),
        new faceapi.TinyFaceDetectorOptions({ inputSize: 320, scoreThreshold: 0.55 })
      ).withFaceLandmarks(true).withFaceDescriptors();

      if (!runtime.tabletStream) return;
      if (!detections.length) {
        setTabletFeedback("Aguardando um rosto diante da câmera...");
        return;
      }
      if (detections.length > 1) {
        setTabletFeedback("Aproxime apenas um aluno por vez.", "warning");
        return;
      }

      let nearest = null;
      for (const student of students) {
        const distance = faceapi.euclideanDistance(detections[0].descriptor, new Float32Array(student.faceDescriptor));
        if (!nearest || distance < nearest.distance) nearest = { student, distance };
      }

      if (!nearest || nearest.distance > Number(runtime.state.settings.threshold)) {
        setTabletFeedback("Rosto não reconhecido nesta turma. Ajuste a posição ou confira o cadastro do aluno.", "warning");
        return;
      }

      const similarity = Math.max(0, Math.min(99.9, (1 - nearest.distance) * 100));
      const result = await registerAttendance(nearest.student, { method: "reconhecimento_facial", similarity });
      runtime.recognitionCooldownUntil = Date.now() + 4200;
      showRecognitionResult(nearest.student, result);
      if (result.created) playConfirmationSound();
    } catch (error) {
      console.error("Falha no reconhecimento facial:", error);
      setTabletFeedback("Falha momentânea na leitura. Posicione o rosto e aguarde.", "warning");
    } finally {
      runtime.recognitionBusy = false;
      if (runtime.tabletStream) queueRecognition();
    }
  }

  function showRecognitionResult(student, result) {
    const overlay = $("recognition-result");
    $("recognition-avatar").textContent = initials(student.name);
    $("recognition-name").textContent = student.name.split(" ").slice(0, 2).join(" ");
    const isLate = result.record.status === "atrasado";
    $("recognition-detail").textContent = result.created
      ? `${isLate ? "Atraso" : "Presença"} registrado às ${result.record.time}`
      : `${isLate ? "Atraso" : "Presença"} já registrado às ${result.record.time}`;
    overlay.hidden = false;
    setTabletFeedback(result.created ? `${student.name}: ${isLate ? "atraso" : "presença"} registrado com sucesso.` : `${student.name} já possui registro hoje.`, result.created ? "success" : "warning");

    if (globalThis.gsap) {
      gsap.fromTo(overlay, { autoAlpha: 0 }, { autoAlpha: 1, duration: 0.24 });
      gsap.fromTo($("recognition-avatar"), { scale: 0.72 }, { scale: 1, duration: 0.5, ease: "back.out(1.8)" });
    }

    clearTimeout(runtime.recognitionTimer);
    runtime.recognitionTimer = setTimeout(() => {
      if (!runtime.tabletStream) return;
      if (globalThis.gsap) gsap.to(overlay, { autoAlpha: 0, duration: 0.2, onComplete: () => { overlay.hidden = true; } });
      else overlay.hidden = true;
    }, 2700);
  }

  function playConfirmationSound() {
    try {
      const AudioContextClass = globalThis.AudioContext || globalThis.webkitAudioContext;
      if (!AudioContextClass) return;
      const audioContext = new AudioContextClass();
      const oscillator = audioContext.createOscillator();
      const gain = audioContext.createGain();
      oscillator.type = "sine";
      oscillator.frequency.setValueAtTime(660, audioContext.currentTime);
      oscillator.frequency.exponentialRampToValueAtTime(880, audioContext.currentTime + 0.12);
      gain.gain.setValueAtTime(0.08, audioContext.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, audioContext.currentTime + 0.22);
      oscillator.connect(gain);
      gain.connect(audioContext.destination);
      oscillator.start();
      oscillator.stop(audioContext.currentTime + 0.23);
      oscillator.onended = () => audioContext.close().catch(() => {});
    } catch (error) {
      console.debug("Confirmação sonora indisponível.", error);
    }
  }

  async function saveSettings(event) {
    event.preventDefault();
    if (!requireAdmin()) return;
    const schoolName = $("setting-school-name").value.trim();
    if (schoolName.length < 2) return showToast("Nome inválido", "Informe o nome da instituição de ensino.", "warning");
    const settings = {
      ...runtime.state.settings,
      schoolName,
      lateTime: $("setting-late-time").value || "07:15",
      threshold: Number($("setting-threshold").value),
      scanInterval: Number($("setting-scan-interval").value)
    };
    try {
      setSyncStatus("loading", "Salvando configurações");
      const { error } = await runtime.db.from("app_settings").upsert(settingsToRow(settings));
      if (error) throw databaseError(error, "Não foi possível salvar as configurações.");
      runtime.state.settings = settings;
      renderEverything({ refreshSettings: true });
      setSyncStatus("ready", "Em tempo real");
      showToast("Configurações salvas", "As preferências foram atualizadas em todos os aparelhos.");
    } catch (error) {
      setSyncStatus("error", "Erro ao salvar");
      showToast("Falha ao salvar configurações", error.message, "error");
    }
  }

  async function resetAllData() {
    if (!requireAdmin()) return;
    if (!confirm("Apagar todos os alunos, turmas, registros e biometrias do banco compartilhado? Isso afetará todos os aparelhos e não pode ser desfeito.")) return;
    stopTabletCamera();
    try {
      setSyncStatus("loading", "Apagando dados");
      const operations = [
        await runtime.db.from("early_departures").delete().neq("id", ""),
        await runtime.db.from("attendance_closures").delete().neq("id", ""),
        await runtime.db.from("attendance").delete().neq("id", ""),
        await runtime.db.from("students").delete().neq("id", ""),
        await runtime.db.from("classes").delete().neq("id", "")
      ];
      const failed = operations.find((result) => result.error);
      if (failed) throw databaseError(failed.error, "Não foi possível apagar todos os dados.");
      const preservedSchoolPeriods = [...(runtime.state.schoolPeriods || [])];
      runtime.state = createInitialState();
      runtime.state.schoolPeriods = preservedSchoolPeriods;
      const { error } = await runtime.db.from("app_settings").upsert(settingsToRow(runtime.state.settings));
      if (error) throw databaseError(error, "Os registros foram apagados, mas as configurações não puderam ser redefinidas.");
      renderEverything({ refreshSettings: true });
      setSyncStatus("ready", "Em tempo real");
      showToast("Dados apagados", "Todos os aparelhos agora exibem o banco escolar vazio.");
    } catch (error) {
      setSyncStatus("error", "Erro ao apagar");
      showToast("Falha ao apagar dados", error.message, "error");
      scheduleRemoteRefresh();
    }
  }

  function showToast(title, message, type = "success") {
    const toast = document.createElement("div");
    toast.className = `toast${type === "success" ? "" : ` toast-${type}`}`;
    const icon = type === "error" ? "close" : type === "warning" ? "alert" : "check";
    toast.innerHTML = `${iconMarkup(icon)}<div class="toast-copy"><strong>${escapeHTML(title)}</strong><span>${escapeHTML(message)}</span></div>`;
    $("toast-container").appendChild(toast);
    if (globalThis.gsap) gsap.fromTo(toast, { autoAlpha: 0, x: 18, y: 4 }, { autoAlpha: 1, x: 0, y: 0, duration: 0.28, ease: "power2.out" });
    setTimeout(() => {
      if (globalThis.gsap) gsap.to(toast, { autoAlpha: 0, x: 12, duration: 0.22, onComplete: () => toast.remove() });
      else toast.remove();
    }, 3800);
  }

  function handleDelegatedClick(event) {
    const navItem = event.target.closest("[data-view]");
    if (navItem) {
      event.preventDefault();
      return switchView(navItem.dataset.view);
    }

    const viewLink = event.target.closest("[data-view-link]");
    if (viewLink) {
      event.preventDefault();
      return switchView(viewLink.dataset.viewLink);
    }

    if (event.target.closest("[data-close-modal]")) return closeModal();

    const button = event.target.closest("[data-action]");
    if (!button) return;
    const { action, id } = button.dataset;
    switch (action) {
      case "export": return downloadReport();
      case "edit-student": return openStudentModal(id);
      case "delete-student": return deleteStudent(id);
      case "edit-class": return openClassModal(id);
      case "delete-class": return deleteClass(id);
      case "delete-attendance": return deleteAttendance(id);
      case "edit-departure": return openDepartureModal(id);
      case "delete-departure": return deleteEarlyDeparture(id);
      case "open-class-tablet": return openTablet(id);
      case "finalize-attendance": return openFinalizeModal(id || "");
      case "open-late": return openLateArrivals(id);
      case "finalize-late": return openFinalizeModal(id);
      case "resend-report": return resendAttendanceReport(id);
      case "download-professor-json": return downloadProfessorJSON(id);
      default: return undefined;
    }
  }

  function bindEvents() {
    document.addEventListener("click", handleDelegatedClick);
    $("login-form").addEventListener("submit", submitLogin);
    $("logout-button").addEventListener("click", signOut);
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        if (runtime.activeModal) closeModal();
        else if (!$("tablet-screen").hidden) closeTablet();
        else closeMobileMenu();
      }
    });

    $("mobile-menu").addEventListener("click", openMobileMenu);
    $("sidebar-backdrop").addEventListener("click", closeMobileMenu);
    $("header-tablet-button").addEventListener("click", () => openTablet());
    $("header-finalize-button").addEventListener("click", () => openFinalizeModal());
    $("attendance-finalize-button").addEventListener("click", () => openFinalizeModal($("attendance-class-filter").value));
    $("tablet-finalize-button").addEventListener("click", () => openFinalizeModal($("tablet-class-select").value));
    $("sidebar-tablet-button").addEventListener("click", () => openTablet());
    $("dashboard-open-tablet").addEventListener("click", () => openTablet());
    $("exit-tablet-button").addEventListener("click", closeTablet);
    $("tablet-screen").querySelector(".tablet-brand").addEventListener("click", (event) => { event.preventDefault(); closeTablet(); });

    $("add-student-button").addEventListener("click", () => openStudentModal());
    $("student-form").addEventListener("submit", saveStudent);
    $("student-search").addEventListener("input", renderStudents);
    $("student-class-filter").addEventListener("change", renderStudents);
    $("capture-face-button").addEventListener("click", captureStudentFace);
    $("student-consent").addEventListener("change", () => {
      if (!$("student-consent").checked) {
        if (runtime.enrollmentStream) stopEnrollmentCamera();
        runtime.pendingDescriptor = null;
        updateEnrollmentStatus("A biometria será removida ao salvar o aluno.");
        return;
      }
      updateEnrollmentStatus();
    });

    $("add-class-button").addEventListener("click", () => openClassModal());
    $("class-form").addEventListener("submit", saveClass);

    $("add-departure-button").addEventListener("click", () => openDepartureModal());
    $("edit-schedule-button").addEventListener("click", openScheduleModal);
    $("departure-form").addEventListener("submit", saveEarlyDeparture);
    $("schedule-form").addEventListener("submit", saveSchoolSchedule);
    $("departure-date-filter").addEventListener("change", renderEarlyDepartures);
    $("departure-class-filter").addEventListener("change", renderEarlyDepartures);
    $("departure-class").addEventListener("change", () => refreshDepartureStudents());
    $("departure-date").addEventListener("change", () => refreshDepartureStudents());
    $("departure-time").addEventListener("input", updateDeparturePreview);

    $("add-account-button").addEventListener("click", openAccountModal);
    $("account-form").addEventListener("submit", createAccount);
    $("account-role").addEventListener("change", updateAccountClassField);
    $("refresh-accounts-button").addEventListener("click", () => loadAccounts(true));

    $("attendance-date-filter").addEventListener("change", () => { renderAttendance(); renderClosures(); });
    $("attendance-class-filter").addEventListener("change", () => { renderAttendance(); renderClosures(); });
    $("attendance-method-filter").addEventListener("change", renderAttendance);
    $("finalize-class-select").addEventListener("change", updateFinalizePreview);
    $("finalize-form").addEventListener("submit", submitFinalizeAttendance);
    $("finalize-open-late-button").addEventListener("click", () => openLateArrivals());
    $("finalize-resend-button").addEventListener("click", () => resendAttendanceReport());

    $("report-form").addEventListener("submit", (event) => { event.preventDefault(); renderReportPreview(); });
    $("report-export-button").addEventListener("click", () => downloadReport({ useReportFilters: true }));
    ["report-start-date", "report-end-date", "report-class-filter"].forEach((id) => $(id).addEventListener("change", renderReportPreview));
    ["absence-start-date", "absence-end-date", "absence-class-filter"].forEach((id) => $(id).addEventListener("change", renderAbsenceRanking));

    $("settings-form").addEventListener("submit", saveSettings);
    $("setting-threshold").addEventListener("input", () => { $("threshold-display").textContent = Number($("setting-threshold").value).toFixed(2).replace(".", ","); });
    $("load-models-button").addEventListener("click", async () => {
      try { await loadFaceModels(); }
      catch (error) { showToast("Modelos indisponíveis", error.message, "error"); }
    });
    $("reset-data-button").addEventListener("click", resetAllData);

    $("start-camera-button").addEventListener("click", startTabletCamera);
    $("tablet-class-select").addEventListener("change", () => {
      if (runtime.tabletStream) stopTabletCamera();
      renderTablet();
    });

    globalThis.addEventListener("beforeunload", () => {
      stopStream(runtime.tabletStream);
      stopStream(runtime.enrollmentStream);
    });
  }

  async function initialize() {
    runtime.state = createInitialState();
    const storageNotice = document.querySelector(".settings-privacy .privacy-list p:last-child");
    if (storageNotice) storageNotice.innerHTML = `${iconMarkup("shield")} Dados escolares armazenados no banco central com autenticação e regras de acesso.`;
    $("reset-data-button").innerHTML = `${iconMarkup("trash")} Apagar todos os dados compartilhados`;
    const today = localDateKey();
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
    $("attendance-date-filter").value = today;
    $("departure-date-filter").value = today;
    $("report-start-date").value = today;
    $("report-end-date").value = today;
    $("absence-start-date").value = localDateKey(thirtyDaysAgo);
    $("absence-end-date").value = today;
    bindEvents();
    renderEverything({ refreshSettings: true });
    updateClock();
    runtime.clockTimer = setInterval(updateClock, 30000);

    const hashView = location.hash.replace(/^#/, "");
    switchView(VIEW_LABELS[hashView] ? hashView : "dashboard", false);

    if (!configuredSupabase()) {
      showSetupScreen("[ERRO] Fale com o programador responsável.");
    } else {
      try {
        createDatabaseClient();
        const { data, error } = await runtime.db.auth.getSession();
        if (error) throw error;
        if (data.session) await enterApplication(data.session);
        else showLoginScreen();
        runtime.db.auth.onAuthStateChange((event) => {
          if (event === "SIGNED_OUT" && runtime.session) {
            clearLocalSession("Sua sessão foi encerrada. Entre novamente.", "warning");
          }
        });
      } catch (error) {
        showLoginScreen(`Falha ao conectar: ${error.message}`, "error");
      }
    }

    // Superfície de inspeção intencionalmente sem descritores faciais.
    globalThis.PresencaAI = Object.freeze({
      versao: APP_VERSION,
      gerarRelatorio: (filters = {}) => buildReport(filters),
      totalAlunos: () => activeStudents().length,
      totalPresencasHoje: () => todaysAttendance().length,
      totalTurmasFinalizadasHoje: () => runtime.state.closures.filter((closure) => closure.date === localDateKey()).length,
      gerarRankingAusencias: () => absenceRankingData().rows.map((row) => ({ ...row })),
      gerarRelatorioPorAula: (filters = {}) => attendancePercentageData(filters).rows.map((row) => ({ ...row })),
      gerarJsonProfessor: (classId, date = localDateKey()) => {
        const closure = getClosure(classId, date);
        return closure && !closure.acceptingLate ? professorPayloads(closure.id) : [];
      },
      sincronizar: () => loadRemoteState()
    });
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", initialize, { once: true });
  else initialize();
})();
