const state = {
  session: null,
  cities: [],
  hospitals: [],
  doctors: [],
  doctorDirectory: [],
  favorites: {
    doctors: [],
    hospitals: [],
  },
  familyMembers: [],
  hospitalDetail: null,
  doctorDetail: null,
  profile: null,
  notifications: {
    items: [],
    unreadCount: 0,
  },
  slotAvailability: {},
  myAppointments: { upcoming: [], past: [] },
  filters: {
    cityId: "",
    hospitalId: "",
    departmentId: "",
    specialization: "",
    day: "",
    search: "",
  },
  admin: {
    stats: null,
    charts: {
      bookingsPerDay: [],
      topDoctors: [],
      topHospitals: [],
    },
    departments: [],
    hospitals: [],
    doctors: [],
    cities: [],
    appointments: [],
    doctorLeaves: [],
    board: [],
    appointmentFilters: {
      date: "",
      hospital: "",
      doctor: "",
      priority: "",
      status: "",
    },
  },
  doctorDaily: null,
  selectedCity: null,
  selectedHospital: null,
  latestAppointment: null,
  route: "home",
  theme: localStorage.getItem("pulsecare-theme") || "light",
  editingDoctorId: null,
  editingHospitalId: null,
  mobileMenuOpen: false,
  bookingWizard: createDefaultBookingDraft(),
};

const app = document.getElementById("app");
const sidebarNav = document.getElementById("sidebarNav");
const menuToggle = document.getElementById("menuToggle");
const navScrim = document.getElementById("navScrim");
const themeToggle = document.getElementById("themeToggle");
const installButton = document.getElementById("installButton");
const logoutButton = document.getElementById("logoutButton");
const userChip = document.getElementById("userChip");
const loadingOverlay = document.getElementById("loadingOverlay");
const pageTitle = document.getElementById("pageTitle");
const pageEyebrow = document.getElementById("pageEyebrow");
const ADMIN_EMAIL = "gauravkale216@gmail.com";
const APPOINTMENT_SLOT_START_TIME = "10:00";
const APPOINTMENT_SLOT_STEP_MINUTES = 15;
const APPOINTMENT_SLOT_DURATION_MINUTES = 15;
const BOOKING_DRAFT_STORAGE_KEY = "pulsecare-booking-draft";
const BOOKING_WIZARD_STEPS = [
  { id: 1, label: "City", icon: "fa-location-dot" },
  { id: 2, label: "Hospital", icon: "fa-hospital" },
  { id: 3, label: "Department", icon: "fa-stethoscope" },
  { id: 4, label: "Doctor", icon: "fa-user-doctor" },
  { id: 5, label: "Date & Time", icon: "fa-calendar-days" },
  { id: 6, label: "Patient", icon: "fa-id-card" },
  { id: 7, label: "Review", icon: "fa-clipboard-check" },
];
let autoRefreshTimer = null;
let adminCharts = [];
let deferredInstallPrompt = null;

document.body.dataset.theme = state.theme;
updateThemeLabel();
syncMobileMenu();
hydrateBookingDraft();

themeToggle.addEventListener("click", () => {
  state.theme = state.theme === "dark" ? "light" : "dark";
  document.body.dataset.theme = state.theme;
  localStorage.setItem("pulsecare-theme", state.theme);
  updateThemeLabel();
});

menuToggle.addEventListener("click", () => {
  state.mobileMenuOpen = !state.mobileMenuOpen;
  syncMobileMenu();
});

navScrim.addEventListener("click", () => {
  closeMobileMenu();
});

logoutButton.addEventListener("click", withSafeHandler(async () => {
  await apiFetch("/api/logout", { method: "POST" }, { skipAuthRedirect: true });
  state.session = null;
  state.route = "home";
  state.selectedCity = null;
  state.selectedHospital = null;
  state.hospitalDetail = null;
  state.doctorDetail = null;
  state.profile = null;
  state.notifications = { items: [], unreadCount: 0 };
  state.latestAppointment = null;
  state.favorites = { doctors: [], hospitals: [] };
  state.familyMembers = [];
  state.slotAvailability = {};
  state.bookingWizard = createDefaultBookingDraft();
  persistBookingDraft();
  history.replaceState({}, "", "/");
  render();
}));

installButton.addEventListener("click", withSafeHandler(async () => {
  if (!deferredInstallPrompt) return;
  deferredInstallPrompt.prompt();
  const choice = await deferredInstallPrompt.userChoice.catch(() => null);
  if (choice?.outcome) {
    showToast(
      choice.outcome === "accepted"
        ? "PulseCare is being installed."
        : "Install prompt dismissed.",
      choice.outcome === "accepted" ? "success" : "error"
    );
  }
  deferredInstallPrompt = null;
  updateInstallButtonVisibility();
}));

document.addEventListener("click", withSafeHandler(handleClick));
document.addEventListener("submit", withSafeHandler(handleSubmit));
document.addEventListener("input", withSafeHandler(handleInput));
document.addEventListener("change", withSafeHandler(handleChange));

window.addEventListener("beforeinstallprompt", (event) => {
  event.preventDefault();
  deferredInstallPrompt = event;
  updateInstallButtonVisibility();
});

window.addEventListener("appinstalled", () => {
  deferredInstallPrompt = null;
  updateInstallButtonVisibility();
  showToast("PulseCare installed on this device.");
});

window.addEventListener("unhandledrejection", (event) => {
  event.preventDefault();
  handleClientError(event.reason);
});

window.addEventListener("error", (event) => {
  handleClientError(event.error || event.message);
});

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch(() => {});
  });
}

init();

function createDefaultBookingDraft() {
  return {
    step: 1,
    cityId: "",
    hospitalId: "",
    departmentId: "",
    doctorId: "",
    date: "",
    selectedSlotNumber: "",
    expectedSlot: null,
    hospitalSearch: "",
    departmentSearch: "",
    doctorSearch: "",
    patientType: "existing",
    bookingFor: "self",
    familyMemberId: "",
    patientName: "",
    mobile: "",
    emergencyContact: "",
    reasonForVisit: "",
    notes: "",
    priority: "normal",
    availabilityMessage: "",
    availabilityStatus: "idle",
  };
}

function hydrateBookingDraft() {
  try {
    const saved = sessionStorage.getItem(BOOKING_DRAFT_STORAGE_KEY);
    if (!saved) return;
    state.bookingWizard = {
      ...createDefaultBookingDraft(),
      ...JSON.parse(saved),
    };
  } catch (error) {
    state.bookingWizard = createDefaultBookingDraft();
  }
}

function persistBookingDraft() {
  sessionStorage.setItem(
    BOOKING_DRAFT_STORAGE_KEY,
    JSON.stringify(state.bookingWizard)
  );
}

function updateBookingDraft(patch) {
  state.bookingWizard = {
    ...state.bookingWizard,
    ...patch,
  };
  persistBookingDraft();
}

async function init() {
  try {
    await hydrateSession();
    if (state.session?.authenticated) {
      await Promise.all([loadCities(), loadFavorites(), loadFamilyMembers(), loadNotifications()]);
      const params = new URLSearchParams(window.location.search);
      const appointmentId = params.get("appointment");
      if (appointmentId) {
        await loadAppointmentDetails(appointmentId);
        state.route = "confirmation";
      } else if (window.location.pathname === "/dashboard") {
        state.route = "booking";
      } else if (window.location.pathname === "/profile") {
        state.route = "profile";
        await Promise.all([loadProfile(), loadMyAppointments()]);
      } else if (window.location.pathname === "/notifications") {
        state.route = "notifications";
        await loadNotifications({ markRead: true });
      } else if (/^\/hospital\/\d+$/.test(window.location.pathname)) {
        state.route = "hospital-detail";
        await loadHospitalDetail(window.location.pathname.split("/")[2]);
      } else if (/^\/doctor\/\d+$/.test(window.location.pathname)) {
        state.route = "doctor-detail";
        await loadDoctorDetail(window.location.pathname.split("/")[2]);
      } else if (window.location.pathname === "/admin/board" && isAdmin()) {
        state.route = "admin-board";
        await loadAdminBoard();
      } else if (/^\/doctor\/\d+\/today$/.test(window.location.pathname) && isStaff()) {
        state.route = "doctor-today";
        await loadDoctorToday(window.location.pathname.split("/")[2]);
      } else if (window.location.pathname === "/admin" && isAdmin()) {
        state.route = "admin";
        await loadAdminData();
      } else {
        state.route = "booking";
      }

      if (state.route === "booking") {
        await loadBookingWizardData();
      }
    }
  } catch (error) {
    showToast(error.message, "error");
  } finally {
    render();
  }
}

async function hydrateSession() {
  state.session = await apiFetch("/api/session", {}, { skipAuthRedirect: true, silent: true });
}

async function apiFetch(url, options = {}, config = {}) {
  if (!config.silent) setLoading(true);
  try {
    const response = await fetch(url, {
      credentials: "include",
      headers: { "Content-Type": "application/json", ...(options.headers || {}) },
      ...options,
    });
    const payload = await response.json().catch(() => ({}));
    if (response.status === 401 && !config.skipAuthRedirect) {
      state.session = { authenticated: false, user: null };
      state.route = "home";
      render();
      throw new Error("Please login to continue");
    }
    if (!response.ok) throw new Error(payload.error || "Request failed");
    return payload;
  } finally {
    if (!config.silent) setLoading(false);
  }
}

function withSafeHandler(handler) {
  return async function guardedHandler(event) {
    try {
      await handler(event);
    } catch (error) {
      handleClientError(error);
    }
  };
}

function handleClientError(error) {
  const message = error?.message || String(error || "Something went wrong. Please try again.");
  console.error(error);
  setLoading(false);
  showToast(message, "error");
}

async function loadCities() {
  state.cities = await apiFetch("/cities", {}, { silent: true });
}

async function loadHospitals(cityId) {
  state.hospitals = await apiFetch(`/hospitals/${cityId}`, {}, { silent: true });
}

async function loadDoctors(hospitalId) {
  state.doctors = await apiFetch(`/doctors/${hospitalId}`, {}, { silent: true });
}

async function loadDoctorDirectory() {
  const params = new URLSearchParams();
  if (state.filters.cityId) params.set("cityId", state.filters.cityId);
  if (state.filters.hospitalId) params.set("hospitalId", state.filters.hospitalId);
  if (state.filters.departmentId) params.set("departmentId", state.filters.departmentId);
  if (state.filters.specialization) params.set("specialization", state.filters.specialization);
  if (state.filters.day) params.set("day", state.filters.day);
  if (state.filters.search) params.set("search", state.filters.search);
  state.doctorDirectory = await apiFetch(`/directory/doctors?${params.toString()}`, {}, { silent: true });
}

async function loadAppointmentDetails(appointmentId) {
  state.latestAppointment = await apiFetch(`/appointment/${appointmentId}`, {}, { silent: true });
}

async function loadMyAppointments() {
  state.myAppointments = await apiFetch("/appointments/my", {}, { silent: true });
}

async function loadFavorites() {
  state.favorites = await apiFetch("/favorites", {}, { silent: true });
}

async function loadFamilyMembers() {
  state.familyMembers = await apiFetch("/family-members", {}, { silent: true });
}

async function loadProfile() {
  state.profile = await apiFetch("/profile", {}, { silent: true });
  return state.profile;
}

async function loadNotifications(options = {}) {
  state.notifications = await apiFetch("/notifications", {}, { silent: true });

  if (options.markRead && state.notifications.unreadCount) {
    await apiFetch("/notifications/read", { method: "POST" }, { silent: true });
    state.notifications = {
      ...state.notifications,
      unreadCount: 0,
      items: state.notifications.items.map((item) => ({ ...item, is_read: true })),
    };
  }

  return state.notifications;
}

async function loadHospitalDetail(hospitalId) {
  state.hospitalDetail = await apiFetch(`/hospital/${hospitalId}/details`, {}, { silent: true });
  state.selectedHospital = state.hospitalDetail;
  state.selectedCity = state.hospitalDetail
    ? {
        id: Number(state.hospitalDetail.city_id),
        name: state.hospitalDetail.city_name,
      }
    : state.selectedCity;
  return state.hospitalDetail;
}

async function loadDoctorDetail(doctorId) {
  state.doctorDetail = await apiFetch(`/doctor/${doctorId}/details`, {}, { silent: true });
  if (state.doctorDetail) {
    state.selectedHospital = {
      id: Number(state.doctorDetail.hospital_id),
      name: state.doctorDetail.hospital_name,
      city_id: Number(state.doctorDetail.city_id),
      city_name: state.doctorDetail.city_name,
      location: state.doctorDetail.hospital_location,
      contact_phone: state.doctorDetail.hospital_contact_phone,
      map_link: state.doctorDetail.hospital_map_link,
    };
    state.selectedCity = {
      id: Number(state.doctorDetail.city_id),
      name: state.doctorDetail.city_name,
    };
  }
  return state.doctorDetail;
}

async function openProfilePage() {
  await Promise.all([loadProfile(), loadMyAppointments()]);
  state.route = "profile";
  history.replaceState({}, "", "/profile");
  closeMobileMenu();
  render();
}

async function openHospitalDetailPage(hospitalId) {
  await loadHospitalDetail(hospitalId);
  state.filters.cityId = String(state.hospitalDetail?.city_id || "");
  state.filters.hospitalId = String(state.hospitalDetail?.id || "");
  state.route = "hospital-detail";
  history.replaceState({}, "", `/hospital/${hospitalId}`);
  closeMobileMenu();
  render();
}

async function openDoctorDetailPage(doctorId) {
  await loadDoctorDetail(doctorId);
  state.filters.cityId = String(state.doctorDetail?.city_id || "");
  state.filters.hospitalId = String(state.doctorDetail?.hospital_id || "");
  state.route = "doctor-detail";
  history.replaceState({}, "", `/doctor/${doctorId}`);
  closeMobileMenu();
  render();
}

async function loadDoctorSlots(doctorId, date, options = {}) {
  const params = new URLSearchParams({ date });
  if (options.excludeAppointmentId) {
    params.set("excludeAppointmentId", options.excludeAppointmentId);
  }
  const result = await apiFetch(`/doctor/${doctorId}/slots?${params.toString()}`, {}, { silent: true });
  state.slotAvailability[getSlotCacheKey(doctorId, date, options.excludeAppointmentId)] = result;
  return result;
}

async function loadQueue() {
  if (!state.latestAppointment) return null;
  return apiFetch(
    `/queue/${state.latestAppointment.doctor_id}/${state.latestAppointment.appointment_date}?token=${state.latestAppointment.token_number}`,
    {},
    { silent: true }
  );
}

function getAdminAppointmentQueryParams() {
  const params = new URLSearchParams();
  const filters = state.admin.appointmentFilters;
  if (filters.date) params.set("date", filters.date);
  if (filters.hospital) params.set("hospital", filters.hospital);
  if (filters.doctor) params.set("doctor", filters.doctor);
  if (filters.priority) params.set("priority", filters.priority);
  if (filters.status) params.set("status", filters.status);
  return params;
}

async function loadAdminAppointments() {
  const params = getAdminAppointmentQueryParams();
  state.admin.appointments = await apiFetch(
    `/admin/appointments${params.toString() ? `?${params.toString()}` : ""}`,
    {},
    { silent: true }
  );
}

async function loadAdminData() {
  const [statsPayload, cities, departments, hospitals, doctors, doctorLeaves] = await Promise.all([
    apiFetch("/admin/stats", {}, { silent: true }),
    apiFetch("/admin/cities", {}, { silent: true }),
    apiFetch("/admin/departments", {}, { silent: true }),
    apiFetch("/admin/hospitals", {}, { silent: true }),
    apiFetch("/admin/doctors", {}, { silent: true }),
    apiFetch("/admin/doctor-leaves", {}, { silent: true }),
    loadAdminAppointments(),
  ]);
  state.admin.stats = statsPayload.stats;
  state.admin.charts = statsPayload.charts || state.admin.charts;
  state.admin.cities = cities;
  state.admin.departments = departments;
  state.admin.hospitals = hospitals;
  state.admin.doctors = doctors;
  state.admin.doctorLeaves = doctorLeaves;
}

async function loadAdminBoard() {
  state.admin.board = await apiFetch("/admin/board-data", {}, { silent: true });
}

async function loadDoctorToday(doctorId) {
  state.doctorDaily = await apiFetch(`/doctor/${doctorId}/today-data`, {}, { silent: true });
}

function configureAutoRefresh() {
  if (autoRefreshTimer) {
    clearInterval(autoRefreshTimer);
    autoRefreshTimer = null;
  }

  if (!state.session?.authenticated) return;

  const refreshers = {
    confirmation: async () => {
      if (!state.latestAppointment?.id) return;
      await loadAppointmentDetails(state.latestAppointment.id);
      await renderConfirmation();
    },
    "admin-board": async () => {
      if (!isAdmin()) return;
      await Promise.all([loadAdminBoard(), loadAdminData()]);
      render();
    },
    "doctor-today": async () => {
      if (!isStaff() || !state.doctorDaily?.doctor_id) return;
      await loadDoctorToday(state.doctorDaily.doctor_id);
      render();
    },
  };

  const activeRefresh = refreshers[state.route];
  if (!activeRefresh) return;

  autoRefreshTimer = setInterval(() => {
    activeRefresh().catch(() => {});
  }, 12000);
}

function render() {
  document.body.classList.toggle("is-login", !state.session?.authenticated);

  if (state.route !== "admin") {
    destroyAdminCharts();
  }
  updateHeader();
  renderNav();
  configureAutoRefresh();

  if (!state.session?.authenticated) {
    app.innerHTML = document.getElementById("loginTemplate").innerHTML;
    document.getElementById("loginButton").addEventListener("click", () => {
      window.location.href = "/auth/google";
    });
    return;
  }

  if (state.route === "booking") return renderBookingWizard();
  if (state.route === "cities") return renderCities();
  if (state.route === "hospitals") return renderHospitals();
  if (state.route === "hospital-detail") return renderHospitalDetail();
  if (state.route === "doctors") return renderDoctors();
  if (state.route === "doctor-detail") return renderDoctorDetail();
  if (state.route === "appointments") return renderAppointments();
  if (state.route === "profile") return renderProfile();
  if (state.route === "notifications") return renderNotifications();
  if (state.route === "confirmation") return renderConfirmation();
  if (state.route === "admin") return renderAdmin();
  if (state.route === "admin-board") return renderAdminBoard();
  if (state.route === "doctor-today") return renderDoctorToday();
  return renderCities();
}

function updateHeader() {
  const user = state.session?.user;
  userChip.innerHTML = user
    ? `${user.photo ? `<img src="${user.photo}" alt="${escapeHtml(user.name)}" />` : ""}<div><strong>${escapeHtml(user.name)}</strong><div>${escapeHtml(user.role || "patient")}</div></div>`
    : '<div><strong>Guest</strong><div>Login required</div></div>';
  userChip.classList.toggle("hidden", !user);
  userChip.dataset.action = user ? "open-profile" : "";

  const titles = {
    home: ["Welcome", "Hospital Management System"],
    booking: ["Patient booking", "Book a hospital appointment"],
    cities: ["Choose your city", "Find hospitals near you"],
    hospitals: ["Hospital directory", state.selectedCity?.name || "Hospitals"],
    "hospital-detail": ["Hospital details", state.hospitalDetail?.name || "Hospital overview"],
    doctors: ["Doctor availability", state.selectedHospital?.name || "Doctor directory"],
    "doctor-detail": ["Doctor profile", state.doctorDetail?.name || "Doctor details"],
    appointments: ["My bookings", "Upcoming and past appointments"],
    profile: ["My profile", "Personal details and history"],
    notifications: ["Notification center", "Booking updates"],
    confirmation:
      (state.latestAppointment?.status || "").toLowerCase() === "pending_payment"
        ? ["Payment pending", "Complete payment to confirm"]
        : ["Booking confirmed", "Track your token live"],
    admin: ["Admin control room", "Operations dashboard"],
    "admin-board": ["Reception board", "Today's appointment board"],
    "doctor-today": ["Doctor daily list", state.doctorDaily?.doctor_name || "Today's patients"],
  };
  const [eyebrow, title] = titles[state.route] || titles.home;
  pageEyebrow.textContent = eyebrow;
  pageTitle.textContent = title;
}

function renderNav() {
  const items = state.session?.authenticated
    ? [
        { id: "booking", label: "Book Appointment", icon: "fa-calendar-check", activeRoutes: ["booking"] },
        { id: "cities", label: "Cities", icon: "fa-city", activeRoutes: ["cities"] },
        { id: "hospitals", label: "Hospitals", icon: "fa-hospital", hidden: !state.selectedCity && !state.hospitalDetail, activeRoutes: ["hospitals", "hospital-detail"] },
        { id: "doctors", label: "Doctors", icon: "fa-user-doctor", activeRoutes: ["doctors", "doctor-detail"] },
        { id: "appointments", label: "My Appointments", icon: "fa-notes-medical", activeRoutes: ["appointments"] },
        { id: "profile", label: "Profile", icon: "fa-id-card", activeRoutes: ["profile"] },
        { id: "notifications", label: "Notifications", icon: "fa-bell", activeRoutes: ["notifications"], badge: state.notifications.unreadCount || 0 },
        { id: "confirmation", label: "My Queue", icon: "fa-ticket", hidden: !state.latestAppointment, activeRoutes: ["confirmation"] },
        { id: "admin", label: "Admin Panel", icon: "fa-chart-line", hidden: !isAdmin(), activeRoutes: ["admin"] },
        { id: "admin-board", label: "Today's Board", icon: "fa-tv", hidden: !isAdmin(), activeRoutes: ["admin-board"] },
      ]
    : [];

  sidebarNav.innerHTML = items
    .filter((item) => !item.hidden)
    .map(
      (item) => `
        <button class="nav-button ${(item.activeRoutes || [item.id]).includes(state.route) ? "active" : ""}" data-route="${item.id}" type="button">
          <i class="fa-solid ${item.icon}"></i>
          <span>${item.label}</span>
          ${item.badge ? `<span class="nav-button__badge">${item.badge}</span>` : ""}
        </button>
      `
    )
    .join("");

  logoutButton.classList.toggle("hidden", !state.session?.authenticated);
  updateInstallButtonVisibility();
}

function renderBookingWizard() {
  const draft = state.bookingWizard;
  app.innerHTML = `
    <section class="booking-workspace">
      ${renderBookingHero()}
      <div class="booking-layout">
        <article class="booking-wizard-panel">
          ${renderWizardStepper()}
          <div class="wizard-stage">
            ${renderWizardBody(draft.step)}
          </div>
        </article>
        ${renderWizardSidebar()}
      </div>
    </section>
  `;
}

function renderBookingHero() {
  const draft = state.bookingWizard;
  const doctor = getWizardDoctor();
  const hospital = getWizardHospital();
  const slot = getWizardSelectedSlot();
  return `
    <section class="booking-hero">
      <div class="booking-hero__copy">
        <p class="eyebrow">Premium appointment desk</p>
        <h3>Book care with confidence.</h3>
        <p>Choose the right hospital, department, doctor, and queue slot through a guided hospital-grade booking flow.</p>
        <div class="booking-hero__metrics">
          <span><strong>${state.cities.length || 0}</strong> Cities</span>
          <span><strong>${state.hospitals.length || "--"}</strong> Hospitals loaded</span>
          <span><strong>${doctor ? "1" : "--"}</strong> Doctor selected</span>
        </div>
      </div>
      <div class="booking-hero__summary">
        <p class="eyebrow">Current selection</p>
        <h4>${escapeHtml(doctor?.name || "No doctor selected")}</h4>
        <p>${escapeHtml(hospital?.name || "Select a hospital to begin")}</p>
        <div class="chip-row">
          <span class="chip"><i class="fa-solid fa-calendar-day"></i>${draft.date ? formatDate(draft.date) : "Date pending"}</span>
          <span class="chip"><i class="fa-regular fa-clock"></i>${slot ? slot.label : "Slot pending"}</span>
        </div>
      </div>
    </section>
  `;
}

function renderWizardStepper() {
  const activeStep = Number(state.bookingWizard.step || 1);
  return `
    <div class="wizard-progress" aria-label="Booking progress">
      <div class="wizard-progress__meta">
        <span>Step ${activeStep} of ${BOOKING_WIZARD_STEPS.length}</span>
        <strong>${escapeHtml(BOOKING_WIZARD_STEPS.find((step) => step.id === activeStep)?.label || "Booking")}</strong>
      </div>
      <div class="wizard-steps">
        ${BOOKING_WIZARD_STEPS.map((step) => `
          <button
            class="wizard-step ${step.id === activeStep ? "active" : ""} ${step.id < activeStep ? "complete" : ""}"
            data-action="wizard-step"
            data-step="${step.id}"
            type="button"
            ${isWizardStepReachable(step.id) ? "" : "disabled"}
            aria-label="Go to ${escapeAttribute(step.label)}"
            aria-current="${step.id === activeStep ? "step" : "false"}"
          >
            <i class="fa-solid ${step.icon}"></i>
            <span>${escapeHtml(step.label)}</span>
          </button>
        `).join("")}
      </div>
    </div>
  `;
}

function renderWizardBody(step) {
  if (step === 1) return renderWizardCityStep();
  if (step === 2) return renderWizardHospitalStep();
  if (step === 3) return renderWizardDepartmentStep();
  if (step === 4) return renderWizardDoctorStep();
  if (step === 5) return renderWizardScheduleStep();
  if (step === 6) return renderWizardPatientStep();
  if (step === 7) return renderWizardReviewStep();
  return renderWizardCityStep();
}

function renderWizardCityStep() {
  return `
    <div class="wizard-screen">
      <div class="section-header">
        <div>
          <p class="eyebrow">Step 1</p>
          <h3>Where would you like to receive care?</h3>
          <p>Select a city to unlock hospitals and doctor availability.</p>
        </div>
      </div>
      <div class="premium-card-grid">
        ${state.cities.length ? state.cities.map((city) => `
          <button class="premium-select-card ${String(state.bookingWizard.cityId) === String(city.id) ? "selected" : ""}" data-action="wizard-select-city" data-city-id="${city.id}" type="button" aria-pressed="${String(state.bookingWizard.cityId) === String(city.id)}">
            <span class="premium-select-card__icon"><i class="fa-solid fa-location-dot"></i></span>
            <strong>${escapeHtml(city.name)}</strong>
            <span>${city.hospital_count || 0} hospitals available</span>
            <em>Priority OPD and specialist appointments</em>
          </button>
        `).join("") : renderWizardSkeletonCards(3)}
      </div>
    </div>
  `;
}

function renderWizardHospitalStep() {
  const draft = state.bookingWizard;
  const hospitals = state.hospitals.filter((hospital) => {
    const term = draft.hospitalSearch.toLowerCase();
    return !term || hospital.name.toLowerCase().includes(term) || String(hospital.location || "").toLowerCase().includes(term);
  });

  return `
    <div class="wizard-screen">
      <div class="section-header">
        <div>
          <p class="eyebrow">Step 2</p>
          <h3>Select a hospital</h3>
          <p>Compare hospital access, OPD capacity, and front desk information.</p>
        </div>
        <div class="search-row compact-search">
          <input id="bookingHospitalSearch" type="search" placeholder="Search hospitals or location" value="${escapeHtml(draft.hospitalSearch)}" aria-label="Search hospitals" />
        </div>
      </div>
      <div class="hospital-premium-grid">
        ${hospitals.length ? hospitals.map(renderPremiumHospitalCard).join("") : emptyState("No hospitals matched this city. Try a different search or go back to select another city.")}
      </div>
      ${renderWizardNavControls()}
    </div>
  `;
}

function renderPremiumHospitalCard(hospital) {
  const meta = getHospitalMeta(hospital);
  return `
    <article class="hospital-premium-card ${String(state.bookingWizard.hospitalId) === String(hospital.id) ? "selected" : ""}">
      <img src="${hospital.image || placeholderImage("hospital")}" alt="${escapeHtml(hospital.name)}" />
      <div class="hospital-premium-card__body">
        <div class="section-header">
          <div>
            <p class="eyebrow">${escapeHtml(hospital.city_name || getWizardCity()?.name || "Hospital")}</p>
            <h3>${escapeHtml(hospital.name)}</h3>
          </div>
        </div>
        <p class="card__meta"><i class="fa-solid fa-location-dot"></i>${escapeHtml(hospital.address || hospital.location || "Address not available")}</p>
        ${hospital.contact_phone ? `<p class="card__meta"><i class="fa-solid fa-phone"></i>${escapeHtml(hospital.contact_phone)}</p>` : ""}
        <div class="chip-row">
          <span class="chip"><i class="fa-solid fa-user-doctor"></i>${hospital.doctor_count || 0} doctors</span>
          ${meta.hours ? `<span class="chip"><i class="fa-regular fa-clock"></i>${escapeHtml(meta.hours)}</span>` : ""}
        </div>
        ${meta.departments ? `<p class="hospital-specialties">${escapeHtml(meta.departments)}</p>` : ""}
        <div class="card__actions">
          <button class="primary-button" data-action="wizard-select-hospital" data-hospital-id="${hospital.id}" type="button">
            <i class="fa-solid fa-arrow-right"></i>
            <span>Choose Hospital</span>
          </button>
          ${hospital.map_link ? `<a class="ghost-button link-button" href="${escapeAttribute(hospital.map_link)}" target="_blank" rel="noreferrer"><i class="fa-solid fa-map-location-dot"></i><span>Map</span></a>` : ""}
        </div>
      </div>
    </article>
  `;
}

function renderWizardDepartmentStep() {
  const draft = state.bookingWizard;
  const departments = getWizardDepartments().filter((department) => {
    const term = draft.departmentSearch.toLowerCase();
    return !term || department.name.toLowerCase().includes(term) || department.description.toLowerCase().includes(term);
  });
  const popular = getWizardDepartments().slice(0, 4);

  return `
    <div class="wizard-screen">
      <div class="section-header">
        <div>
          <p class="eyebrow">Step 3</p>
          <h3>Choose a department</h3>
          <p>Pick the care area that best matches the reason for visit.</p>
        </div>
        <div class="search-row compact-search">
          <input id="bookingDepartmentSearch" type="search" placeholder="Search departments" value="${escapeHtml(draft.departmentSearch)}" aria-label="Search departments" />
        </div>
      </div>
      ${popular.length ? `<div class="popular-strip">${popular.map((department) => `<button class="chip" data-action="wizard-select-department" data-department-id="${department.id}" type="button"><i class="fa-solid ${department.icon}"></i>${escapeHtml(department.name)}</button>`).join("")}</div>` : ""}
      <div class="premium-card-grid">
        ${departments.length ? departments.map((department) => `
          <button class="department-card ${String(draft.departmentId) === String(department.id) ? "selected" : ""}" data-action="wizard-select-department" data-department-id="${department.id}" type="button" aria-pressed="${String(draft.departmentId) === String(department.id)}">
            <span class="premium-select-card__icon"><i class="fa-solid ${department.icon}"></i></span>
            <strong>${escapeHtml(department.name)}</strong>
            <span>${department.doctorCount} doctors available</span>
            <em>${escapeHtml(department.description)}</em>
          </button>
        `).join("") : emptyState("No departments found for this hospital.")}
      </div>
      ${renderWizardNavControls()}
    </div>
  `;
}

function renderWizardDoctorStep() {
  const draft = state.bookingWizard;
  const doctors = getWizardDoctors().filter((doctor) => {
    const term = draft.doctorSearch.toLowerCase();
    const sameDepartment = !draft.departmentId || String(doctor.department_id || doctor.specialization) === String(draft.departmentId);
    const matchesSearch =
      !term ||
      doctor.name.toLowerCase().includes(term) ||
      String(doctor.specialization || "").toLowerCase().includes(term) ||
      String(doctor.department_name || "").toLowerCase().includes(term);
    return sameDepartment && matchesSearch;
  });

  return `
    <div class="wizard-screen">
      <div class="section-header">
        <div>
          <p class="eyebrow">Step 4</p>
          <h3>Select your doctor</h3>
          <p>Review experience, languages, fee estimate, and next expected availability.</p>
        </div>
        <div class="search-row compact-search">
          <input id="bookingDoctorSearch" type="search" placeholder="Search doctors" value="${escapeHtml(draft.doctorSearch)}" aria-label="Search doctors" />
        </div>
      </div>
      <div class="doctor-premium-grid">
        ${doctors.length ? doctors.map(renderPremiumDoctorCard).join("") : emptyState("No doctors match this department. Try another department or search term.")}
      </div>
      ${renderWizardNavControls()}
    </div>
  `;
}

function renderPremiumDoctorCard(doctor) {
  const meta = getDoctorMeta(doctor);
  const availableToday = !isDoctorUnavailableOnDate(doctor, todayDate());
  return `
    <article class="doctor-premium-card ${String(state.bookingWizard.doctorId) === String(doctor.id) ? "selected" : ""}">
      <img src="${doctor.image || placeholderImage("doctor")}" alt="${escapeHtml(doctor.name)}" />
      <div class="doctor-premium-card__content">
        <div class="section-header">
          <div>
            <p class="eyebrow">${escapeHtml(doctor.department_name || doctor.specialization || "Specialist")}</p>
            <h3>${escapeHtml(doctor.name)}</h3>
          </div>
        </div>
        <p>${[meta.qualification, meta.experience !== null ? `${meta.experience} years experience` : ""].filter(Boolean).map(escapeHtml).join(" - ") || "&nbsp;"}</p>
        <div class="chip-row">
          <span class="chip"><i class="fa-solid fa-indian-rupee-sign"></i>${escapeHtml(meta.feeLabel)}</span>
          <span class="chip"><i class="fa-solid fa-hospital"></i>${escapeHtml(doctor.hospital_name || getWizardHospital()?.name || "")}</span>
          <span class="chip ${availableToday ? "chip-success" : ""}"><i class="fa-solid fa-calendar-check"></i>${availableToday ? "Available today" : "Unavailable today"}</span>
        </div>
        <div class="doctor-next-slot">
          <strong>${escapeHtml(meta.nextSlot)}</strong>
          <span>Estimated wait ${estimateWait(Number(doctor.booked_patients || 0))}</span>
        </div>
        <div class="card__actions">
          <button class="primary-button" data-action="wizard-select-doctor" data-doctor-id="${doctor.id}" type="button">
            <i class="fa-solid fa-calendar-plus"></i>
            <span>Choose Doctor</span>
          </button>
          <button class="ghost-button" data-action="open-doctor-detail" data-doctor-id="${doctor.id}" type="button">
            <i class="fa-solid fa-id-badge"></i>
            <span>Profile</span>
          </button>
        </div>
      </div>
    </article>
  `;
}

function renderWizardScheduleStep() {
  const draft = state.bookingWizard;
  const doctor = getWizardDoctor();
  const slotResponse = getWizardSlotResponse();
  return `
    <div class="wizard-screen">
      <div class="section-header">
        <div>
          <p class="eyebrow">Step 5</p>
          <h3>Select date and time</h3>
          <p>Pick any open time. Booked, past and out-of-hours times are disabled. For paid consultations your time is held for a few minutes while you pay.</p>
        </div>
      </div>
      <div class="schedule-grid">
        <div class="calendar-strip">
          ${getCalendarDays(14).map((day) => {
            const disabled = doctor && isDoctorUnavailableOnDate(doctor, day.value);
            return `
              <button class="calendar-day ${draft.date === day.value ? "selected" : ""}" data-action="wizard-select-date" data-date="${day.value}" type="button" ${disabled ? "disabled" : ""} aria-pressed="${draft.date === day.value}">
                <span>${escapeHtml(day.weekday)}</span>
                <strong>${day.day}</strong>
                <em>${escapeHtml(day.month)}</em>
              </button>
            `;
          }).join("")}
        </div>
        <div class="slot-panel">
          ${draft.availabilityStatus === "loading" ? renderWizardSkeletonCards(3) : renderWizardSlotGroups(slotResponse)}
        </div>
      </div>
      ${renderAppointmentConflict()}
      ${renderWizardNavControls()}
    </div>
  `;
}

function renderWizardSlotGroups(slotResponse) {
  if (!state.bookingWizard.date) {
    return emptyState("Choose an appointment date to view available OPD tokens.");
  }

  if (!slotResponse) {
    return emptyState(state.bookingWizard.availabilityMessage || "Select a date to check live availability.");
  }

  if (slotResponse.unavailable || slotResponse.limitReached) {
    return emptyState(slotResponse.note || "No appointments are available on this date.");
  }

  const selectedSlot = getWizardSelectedSlot();
  const groupedSlots = groupSlotsByDaypart(slotResponse.slots || []);
  return `
    <div class="recommended-slot">
      <p class="eyebrow">Earliest available time</p>
      <h3>${slotResponse.nextSlot ? escapeHtml(formatTime(slotResponse.nextSlot.startTime)) : "No slots available"}</h3>
      <p>${slotResponse.bookedPatients || 0}/${slotResponse.maxPatientsPerDay || "--"} bookings taken for this doctor. Consultation fee ${escapeHtml(formatFee(slotResponse.consultationFee))}.</p>
    </div>
    ${Object.entries(groupedSlots).map(([label, slots]) => `
      <div class="slot-group">
        <h4>${escapeHtml(label)}</h4>
        <div class="slot-grid">
          ${slots.map((slot) => {
            const isRecommended = slotResponse.nextSlot && Number(slot.slotNumber) === Number(slotResponse.nextSlot.slotNumber);
            const disabled = !slot.isAvailable;
            return `
              <button
                class="slot-choice ${selectedSlot?.slotNumber === slot.slotNumber ? "selected" : ""} ${isRecommended ? "recommended" : ""}"
                data-action="wizard-select-slot"
                data-slot-number="${slot.slotNumber}"
                type="button"
                ${disabled ? "disabled" : ""}
                aria-pressed="${selectedSlot?.slotNumber === slot.slotNumber}"
              >
                <span>${escapeHtml(formatTime(slot.startTime))}</span>
                <strong>${slot.isAvailable ? (isRecommended ? "Earliest" : "Available") : escapeHtml(slot.unavailableReason || "Unavailable")}</strong>
              </button>
            `;
          }).join("")}
        </div>
      </div>
    `).join("")}
  `;
}

function renderWizardPatientStep() {
  const draft = state.bookingWizard;
  const selectedFamilyMember = getSelectedFamilyMember();
  const patientName = selectedFamilyMember?.name || draft.patientName || state.session?.user?.name || "";
  const mobile = draft.mobile || state.session?.user?.phone || state.profile?.user?.phone || "";
  return `
    <div class="wizard-screen">
      <div class="section-header">
        <div>
          <p class="eyebrow">Step 6</p>
          <h3>Patient information</h3>
          <p>Confirm contact details and visit reason for the hospital desk.</p>
        </div>
      </div>
      <form class="patient-form-grid" data-form="booking-wizard-patient">
        <div class="segmented-control" role="group" aria-label="Patient type">
          <button class="${draft.patientType === "existing" ? "active" : ""}" data-action="wizard-patient-type" data-type="existing" type="button">Existing Patient</button>
          <button class="${draft.patientType === "new" ? "active" : ""}" data-action="wizard-patient-type" data-type="new" type="button">New Patient</button>
        </div>
        <label>Booking for
          <select id="bookingWizardFamilyMember" name="family_member_id">
            ${renderFamilyMemberOptions(draft.familyMemberId)}
          </select>
        </label>
        <label>Patient name
          <input id="bookingWizardPatientName" type="text" value="${escapeHtml(patientName)}" placeholder="Patient full name" ${selectedFamilyMember ? "readonly" : ""} required />
        </label>
        <label>Mobile number
          <input id="bookingWizardMobile" type="tel" value="${escapeHtml(mobile)}" placeholder="10-digit mobile number" required />
        </label>
        <label>Emergency contact
          <input id="bookingWizardEmergencyContact" type="tel" value="${escapeHtml(draft.emergencyContact)}" placeholder="Optional alternate contact" />
        </label>
        <label>Priority
          <select id="bookingWizardPriority">
            <option value="normal" ${draft.priority === "normal" ? "selected" : ""}>Normal priority</option>
            <option value="emergency" ${draft.priority === "emergency" ? "selected" : ""}>Emergency priority</option>
          </select>
        </label>
        <label class="full">Reason for visit
          <textarea id="bookingWizardReason" rows="4" placeholder="Describe symptoms or reason for consultation" required>${escapeHtml(draft.reasonForVisit)}</textarea>
        </label>
        <label class="full">Notes for hospital desk
          <textarea id="bookingWizardNotes" rows="3" placeholder="Optional accessibility needs, reports to carry, or preferred instructions">${escapeHtml(draft.notes)}</textarea>
        </label>
        <p class="form-feedback" id="bookingWizardPatientFeedback" aria-live="polite">${escapeHtml(validateWizardStep(6))}</p>
      </form>
      ${renderWizardNavControls()}
    </div>
  `;
}

function renderWizardReviewStep() {
  const summary = getBookingSummary();
  const validationError = validateWizardStep(7);
  return `
    <div class="wizard-screen">
      <div class="section-header">
        <div>
          <p class="eyebrow">Step 7</p>
          <h3>Review and confirm</h3>
          <p>Check every detail before sending the request to the hospital queue.</p>
        </div>
      </div>
      <article class="review-card">
        <div class="review-card__header">
          <div>
            <p class="eyebrow">Appointment summary</p>
            <h3>${escapeHtml(summary.doctorName)}</h3>
            <p>${escapeHtml(summary.departmentName)} at ${escapeHtml(summary.hospitalName)}</p>
          </div>
          <span class="success-ring"><i class="fa-solid fa-shield-heart"></i></span>
        </div>
        <div class="review-grid">
          ${renderReviewItem("Hospital", summary.hospitalName, "fa-hospital")}
          ${renderReviewItem("Department", summary.departmentName, "fa-stethoscope")}
          ${renderReviewItem("Doctor", summary.doctorName, "fa-user-doctor")}
          ${renderReviewItem("Date", summary.date, "fa-calendar-day")}
          ${renderReviewItem("Time", summary.slotLabel, "fa-clock")}
          ${renderReviewItem("Consultation Fee", summary.fee, "fa-indian-rupee-sign")}
          ${renderReviewItem("Patient", summary.patientName, "fa-id-card")}
          ${renderReviewItem("Booking For", summary.bookingFor, "fa-people-group")}
          ${renderReviewItem("Notes", summary.notes || "No additional notes", "fa-notes-medical")}
          ${renderReviewItem("Total Amount", summary.fee, "fa-receipt")}
        </div>
      </article>
      ${validationError ? `<p class="form-feedback">${escapeHtml(validationError)}</p>` : ""}
      <div class="wizard-actions">
        <button class="ghost-button" data-action="wizard-back" type="button"><i class="fa-solid fa-arrow-left"></i><span>Back</span></button>
        <button class="primary-button" data-action="wizard-confirm-booking" type="button" ${validationError ? "disabled" : ""}>
          <i class="fa-solid fa-calendar-check"></i>
          <span>${Number(getWizardDoctor()?.consultation_fee) > 0 ? `Confirm and pay ${escapeHtml(formatFee(getWizardDoctor().consultation_fee))}` : "Confirm Appointment"}</span>
        </button>
      </div>
    </div>
  `;
}

function renderWizardSidebar() {
  const summary = getBookingSummary();
  return `
    <aside class="booking-sidebar">
      <article class="booking-sidebar-card">
        <p class="eyebrow">Care concierge</p>
        <h3>${escapeHtml(summary.hospitalName || "Select hospital")}</h3>
        <div class="sidebar-timeline">
          ${BOOKING_WIZARD_STEPS.map((step) => `
            <button class="${state.bookingWizard.step === step.id ? "active" : ""}" data-action="wizard-step" data-step="${step.id}" type="button" ${isWizardStepReachable(step.id) ? "" : "disabled"}>
              <i class="fa-solid ${step.icon}"></i>
              <span>${escapeHtml(step.label)}</span>
            </button>
          `).join("")}
        </div>
      </article>
      <article class="booking-sidebar-card">
        <p class="eyebrow">Smart suggestion</p>
        <h3>${escapeHtml(summary.slotLabel || "Earliest available slot appears here")}</h3>
        <p>${escapeHtml(summary.waitEstimate)}</p>
        <div class="chip-row">
          <span class="chip"><i class="fa-solid fa-indian-rupee-sign"></i>${escapeHtml(summary.fee)}</span>
          ${Number(getWizardDoctor()?.consultation_fee) > 0 ? '<span class="chip"><i class="fa-solid fa-hourglass-half"></i>Time is held while you pay</span>' : ""}
        </div>
      </article>
    </aside>
  `;
}

function renderWizardNavControls() {
  const step = Number(state.bookingWizard.step || 1);
  const validationError = validateWizardStep(step);
  return `
    <div class="wizard-actions">
      <button class="ghost-button" data-action="wizard-back" type="button" ${step === 1 ? "disabled" : ""}>
        <i class="fa-solid fa-arrow-left"></i>
        <span>Back</span>
      </button>
      <button class="secondary-button" data-action="wizard-reset" type="button">
        <i class="fa-solid fa-rotate-left"></i>
        <span>Start Over</span>
      </button>
      <button class="primary-button" data-action="wizard-next" type="button" ${validationError ? "disabled" : ""}>
        <span>${step === 6 ? "Review Booking" : "Continue"}</span>
        <i class="fa-solid fa-arrow-right"></i>
      </button>
    </div>
    ${validationError ? `<p class="form-feedback">${escapeHtml(validationError)}</p>` : ""}
  `;
}

function renderReviewItem(label, value, icon) {
  return `
    <div class="review-item">
      <span><i class="fa-solid ${icon}"></i>${escapeHtml(label)}</span>
      <strong>${escapeHtml(value || "Pending")}</strong>
    </div>
  `;
}

function renderWizardSkeletonCards(count = 3) {
  return Array.from({ length: count })
    .map(() => `<div class="wizard-skeleton"><span></span><strong></strong><em></em></div>`)
    .join("");
}

function renderCities() {
  app.innerHTML = `
    <section class="page-grid">
      <div class="section-header">
        <div>
          <p class="eyebrow">City selection</p>
          <h3>Select a city to explore hospitals</h3>
          <p>Choose a city to browse hospitals, doctors, and booking options.</p>
        </div>
      </div>
      <div class="cards-grid">
        ${state.cities.length ? state.cities.map(renderCityCard).join("") : emptyState("No cities found yet. Ask admin to add a city to begin.")}
      </div>
    </section>
  `;
}

function renderCityCard(city) {
  return `
    <article class="card">
      <span class="chip"><i class="fa-solid fa-location-dot"></i>${escapeHtml(city.name)}</span>
      <h3>${escapeHtml(city.name)}</h3>
      <p class="card__meta">${city.hospital_count} hospitals available in this city.</p>
      <div class="card__actions">
        <button class="primary-button" data-action="open-city" data-city-id="${city.id}" data-city-name="${escapeHtml(city.name)}" type="button">
          <i class="fa-solid fa-arrow-right"></i>
          <span>View Hospitals</span>
        </button>
      </div>
    </article>
  `;
}

function renderHospitals(filtered = state.hospitals) {
  app.innerHTML = `
    <section class="page-grid">
      <div class="section-header">
        <div>
          <p class="eyebrow">Hospitals</p>
          <h3>${escapeHtml(state.selectedCity?.name || "Selected city")}</h3>
          <p>Browse hospitals, save directions, and open doctor availability.</p>
        </div>
        <div class="search-row">
          <input id="hospitalSearch" type="search" placeholder="Search hospitals or location" />
        </div>
      </div>
      <div class="cards-grid" id="hospitalGrid">
        ${hospitalCards(filtered)}
      </div>
    </section>
  `;
}

function hospitalCards(hospitals) {
  if (!hospitals.length) return emptyState("No hospitals found for this city. Try another city or ask admin to add one.");

  return hospitals
    .map(
      (hospital) => `
        <article class="card">
          <img class="card__media" src="${hospital.image || placeholderImage("hospital")}" alt="${escapeHtml(hospital.name)}" />
          <div class="chip-row">
            <span class="chip"><i class="fa-solid fa-hospital"></i>${hospital.doctor_count} doctors</span>
            <span class="chip"><i class="fa-solid fa-city"></i>${escapeHtml(hospital.city_name)}</span>
            ${hospital.contact_phone ? `<span class="chip"><i class="fa-solid fa-phone"></i>${escapeHtml(hospital.contact_phone)}</span>` : ""}
          </div>
          <h3>${escapeHtml(hospital.name)}</h3>
          <p class="card__meta"><i class="fa-solid fa-location-dot"></i> ${escapeHtml(hospital.location)}</p>
          <div class="help-strip">
            ${hospital.map_link ? `<a href="${escapeAttribute(hospital.map_link)}" target="_blank" rel="noreferrer">Open hospital map</a>` : "<span>Map link will be added by admin soon.</span>"}
          </div>
          <div class="card__actions">
            <button class="${hospital.is_favorite ? "secondary-button" : "ghost-button"}" data-action="toggle-favorite-hospital" data-hospital-id="${hospital.id}" type="button">
              <i class="fa-${hospital.is_favorite ? "solid" : "regular"} fa-star"></i>
              <span>${hospital.is_favorite ? "Saved hospital" : "Save hospital"}</span>
            </button>
            <button class="primary-button" data-action="open-hospital" data-id="${hospital.id}" type="button">
              <i class="fa-solid fa-user-doctor"></i>
              <span>View Doctors</span>
            </button>
          </div>
        </article>
      `
    )
    .join("");
}

function renderHospitalDetail() {
  if (!state.hospitalDetail) {
    app.innerHTML = emptyState("Hospital details are not available.");
    return;
  }

  const hospital = state.hospitalDetail;
  app.innerHTML = `
    <section class="page-grid">
      <article class="hero-card hospital-hero">
        <div class="detail-hero">
          <div class="detail-hero__copy">
            <p class="eyebrow">${escapeHtml(hospital.city_name || "Hospital")}</p>
            <h3>${escapeHtml(hospital.name)}</h3>
            <p>${escapeHtml(hospital.location || "Address will be updated soon.")}</p>
            <div class="chip-row">
              <span class="chip"><i class="fa-solid fa-hospital"></i>${hospital.doctor_count} doctors</span>
              ${hospital.contact_phone ? `<span class="chip"><i class="fa-solid fa-phone"></i>${escapeHtml(hospital.contact_phone)}</span>` : ""}
            </div>
          </div>
          <img class="detail-hero__media" src="${hospital.image || placeholderImage("hospital")}" alt="${escapeHtml(hospital.name)}" />
        </div>
        <div class="detail-grid">
          <article class="list-card">
            <p class="eyebrow">Address</p>
            <h3>${escapeHtml(hospital.location || "Address unavailable")}</h3>
            <p>${escapeHtml(hospital.city_name || "")}</p>
          </article>
          <article class="list-card">
            <p class="eyebrow">Phone</p>
            <h3>${escapeHtml(hospital.contact_phone || "Not available")}</h3>
            <p>Call the front desk for assistance.</p>
          </article>
          <article class="list-card">
            <p class="eyebrow">Map</p>
            <h3>${hospital.map_link ? "Directions ready" : "Map pending"}</h3>
            <div class="form-actions">
              ${hospital.map_link ? `<a class="primary-button link-button" href="${escapeAttribute(hospital.map_link)}" target="_blank" rel="noreferrer"><i class="fa-solid fa-map-location-dot"></i><span>Open map</span></a>` : "<span class='table-subtext'>Map link will be added soon.</span>"}
            </div>
          </article>
        </div>
      </article>
      <article class="table-card">
        <div class="section-header">
          <div>
            <p class="eyebrow">Doctors list</p>
            <h3>Book directly from this hospital</h3>
            <p>Browse the hospital roster, open doctor profiles, or reserve a slot right here.</p>
          </div>
          <div class="form-actions">
            <button class="secondary-button" type="button" data-action="open-hospital-directory" data-hospital-id="${hospital.id}">
              <i class="fa-solid fa-table-cells-large"></i>
              <span>Directory View</span>
            </button>
          </div>
        </div>
        <div class="cards-grid">
          ${hospital.doctors?.length ? doctorCards(hospital.doctors) : emptyState("No doctors are assigned to this hospital yet.")}
        </div>
      </article>
    </section>
  `;
}

function renderDoctors() {
  const sourceDoctors = shouldUseFilteredDoctorDirectory() ? state.doctorDirectory : state.doctors;
  const displayedDoctors = sourceDoctors;
  const departmentOptions = [
    ...new Map(
      sourceDoctors
        .filter((doctor) => doctor.department_id && doctor.department_name)
        .map((doctor) => [String(doctor.department_id), { id: doctor.department_id, name: doctor.department_name }])
    ).values(),
  ].sort((left, right) => String(left.name).localeCompare(String(right.name)));
  const specializationOptions = [...new Set(sourceDoctors.map((doctor) => doctor.specialization).filter(Boolean))].sort();
  const hospitalOptions = getCurrentHospitalOptions();

  app.innerHTML = `
    <section class="page-grid">
      <div class="section-header">
        <div>
          <p class="eyebrow">Doctors</p>
          <h3>${escapeHtml(state.selectedHospital?.name || "Doctor directory")}</h3>
          <p>Filter by city, hospital, specialization, and available day to find the right doctor faster.</p>
        </div>
      </div>
      <article class="form-card">
        <div class="search-row">
          <input id="doctorSearch" type="search" placeholder="Search doctor or specialization" value="${escapeHtml(state.filters.search)}" />
          <select id="doctorCityFilter" aria-label="Filter doctors by city">
            <option value="">All cities</option>
            ${state.cities.map((city) => `<option value="${city.id}" ${String(state.filters.cityId) === String(city.id) ? "selected" : ""}>${escapeHtml(city.name)}</option>`).join("")}
          </select>
          <select id="doctorHospitalFilter" aria-label="Filter doctors by hospital">
            <option value="">All hospitals</option>
            ${hospitalOptions.map((hospital) => `<option value="${hospital.id}" ${String(state.filters.hospitalId) === String(hospital.id) ? "selected" : ""}>${escapeHtml(hospital.name)}</option>`).join("")}
          </select>
          <select id="doctorDepartmentFilter" aria-label="Filter doctors by department">
            <option value="">All departments</option>
            ${departmentOptions.map((item) => `<option value="${item.id}" ${String(state.filters.departmentId) === String(item.id) ? "selected" : ""}>${escapeHtml(item.name)}</option>`).join("")}
          </select>
          <select id="doctorSpecializationFilter" aria-label="Filter doctors by specialization">
            <option value="">All specializations</option>
            ${specializationOptions.map((item) => `<option value="${escapeHtml(item)}" ${state.filters.specialization === item ? "selected" : ""}>${escapeHtml(item)}</option>`).join("")}
          </select>
          <select id="doctorDayFilter" aria-label="Filter doctors by available day">
            <option value="">Any day</option>
            ${["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"].map((day) => `<option value="${day}" ${state.filters.day === day ? "selected" : ""}>${capitalize(day)}</option>`).join("")}
          </select>
        </div>
      </article>
      <div class="cards-grid" id="doctorGrid">
        ${doctorCards(displayedDoctors)}
      </div>
    </section>
  `;
}

function doctorCards(doctors) {
  if (!doctors.length) {
    return emptyState("No doctors matched your filters. Try changing city, hospital, specialization, or available day.");
  }

  return doctors
    .map(
      (doctor) => `
        <article class="card">
          <img class="card__media" src="${doctor.image || placeholderImage("doctor")}" alt="${escapeHtml(doctor.name)}" />
          <div class="chip-row">
            ${doctor.department_name ? `<span class="chip"><i class="fa-solid fa-building-user"></i>${escapeHtml(doctor.department_name)}</span>` : ""}
            <span class="chip"><i class="fa-solid fa-stethoscope"></i>${escapeHtml(doctor.specialization)}</span>
            <span class="chip"><i class="fa-solid fa-users"></i>${doctor.booked_patients}/${doctor.max_patients_per_day || "?"} booked today</span>
            ${doctor.unavailable_days ? `<span class="chip"><i class="fa-solid fa-calendar-xmark"></i>${escapeHtml(formatUnavailableDays(doctor.unavailable_days))}</span>` : ""}
          </div>
          <h3>${escapeHtml(doctor.name)}</h3>
          <p class="card__meta"><i class="fa-regular fa-clock"></i> ${formatTimeRange(doctor.available_from, doctor.available_to)}</p>
          <p class="card__meta"><i class="fa-solid fa-hospital"></i> ${escapeHtml(doctor.hospital_name)}${doctor.city_name ? ` • ${escapeHtml(doctor.city_name)}` : ""}</p>
          ${doctor.availability_note ? `<p class="card__meta"><i class="fa-solid fa-circle-info"></i> ${escapeHtml(doctor.availability_note)}</p>` : ""}
          ${
            Number(doctor.max_patients_per_day || 0) > 0 &&
            Number(doctor.booked_patients || 0) >= Number(doctor.max_patients_per_day || 0)
              ? `<p class="card__meta"><i class="fa-solid fa-triangle-exclamation"></i> Daily limit reached for this doctor.</p>`
              : ""
          }
          <div class="help-strip">
            <span><i class="fa-solid fa-location-dot"></i> ${escapeHtml(doctor.hospital_location || "Location not available")}</span>
            ${doctor.hospital_contact_phone ? `<span><i class="fa-solid fa-phone"></i> ${escapeHtml(doctor.hospital_contact_phone)}</span>` : ""}
            ${doctor.hospital_map_link ? `<a href="${escapeAttribute(doctor.hospital_map_link)}" target="_blank" rel="noreferrer">Open map</a>` : ""}
          </div>
          <div class="card__actions">
            <button class="${doctor.is_favorite ? "secondary-button" : "ghost-button"}" data-action="toggle-favorite-doctor" data-doctor-id="${doctor.id}" type="button">
              <i class="fa-${doctor.is_favorite ? "solid" : "regular"} fa-star"></i>
              <span>${doctor.is_favorite ? "Saved doctor" : "Save doctor"}</span>
            </button>
            <button class="ghost-button" data-action="open-doctor-detail" data-doctor-id="${doctor.id}" type="button">
              <i class="fa-solid fa-id-badge"></i>
              <span>View Profile</span>
            </button>
            ${
              isStaff()
                ? `<button class="ghost-button" data-action="open-doctor-today" data-doctor-id="${doctor.id}" type="button">
                    <i class="fa-solid fa-clipboard-list"></i>
                    <span>Today's Queue</span>
                  </button>`
                : ""
            }
          </div>
          <form class="form-card compact-form" data-form="book-appointment">
            <input type="hidden" name="doctor_id" value="${doctor.id}" />
            <input type="hidden" name="hospital_id" value="${doctor.hospital_id}" />
            <div class="form-grid">
              <input aria-label="Patient name" name="name" type="text" placeholder="Patient name" value="${escapeHtml(state.session.user.name || "")}" required />
              <input aria-label="Mobile number" name="mobile" type="tel" placeholder="10-digit mobile" required />
              <select aria-label="Book for self or family member" name="family_member_id">
                ${renderFamilyMemberOptions()}
              </select>
              <select aria-label="Visit priority" name="priority">
                <option value="normal" selected>Normal priority</option>
                <option value="emergency">Emergency priority</option>
              </select>
              <input aria-label="Appointment date" name="date" type="date" min="${todayDate()}" required />
              <textarea aria-label="Reason for visit" class="full" name="reason_for_visit" placeholder="Reason for visit" rows="3" required></textarea>
            </div>
            <p class="card__meta"><i class="fa-solid fa-truck-medical"></i> Emergency bookings move ahead in the queue even if the token number is higher.</p>
            <p class="card__meta" data-slot-preview>Next free slot will be assigned automatically after you choose a date.</p>
            <p class="card__meta">Reminder email will be sent to ${escapeHtml(state.session.user.email || "your account")} before the appointment.</p>
            <p class="form-feedback" aria-live="polite"></p>
            <div class="form-actions">
              <button class="primary-button" type="submit">
                <i class="fa-solid fa-calendar-check"></i>
                <span>Book Appointment</span>
              </button>
            </div>
          </form>
        </article>
      `
    )
    .join("");
}

function renderDoctorDetail() {
  if (!state.doctorDetail) {
    app.innerHTML = emptyState("Doctor details are not available.");
    return;
  }

  const doctor = state.doctorDetail;
  app.innerHTML = `
    <section class="page-grid">
      <article class="hero-card doctor-hero">
        <div class="detail-hero">
          <div class="detail-hero__copy">
            <p class="eyebrow">${escapeHtml(doctor.department_name || "Doctor profile")}</p>
            <h3>${escapeHtml(doctor.name)}</h3>
            <p>${escapeHtml(doctor.specialization || "Specialization will be updated soon.")}</p>
            <div class="chip-row">
              <span class="chip"><i class="fa-solid fa-hospital"></i>${escapeHtml(doctor.hospital_name)}</span>
              <span class="chip"><i class="fa-regular fa-clock"></i>${formatTimeRange(doctor.available_from, doctor.available_to)}</span>
              <span class="chip"><i class="fa-solid fa-users"></i>${doctor.booked_patients}/${doctor.max_patients_per_day || "?"} booked today</span>
            </div>
          </div>
          <img class="detail-hero__media" src="${doctor.image || placeholderImage("doctor")}" alt="${escapeHtml(doctor.name)}" />
        </div>
      </article>
      <div class="stat-grid">
        <article class="stat-card"><p class="eyebrow">Specialization</p><strong>${escapeHtml(doctor.specialization || "N/A")}</strong><span>${escapeHtml(doctor.department_name || "Department pending")}</span></article>
        <article class="stat-card"><p class="eyebrow">Schedule</p><strong>${escapeHtml(formatTimeRange(doctor.available_from, doctor.available_to))}</strong><span>${escapeHtml(doctor.unavailable_days ? `Off: ${formatUnavailableDays(doctor.unavailable_days)}` : "Available all week")}</span></article>
        <article class="stat-card"><p class="eyebrow">Total bookings</p><strong>${doctor.total_bookings || 0}</strong><span>${doctor.completed_bookings || 0} completed</span></article>
        <article class="stat-card"><p class="eyebrow">Upcoming queue</p><strong>${doctor.upcoming_bookings || 0}</strong><span>${doctor.cancelled_bookings || 0} cancelled</span></article>
      </div>
      <div class="detail-grid">
        <article class="list-card">
          <p class="eyebrow">Hospital</p>
          <h3>${escapeHtml(doctor.hospital_name)}</h3>
          <p>${escapeHtml(doctor.hospital_location || "Location not available")}</p>
          <div class="help-strip">
            ${doctor.hospital_contact_phone ? `<span><i class="fa-solid fa-phone"></i> ${escapeHtml(doctor.hospital_contact_phone)}</span>` : ""}
            ${doctor.hospital_map_link ? `<a href="${escapeAttribute(doctor.hospital_map_link)}" target="_blank" rel="noreferrer">Open hospital map</a>` : ""}
          </div>
        </article>
        <article class="form-card">
          <p class="eyebrow">Book this doctor</p>
          <h3>Reserve a consultation slot</h3>
          <form class="compact-form" data-form="book-appointment">
            <input type="hidden" name="doctor_id" value="${doctor.id}" />
            <input type="hidden" name="hospital_id" value="${doctor.hospital_id}" />
            <div class="form-grid">
              <input aria-label="Patient name" name="name" type="text" placeholder="Patient name" value="${escapeHtml(state.session?.user?.name || "")}" required />
              <input aria-label="Mobile number" name="mobile" type="tel" placeholder="10-digit mobile" value="${escapeHtml(state.profile?.user?.phone || state.session?.user?.phone || "")}" required />
              <select aria-label="Book for self or family member" name="family_member_id">
                ${renderFamilyMemberOptions()}
              </select>
              <select aria-label="Visit priority" name="priority">
                <option value="normal" selected>Normal priority</option>
                <option value="emergency">Emergency priority</option>
              </select>
              <input aria-label="Appointment date" name="date" type="date" min="${todayDate()}" required />
              <textarea aria-label="Reason for visit" class="full" name="reason_for_visit" placeholder="Reason for visit" rows="3" required></textarea>
            </div>
            <p class="card__meta" data-slot-preview>Next free slot will be assigned automatically after you choose a date.</p>
            <p class="form-feedback" aria-live="polite"></p>
            <div class="form-actions">
              <button class="primary-button" type="submit"><i class="fa-solid fa-calendar-check"></i><span>Book Appointment</span></button>
              <button class="ghost-button" type="button" data-action="open-hospital-detail" data-hospital-id="${doctor.hospital_id}"><i class="fa-solid fa-hospital"></i><span>Hospital Details</span></button>
            </div>
          </form>
        </article>
      </div>
    </section>
  `;
}

async function renderAppointments() {
  await Promise.all([loadMyAppointments(), loadFavorites(), loadFamilyMembers()]);
  app.innerHTML = `
    <section class="page-grid">
      <div class="section-header">
        <div>
          <p class="eyebrow">Appointment history</p>
          <h3>Upcoming and past bookings</h3>
          <p>Reschedule, cancel, print, and review all your bookings from one place.</p>
        </div>
      </div>
      <article class="table-card">
        <div class="section-header">
          <div>
            <p class="eyebrow">Favorites</p>
            <h3>Quick rebooking</h3>
            <p>Save doctors and hospitals you visit often, then jump back into booking faster.</p>
          </div>
        </div>
        ${renderFavoritesSection()}
      </article>
      <article class="table-card">
        <div class="section-header">
          <div>
            <p class="eyebrow">Family booking</p>
            <h3>Manage family members</h3>
            <p>Add relatives once, then book appointments for them without retyping details.</p>
          </div>
        </div>
        <form class="form-card compact-form" data-form="add-family-member">
          <div class="form-grid">
            <input name="name" type="text" placeholder="Family member name" required />
            <input name="relation" type="text" placeholder="Relation" required />
          </div>
          <p class="form-feedback" aria-live="polite"></p>
          <div class="form-actions">
            <button class="primary-button" type="submit"><i class="fa-solid fa-user-plus"></i><span>Add family member</span></button>
          </div>
        </form>
        ${renderFamilyMembersSection()}
      </article>
      <article class="table-card">
        <div class="section-header">
          <div>
            <p class="eyebrow">Upcoming</p>
            <h3>Active bookings</h3>
          </div>
        </div>
        ${appointmentHistoryCards(state.myAppointments.upcoming, true)}
      </article>
      <article class="table-card">
        <div class="section-header">
          <div>
            <p class="eyebrow">Past</p>
            <h3>Completed and cancelled</h3>
          </div>
        </div>
        ${appointmentHistoryCards(state.myAppointments.past, false)}
      </article>
    </section>
  `;
}

async function renderProfile() {
  if (!state.profile) {
    app.innerHTML = emptyState("Profile data is not available.");
    return;
  }

  const profile = state.profile;
  app.innerHTML = `
    <section class="page-grid">
      <div class="stat-grid">
        <article class="stat-card"><p class="eyebrow">Name</p><strong>${escapeHtml(profile.user?.name || state.session?.user?.name || "")}</strong><span>${escapeHtml(profile.user?.email || "")}</span></article>
        <article class="stat-card"><p class="eyebrow">Phone</p><strong>${escapeHtml(profile.user?.phone || "Add your phone")}</strong><span>Used for booking contact</span></article>
        <article class="stat-card"><p class="eyebrow">Upcoming</p><strong>${profile.stats?.upcoming_appointments || 0}</strong><span>${profile.stats?.total_appointments || 0} total appointments</span></article>
        <article class="stat-card"><p class="eyebrow">Completed</p><strong>${profile.stats?.completed_appointments || 0}</strong><span>${profile.stats?.cancelled_appointments || 0} cancelled</span></article>
      </div>
      <article class="form-card">
        <p class="eyebrow">Profile details</p>
        <h3>Update your contact information</h3>
        <form data-form="profile-form">
          <div class="form-grid">
            <input name="name" type="text" value="${escapeHtml(profile.user?.name || "")}" placeholder="Your name" required />
            <input name="phone" type="tel" value="${escapeHtml(profile.user?.phone || "")}" placeholder="Phone number" />
          </div>
          <p class="form-feedback" aria-live="polite"></p>
          <div class="form-actions">
            <button class="primary-button" type="submit"><i class="fa-solid fa-floppy-disk"></i><span>Save Profile</span></button>
          </div>
        </form>
      </article>
      <article class="table-card">
        <div class="section-header">
          <div>
            <p class="eyebrow">Appointment history</p>
            <h3>Upcoming appointments</h3>
          </div>
        </div>
        ${appointmentHistoryCards(state.myAppointments.upcoming, true)}
      </article>
      <article class="table-card">
        <div class="section-header">
          <div>
            <p class="eyebrow">Past visits</p>
            <h3>Completed and cancelled appointments</h3>
          </div>
        </div>
        ${appointmentHistoryCards(state.myAppointments.past, false)}
      </article>
    </section>
  `;
}

function renderNotifications() {
  const items = state.notifications.items || [];
  app.innerHTML = `
    <section class="page-grid">
      <article class="table-card">
        <div class="section-header">
          <div>
            <p class="eyebrow">Notification center</p>
            <h3>Booking updates</h3>
            <p>Track new bookings, cancellations, and reschedules from one place.</p>
          </div>
          <div class="chip-row">
            <span class="chip"><i class="fa-solid fa-bell"></i>${state.notifications.unreadCount || 0} unread</span>
            <button class="secondary-button" type="button" data-action="refresh-notifications"><i class="fa-solid fa-rotate"></i><span>Refresh</span></button>
          </div>
        </div>
        ${
          items.length
            ? `<div class="notification-list">
                ${items
                  .map(
                    (item) => `
                      <article class="list-card notification-card ${item.is_read ? "" : "notification-card--unread"}">
                        <div class="section-header">
                          <div>
                            <p class="eyebrow">${escapeHtml(formatNotificationType(item.type))}</p>
                            <h3>${escapeHtml(item.title)}</h3>
                          </div>
                          ${item.is_read ? '<span class="chip">Read</span>' : '<span class="chip"><i class="fa-solid fa-sparkles"></i>New</span>'}
                        </div>
                        <p>${escapeHtml(item.message)}</p>
                        <p class="card__meta"><i class="fa-regular fa-clock"></i>${escapeHtml(formatDateTime(item.created_at))}</p>
                      </article>
                    `
                  )
                  .join("")}
              </div>`
            : emptyState("No notifications yet. Booking activity will appear here.")
        }
      </article>
    </section>
  `;
}

function appointmentHistoryCards(items, active) {
  if (!items.length) {
    return emptyState(active ? "No upcoming appointments yet. Book a doctor to see your active bookings here." : "No past appointments available yet.");
  }

  return `
    <div class="history-grid">
      ${items
        .map(
          (appointment) => `
            <article class="list-card history-card">
              <div class="section-header">
                <div>
                  <p class="eyebrow">${escapeHtml(appointment.hospital_name)}</p>
                  <h3>${escapeHtml(appointment.doctor_name)}</h3>
                </div>
                ${statusBadge(appointment.status)}
              </div>
              <div class="chip-row">
                ${appointment.department_name ? `<span class="chip"><i class="fa-solid fa-building-user"></i>${escapeHtml(appointment.department_name)}</span>` : ""}
                ${priorityBadge(appointment.priority)}
              </div>
              <p class="card__meta"><i class="fa-solid fa-stethoscope"></i> ${escapeHtml(appointment.specialization || "")}</p>
              <p class="card__meta"><i class="fa-solid fa-calendar-day"></i> ${formatDate(appointment.appointment_date)} • Token ${appointment.token_number}</p>
              <p class="card__meta"><i class="fa-regular fa-clock"></i> ${escapeHtml(formatAppointmentSlot(appointment))}</p>
              ${appointment.reason_for_visit ? `<p class="card__meta"><i class="fa-solid fa-notes-medical"></i> ${escapeHtml(appointment.reason_for_visit)}</p>` : ""}
              ${appointment.visit_notes ? `<p class="card__meta"><i class="fa-solid fa-file-waveform"></i> ${escapeHtml(appointment.visit_notes)}</p>` : ""}
              ${appointment.family_member_name ? `<p class="card__meta"><i class="fa-solid fa-people-group"></i> Booked for ${escapeHtml(appointment.family_member_name)}${appointment.family_relation ? ` • ${escapeHtml(appointment.family_relation)}` : ""}</p>` : ""}
              <p class="card__meta"><i class="fa-solid fa-location-dot"></i> ${escapeHtml(appointment.hospital_location || "")}</p>
              <div class="help-strip">
                ${appointment.hospital_contact_phone ? `<span><i class="fa-solid fa-phone"></i> ${escapeHtml(appointment.hospital_contact_phone)}</span>` : ""}
                ${appointment.hospital_map_link ? `<a href="${escapeAttribute(appointment.hospital_map_link)}" target="_blank" rel="noreferrer">Open map</a>` : ""}
              </div>
              ${renderPaymentActions(appointment)}
              ${
                active && (appointment.status || "").toLowerCase() !== "pending_payment"
                  ? `
                    <form class="form-card compact-form" data-form="reschedule-appointment">
                      <input type="hidden" name="appointment_id" value="${appointment.id}" />
                      <input type="hidden" name="doctor_id" value="${appointment.doctor_id}" />
                      <div class="form-grid">
                        <input aria-label="New appointment date" name="date" type="date" min="${todayDate()}" required />
                      </div>
                      <p class="card__meta" data-slot-preview>Next free slot will be assigned automatically after you choose a new date.</p>
                      <p class="form-feedback" aria-live="polite"></p>
                      <div class="form-actions">
                        <button class="ghost-button" type="submit"><i class="fa-solid fa-calendar-plus"></i><span>Reschedule</span></button>
                        ${
                          canCheckIn(appointment)
                            ? `<button class="secondary-button" type="button" data-action="check-in-appointment" data-appointment-id="${appointment.id}"><i class="fa-solid fa-person-circle-check"></i><span>${(appointment.status || "").toLowerCase() === "checked_in" ? "Checked in" : "I arrived"}</span></button>`
                            : ""
                        }
                        <button class="secondary-button" type="button" data-action="print-slip" data-appointment-id="${appointment.id}"><i class="fa-solid fa-print"></i><span>Print Slip</span></button>
                        <button class="danger-button" type="button" data-action="cancel-appointment" data-appointment-id="${appointment.id}"><i class="fa-solid fa-ban"></i><span>Cancel</span></button>
                      </div>
                    </form>
                  `
                  : (appointment.status || "").toLowerCase() === "pending_payment" ? "" : `
                    <div class="form-actions">
                      <button class="secondary-button" type="button" data-action="print-slip" data-appointment-id="${appointment.id}"><i class="fa-solid fa-print"></i><span>Print Slip</span></button>
                    </div>
                  `
              }
            </article>
          `
        )
        .join("")}
    </div>
  `;
}

function renderFavoritesSection() {
  const favoriteDoctors = state.favorites.doctors || [];
  const favoriteHospitals = state.favorites.hospitals || [];

  if (!favoriteDoctors.length && !favoriteHospitals.length) {
    return emptyState("No favorites saved yet. Tap the star on a doctor or hospital card to build your quick list.");
  }

  return `
    <div class="history-grid">
      ${
        favoriteDoctors.length
          ? favoriteDoctors
              .map(
                (doctor) => `
                  <article class="list-card history-card">
                    <p class="eyebrow">Favorite doctor</p>
                    <h3>${escapeHtml(doctor.name)}</h3>
                    ${doctor.department_name ? `<div class="chip-row"><span class="chip"><i class="fa-solid fa-building-user"></i>${escapeHtml(doctor.department_name)}</span></div>` : ""}
                    <p class="card__meta"><i class="fa-solid fa-stethoscope"></i> ${escapeHtml(doctor.specialization || "")}</p>
                    <p class="card__meta"><i class="fa-solid fa-hospital"></i> ${escapeHtml(doctor.hospital_name)}${doctor.city_name ? ` • ${escapeHtml(doctor.city_name)}` : ""}</p>
                    <div class="form-actions">
                      <button class="primary-button" type="button" data-action="open-favorite-doctor" data-doctor-id="${doctor.id}"><i class="fa-solid fa-bolt"></i><span>Quick rebook</span></button>
                      <button class="ghost-button" type="button" data-action="toggle-favorite-doctor" data-doctor-id="${doctor.id}"><i class="fa-solid fa-star-half-stroke"></i><span>Remove</span></button>
                    </div>
                  </article>
                `
              )
              .join("")
          : ""
      }
      ${
        favoriteHospitals.length
          ? favoriteHospitals
              .map(
                (hospital) => `
                  <article class="list-card history-card">
                    <p class="eyebrow">Favorite hospital</p>
                    <h3>${escapeHtml(hospital.name)}</h3>
                    <p class="card__meta"><i class="fa-solid fa-city"></i> ${escapeHtml(hospital.city_name || "")}</p>
                    <p class="card__meta"><i class="fa-solid fa-location-dot"></i> ${escapeHtml(hospital.location || "")}</p>
                    <div class="form-actions">
                      <button class="primary-button" type="button" data-action="open-favorite-hospital" data-hospital-id="${hospital.id}"><i class="fa-solid fa-arrow-right"></i><span>Open hospital</span></button>
                      <button class="ghost-button" type="button" data-action="toggle-favorite-hospital" data-hospital-id="${hospital.id}"><i class="fa-solid fa-star-half-stroke"></i><span>Remove</span></button>
                    </div>
                  </article>
                `
              )
              .join("")
          : ""
      }
    </div>
  `;
}

function renderFamilyMembersSection() {
  if (!state.familyMembers.length) {
    return emptyState("No family members added yet. Add a parent, spouse, or child for faster booking.");
  }

  return `
    <div class="history-grid">
      ${state.familyMembers
        .map(
          (member) => `
            <article class="list-card history-card">
              <p class="eyebrow">${escapeHtml(member.relation)}</p>
              <h3>${escapeHtml(member.name)}</h3>
              <p class="card__meta"><i class="fa-solid fa-user-group"></i> Ready for family booking</p>
            </article>
          `
        )
        .join("")}
    </div>
  `;
}

async function renderConfirmation() {
  if (!state.latestAppointment) {
    state.route = "booking";
    return render();
  }
  const queue = await loadQueue().catch(() => null);
  const appointment = state.latestAppointment;
  const isHeld = (appointment.status || "").toLowerCase() === "pending_payment";
  app.innerHTML = `
    <section class="page-grid confirmation-premium">
      <article class="confirmation-hero">
        <div class="success-animation" aria-hidden="true">
          <i class="fa-solid ${isHeld ? "fa-hourglass-half" : "fa-check"}"></i>
        </div>
        <div>
          ${
            (appointment.status || "").toLowerCase() === "pending_payment"
              ? `<p class="eyebrow">Payment pending</p>
          <h3>Complete payment to confirm your time</h3>
          <p>Appointment ID PC-${String(appointment.id).padStart(6, "0")} is held${Number(appointment.hold_seconds_left) > 0 ? ` for about ${Math.ceil(appointment.hold_seconds_left / 60)} more minutes` : ", but the hold has expired"}.</p>
          ${renderPaymentActions(appointment)}`
              : `<p class="eyebrow">Booking confirmed</p>
          <h3>Your appointment is reserved</h3>
          <p>Appointment ID PC-${String(appointment.id).padStart(6, "0")} has been sent to ${escapeHtml(state.session.user.email || "your account")}.</p>
          ${renderPaymentActions(appointment)}`
          }
          <div class="form-actions">
            <button class="primary-button" type="button" data-action="print-current-slip"><i class="fa-solid fa-print"></i><span>Print Slip</span></button>
            <button class="secondary-button" type="button" data-action="download-current-slip"><i class="fa-solid fa-download"></i><span>Download Slip</span></button>
            <button class="ghost-button" type="button" data-action="add-current-calendar"><i class="fa-solid fa-calendar-plus"></i><span>Add to Calendar</span></button>
            <button class="ghost-button" type="button" data-action="wizard-book-another"><i class="fa-solid fa-plus"></i><span>Book Another</span></button>
          </div>
        </div>
        <div class="qr-placeholder" aria-label="QR code placeholder">
          <span></span><span></span><span></span><span></span>
          <strong>QR</strong>
        </div>
      </article>
      <div class="stat-grid">
        <article class="stat-card"><p class="eyebrow">Hospital</p><strong>${escapeHtml(appointment.hospital_name)}</strong><span>${escapeHtml(appointment.hospital_location)}</span></article>
        <article class="stat-card"><p class="eyebrow">Doctor</p><strong>${escapeHtml(appointment.doctor_name)}</strong><span>${escapeHtml(appointment.department_name || appointment.specialization || "")}</span></article>
        <article class="stat-card"><p class="eyebrow">Appointment date</p><strong>${formatDate(appointment.appointment_date)}</strong><span>Token ${appointment.token_number}</span></article>
        <article class="stat-card"><p class="eyebrow">Priority</p><strong>${escapeHtml(formatPriorityLabel(appointment.priority))}</strong><span>${escapeHtml(formatAppointmentSlot(appointment))}</span></article>
      </div>
      <article class="queue-card">
        <div class="section-header">
          <div><p class="eyebrow">${isHeld ? "Time held" : "Booking confirmation"}</p><h3>${isHeld ? "Your token is held until payment" : "Your token is reserved"}</h3><p>${appointment.patients_before} patients were ahead when you booked.${normalizePriority(appointment.priority) === "emergency" ? " Emergency priority moves you ahead of normal tokens in the live queue." : ""}</p></div>
          <div class="form-actions">
            <button class="ghost-button" type="button" data-action="refresh-queue"><i class="fa-solid fa-rotate"></i><span>Refresh Queue</span></button>
            <button class="secondary-button" type="button" data-action="print-current-slip"><i class="fa-solid fa-print"></i><span>Print Slip</span></button>
            ${
              canCheckIn(appointment)
                ? `<button class="primary-button" type="button" data-action="check-in-appointment" data-appointment-id="${appointment.id}"><i class="fa-solid fa-person-circle-check"></i><span>${(appointment.status || "").toLowerCase() === "checked_in" ? "Checked in" : "I arrived"}</span></button>`
                : ""
            }
          </div>
        </div>
        <div class="detail-grid">
          <div class="list-card">
            <p class="eyebrow">Patient</p>
            <h3>${escapeHtml(appointment.user_name)}</h3>
            <p>${escapeHtml(appointment.mobile)}</p>
            ${appointment.family_member_name ? `<p class="card__meta"><i class="fa-solid fa-people-group"></i>${escapeHtml(appointment.family_member_name)}${appointment.family_relation ? ` • ${escapeHtml(appointment.family_relation)}` : ""}</p>` : ""}
            ${appointment.reason_for_visit ? `<p class="card__meta"><i class="fa-solid fa-notes-medical"></i> ${escapeHtml(appointment.reason_for_visit)}</p>` : ""}
            ${appointment.visit_notes ? `<p class="card__meta"><i class="fa-solid fa-file-waveform"></i> ${escapeHtml(appointment.visit_notes)}</p>` : ""}
          </div>
          <div class="list-card"><p class="eyebrow">Token number</p><div class="queue-pill">${appointment.token_number}</div><div class="chip-row">${priorityBadge(appointment.priority)}${statusBadge(appointment.status)}</div></div>
          <div class="list-card">
            <p class="eyebrow">Payment</p>
            <h3>${escapeHtml(isHeld ? "Pending" : appointment.payment_status ? formatStatusLabel(appointment.payment_status) : Number(appointment.fee_amount) > 0 ? "Paid" : "No fee due")}</h3>
            <p>${Number(appointment.fee_amount) > 0 ? `Consultation fee ${escapeHtml(formatFee(appointment.fee_amount))}${appointment.receipt_no ? ` - receipt ${escapeHtml(appointment.receipt_no)}` : ""}` : "This consultation is free of charge."}</p>
          </div>
        </div>
      </article>
      <article class="queue-card">
        <p class="eyebrow">Live queue system</p>
        <h3>Track queue progress</h3>
        <div class="queue-grid">
          <div class="list-card"><p class="eyebrow">Current serving token</p><div class="queue-pill">${queue?.currentServingToken ?? "Not started"}</div></div>
          <div class="list-card"><p class="eyebrow">Your token</p><div class="queue-pill">${appointment.token_number}</div></div>
          <div class="list-card"><p class="eyebrow">Remaining patients</p><div class="queue-pill">${queue?.remainingPatients ?? 0}</div></div>
          <div class="list-card"><p class="eyebrow">Estimated wait</p><div class="queue-pill">${estimateWait(queue?.remainingPatients || 0)}</div></div>
        </div>
      </article>
      <article class="queue-card">
        <p class="eyebrow">Help & contact</p>
        <h3>Need directions or support?</h3>
        
        <div class="help-strip large">
          <span><i class="fa-solid fa-location-dot"></i> ${escapeHtml(appointment.hospital_location)}</span>
          ${appointment.hospital_contact_phone ? `<span><i class="fa-solid fa-phone"></i> ${escapeHtml(appointment.hospital_contact_phone)}</span>` : "<span><i class='fa-solid fa-circle-info'></i> Front desk contact will be updated soon.</span>"}
          ${appointment.hospital_map_link ? `<a href="${escapeAttribute(appointment.hospital_map_link)}" target="_blank" rel="noreferrer">Open hospital map</a>` : ""}
        </div>
      </article>
    </section>
  `;
}

function renderAdmin() {
  const stats = state.admin.stats || { total_hospitals: 0, total_doctors: 0, total_appointments: 0, total_cities: 0 };
  app.innerHTML = `
    <section class="page-grid">
      <div class="stat-grid">
        <article class="stat-card"><p class="eyebrow">Hospitals</p><strong>${stats.total_hospitals}</strong></article>
        <article class="stat-card"><p class="eyebrow">Doctors</p><strong>${stats.total_doctors}</strong></article>
        <article class="stat-card"><p class="eyebrow">Appointments</p><strong>${stats.total_appointments}</strong></article>
        <article class="stat-card"><p class="eyebrow">Cities</p><strong>${stats.total_cities}</strong></article>
      </div>
      <div class="admin-grid">
        <div class="admin-stack">
          <article class="form-card">
            <p class="eyebrow">Add city</p><h3>Create a new city option</h3>
            <form data-form="add-city">
              <div class="form-grid">
                <input class="full" name="name" type="text" placeholder="City name" required />
              </div>
              <p class="form-feedback" aria-live="polite"></p>
              <div class="form-actions"><button class="primary-button" type="submit"><i class="fa-solid fa-city"></i><span>Add City</span></button></div>
            </form>
          </article>
          <article class="form-card">
            <p class="eyebrow">Hospital management</p><h3>${state.editingHospitalId ? "Edit hospital" : "Register a new hospital"}</h3>
            <form data-form="hospital-form">
              <div class="form-grid">
                <input name="name" type="text" placeholder="Hospital name" required />
                <select name="city_id" required><option value="">Select city</option>${state.admin.cities.map((city) => `<option value="${city.id}">${escapeHtml(city.name)}</option>`).join("")}</select>
                <input class="full" name="location" type="text" placeholder="Location" required />
                <input class="full" name="image" type="url" placeholder="Image URL" />
                <input name="contact_phone" type="tel" placeholder="Contact phone" />
                <input name="map_link" type="url" placeholder="Google Maps link" />
              </div>
              <p class="form-feedback" aria-live="polite"></p>
              <div class="form-actions">
                <button class="primary-button" type="submit"><i class="fa-solid ${state.editingHospitalId ? "fa-pen" : "fa-plus"}"></i><span>${state.editingHospitalId ? "Update Hospital" : "Add Hospital"}</span></button>
                ${state.editingHospitalId ? '<button class="ghost-button" type="button" data-action="cancel-hospital-edit">Cancel Edit</button>' : ""}
              </div>
            </form>
          </article>
          <article class="form-card">
            <p class="eyebrow">Add doctor</p><h3>${state.editingDoctorId ? "Edit doctor profile" : "Create doctor profile"}</h3>
            <form data-form="doctor-form">
              <div class="form-grid">
                <input name="name" type="text" placeholder="Doctor name" required />
                <input name="specialization" type="text" placeholder="Specialization" required />
                <select name="department_id" required><option value="">Select department</option>${state.admin.departments.map((department) => `<option value="${department.id}">${escapeHtml(department.name)}</option>`).join("")}</select>
                <select name="hospital_id" required><option value="">Select hospital</option>${state.admin.hospitals.map((hospital) => `<option value="${hospital.id}">${escapeHtml(hospital.name)} • ${escapeHtml(hospital.city_name)}</option>`).join("")}</select>
                <input name="image" type="url" placeholder="Image URL" />
                <input name="max_patients_per_day" type="number" min="1" placeholder="Max patients per day" required />
                <select name="available_from" required><option value="">Start time</option>${renderTimeOptions()}</select>
                <select name="available_to" required><option value="">End time</option>${renderTimeOptions()}</select>
                <select class="full" name="unavailable_days" multiple size="4">${renderDayOptions()}</select>
                <input class="full" name="availability_note" type="text" placeholder="Holiday note, weekly off, or no doctor available message" />
              </div>
              <p class="card__meta">All doctors now use a fixed token schedule: token 1 starts at 10:00 AM and every token lasts 15 minutes. Hold Ctrl/Cmd to select weekly off-days.</p>
              <p class="form-feedback" aria-live="polite"></p>
              <div class="form-actions">
                <button class="primary-button" type="submit"><i class="fa-solid ${state.editingDoctorId ? "fa-pen" : "fa-plus"}"></i><span>${state.editingDoctorId ? "Update Doctor" : "Add Doctor"}</span></button>
                ${state.editingDoctorId ? '<button class="ghost-button" type="button" data-action="cancel-edit">Cancel Edit</button>' : ""}
              </div>
            </form>
          </article>
          <article class="form-card">
            <p class="eyebrow">Doctor leave system</p><h3>Block leave dates from booking</h3>
            <form data-form="doctor-leave-form">
              <div class="form-grid">
                <select name="doctor_id" required>
                  <option value="">Select doctor</option>
                  ${state.admin.doctors.map((doctor) => `<option value="${doctor.id}">${escapeHtml(doctor.name)} • ${escapeHtml(doctor.hospital_name)}</option>`).join("")}
                </select>
                <input name="leave_date" type="date" min="${todayDate()}" required />
                <input class="full" name="reason" type="text" placeholder="Reason for leave" />
              </div>
              <p class="form-feedback" aria-live="polite"></p>
              <div class="form-actions"><button class="primary-button" type="submit"><i class="fa-solid fa-calendar-xmark"></i><span>Save Leave</span></button></div>
            </form>
          </article>
        </div>
        <div class="admin-stack">
          <article class="chart-card">
            <p class="eyebrow">Bookings per day</p><h3>Last 14 days</h3>
            <div class="chart-canvas-wrap"><canvas id="bookingsPerDayChart"></canvas></div>
          </article>
          <article class="chart-card">
            <p class="eyebrow">Top doctors</p><h3>Most booked doctors</h3>
            <div class="chart-canvas-wrap"><canvas id="topDoctorsChart"></canvas></div>
          </article>
          <article class="chart-card">
            <p class="eyebrow">Top hospitals</p><h3>Most booked hospitals</h3>
            <div class="chart-canvas-wrap"><canvas id="topHospitalsChart"></canvas></div>
          </article>
        </div>
      </div>
      <article class="table-card">
        <div class="section-header"><div><p class="eyebrow">Manage hospitals</p><h3>Hospital directory</h3></div></div>
        ${hospitalsTable()}
      </article>
      <article class="table-card">
        <div class="section-header"><div><p class="eyebrow">Manage doctors</p><h3>Doctor roster</h3></div></div>
        ${doctorsTable()}
      </article>
      <article class="table-card">
        <div class="section-header"><div><p class="eyebrow">Appointments</p><h3>Visible appointment table</h3><p>Track department, priority, reason for visit, and post-visit notes in one place.</p></div></div>
        ${appointmentsTable()}
      </article>
      <article class="table-card">
        <div class="section-header"><div><p class="eyebrow">Doctor leaves</p><h3>Upcoming leave records</h3><p>These dates are blocked for patient booking and rescheduling.</p></div></div>
        ${doctorLeavesTable()}
      </article>
    </section>
  `;
  destroyAdminCharts();
  renderAdminCharts();
  if (state.editingHospitalId) fillHospitalForm();
  if (state.editingDoctorId) fillDoctorForm();
}

function renderAdminBoard() {
  app.innerHTML = `
    <section class="page-grid">
      <div class="section-header">
        <div>
          <p class="eyebrow">Today's appointment board</p>
          <h3>Reception queue by doctor</h3>
          <p>Live grouped view of today's tokens, patients, and statuses.</p>
        </div>
      </div>
      <div class="cards-grid">
        ${state.admin.board.length ? state.admin.board.map(renderBoardCard).join("") : emptyState("No doctors or appointments available for today.")}
      </div>
    </section>
  `;
}

function renderBoardCard(doctor) {
  return `
    <article class="card board-card">
      <div class="section-header">
        <div>
          <p class="eyebrow">${escapeHtml(doctor.hospital_name)}</p>
          <h3>${escapeHtml(doctor.doctor_name)}</h3>
          <p>${escapeHtml(doctor.department_name || doctor.specialization || "")}</p>
        </div>
        <div class="queue-pill">${doctor.now_serving ?? "No queue"}</div>
      </div>
      <p class="card__meta"><strong>Now Serving:</strong> ${doctor.now_serving ?? "Not started"}</p>
      ${doctor.appointments.length ? `
        <table class="compact-table">
          <thead><tr><th>Token</th><th>Patient</th><th>Priority</th><th>Status</th></tr></thead>
          <tbody>
            ${doctor.appointments.map((item) => `
              <tr>
                <td>${item.token_number}</td>
                <td>${escapeHtml(item.user_name)}${item.reason_for_visit ? `<br><span class="table-subtext">${escapeHtml(item.reason_for_visit)}</span>` : ""}</td>
                <td>${priorityBadge(item.priority)}</td>
                <td>${statusBadge(item.status)}</td>
              </tr>
            `).join("")}
          </tbody>
        </table>
      ` : emptyState("No appointments booked for this doctor today.")}
    </article>
  `;
}

function renderDoctorToday() {
  if (!state.doctorDaily) {
    app.innerHTML = emptyState("Doctor daily list is not available.");
    return;
  }

  app.innerHTML = `
    <section class="page-grid">
      <div class="section-header">
        <div>
          <p class="eyebrow">${escapeHtml(state.doctorDaily.hospital_name)}</p>
          <h3>${escapeHtml(state.doctorDaily.doctor_name)}</h3>
          <p>${escapeHtml(state.doctorDaily.department_name || state.doctorDaily.specialization || "")}</p>
        </div>
        <div class="queue-pill">${state.doctorDaily.now_serving ?? "No queue"}</div>
      </div>
      <article class="table-card">
        <div class="section-header">
          <div>
            <p class="eyebrow">Today's patients</p>
            <h3>Emergency-first queue</h3>
            <p>Quick OPD workflow for this doctor.</p>
          </div>
        </div>
        ${doctorTodayTable()}
      </article>
    </section>
  `;
}

function destroyAdminCharts() {
  adminCharts.forEach((chart) => chart.destroy());
  adminCharts = [];
}

function renderAdminCharts() {
  if (typeof Chart === "undefined") return;

  const chartConfigs = [
    {
      id: "bookingsPerDayChart",
      type: "line",
      data: state.admin.charts.bookingsPerDay || [],
      datasetLabel: "Bookings",
      borderColor: "#f97316",
      backgroundColor: "rgba(249, 115, 22, 0.18)",
    },
    {
      id: "topDoctorsChart",
      type: "bar",
      data: state.admin.charts.topDoctors || [],
      datasetLabel: "Bookings",
      borderColor: "#14b8a6",
      backgroundColor: "rgba(20, 184, 166, 0.35)",
    },
    {
      id: "topHospitalsChart",
      type: "bar",
      data: state.admin.charts.topHospitals || [],
      datasetLabel: "Bookings",
      borderColor: "#3b82f6",
      backgroundColor: "rgba(59, 130, 246, 0.35)",
    },
  ];

  chartConfigs.forEach((config) => {
    const canvas = document.getElementById(config.id);
    if (!canvas || !config.data.length) return;

    adminCharts.push(
      new Chart(canvas, {
        type: config.type,
        data: {
          labels: config.data.map((item) => item.label),
          datasets: [
            {
              label: config.datasetLabel,
              data: config.data.map((item) => item.value),
              borderColor: config.borderColor,
              backgroundColor: config.backgroundColor,
              fill: config.type === "line",
              tension: 0.3,
              borderWidth: 2,
            },
          ],
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          plugins: {
            legend: { display: false },
          },
          scales: {
            y: {
              beginAtZero: true,
              ticks: { precision: 0 },
            },
          },
        },
      })
    );
  });
}

function hospitalsTable() {
  if (!state.admin.hospitals.length) return emptyState("No hospitals available.");
  return `
    <table>
      <thead><tr><th>Name</th><th>City</th><th>Location</th><th>Doctors</th><th>Action</th></tr></thead>
      <tbody>
        ${state.admin.hospitals
          .map(
            (hospital) => `
              <tr>
                <td>${escapeHtml(hospital.name)}</td>
                <td>${escapeHtml(hospital.city_name)}</td>
                <td>${escapeHtml(hospital.location)}${hospital.contact_phone ? `<br><span class="table-subtext">${escapeHtml(hospital.contact_phone)}</span>` : ""}</td>
                <td>${hospital.doctor_count}</td>
                <td class="table-actions">
                  <button class="ghost-button" data-action="edit-hospital" data-id="${hospital.id}" type="button">Edit</button>
                  <button class="danger-button" data-action="delete-hospital" data-id="${hospital.id}" type="button">Delete</button>
                </td>
              </tr>
            `
          )
          .join("")}
      </tbody>
    </table>
  `;
}

function doctorLeavesTable() {
  if (!state.admin.doctorLeaves.length) {
    return emptyState("No doctor leave records available.");
  }

  return `
    <table>
      <thead><tr><th>Date</th><th>Doctor</th><th>Hospital</th><th>Reason</th><th>Action</th></tr></thead>
      <tbody>
        ${state.admin.doctorLeaves
          .map(
            (leave) => `
              <tr>
                <td>${formatDate(leave.leave_date)}</td>
                <td>${escapeHtml(leave.doctor_name)}${leave.specialization ? `<br><span class="table-subtext">${escapeHtml(leave.specialization)}</span>` : ""}</td>
                <td>${escapeHtml(leave.hospital_name)}</td>
                <td>${escapeHtml(leave.reason || "Doctor unavailable")}</td>
                <td class="table-actions">
                  <button class="danger-button" data-action="delete-doctor-leave" data-id="${leave.id}" type="button">Delete</button>
                </td>
              </tr>
            `
          )
          .join("")}
      </tbody>
    </table>
  `;
}

function doctorsTable() {
  if (!state.admin.doctors.length) return emptyState("No doctors available.");
  return `
    <table>
      <thead><tr><th>Name</th><th>Department</th><th>Hospital</th><th>Time</th><th>Capacity</th><th>Availability</th><th>Action</th></tr></thead>
      <tbody>
        ${state.admin.doctors
          .map(
            (doctor) => `
              <tr>
                <td>${escapeHtml(doctor.name)}</td>
                <td>${escapeHtml(doctor.department_name || "Unassigned")}<br><span class="table-subtext">${escapeHtml(doctor.specialization)}</span></td>
                <td>${escapeHtml(doctor.hospital_name)}</td>
                <td>${formatTimeRange(doctor.available_from, doctor.available_to)}</td>
                <td>${escapeHtml(String(doctor.max_patients_per_day || ""))} / day</td>
                <td>${escapeHtml(formatAvailabilitySummary(doctor))}</td>
                <td class="table-actions">
                  <button class="ghost-button" data-action="edit-doctor" data-id="${doctor.id}" type="button">Edit</button>
                  <button class="danger-button" data-action="delete-doctor" data-id="${doctor.id}" type="button">Delete</button>
                </td>
              </tr>
            `
          )
          .join("")}
      </tbody>
    </table>
  `;
}

function appointmentsTable() {
  const filteredAppointments = getFilteredAdminAppointments();
  const hospitals = state.admin.hospitals;
  const doctors = state.admin.doctors;

  return `
    <div class="search-row table-toolbar">
      <input id="adminAppointmentDateFilter" type="date" value="${escapeHtml(state.admin.appointmentFilters.date)}" />
      <select id="adminAppointmentHospitalFilter">
        <option value="">All hospitals</option>
        ${hospitals.map((item) => `<option value="${item.id}" ${String(state.admin.appointmentFilters.hospital) === String(item.id) ? "selected" : ""}>${escapeHtml(item.name)}</option>`).join("")}
      </select>
      <select id="adminAppointmentDoctorFilter">
        <option value="">All doctors</option>
        ${doctors.map((item) => `<option value="${item.id}" ${String(state.admin.appointmentFilters.doctor) === String(item.id) ? "selected" : ""}>${escapeHtml(item.name)}</option>`).join("")}
      </select>
      <select id="adminAppointmentPriorityFilter">
        <option value="">All priorities</option>
        ${["normal", "emergency"].map((item) => `<option value="${item}" ${state.admin.appointmentFilters.priority === item ? "selected" : ""}>${formatPriorityLabel(item)}</option>`).join("")}
      </select>
      <select id="adminAppointmentStatusFilter">
        <option value="">All statuses</option>
        ${["booked", "pending", "checked_in", "serving", "completed", "skipped", "cancelled"].map((item) => `<option value="${item}" ${state.admin.appointmentFilters.status === item ? "selected" : ""}>${capitalize(item)}</option>`).join("")}
      </select>
      <button class="secondary-button" type="button" data-action="export-appointments">Export CSV</button>
    </div>
    ${
      filteredAppointments.length
        ? `
          <table>
            <thead><tr><th>Patient</th><th>Hospital</th><th>Doctor</th><th>Date</th><th>Queue</th><th>Status</th><th>Visit Notes</th><th>Queue Control</th><th>Doctor View</th></tr></thead>
            <tbody>
              ${filteredAppointments
                .map(
                  (appointment) => `
                    <tr>
                      <td>
                        ${escapeHtml(appointment.user_name)}
                        <br><span class="table-subtext">${escapeHtml(appointment.mobile)}</span>
                        ${appointment.reason_for_visit ? `<br><span class="table-subtext">${escapeHtml(appointment.reason_for_visit)}</span>` : ""}
                      </td>
                      <td>${escapeHtml(appointment.hospital_name)}<br><span class="table-subtext">${escapeHtml(appointment.city_name)}</span></td>
                      <td>${escapeHtml(appointment.doctor_name)}<br><span class="table-subtext">${escapeHtml(appointment.department_name || appointment.specialization || "")}</span></td>
                      <td>${formatDate(appointment.appointment_date)}</td>
                      <td>
                        <strong>Token ${appointment.token_number}</strong>
                        <br>${priorityBadge(appointment.priority)}
                      </td>
                      <td>${statusBadge(appointment.status)}</td>
                      <td>${renderVisitNotesForm(appointment)}</td>
                      <td class="table-actions">
                        ${renderStatusActionButton(appointment, "serving", "Serving")}
                        ${renderStatusActionButton(appointment, "completed", "Complete")}
                        ${renderStatusActionButton(appointment, "skipped", "Skip")}
                        ${renderStatusActionButton(appointment, "booked", "Reset")}
                      </td>
                      <td class="table-actions">
                        <button class="ghost-button" data-action="open-doctor-today" data-doctor-id="${appointment.doctor_id}" type="button">Today's List</button>
                      </td>
                    </tr>
                  `
                )
                .join("")}
            </tbody>
          </table>
        `
        : emptyState("No appointments available for the selected filters.")
    }
  `;
}

function doctorTodayTable() {
  if (!state.doctorDaily?.appointments?.length) {
    return emptyState("No patients are scheduled for this doctor today.");
  }

  return `
    <table>
      <thead><tr><th>Token</th><th>Patient</th><th>Priority</th><th>Status</th><th>Visit Notes</th><th>Action</th></tr></thead>
      <tbody>
        ${state.doctorDaily.appointments.map((item) => `
          <tr>
            <td>${item.token_number}</td>
            <td>${escapeHtml(item.user_name)}<br><span class="table-subtext">${escapeHtml(item.mobile || "")}</span>${item.reason_for_visit ? `<br><span class="table-subtext">${escapeHtml(item.reason_for_visit)}</span>` : ""}</td>
            <td>${priorityBadge(item.priority)}</td>
            <td>${statusBadge(item.status)}</td>
            <td>${renderVisitNotesForm(item)}</td>
            <td class="table-actions">
              ${
                isAdmin()
                  ? `
                    ${renderStatusActionButton(item, "serving", "Serving")}
                    ${renderStatusActionButton(item, "completed", "Complete")}
                    ${renderStatusActionButton(item, "skipped", "Skip")}
                  `
                  : '<span class="table-subtext">Admin queue controls only</span>'
              }
            </td>
          </tr>
        `).join("")}
      </tbody>
    </table>
  `;
}

function renderFamilyMemberOptions(selected = "") {
  return [
    `<option value="" ${selected ? "" : "selected"}>Book for myself</option>`,
    ...state.familyMembers.map(
      (member) =>
        `<option value="${member.id}" ${String(selected) === String(member.id) ? "selected" : ""}>${escapeHtml(member.name)} • ${escapeHtml(member.relation)}</option>`
    ),
  ].join("");
}

function renderStatusActionButton(appointment, status, label) {
  return `
    <button
      class="${(appointment.status || "").toLowerCase() === status ? "primary-button" : "ghost-button"}"
      data-action="update-appointment-status"
      data-appointment-id="${appointment.appointment_id || appointment.id}"
      data-status="${status}"
      type="button"
    >
      ${label}
    </button>
  `;
}

function renderVisitNotesForm(appointment) {
  const notes = escapeHtml(appointment.visit_notes || "");
  if (!isStaff()) {
    return notes || "<span class='table-subtext'>No notes</span>";
  }

  return `
    <form class="compact-form" data-form="visit-notes-form">
      <input type="hidden" name="appointment_id" value="${appointment.appointment_id || appointment.id}" />
      <textarea name="visit_notes" rows="3" placeholder="Add visit notes">${notes}</textarea>
      <div class="form-actions">
        <button class="ghost-button" type="submit">Save Notes</button>
      </div>
      <p class="form-feedback" aria-live="polite"></p>
    </form>
  `;
}

async function handleClick(event) {
  const routeTarget = event.target.closest("[data-route]");
  const actionTarget = event.target.closest("[data-action]");

  if (routeTarget) {
    closeMobileMenu();
    state.route = routeTarget.dataset.route;
    if (state.route === "admin") await loadAdminData();
    if (state.route === "admin-board") await Promise.all([loadAdminBoard(), loadAdminData()]);
    if (state.route === "appointments") await loadMyAppointments();
    if (state.route === "booking") {
      await loadBookingWizardData();
    }
    if (state.route === "profile") await Promise.all([loadProfile(), loadMyAppointments()]);
    if (state.route === "notifications") await loadNotifications({ markRead: true });
    if (state.route === "confirmation" && state.latestAppointment?.id) {
      await loadAppointmentDetails(state.latestAppointment.id);
      history.replaceState({}, "", `/?appointment=${state.latestAppointment.id}`);
    } else if (state.route === "profile") {
      history.replaceState({}, "", "/profile");
    } else if (state.route === "notifications") {
      history.replaceState({}, "", "/notifications");
    } else if (state.route === "admin") {
      history.replaceState({}, "", "/admin");
    } else if (state.route === "admin-board") {
      history.replaceState({}, "", "/admin/board");
    } else if (state.route === "booking") {
      history.replaceState({}, "", "/dashboard");
    } else if (!["doctor-today", "doctor-detail", "hospital-detail"].includes(state.route)) {
      history.replaceState({}, "", "/");
    }
    if (state.route === "hospitals" && state.selectedCity?.id && !state.hospitals.length) {
      await loadHospitals(state.selectedCity.id);
    }
    if (state.route === "doctors") {
      if (state.selectedCity && !state.hospitals.length) {
        await loadHospitals(state.selectedCity.id);
      }
      if (state.selectedHospital) {
        state.filters.hospitalId = String(state.selectedHospital.id);
        state.filters.cityId = String(state.selectedHospital.city_id || state.selectedCity?.id || "");
      }
      await loadDoctorDirectory();
    }
    render();
    return;
  }

  if (!actionTarget) return;
  const action = actionTarget.dataset.action;

  if (action === "wizard-step") {
    const step = Number(actionTarget.dataset.step);
    if (!isWizardStepReachable(step)) return;
    updateBookingDraft({ step });
    render();
    return;
  }

  if (action === "wizard-next") {
    const error = validateWizardStep(state.bookingWizard.step);
    if (error) {
      showToast(error, "error");
      return;
    }
    updateBookingDraft({ step: Math.min(Number(state.bookingWizard.step || 1) + 1, BOOKING_WIZARD_STEPS.length) });
    render();
    return;
  }

  if (action === "wizard-back") {
    updateBookingDraft({ step: Math.max(Number(state.bookingWizard.step || 1) - 1, 1) });
    render();
    return;
  }

  if (action === "wizard-reset") {
    state.bookingWizard = createDefaultBookingDraft();
    persistBookingDraft();
    render();
    showToast("Booking draft cleared.");
    return;
  }

  if (action === "wizard-select-city") {
    const cityId = actionTarget.dataset.cityId;
    const city = state.cities.find((item) => String(item.id) === String(cityId));
    updateBookingDraft({
      cityId,
      hospitalId: "",
      departmentId: "",
      doctorId: "",
      date: "",
      selectedSlotNumber: "",
      expectedSlot: null,
      step: 2,
    });
    state.selectedCity = city ? { id: Number(city.id), name: city.name } : null;
    state.hospitals = [];
    await loadHospitals(cityId);
    render();
    return;
  }

  if (action === "wizard-select-hospital") {
    const hospitalId = actionTarget.dataset.hospitalId;
    const hospital = state.hospitals.find((item) => String(item.id) === String(hospitalId));
    updateBookingDraft({
      hospitalId,
      departmentId: "",
      doctorId: "",
      date: "",
      selectedSlotNumber: "",
      expectedSlot: null,
      step: 3,
    });
    state.selectedHospital = hospital || state.selectedHospital;
    await loadHospitalDetail(hospitalId);
    await loadWizardDoctorDirectory();
    render();
    return;
  }

  if (action === "wizard-select-department") {
    updateBookingDraft({
      departmentId: actionTarget.dataset.departmentId,
      doctorId: "",
      date: "",
      selectedSlotNumber: "",
      expectedSlot: null,
      step: 4,
    });
    render();
    return;
  }

  if (action === "wizard-select-doctor") {
    updateBookingDraft({
      doctorId: actionTarget.dataset.doctorId,
      date: "",
      selectedSlotNumber: "",
      expectedSlot: null,
      step: 5,
    });
    render();
    return;
  }

  if (action === "wizard-select-date") {
    await loadWizardSlots(actionTarget.dataset.date);
    render();
    return;
  }

  if (action === "wizard-select-slot") {
    const slotResponse = getWizardSlotResponse();
    const slot = slotResponse?.slots?.find((item) => String(item.slotNumber) === String(actionTarget.dataset.slotNumber));
    if (!slot?.isAvailable) return;
    updateBookingDraft({
      selectedSlotNumber: actionTarget.dataset.slotNumber,
      expectedSlot: slot || slotResponse?.nextSlot || null,
    });
    render();
    return;
  }

  if (action === "wizard-patient-type") {
    updateBookingDraft({ patientType: actionTarget.dataset.type });
    render();
    return;
  }

  if (action === "wizard-confirm-booking") {
    await confirmWizardBooking();
    return;
  }

  if (action === "wizard-book-another") {
    state.bookingWizard = createDefaultBookingDraft();
    persistBookingDraft();
    state.route = "booking";
    history.replaceState({}, "", "/dashboard");
    render();
    return;
  }

  if (action === "download-current-slip") {
    downloadAppointmentSlip(state.latestAppointment);
    return;
  }

  if (action === "add-current-calendar") {
    downloadAppointmentCalendar(state.latestAppointment);
    return;
  }

  if (action === "open-profile") {
    await openProfilePage();
    return;
  }

  if (action === "open-city") {
    state.selectedCity = { id: Number(actionTarget.dataset.cityId), name: actionTarget.dataset.cityName };
    state.filters.cityId = String(state.selectedCity.id);
    state.filters.hospitalId = "";
    await loadHospitals(state.selectedCity.id);
    state.route = "hospitals";
    closeMobileMenu();
    render();
  }

  if (action === "open-hospital") {
    await openHospitalDetailPage(actionTarget.dataset.id);
    return;
  }

  if (action === "open-hospital-detail") {
    await openHospitalDetailPage(actionTarget.dataset.hospitalId);
    return;
  }

  if (action === "open-hospital-directory") {
    const hospitalId = Number(actionTarget.dataset.hospitalId);
    state.selectedHospital =
      state.hospitals.find((item) => item.id === hospitalId) ||
      state.hospitalDetail ||
      state.selectedHospital;
    state.filters.cityId = String(state.selectedHospital?.city_id || state.selectedCity?.id || "");
    state.filters.hospitalId = String(hospitalId || "");
    await loadDoctors(hospitalId);
    await loadDoctorDirectory();
    state.route = "doctors";
    history.replaceState({}, "", "/");
    closeMobileMenu();
    render();
  }

  if (action === "refresh-queue") {
    await renderConfirmation();
  }

  if (action === "print-current-slip") {
    printAppointmentSlip(state.latestAppointment);
  }

  if (action === "print-slip") {
    const appointmentId = Number(actionTarget.dataset.appointmentId);
    const allAppointments = [...state.myAppointments.upcoming, ...state.myAppointments.past];
    printAppointmentSlip(allAppointments.find((item) => item.id === appointmentId));
  }

  if (action === "pay-appointment") {
    await payForAppointment(actionTarget.dataset.appointmentId);
    return;
  }

  if (action === "cancel-appointment") {
    const cancelResult = await apiFetch(`/appointment/${actionTarget.dataset.appointmentId}/cancel`, { method: "POST" });
    await loadMyAppointments();
    await loadNotifications();
    if (state.latestAppointment?.id === Number(actionTarget.dataset.appointmentId)) {
      await loadAppointmentDetails(actionTarget.dataset.appointmentId);
    }
    render();
    const refund = cancelResult?.refund;
    showToast(
      refund?.status === "processed" ? `Appointment cancelled. Refund of ${formatFee(refund.amount)} initiated.`
      : refund?.status === "pending" ? "Appointment cancelled. Your refund is being processed."
      : refund?.status === "not_eligible" ? "Appointment cancelled. This was inside the no-refund window."
      : "Appointment cancelled"
    );
  }

  if (action === "delete-hospital") {
    await apiFetch(`/admin/delete-hospital/${actionTarget.dataset.id}`, { method: "POST" });
    if (state.editingHospitalId === Number(actionTarget.dataset.id)) {
      state.editingHospitalId = null;
    }
    await loadAdminData();
    render();
    showToast("Hospital deleted");
  }

  if (action === "delete-doctor") {
    await apiFetch(`/admin/delete-doctor/${actionTarget.dataset.id}`, { method: "POST" });
    await loadAdminData();
    render();
    showToast("Doctor deleted");
  }

  if (action === "edit-doctor") {
    state.editingDoctorId = Number(actionTarget.dataset.id);
    render();
  }

  if (action === "edit-hospital") {
    state.editingHospitalId = Number(actionTarget.dataset.id);
    render();
  }

  if (action === "cancel-edit") {
    state.editingDoctorId = null;
    render();
  }

  if (action === "cancel-hospital-edit") {
    state.editingHospitalId = null;
    render();
  }

  if (action === "toggle-favorite-hospital") {
    await apiFetch(`/favorites/hospitals/${actionTarget.dataset.hospitalId}`, { method: "POST" });
    await loadFavorites();
    if (state.selectedCity?.id) {
      await loadHospitals(state.selectedCity.id);
    }
    render();
    showToast("Hospital favorites updated.");
  }

  if (action === "toggle-favorite-doctor") {
    await apiFetch(`/favorites/doctors/${actionTarget.dataset.doctorId}`, { method: "POST" });
    await loadFavorites();
    if (state.selectedHospital?.id) {
      await loadDoctors(state.selectedHospital.id);
    }
    await loadDoctorDirectory();
    render();
    showToast("Doctor favorites updated.");
  }

  if (action === "open-favorite-hospital") {
    const hospital = state.favorites.hospitals.find((item) => String(item.id) === String(actionTarget.dataset.hospitalId));
    if (!hospital) return;
    state.selectedCity = { id: Number(hospital.city_id), name: hospital.city_name };
    state.filters.cityId = String(hospital.city_id);
    await loadHospitals(hospital.city_id);
    await openHospitalDetailPage(hospital.id);
    return;
  }

  if (action === "open-favorite-doctor") {
    const doctor = state.favorites.doctors.find((item) => String(item.id) === String(actionTarget.dataset.doctorId));
    if (!doctor) return;
    await openDoctorDetailPage(doctor.id);
    return;
  }

  if (action === "update-appointment-status") {
    const appointmentId = actionTarget.dataset.appointmentId;
    const nextStatus = actionTarget.dataset.status;
    await apiFetch(`/admin/appointment/${appointmentId}/status`, {
      method: "POST",
      body: JSON.stringify({ status: nextStatus }),
    });
    await loadAdminData();
    if (state.route === "admin-board") {
      await loadAdminBoard();
    }
    if (state.route === "doctor-today" && state.doctorDaily?.doctor_id) {
      await loadDoctorToday(state.doctorDaily.doctor_id);
    }
    if (state.route === "confirmation" && state.latestAppointment?.id === Number(appointmentId)) {
      await loadAppointmentDetails(appointmentId);
    }
    render();
    showToast(`Appointment marked as ${nextStatus}.`);
  }

  if (action === "open-doctor-today") {
    const doctorId = actionTarget.dataset.doctorId;
    await loadDoctorToday(doctorId);
    state.route = "doctor-today";
    history.replaceState({}, "", `/doctor/${doctorId}/today`);
    closeMobileMenu();
    render();
  }

  if (action === "open-doctor-detail") {
    await openDoctorDetailPage(actionTarget.dataset.doctorId);
    return;
  }

  if (action === "export-appointments") {
    downloadAdminAppointmentsCsv();
    showToast("Appointment report downloaded.");
  }

  if (action === "refresh-notifications") {
    await loadNotifications({ markRead: true });
    render();
    showToast("Notifications refreshed.");
  }

  if (action === "delete-doctor-leave") {
    await apiFetch(`/admin/doctor-leaves/${actionTarget.dataset.id}/delete`, { method: "POST" });
    await loadAdminData();
    render();
    showToast("Doctor leave deleted");
  }

  if (action === "check-in-appointment") {
    const appointmentId = actionTarget.dataset.appointmentId;
    const appointment = getAppointmentById(appointmentId);
    if ((appointment?.status || "").toLowerCase() === "checked_in") {
      showToast("You are already checked in.");
      return;
    }
    await apiFetch(`/appointment/${appointmentId}/check-in`, { method: "POST" });
    await loadMyAppointments();
    if (state.latestAppointment?.id === Number(appointmentId)) {
      await loadAppointmentDetails(appointmentId);
    }
    render();
    showToast("Check-in completed.");
  }
}

async function handleSubmit(event) {
  const form = event.target.closest("[data-form]");
  if (!form) return;
  event.preventDefault();
  const formData = new FormData(form);
  const data = Object.fromEntries(formData.entries());
  clearFormFeedback(form);

  try {
    if (form.dataset.form === "doctor-form") {
      data.unavailable_days = formData.getAll("unavailable_days").join(",");
    }

    if (form.dataset.form === "book-appointment") {
      const selectedDoctor = (shouldUseFilteredDoctorDirectory() ? state.doctorDirectory : state.doctors).find(
        (doctor) => String(doctor.id) === String(data.doctor_id)
      );
      const validationError = validateBookingData(data);
      if (validationError) {
        setFormFeedback(form, validationError);
        return;
      }
      if (selectedDoctor && isDoctorUnavailableOnDate(selectedDoctor, data.date)) {
        const offDay = getDayName(data.date);
        const message = selectedDoctor.availability_note
          ? `${selectedDoctor.name} is unavailable on ${offDay}. ${selectedDoctor.availability_note}`
          : `${selectedDoctor.name} is unavailable on ${offDay}.`;
        setFormFeedback(form, message);
        showToast(message, "error");
        return;
      }
      const booking = await apiFetch("/book", { method: "POST", body: JSON.stringify(data) });
      state.slotAvailability = {};
      await loadAppointmentDetails(booking.id);
      await loadMyAppointments();
      await loadNotifications();
      if (state.session?.user) {
        state.session.user.phone = data.mobile;
      }
      state.route = "confirmation";
      history.replaceState({}, "", `/?appointment=${booking.id}`);
      render();
      showToast(
        data.priority === "emergency"
          ? `Emergency appointment booked. Your token is ${booking.token_number}.`
          : `Appointment booked. Your token is ${booking.token_number}.`
      );
    }

    if (form.dataset.form === "reschedule-appointment") {
      await apiFetch(`/appointment/${data.appointment_id}/reschedule`, {
        method: "POST",
        body: JSON.stringify({ date: data.date }),
      });
      state.slotAvailability = {};
      await loadMyAppointments();
      await loadNotifications();
      if (state.latestAppointment?.id === Number(data.appointment_id)) {
        await loadAppointmentDetails(data.appointment_id);
      }
      render();
      showToast("Appointment rescheduled");
    }

    if (form.dataset.form === "add-family-member") {
      await apiFetch("/family-members", { method: "POST", body: JSON.stringify(data) });
      form.reset();
      await loadFamilyMembers();
      render();
      showToast("Family member added");
    }

    if (form.dataset.form === "hospital-form") {
      const url = state.editingHospitalId
        ? `/admin/update-hospital/${state.editingHospitalId}`
        : "/admin/add-hospital";
      await apiFetch(url, { method: "POST", body: JSON.stringify(data) });
      form.reset();
      state.editingHospitalId = null;
      await loadAdminData();
      render();
      showToast("Hospital details saved");
    }

    if (form.dataset.form === "add-city") {
      await apiFetch("/admin/add-city", { method: "POST", body: JSON.stringify(data) });
      form.reset();
      await loadAdminData();
      render();
      showToast("City added");
    }

    if (form.dataset.form === "doctor-form") {
      const url = state.editingDoctorId
        ? `/admin/update-doctor/${state.editingDoctorId}`
        : "/admin/add-doctor";
      await apiFetch(url, { method: "POST", body: JSON.stringify(data) });
      form.reset();
      state.editingDoctorId = null;
      await loadAdminData();
      render();
      showToast("Doctor details saved");
    }

    if (form.dataset.form === "doctor-leave-form") {
      await apiFetch("/admin/doctor-leaves", { method: "POST", body: JSON.stringify(data) });
      form.reset();
      await loadAdminData();
      render();
      showToast("Doctor leave saved");
    }

    if (form.dataset.form === "visit-notes-form") {
      await apiFetch(`/admin/appointment/${data.appointment_id}/visit-notes`, {
        method: "POST",
        body: JSON.stringify({ visit_notes: data.visit_notes }),
      });
      if (isAdmin()) {
        await loadAdminData();
      }
      if (state.route === "doctor-today" && state.doctorDaily?.doctor_id) {
        await loadDoctorToday(state.doctorDaily.doctor_id);
      }
      if (state.latestAppointment?.id === Number(data.appointment_id)) {
        await loadAppointmentDetails(data.appointment_id);
      }
      render();
      showToast("Visit notes saved");
    }

    if (form.dataset.form === "profile-form") {
      const result = await apiFetch("/profile", {
        method: "POST",
        body: JSON.stringify(data),
      });
      state.profile = state.profile
        ? { ...state.profile, user: result.user }
        : { user: result.user, stats: null };
      if (state.session?.user) {
        state.session.user = { ...state.session.user, ...result.user };
      }
      render();
      showToast("Profile updated");
    }
  } catch (error) {
    setFormFeedback(form, error.message);
    showToast(error.message, "error");
  }
}

function handleInput(event) {
  if (event.target.id === "bookingHospitalSearch") {
    updateBookingDraft({ hospitalSearch: event.target.value });
    render();
    return;
  }

  if (event.target.id === "bookingDepartmentSearch") {
    updateBookingDraft({ departmentSearch: event.target.value });
    render();
    return;
  }

  if (event.target.id === "bookingDoctorSearch") {
    updateBookingDraft({ doctorSearch: event.target.value });
    render();
    return;
  }

  if (event.target.id === "bookingWizardPatientName") {
    updateBookingDraft({ patientName: event.target.value });
    updateWizardPatientFeedback();
  }

  if (event.target.id === "bookingWizardMobile") {
    updateBookingDraft({ mobile: event.target.value });
    updateWizardPatientFeedback();
  }

  if (event.target.id === "bookingWizardEmergencyContact") {
    updateBookingDraft({ emergencyContact: event.target.value });
    updateWizardPatientFeedback();
  }

  if (event.target.id === "bookingWizardReason") {
    updateBookingDraft({ reasonForVisit: event.target.value });
    updateWizardPatientFeedback();
  }

  if (event.target.id === "bookingWizardNotes") {
    updateBookingDraft({ notes: event.target.value });
  }

  if (event.target.id === "hospitalSearch") {
    const term = event.target.value.toLowerCase().trim();
    const filtered = state.hospitals.filter(
      (hospital) =>
        hospital.name.toLowerCase().includes(term) ||
        hospital.location.toLowerCase().includes(term)
    );
    document.getElementById("hospitalGrid").innerHTML = hospitalCards(filtered);
  }

  if (event.target.id === "doctorSearch") {
    state.filters.search = event.target.value.trim();
    refreshDoctorDirectory();
  }
}

async function handleChange(event) {
  if (event.target.id === "bookingWizardFamilyMember") {
    updateBookingDraft({
      familyMemberId: event.target.value,
      bookingFor: event.target.value ? "family" : "self",
      patientName: event.target.value
        ? state.familyMembers.find((member) => String(member.id) === String(event.target.value))?.name || ""
        : state.session?.user?.name || "",
    });
    render();
    return;
  }

  if (event.target.id === "bookingWizardPriority") {
    updateBookingDraft({ priority: event.target.value });
    return;
  }

  if (event.target.id === "doctorCityFilter") {
    state.filters.cityId = event.target.value;
    if (state.filters.hospitalId && !getCurrentHospitalOptions().find((item) => String(item.id) === String(state.filters.hospitalId))) {
      state.filters.hospitalId = "";
    }
    render();
    refreshDoctorDirectory();
  }

  if (event.target.id === "doctorHospitalFilter") {
    state.filters.hospitalId = event.target.value;
    refreshDoctorDirectory();
  }

  if (event.target.id === "doctorDepartmentFilter") {
    state.filters.departmentId = event.target.value;
    refreshDoctorDirectory();
  }

  if (event.target.id === "doctorSpecializationFilter") {
    state.filters.specialization = event.target.value;
    refreshDoctorDirectory();
  }

  if (event.target.id === "doctorDayFilter") {
    state.filters.day = event.target.value;
    refreshDoctorDirectory();
  }

  if (event.target.name === "family_member_id" && event.target.closest('[data-form="book-appointment"]')) {
    syncBookingNameWithFamily(event.target.closest("form"));
  }

  if (event.target.name === "date" && event.target.closest('[data-form="book-appointment"]')) {
    await updateAutoSlotPreview(event.target.closest("form"), {
      doctorId: event.target.closest("form").doctor_id.value,
      date: event.target.value,
    });
  }

  if (event.target.name === "date" && event.target.closest('[data-form="reschedule-appointment"]')) {
    const form = event.target.closest("form");
    await updateAutoSlotPreview(form, {
      doctorId: form.doctor_id.value,
      date: event.target.value,
      excludeAppointmentId: form.appointment_id.value,
    });
  }

  if (event.target.id === "adminAppointmentDateFilter") {
    state.admin.appointmentFilters.date = event.target.value;
    await loadAdminAppointments();
    render();
  }

  if (event.target.id === "adminAppointmentHospitalFilter") {
    state.admin.appointmentFilters.hospital = event.target.value;
    await loadAdminAppointments();
    render();
  }

  if (event.target.id === "adminAppointmentDoctorFilter") {
    state.admin.appointmentFilters.doctor = event.target.value;
    await loadAdminAppointments();
    render();
  }

  if (event.target.id === "adminAppointmentPriorityFilter") {
    state.admin.appointmentFilters.priority = event.target.value;
    await loadAdminAppointments();
    render();
  }

  if (event.target.id === "adminAppointmentStatusFilter") {
    state.admin.appointmentFilters.status = event.target.value;
    await loadAdminAppointments();
    render();
  }
}

function fillDoctorForm() {
  const doctor = state.admin.doctors.find((item) => item.id === state.editingDoctorId);
  const form = document.querySelector('[data-form="doctor-form"]');
  if (!doctor || !form) return;
  form.name.value = doctor.name;
  form.specialization.value = doctor.specialization;
  form.department_id.value = doctor.department_id || "";
  form.hospital_id.value = doctor.hospital_id;
  form.image.value = doctor.image || "";
  form.max_patients_per_day.value = doctor.max_patients_per_day || 24;
  form.available_from.value = doctor.available_from.slice(0, 5);
  form.available_to.value = doctor.available_to.slice(0, 5);
  form.availability_note.value = doctor.availability_note || "";
  const selectedDays = (doctor.unavailable_days || "")
    .split(",")
    .map((value) => value.trim().toLowerCase());
  Array.from(form.unavailable_days.options).forEach((option) => {
    option.selected = selectedDays.includes(option.value);
  });
}

function fillHospitalForm() {
  const hospital = state.admin.hospitals.find((item) => item.id === state.editingHospitalId);
  const form = document.querySelector('[data-form="hospital-form"]');
  if (!hospital || !form) return;
  form.name.value = hospital.name;
  form.city_id.value = hospital.city_id;
  form.location.value = hospital.location;
  form.image.value = hospital.image || "";
  form.contact_phone.value = hospital.contact_phone || "";
  form.map_link.value = hospital.map_link || "";
}

function syncBookingNameWithFamily(form) {
  if (!form) return;
  const nameInput = form.querySelector('input[name="name"]');
  const familySelect = form.querySelector('select[name="family_member_id"]');
  if (!nameInput || !familySelect) return;

  const selectedMember = state.familyMembers.find(
    (member) => String(member.id) === String(familySelect.value)
  );

  if (selectedMember) {
    nameInput.value = selectedMember.name;
    nameInput.readOnly = true;
  } else {
    nameInput.readOnly = false;
    nameInput.value = state.session?.user?.name || "";
  }
}

function setLoading(isLoading) {
  loadingOverlay.classList.toggle("hidden", !isLoading);
}

function syncMobileMenu() {
  document.body.dataset.navOpen = state.mobileMenuOpen ? "true" : "false";
  navScrim.classList.toggle("hidden", !state.mobileMenuOpen);
  menuToggle.setAttribute("aria-expanded", state.mobileMenuOpen ? "true" : "false");
}

function closeMobileMenu() {
  if (!state.mobileMenuOpen) return;
  state.mobileMenuOpen = false;
  syncMobileMenu();
}

function updateThemeLabel() {
  themeToggle.innerHTML =
    state.theme === "dark"
      ? '<i class="fa-solid fa-sun"></i><span>Light mode</span>'
      : '<i class="fa-solid fa-moon"></i><span>Dark mode</span>';
}

function updateInstallButtonVisibility() {
  installButton.classList.toggle("hidden", !deferredInstallPrompt);
}

function isAdmin() {
  const user = state.session?.user;
  return Boolean(user && (user.role === "admin" || user.email === ADMIN_EMAIL));
}

function isStaff() {
  const role = String(state.session?.user?.role || "").toLowerCase();
  return isAdmin() || role === "doctor";
}

function showToast(message, type = "success") {
  const toast = document.createElement("div");
  toast.className = `toast ${type === "error" ? "error" : ""}`;
  toast.textContent = message;
  document.getElementById("toastStack").appendChild(toast);
  setTimeout(() => toast.remove(), 3200);
}

function setFormFeedback(form, message) {
  const node = form.querySelector(".form-feedback");
  if (node) node.textContent = message;
}

function clearFormFeedback(form) {
  const node = form.querySelector(".form-feedback");
  if (node) node.textContent = "";
}

function getWizardCity() {
  return state.cities.find((city) => String(city.id) === String(state.bookingWizard.cityId)) || null;
}

function getWizardHospital() {
  return (
    state.hospitalDetail?.id && String(state.hospitalDetail.id) === String(state.bookingWizard.hospitalId)
      ? state.hospitalDetail
      : state.hospitals.find((hospital) => String(hospital.id) === String(state.bookingWizard.hospitalId))
  ) || null;
}

function getWizardDoctors() {
  const hospitalDoctors = state.hospitalDetail?.doctors || [];
  const source = state.doctorDirectory.length ? state.doctorDirectory : hospitalDoctors.length ? hospitalDoctors : state.doctors;
  return source.filter((doctor) => {
    if (!state.bookingWizard.hospitalId) return true;
    return String(doctor.hospital_id) === String(state.bookingWizard.hospitalId);
  });
}

function getWizardDoctor() {
  return getWizardDoctors().find((doctor) => String(doctor.id) === String(state.bookingWizard.doctorId)) || null;
}

function getWizardDepartments() {
  const departments = new Map();
  getWizardDoctors().forEach((doctor) => {
    const id = doctor.department_id || doctor.specialization || "general";
    const name = doctor.department_name || doctor.specialization || "General Medicine";
    const existing = departments.get(String(id));
    departments.set(String(id), {
      id,
      name,
      doctorCount: (existing?.doctorCount || 0) + 1,
      icon: getDepartmentIcon(name),
      description: getDepartmentDescription(name),
    });
  });
  return Array.from(departments.values()).sort((left, right) => right.doctorCount - left.doctorCount);
}

function getWizardDepartment() {
  return getWizardDepartments().find((department) => String(department.id) === String(state.bookingWizard.departmentId)) || null;
}

function getWizardSlotResponse() {
  if (!state.bookingWizard.doctorId || !state.bookingWizard.date) return null;
  return state.slotAvailability[getSlotCacheKey(state.bookingWizard.doctorId, state.bookingWizard.date)] || null;
}

function getWizardSelectedSlot() {
  const slotResponse = getWizardSlotResponse();
  if (!slotResponse) return state.bookingWizard.expectedSlot;
  return (
    slotResponse.slots?.find((slot) => String(slot.slotNumber) === String(state.bookingWizard.selectedSlotNumber)) ||
    slotResponse.nextSlot ||
    state.bookingWizard.expectedSlot
  );
}

function getSelectedFamilyMember() {
  return state.familyMembers.find((member) => String(member.id) === String(state.bookingWizard.familyMemberId)) || null;
}

function getHospitalMeta(hospital) {
  const departments = getWizardDoctors()
    .filter((doctor) => String(doctor.hospital_id) === String(hospital.id))
    .map((doctor) => doctor.department_name || doctor.specialization)
    .filter(Boolean);
  const hours =
    hospital.opens_at && hospital.closes_at
      ? `${formatTime(hospital.opens_at)} - ${formatTime(hospital.closes_at)}`
      : "";
  return {
    hours,
    departments: [...new Set(departments)].slice(0, 4).join(", "),
  };
}

function formatFee(value) {
  const fee = Number(value);
  if (!Number.isFinite(fee) || fee <= 0) return "Free consultation";
  return `\u20B9${fee.toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;
}

function getDoctorMeta(doctor) {
  const years = Number(doctor.experience_years);
  return {
    qualification: doctor.qualification || "",
    experience: Number.isFinite(years) && doctor.experience_years !== null ? years : null,
    fee: Number(doctor.consultation_fee) || 0,
    feeLabel: formatFee(doctor.consultation_fee),
    nextSlot: isDoctorUnavailableOnDate(doctor, todayDate())
      ? "Next available after weekly off"
      : `Today after ${formatTime(doctor.available_from || APPOINTMENT_SLOT_START_TIME)}`,
  };
}

function getBookingSummary() {
  const draft = state.bookingWizard;
  const hospital = getWizardHospital();
  const department = getWizardDepartment();
  const doctor = getWizardDoctor();
  const slot = getWizardSelectedSlot();
  const familyMember = getSelectedFamilyMember();
  const patientName = familyMember?.name || draft.patientName || state.session?.user?.name || "";
  const doctorMeta = doctor ? getDoctorMeta(doctor) : null;
  return {
    hospitalName: hospital?.name || "",
    departmentName: department?.name || doctor?.department_name || doctor?.specialization || "",
    doctorName: doctor?.name || "",
    date: draft.date ? formatDate(draft.date) : "",
    slotLabel: slot?.label || draft.expectedSlot?.label || "",
    fee: doctorMeta ? doctorMeta.feeLabel : "Shown after doctor selection",
    patientName,
    bookingFor: familyMember ? `${familyMember.name} (${familyMember.relation})` : "Self",
    notes: draft.notes,
    waitEstimate: slot ? `Estimated wait starts around ${slot.label}.` : "Earliest available token will be recommended after date selection.",
  };
}

function validateWizardStep(step) {
  const draft = state.bookingWizard;
  if (step >= 1 && !draft.cityId) return "Select a city to continue.";
  if (step >= 2 && !draft.hospitalId) return "Select a hospital to continue.";
  if (step >= 3 && !draft.departmentId) return "Select a department to continue.";
  if (step >= 4 && !draft.doctorId) return "Select a doctor to continue.";
  if (step >= 5 && (!draft.date || !getWizardSelectedSlot())) return "Select an available date and time.";
  if (step >= 6) {
    const familyMember = getSelectedFamilyMember();
    const patientName = familyMember?.name || draft.patientName || state.session?.user?.name || "";
    const mobile = draft.mobile || state.session?.user?.phone || state.profile?.user?.phone || "";
    if (!patientName.trim()) return "Patient name is required.";
    if (!/^[0-9]{10}$/.test(String(mobile || "").replace(/\D/g, ""))) return "Enter a valid 10-digit mobile number.";
    if (draft.emergencyContact && !/^[0-9]{10}$/.test(String(draft.emergencyContact || "").replace(/\D/g, ""))) {
      return "Enter a valid 10-digit emergency contact or leave it blank.";
    }
    if (!draft.reasonForVisit.trim()) return "Reason for visit is required.";
  }
  return "";
}

function updateWizardPatientFeedback() {
  const feedback = document.getElementById("bookingWizardPatientFeedback");
  const error = validateWizardStep(6);
  if (feedback) {
    feedback.textContent = error;
  }
  // Keep the Continue button in step with the form: it used to stay disabled after the form became valid.
  const next = document.querySelector('.wizard-screen [data-action="wizard-next"]');
  if (next) {
    next.disabled = Boolean(error);
  }
}

function isWizardStepReachable(step) {
  if (step <= state.bookingWizard.step) return true;
  return !validateWizardStep(step - 1);
}

function getCalendarDays(count) {
  const start = new Date(`${todayDate()}T12:00:00`);
  return Array.from({ length: count }).map((_, index) => {
    const date = new Date(start);
    date.setDate(start.getDate() + index);
    const value = date.toISOString().slice(0, 10);
    return {
      value,
      weekday: date.toLocaleDateString(undefined, { weekday: "short" }),
      day: date.toLocaleDateString(undefined, { day: "2-digit" }),
      month: date.toLocaleDateString(undefined, { month: "short" }),
    };
  });
}

function groupSlotsByDaypart(slots) {
  return slots.reduce(
    (groups, slot) => {
      const hour = Number(String(slot.startTime || "00:00").split(":")[0]);
      const group = hour < 12 ? "Morning" : hour < 17 ? "Afternoon" : "Evening";
      groups[group].push(slot);
      return groups;
    },
    { Morning: [], Afternoon: [], Evening: [] }
  );
}

function renderAppointmentConflict() {
  const conflict = getAppointmentConflict(state.bookingWizard.date);
  if (!conflict) return "";
  return `
    <div class="warning-strip">
      <i class="fa-solid fa-triangle-exclamation"></i>
      <span>You already have an appointment with ${escapeHtml(conflict.doctor_name)} on ${formatDate(conflict.appointment_date)}.</span>
    </div>
  `;
}

function getAppointmentConflict(date) {
  if (!date) return null;
  return [...state.myAppointments.upcoming, ...state.myAppointments.past].find(
    (appointment) =>
      appointment.appointment_date === date &&
      !["cancelled", "completed", "skipped"].includes(String(appointment.status || "").toLowerCase())
  );
}

async function loadWizardDoctorDirectory() {
  state.filters.cityId = String(state.bookingWizard.cityId || "");
  state.filters.hospitalId = String(state.bookingWizard.hospitalId || "");
  state.filters.departmentId = "";
  state.filters.specialization = "";
  state.filters.day = "";
  state.filters.search = "";
  await loadDoctorDirectory();
}

async function loadBookingWizardData() {
  if (state.bookingWizard.cityId && !state.hospitals.length) {
    await loadHospitals(state.bookingWizard.cityId);
  }

  if (
    state.bookingWizard.hospitalId &&
    String(state.hospitalDetail?.id || "") !== String(state.bookingWizard.hospitalId)
  ) {
    await loadHospitalDetail(state.bookingWizard.hospitalId);
  }

  if (state.bookingWizard.hospitalId) {
    await loadWizardDoctorDirectory();
  }

  if (
    state.bookingWizard.doctorId &&
    state.bookingWizard.date &&
    !getWizardSlotResponse()
  ) {
    try {
      const slotResponse = await loadDoctorSlots(state.bookingWizard.doctorId, state.bookingWizard.date);
      updateBookingDraft({
        selectedSlotNumber: state.bookingWizard.selectedSlotNumber || slotResponse.nextSlot?.slotNumber || "",
        expectedSlot: state.bookingWizard.expectedSlot || slotResponse.nextSlot || null,
        availabilityStatus: "ready",
        availabilityMessage: slotResponse.note || "",
      });
    } catch (error) {
      updateBookingDraft({
        selectedSlotNumber: "",
        expectedSlot: null,
        availabilityStatus: "error",
        availabilityMessage: error.message || "Unable to refresh saved appointment availability.",
      });
    }
  }
}

async function loadWizardSlots(date) {
  updateBookingDraft({
    date,
    selectedSlotNumber: "",
    expectedSlot: null,
    availabilityStatus: "loading",
    availabilityMessage: "",
  });
  render();
  try {
    const slotResponse = await loadDoctorSlots(state.bookingWizard.doctorId, date);
    updateBookingDraft({
      selectedSlotNumber: slotResponse.nextSlot?.slotNumber || "",
      expectedSlot: slotResponse.nextSlot || null,
      availabilityStatus: "ready",
      availabilityMessage: slotResponse.note || "",
    });
    if (!state.myAppointments.upcoming.length && !state.myAppointments.past.length) {
      await loadMyAppointments().catch(() => {});
    }
  } catch (error) {
    updateBookingDraft({
      selectedSlotNumber: "",
      expectedSlot: null,
      availabilityStatus: "error",
      availabilityMessage: error.message || "Unable to load live availability. Please try another date.",
    });
    showToast(state.bookingWizard.availabilityMessage, "error");
  }
}

async function confirmWizardBooking() {
  const draft = state.bookingWizard;
  const familyMember = getSelectedFamilyMember();
  const patientName = familyMember?.name || draft.patientName || state.session?.user?.name || "";
  const mobile = draft.mobile || state.session?.user?.phone || state.profile?.user?.phone || "";
  const data = {
    doctor_id: draft.doctorId,
    hospital_id: draft.hospitalId,
    family_member_id: draft.familyMemberId,
    name: patientName,
    mobile,
    date: draft.date,
    slot_number: getWizardSelectedSlot()?.slotNumber,
    priority: draft.priority,
    reason_for_visit: draft.reasonForVisit,
  };
  const validationError = validateBookingData(data);
  if (validationError) {
    showToast(validationError, "error");
    return;
  }
  setLoading(true);
  try {
    const booking = await apiFetch("/book", { method: "POST", body: JSON.stringify(data) });
    state.slotAvailability = {};
    await loadAppointmentDetails(booking.id);
    await loadMyAppointments();
    await loadNotifications();
    if (state.session?.user) {
      state.session.user.phone = mobile;
    }
    state.bookingWizard = {
      ...createDefaultBookingDraft(),
      cityId: draft.cityId,
      hospitalId: draft.hospitalId,
      patientName,
      mobile,
    };
    persistBookingDraft();
    state.route = "confirmation";
    history.replaceState({}, "", `/?appointment=${booking.id}`);
    render();
    if (booking.requires_payment) {
      showToast("Your time is held. Complete payment to confirm the appointment.");
      setLoading(false);
      await payForAppointment(booking.id);
    } else {
      showToast(`Appointment booked. Your token is ${booking.token_number}.`);
    }
  } catch (error) {
    showToast(error.message || "Unable to confirm appointment. Please try again.", "error");
  } finally {
    setLoading(false);
  }
}

let razorpayScriptPromise = null;
function loadRazorpayCheckout() {
  if (window.Razorpay) return Promise.resolve();
  if (!razorpayScriptPromise) {
    razorpayScriptPromise = new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src = "https://checkout.razorpay.com/v1/checkout.js";
      script.onload = resolve;
      script.onerror = () => {
        razorpayScriptPromise = null;
        reject(new Error("Could not load the payment window. Check your connection and try again."));
      };
      document.head.appendChild(script);
    });
  }
  return razorpayScriptPromise;
}

/**
 * Pay for a held appointment. The browser only reports what Razorpay returned; the server verifies the
 * signature and is the only thing that can confirm the booking.
 */
async function payForAppointment(appointmentId) {
  try {
    const order = await apiFetch("/payments/order", {
      method: "POST",
      body: JSON.stringify({ appointment_id: Number(appointmentId) }),
    });
    await loadRazorpayCheckout();
    const user = state.session?.user || {};
    const paid = await new Promise((resolve, reject) => {
      const checkout = new window.Razorpay({
        key: order.key_id,
        order_id: order.order_id,
        amount: order.amount_paise,
        currency: order.currency,
        name: "PulseCare HMS",
        description: "Consultation fee",
        prefill: { name: user.name || "", email: user.email || "", contact: user.phone || "" },
        theme: { color: "#0e7490" },
        handler: (response) => {
          apiFetch("/payments/verify", { method: "POST", body: JSON.stringify(response) })
            .then(() => resolve(true))
            .catch(reject);
        },
        modal: { ondismiss: () => resolve(false) },
      });
      checkout.on("payment.failed", (failure) => {
        showToast(failure?.error?.description || "Payment failed. You can try again.", "error");
      });
      checkout.open();
    });
    await loadAppointmentDetails(appointmentId);
    await loadMyAppointments();
    await loadNotifications();
    render();
    showToast(paid ? "Payment verified. Your appointment is confirmed." : "Payment not completed. Your time is still held for a few minutes.", paid ? undefined : "error");
  } catch (error) {
    await loadMyAppointments().catch(() => {});
    render();
    showToast(error.message || "Payment could not be started.", "error");
  }
}

function renderPaymentActions(appointment) {
  const status = (appointment.status || "").toLowerCase();
  if (status === "pending_payment") {
    const minutes = Math.ceil(Number(appointment.hold_seconds_left || 0) / 60);
    return `
      <p class="card__meta"><i class="fa-solid fa-hourglass-half"></i> ${minutes > 0 ? `Time held for about ${minutes} more min` : "Hold has expired"} - pay ${escapeHtml(formatFee(appointment.fee_amount))} to confirm</p>
      <div class="form-actions">
        ${minutes > 0 ? `<button class="primary-button" type="button" data-action="pay-appointment" data-appointment-id="${appointment.id}"><i class="fa-solid fa-credit-card"></i><span>Pay ${escapeHtml(formatFee(appointment.fee_amount))}</span></button>` : ""}
        <button class="danger-button" type="button" data-action="cancel-appointment" data-appointment-id="${appointment.id}"><i class="fa-solid fa-ban"></i><span>Cancel</span></button>
      </div>`;
  }
  if (appointment.receipt_no) {
    return `
      <div class="form-actions">
        <a class="secondary-button link-button" href="/receipts/${appointment.id}/print" target="_blank" rel="noopener"><i class="fa-solid fa-receipt"></i><span>View receipt</span></a>
        <a class="secondary-button link-button" href="/receipts/${appointment.id}/pdf"><i class="fa-solid fa-file-pdf"></i><span>Download PDF</span></a>
      </div>`;
  }
  return "";
}

function getDepartmentIcon(name) {
  const value = String(name || "").toLowerCase();
  if (value.includes("cardio")) return "fa-heart-pulse";
  if (value.includes("ortho") || value.includes("bone")) return "fa-bone";
  if (value.includes("neuro")) return "fa-brain";
  if (value.includes("child") || value.includes("pedia")) return "fa-child-reaching";
  if (value.includes("skin") || value.includes("derma")) return "fa-hand-sparkles";
  return "fa-stethoscope";
}

function getDepartmentDescription(name) {
  const value = String(name || "").toLowerCase();
  if (value.includes("cardio")) return "Heart, blood pressure, chest pain, and cardiac follow-up care.";
  if (value.includes("ortho") || value.includes("bone")) return "Bones, joints, fractures, sports injuries, and mobility care.";
  if (value.includes("neuro")) return "Brain, spine, nerve, headache, and seizure-related consultation.";
  return "Specialist consultation, diagnosis, follow-up, and OPD care.";
}

function validateBookingData(data) {
  if (!data.family_member_id && !data.name?.trim()) return "Patient name is required.";
  if (!/^[0-9]{10}$/.test((data.mobile || "").replace(/\D/g, ""))) return "Enter a valid 10-digit mobile number.";
  if (!data.date) return "Please select an appointment date.";
  if (!data.reason_for_visit?.trim()) return "Please enter the reason for visit.";
  return "";
}

function emptyState(message) {
  return `<div class="empty-state">${escapeHtml(message)}</div>`;
}

function todayDate() {
  const now = new Date();
  return new Date(now.getTime() - now.getTimezoneOffset() * 60000)
    .toISOString()
    .split("T")[0];
}

function formatDate(value) {
  return new Date(value).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

function formatDateTime(value) {
  return new Date(value).toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function formatTimeRange(from, to) {
  return `${formatTime(from)} - ${formatTime(to)}`;
}

function formatTime(value) {
  const [hours, minutes] = String(value || "00:00").split(":");
  const date = new Date();
  date.setHours(Number(hours), Number(minutes), 0, 0);
  return date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

function renderTimeOptions() {
  const options = [];
  for (let hour = 0; hour < 24; hour += 1) {
    for (let minute = 0; minute < 60; minute += 30) {
      const value = `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
      options.push(`<option value="${value}">${formatTime(value)}</option>`);
    }
  }
  return options.join("");
}

function renderDayOptions() {
  return ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"]
    .map((day) => `<option value="${day.toLowerCase()}">${day}</option>`)
    .join("");
}

function formatUnavailableDays(value) {
  return String(value || "")
    .split(",")
    .map((day) => day.trim())
    .filter(Boolean)
    .map((day) => capitalize(day))
    .join(", ");
}

function formatAvailabilitySummary(doctor) {
  const days = doctor.unavailable_days
    ? `Off: ${formatUnavailableDays(doctor.unavailable_days)}`
    : "Available all week";
  const capacity = doctor.max_patients_per_day ? `Capacity: ${doctor.max_patients_per_day}/day` : "";
  const summary = [days, capacity, doctor.availability_note].filter(Boolean).join(" - ");
  return summary || "Available all week";
}

function estimateWait(remainingPatients) {
  return `${remainingPatients * 15} min`;
}

function formatAppointmentSlot(appointment) {
  if (appointment?.slot_start && appointment?.slot_end) {
    return `${formatTime(appointment.slot_start)} to ${formatTime(appointment.slot_end)}`;
  }

  if (!appointment?.token_number) {
    return "Slot will appear after doctor timing is set";
  }

  const startMinutes = timeToMinutes(APPOINTMENT_SLOT_START_TIME);
  const slotStartMinutes =
    startMinutes + (Math.max(Number(appointment.token_number), 1) - 1) * APPOINTMENT_SLOT_STEP_MINUTES;
  const slotEndMinutes = slotStartMinutes + APPOINTMENT_SLOT_DURATION_MINUTES;

  return `${minutesToDisplayTime(slotStartMinutes)} to ${minutesToDisplayTime(slotEndMinutes)}`;
}

function getDayName(dateValue) {
  return new Date(`${dateValue}T12:00:00`).toLocaleDateString(undefined, { weekday: "long" });
}

function isDoctorUnavailableOnDate(doctor, dateValue) {
  if (!doctor?.unavailable_days || !dateValue) return false;
  const day = getDayName(dateValue).toLowerCase();
  return doctor.unavailable_days
    .split(",")
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean)
    .includes(day);
}

async function refreshDoctorDirectory() {
  await loadDoctorDirectory();
  const grid = document.getElementById("doctorGrid");
  if (grid) grid.innerHTML = doctorCards(state.doctorDirectory);
}

async function updateAutoSlotPreview(form, { doctorId, date, excludeAppointmentId } = {}) {
  if (!form) return;
  const previewNode = form.querySelector("[data-slot-preview]");
  const feedback = form.querySelector(".form-feedback");
  if (!previewNode) return;

  if (!date) {
    previewNode.textContent =
      form.dataset.form === "reschedule-appointment"
        ? "Next free slot will be assigned automatically after you choose a new date."
        : "Next free slot will be assigned automatically after you choose a date.";
    if (feedback) feedback.textContent = "";
    return;
  }

  const cachedSlots = state.slotAvailability[getSlotCacheKey(doctorId, date, excludeAppointmentId)];
  const slotResponse =
    cachedSlots ||
    (await loadDoctorSlots(doctorId, date, {
      excludeAppointmentId,
    }));

  if (slotResponse.unavailable) {
    previewNode.textContent = "No automatic slot is available on this day.";
    if (feedback) feedback.textContent = slotResponse.note || "Doctor is unavailable on this date.";
    return;
  }

  if (slotResponse.limitReached) {
    previewNode.textContent = "Doctor limit reached for this day.";
    if (feedback) feedback.textContent = slotResponse.note || "Daily booking limit reached.";
    return;
  }

  if (feedback) {
    feedback.textContent = slotResponse.nextSlot
      ? ""
      : "All fixed slots are already booked for this date. Please choose another day.";
  }
  previewNode.textContent = slotResponse.nextSlot
    ? `Next automatic slot: Token ${slotResponse.nextSlot.slotNumber} • ${slotResponse.nextSlot.label}${slotResponse.maxPatientsPerDay ? ` • ${slotResponse.bookedPatients}/${slotResponse.maxPatientsPerDay} booked` : ""}`
    : "All automatic slots are full for this date.";
}

function getSlotCacheKey(doctorId, date, excludeAppointmentId = "") {
  return [doctorId, date, excludeAppointmentId || ""].join(":");
}

function getCurrentHospitalOptions() {
  const baseHospitals = state.hospitals.length ? state.hospitals : state.admin.hospitals;
  if (!state.filters.cityId) return baseHospitals;
  return baseHospitals.filter((hospital) => String(hospital.city_id) === String(state.filters.cityId));
}

function shouldUseFilteredDoctorDirectory() {
  return Boolean(
    state.doctorDirectory.length ||
      state.filters.cityId ||
      state.filters.hospitalId ||
      state.filters.departmentId ||
      state.filters.specialization ||
      state.filters.day ||
      state.filters.search
  );
}

function getFilteredAdminAppointments() {
  return state.admin.appointments;
}

function getAppointmentById(appointmentId) {
  const allAppointments = [...state.myAppointments.upcoming, ...state.myAppointments.past];
  if (state.latestAppointment?.id === Number(appointmentId)) {
    return state.latestAppointment;
  }
  return allAppointments.find((appointment) => Number(appointment.id) === Number(appointmentId)) || null;
}

function canCheckIn(appointment) {
  const status = (appointment?.status || "").toLowerCase();
  return Boolean(
    appointment &&
      appointment.appointment_date === todayDate() &&
      !["completed", "cancelled", "skipped", "serving", "pending_payment"].includes(status)
  );
}

function statusBadge(status) {
  const normalized = (status || "pending").toLowerCase();
  return `<span class="chip status-badge status-badge--${normalized}">${escapeHtml(formatStatusLabel(normalized))}</span>`;
}

function formatPriorityLabel(priority) {
  return normalizePriority(priority) === "emergency" ? "Emergency" : "Normal";
}

function priorityBadge(priority) {
  const normalized = normalizePriority(priority);
  const icon = normalized === "emergency" ? "fa-truck-medical" : "fa-user-clock";
  return `<span class="chip"><i class="fa-solid ${icon}"></i>${escapeHtml(formatPriorityLabel(normalized))}</span>`;
}

function capitalize(value) {
  return String(value || "").charAt(0).toUpperCase() + String(value || "").slice(1);
}

function normalizePriority(priority) {
  return String(priority || "normal").toLowerCase() === "emergency"
    ? "emergency"
    : "normal";
}

function formatStatusLabel(value) {
  return String(value || "")
    .split("_")
    .filter(Boolean)
    .map((part) => capitalize(part))
    .join(" ");
}

function formatNotificationType(type) {
  const labels = {
    booking_created: "Booking created",
    booking_cancelled: "Booking cancelled",
    booking_rescheduled: "Booking rescheduled",
  };

  return labels[type] || "Update";
}

function printAppointmentSlip(appointment) {
  if (!appointment) return;
  const win = window.open("", "_blank", "width=720,height=800");
  if (!win) return;
  win.document.write(`
    <html>
      <head>
        <title>Appointment Slip</title>
        <style>
          body { font-family: Arial, sans-serif; padding: 32px; color: #222; }
          .slip { border: 2px solid #d8b07c; padding: 24px; border-radius: 16px; }
          h1 { margin-top: 0; }
          .row { margin: 10px 0; }
          .token { font-size: 28px; font-weight: bold; margin-top: 20px; }
        </style>
      </head>
      <body>
        <div class="slip">
          <h1>PulseCare HMS Appointment Slip</h1>
          <div class="row"><strong>Hospital:</strong> ${escapeHtml(appointment.hospital_name)}</div>
          <div class="row"><strong>Doctor:</strong> ${escapeHtml(appointment.doctor_name)}</div>
          ${appointment.department_name ? `<div class="row"><strong>Department:</strong> ${escapeHtml(appointment.department_name)}</div>` : ""}
          <div class="row"><strong>Date:</strong> ${escapeHtml(formatDate(appointment.appointment_date))}</div>
          <div class="row"><strong>Time Slot:</strong> ${escapeHtml(formatAppointmentSlot(appointment))}</div>
          <div class="row"><strong>Priority:</strong> ${escapeHtml(formatPriorityLabel(appointment.priority))}</div>
          <div class="row"><strong>Patient:</strong> ${escapeHtml(appointment.user_name)}</div>
          ${
            appointment.family_member_name
              ? `<div class="row"><strong>Booked For:</strong> ${escapeHtml(appointment.family_member_name)}${appointment.family_relation ? ` • ${escapeHtml(appointment.family_relation)}` : ""}</div>`
              : ""
          }
          ${appointment.reason_for_visit ? `<div class="row"><strong>Reason:</strong> ${escapeHtml(appointment.reason_for_visit)}</div>` : ""}
          <div class="row"><strong>Mobile:</strong> ${escapeHtml(appointment.mobile || "")}</div>
          <div class="row"><strong>Location:</strong> ${escapeHtml(appointment.hospital_location || "")}</div>
          <div class="token">Token: ${escapeHtml(String(appointment.token_number))}</div>
        </div>
        <script>window.print();<\/script>
      </body>
    </html>
  `);
  win.document.close();
}

function downloadAppointmentSlip(appointment) {
  if (!appointment) return;
  const lines = [
    "PulseCare HMS Appointment Slip",
    `Appointment ID: PC-${String(appointment.id).padStart(6, "0")}`,
    `Hospital: ${appointment.hospital_name}`,
    `Doctor: ${appointment.doctor_name}`,
    `Department: ${appointment.department_name || appointment.specialization || ""}`,
    `Date: ${formatDate(appointment.appointment_date)}`,
    `Time Slot: ${formatAppointmentSlot(appointment)}`,
    `Token: ${appointment.token_number}`,
    `Priority: ${formatPriorityLabel(appointment.priority)}`,
    `Patient: ${appointment.user_name}`,
    `Mobile: ${appointment.mobile || ""}`,
    `Location: ${appointment.hospital_location || ""}`,
  ];
  downloadTextFile(
    `appointment-PC-${String(appointment.id).padStart(6, "0")}.txt`,
    lines.join("\n")
  );
}

function downloadAppointmentCalendar(appointment) {
  if (!appointment) return;
  const start = getCalendarDateTime(appointment.appointment_date, appointment.slot_start || APPOINTMENT_SLOT_START_TIME);
  const end = getCalendarDateTime(appointment.appointment_date, appointment.slot_end || "10:15");
  const content = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//PulseCare HMS//Appointment//EN",
    "BEGIN:VEVENT",
    `UID:pulsecare-${appointment.id}@hms`,
    `DTSTAMP:${toIcsDateTime(new Date())}`,
    `DTSTART:${toIcsDateTime(start)}`,
    `DTEND:${toIcsDateTime(end)}`,
    `SUMMARY:Appointment with ${appointment.doctor_name}`,
    `LOCATION:${appointment.hospital_name}, ${appointment.hospital_location || ""}`,
    `DESCRIPTION:Token ${appointment.token_number}. Patient ${appointment.user_name}.`,
    "END:VEVENT",
    "END:VCALENDAR",
  ].join("\r\n");
  downloadTextFile(`appointment-PC-${String(appointment.id).padStart(6, "0")}.ics`, content);
}

function downloadTextFile(filename, content) {
  const blob = new Blob([content], { type: "text/plain;charset=utf-8" });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  URL.revokeObjectURL(link.href);
  link.remove();
}

function getCalendarDateTime(dateValue, timeValue) {
  const [hours, minutes] = String(timeValue || "00:00").slice(0, 5).split(":");
  return new Date(`${dateValue}T${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:00`);
}

function toIcsDateTime(date) {
  return date.toISOString().replace(/[-:]/g, "").split(".")[0] + "Z";
}

function downloadAdminAppointmentsCsv() {
  const params = getAdminAppointmentQueryParams();
  const url = `/admin/appointments/export${params.toString() ? `?${params.toString()}` : ""}`;
  const link = document.createElement("a");
  link.href = url;
  document.body.appendChild(link);
  link.click();
  link.remove();
}

function placeholderImage(type) {
  return type === "doctor"
    ? "https://images.unsplash.com/photo-1612349317150-e413f6a5b16d?auto=format&fit=crop&w=900&q=80"
    : "https://images.unsplash.com/photo-1586773860418-d37222d8fce3?auto=format&fit=crop&w=900&q=80";
}

function escapeAttribute(value) {
  return String(value ?? "").replace(/"/g, "&quot;");
}

function timeToMinutes(value) {
  const [hours, minutes] = String(value || "00:00").split(":");
  return Number(hours) * 60 + Number(minutes);
}

function minutesToDisplayTime(totalMinutes) {
  const normalized = ((Number(totalMinutes) % 1440) + 1440) % 1440;
  const hours = Math.floor(normalized / 60);
  const minutes = normalized % 60;
  return formatTime(`${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`);
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
