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
  slotAvailability: {},
  myAppointments: { upcoming: [], past: [] },
  filters: {
    cityId: "",
    hospitalId: "",
    specialization: "",
    day: "",
    search: "",
  },
  admin: {
    stats: null,
    chart: [],
    hospitals: [],
    doctors: [],
    cities: [],
    appointments: [],
    board: [],
    appointmentFilters: {
      date: "",
      hospital: "",
      doctor: "",
      status: "",
    },
  },
  doctorDaily: null,
  selectedCity: null,
  selectedHospital: null,
  latestAppointment: null,
  route: "home",
  theme: localStorage.getItem("pulsecare-theme") || "dark",
  editingDoctorId: null,
};

const app = document.getElementById("app");
const sidebarNav = document.getElementById("sidebarNav");
const themeToggle = document.getElementById("themeToggle");
const logoutButton = document.getElementById("logoutButton");
const userChip = document.getElementById("userChip");
const loadingOverlay = document.getElementById("loadingOverlay");
const pageTitle = document.getElementById("pageTitle");
const pageEyebrow = document.getElementById("pageEyebrow");
const ADMIN_EMAIL = "gauravkale216@gmail.com";
const APPOINTMENT_SLOT_START_TIME = "10:00";
const APPOINTMENT_SLOT_STEP_MINUTES = 15;
const APPOINTMENT_SLOT_DURATION_MINUTES = 15;
let autoRefreshTimer = null;

document.body.dataset.theme = state.theme;
updateThemeLabel();

themeToggle.addEventListener("click", () => {
  state.theme = state.theme === "dark" ? "light" : "dark";
  document.body.dataset.theme = state.theme;
  localStorage.setItem("pulsecare-theme", state.theme);
  updateThemeLabel();
});

logoutButton.addEventListener("click", async () => {
  await apiFetch("/api/logout", { method: "POST" }, { skipAuthRedirect: true });
  state.session = null;
  state.route = "home";
  state.selectedCity = null;
  state.selectedHospital = null;
  state.latestAppointment = null;
  state.favorites = { doctors: [], hospitals: [] };
  state.familyMembers = [];
  state.slotAvailability = {};
  history.replaceState({}, "", "/");
  render();
});

document.addEventListener("click", handleClick);
document.addEventListener("submit", handleSubmit);
document.addEventListener("input", handleInput);
document.addEventListener("change", handleChange);

init();

async function init() {
  try {
    await hydrateSession();
    if (state.session?.authenticated) {
      await Promise.all([loadCities(), loadFavorites(), loadFamilyMembers()]);
      const params = new URLSearchParams(window.location.search);
      const appointmentId = params.get("appointment");
      if (appointmentId) {
        await loadAppointmentDetails(appointmentId);
        state.route = "confirmation";
      } else if (window.location.pathname === "/admin/board" && isAdmin()) {
        state.route = "admin-board";
        await loadAdminBoard();
      } else if (/^\/doctor\/\d+\/today$/.test(window.location.pathname) && isAdmin()) {
        state.route = "doctor-today";
        await loadDoctorToday(window.location.pathname.split("/")[2]);
      } else if (window.location.pathname === "/admin" && isAdmin()) {
        state.route = "admin";
        await loadAdminData();
      } else {
        state.route = "cities";
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

async function loadAdminData() {
  const [statsPayload, cities, hospitals, doctors, appointments] = await Promise.all([
    apiFetch("/admin/stats", {}, { silent: true }),
    apiFetch("/admin/cities", {}, { silent: true }),
    apiFetch("/admin/hospitals", {}, { silent: true }),
    apiFetch("/admin/doctors", {}, { silent: true }),
    apiFetch("/admin/appointments", {}, { silent: true }),
  ]);
  state.admin.stats = statsPayload.stats;
  state.admin.chart = statsPayload.chart;
  state.admin.cities = cities;
  state.admin.hospitals = hospitals;
  state.admin.doctors = doctors;
  state.admin.appointments = appointments;
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
      if (!isAdmin() || !state.doctorDaily?.doctor_id) return;
      await Promise.all([loadDoctorToday(state.doctorDaily.doctor_id), loadAdminData()]);
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

  if (state.route === "cities") return renderCities();
  if (state.route === "hospitals") return renderHospitals();
  if (state.route === "doctors") return renderDoctors();
  if (state.route === "appointments") return renderAppointments();
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

  const titles = {
    home: ["Welcome", "Hospital Management System"],
    cities: ["Choose your city", "Find hospitals near you"],
    hospitals: ["Hospital directory", state.selectedCity?.name || "Hospitals"],
    doctors: ["Doctor availability", state.selectedHospital?.name || "Doctor directory"],
    appointments: ["My bookings", "Upcoming and past appointments"],
    confirmation: ["Booking confirmed", "Track your token live"],
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
        { id: "cities", label: "Cities", icon: "fa-city" },
        { id: "hospitals", label: "Hospitals", icon: "fa-hospital", hidden: !state.selectedCity },
        { id: "doctors", label: "Doctors", icon: "fa-user-doctor" },
        { id: "appointments", label: "My Appointments", icon: "fa-notes-medical" },
        { id: "confirmation", label: "My Queue", icon: "fa-ticket", hidden: !state.latestAppointment },
        { id: "admin", label: "Admin Panel", icon: "fa-chart-line", hidden: !isAdmin() },
        { id: "admin-board", label: "Today's Board", icon: "fa-tv", hidden: !isAdmin() },
      ]
    : [];

  sidebarNav.innerHTML = items
    .filter((item) => !item.hidden)
    .map(
      (item) => `
        <button class="nav-button ${state.route === item.id ? "active" : ""}" data-route="${item.id}" type="button">
          <i class="fa-solid ${item.icon}"></i>
          <span>${item.label}</span>
        </button>
      `
    )
    .join("");

  logoutButton.classList.toggle("hidden", !state.session?.authenticated);
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

function renderDoctors() {
  const displayedDoctors = state.doctorDirectory.length ? state.doctorDirectory : state.doctors;
  const sourceDoctors = state.doctorDirectory.length ? state.doctorDirectory : state.doctors;
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
            <span class="chip"><i class="fa-solid fa-stethoscope"></i>${escapeHtml(doctor.specialization)}</span>
            <span class="chip"><i class="fa-solid fa-users"></i>${doctor.booked_patients} booked today</span>
            ${doctor.unavailable_days ? `<span class="chip"><i class="fa-solid fa-calendar-xmark"></i>${escapeHtml(formatUnavailableDays(doctor.unavailable_days))}</span>` : ""}
          </div>
          <h3>${escapeHtml(doctor.name)}</h3>
          <p class="card__meta"><i class="fa-regular fa-clock"></i> ${formatTimeRange(doctor.available_from, doctor.available_to)}</p>
          <p class="card__meta"><i class="fa-solid fa-hospital"></i> ${escapeHtml(doctor.hospital_name)}${doctor.city_name ? ` • ${escapeHtml(doctor.city_name)}` : ""}</p>
          ${doctor.availability_note ? `<p class="card__meta"><i class="fa-solid fa-circle-info"></i> ${escapeHtml(doctor.availability_note)}</p>` : ""}
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
              <input aria-label="Appointment date" class="full" name="date" type="date" min="${todayDate()}" required />
            </div>
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
              <p class="card__meta"><i class="fa-solid fa-stethoscope"></i> ${escapeHtml(appointment.specialization || "")}</p>
              <p class="card__meta"><i class="fa-solid fa-calendar-day"></i> ${formatDate(appointment.appointment_date)} • Token ${appointment.token_number}</p>
              <p class="card__meta"><i class="fa-regular fa-clock"></i> ${escapeHtml(formatAppointmentSlot(appointment))}</p>
              ${appointment.family_member_name ? `<p class="card__meta"><i class="fa-solid fa-people-group"></i> Booked for ${escapeHtml(appointment.family_member_name)}${appointment.family_relation ? ` • ${escapeHtml(appointment.family_relation)}` : ""}</p>` : ""}
              <p class="card__meta"><i class="fa-solid fa-location-dot"></i> ${escapeHtml(appointment.hospital_location || "")}</p>
              <div class="help-strip">
                ${appointment.hospital_contact_phone ? `<span><i class="fa-solid fa-phone"></i> ${escapeHtml(appointment.hospital_contact_phone)}</span>` : ""}
                ${appointment.hospital_map_link ? `<a href="${escapeAttribute(appointment.hospital_map_link)}" target="_blank" rel="noreferrer">Open map</a>` : ""}
              </div>
              ${
                active
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
                  : `
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
    state.route = "cities";
    return render();
  }
  const queue = await loadQueue().catch(() => null);
  const appointment = state.latestAppointment;
  app.innerHTML = `
    <section class="page-grid">
      <div class="stat-grid">
        <article class="stat-card"><p class="eyebrow">Hospital</p><strong>${escapeHtml(appointment.hospital_name)}</strong><span>${escapeHtml(appointment.hospital_location)}</span></article>
        <article class="stat-card"><p class="eyebrow">Doctor</p><strong>${escapeHtml(appointment.doctor_name)}</strong><span>${escapeHtml(appointment.specialization || "")}</span></article>
        <article class="stat-card"><p class="eyebrow">Appointment date</p><strong>${formatDate(appointment.appointment_date)}</strong><span>Token ${appointment.token_number}</span></article>
        <article class="stat-card"><p class="eyebrow">Appointment slot</p><strong>${escapeHtml(formatAppointmentSlot(appointment))}</strong><span>Selected fixed slot for this doctor</span></article>
      </div>
      <article class="queue-card">
        <div class="section-header">
          <div><p class="eyebrow">Booking confirmation</p><h3>Your token is reserved</h3><p>${appointment.patients_before} patients were ahead when you booked.</p></div>
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
          <div class="list-card"><p class="eyebrow">Patient</p><h3>${escapeHtml(appointment.user_name)}</h3><p>${escapeHtml(appointment.mobile)}</p>${appointment.family_member_name ? `<p class="card__meta"><i class="fa-solid fa-people-group"></i>${escapeHtml(appointment.family_member_name)}${appointment.family_relation ? ` • ${escapeHtml(appointment.family_relation)}` : ""}</p>` : ""}</div>
          <div class="list-card"><p class="eyebrow">Token number</p><div class="queue-pill">${appointment.token_number}</div>${statusBadge(appointment.status)}</div>
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
        <p class="card__meta"><i class="fa-solid fa-envelope"></i> Reminder emails will be sent to ${escapeHtml(state.session.user.email || "your Google account")} before the appointment.</p>
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
            <p class="eyebrow">Add hospital</p><h3>Register a new hospital</h3>
            <form data-form="add-hospital">
              <div class="form-grid">
                <input name="name" type="text" placeholder="Hospital name" required />
                <select name="city_id" required><option value="">Select city</option>${state.admin.cities.map((city) => `<option value="${city.id}">${escapeHtml(city.name)}</option>`).join("")}</select>
                <input class="full" name="location" type="text" placeholder="Location" required />
                <input class="full" name="image" type="url" placeholder="Image URL" />
                <input name="contact_phone" type="tel" placeholder="Contact phone" />
                <input name="map_link" type="url" placeholder="Google Maps link" />
              </div>
              <p class="form-feedback" aria-live="polite"></p>
              <div class="form-actions"><button class="primary-button" type="submit"><i class="fa-solid fa-plus"></i><span>Add Hospital</span></button></div>
            </form>
          </article>
          <article class="form-card">
            <p class="eyebrow">Add doctor</p><h3>${state.editingDoctorId ? "Edit doctor profile" : "Create doctor profile"}</h3>
            <form data-form="doctor-form">
              <div class="form-grid">
                <input name="name" type="text" placeholder="Doctor name" required />
                <input name="specialization" type="text" placeholder="Specialization" required />
                <select name="hospital_id" required><option value="">Select hospital</option>${state.admin.hospitals.map((hospital) => `<option value="${hospital.id}">${escapeHtml(hospital.name)} • ${escapeHtml(hospital.city_name)}</option>`).join("")}</select>
                <input name="image" type="url" placeholder="Image URL" />
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
        </div>
        <article class="chart-card">
          <p class="eyebrow">Appointment trend</p><h3>Top hospitals by bookings</h3>
          <div class="chart-bars">${chartBars()}</div>
        </article>
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
        <div class="section-header"><div><p class="eyebrow">Appointments</p><h3>Visible appointment table</h3><p>See patient, hospital, doctor, date, token, and status together.</p></div></div>
        ${appointmentsTable()}
      </article>
    </section>
  `;
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
          <p>${escapeHtml(doctor.specialization || "")}</p>
        </div>
        <div class="queue-pill">${doctor.now_serving ?? "No queue"}</div>
      </div>
      <p class="card__meta"><strong>Now Serving:</strong> ${doctor.now_serving ?? "Not started"}</p>
      ${doctor.appointments.length ? `
        <table class="compact-table">
          <thead><tr><th>Token</th><th>Patient</th><th>Status</th></tr></thead>
          <tbody>
            ${doctor.appointments.map((item) => `
              <tr>
                <td>${item.token_number}</td>
                <td>${escapeHtml(item.user_name)}</td>
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
          <p>${escapeHtml(state.doctorDaily.specialization || "")}</p>
        </div>
        <div class="queue-pill">${state.doctorDaily.now_serving ?? "No queue"}</div>
      </div>
      <article class="table-card">
        <div class="section-header">
          <div>
            <p class="eyebrow">Today's patients</p>
            <h3>Sorted by token</h3>
            <p>Quick OPD workflow for this doctor.</p>
          </div>
        </div>
        ${doctorTodayTable()}
      </article>
    </section>
  `;
}

function chartBars() {
  if (!state.admin.chart.length) return emptyState("No appointment data available yet.");
  const max = Math.max(...state.admin.chart.map((item) => item.bookings), 1);
  return state.admin.chart
    .map(
      (item) => `
        <div class="bar-row">
          <div class="card__meta"><strong>${escapeHtml(item.name)}</strong><span>${item.bookings} bookings</span></div>
          <div class="bar-track"><div class="bar-fill" style="width:${(item.bookings / max) * 100}%"></div></div>
        </div>
      `
    )
    .join("");
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
                <td class="table-actions"><button class="danger-button" data-action="delete-hospital" data-id="${hospital.id}" type="button">Delete</button></td>
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
      <thead><tr><th>Name</th><th>Specialization</th><th>Hospital</th><th>Time</th><th>Availability</th><th>Action</th></tr></thead>
      <tbody>
        ${state.admin.doctors
          .map(
            (doctor) => `
              <tr>
                <td>${escapeHtml(doctor.name)}</td>
                <td>${escapeHtml(doctor.specialization)}</td>
                <td>${escapeHtml(doctor.hospital_name)}</td>
                <td>${formatTimeRange(doctor.available_from, doctor.available_to)}</td>
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
  const hospitals = [...new Set(state.admin.appointments.map((item) => item.hospital_name))].sort();
  const doctors = [...new Set(state.admin.appointments.map((item) => item.doctor_name))].sort();

  return `
    <div class="search-row table-toolbar">
      <input id="adminAppointmentDateFilter" type="date" value="${escapeHtml(state.admin.appointmentFilters.date)}" />
      <select id="adminAppointmentHospitalFilter">
        <option value="">All hospitals</option>
        ${hospitals.map((item) => `<option value="${escapeHtml(item)}" ${state.admin.appointmentFilters.hospital === item ? "selected" : ""}>${escapeHtml(item)}</option>`).join("")}
      </select>
      <select id="adminAppointmentDoctorFilter">
        <option value="">All doctors</option>
        ${doctors.map((item) => `<option value="${escapeHtml(item)}" ${state.admin.appointmentFilters.doctor === item ? "selected" : ""}>${escapeHtml(item)}</option>`).join("")}
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
            <thead><tr><th>Patient</th><th>Mobile</th><th>Hospital</th><th>Doctor</th><th>Date</th><th>Token</th><th>Status</th><th>Queue Control</th><th>Doctor View</th></tr></thead>
            <tbody>
              ${filteredAppointments
                .map(
                  (appointment) => `
                    <tr>
                      <td>${escapeHtml(appointment.user_name)}</td>
                      <td>${escapeHtml(appointment.mobile)}</td>
                      <td>${escapeHtml(appointment.hospital_name)}<br><span class="table-subtext">${escapeHtml(appointment.city_name)}</span></td>
                      <td>${escapeHtml(appointment.doctor_name)}<br><span class="table-subtext">${escapeHtml(appointment.specialization || "")}</span></td>
                      <td>${formatDate(appointment.appointment_date)}</td>
                      <td>${appointment.token_number}</td>
                      <td>${statusBadge(appointment.status)}</td>
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
      <thead><tr><th>Token</th><th>Patient</th><th>Mobile</th><th>Status</th><th>Action</th></tr></thead>
      <tbody>
        ${state.doctorDaily.appointments.map((item) => `
          <tr>
            <td>${item.token_number}</td>
            <td>${escapeHtml(item.user_name)}</td>
            <td>${escapeHtml(item.mobile || "")}</td>
            <td>${statusBadge(item.status)}</td>
            <td class="table-actions">
              ${renderStatusActionButton(item, "serving", "Serving")}
              ${renderStatusActionButton(item, "completed", "Complete")}
              ${renderStatusActionButton(item, "skipped", "Skip")}
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

async function handleClick(event) {
  const routeTarget = event.target.closest("[data-route]");
  const actionTarget = event.target.closest("[data-action]");

  if (routeTarget) {
    state.route = routeTarget.dataset.route;
    if (state.route === "admin") await loadAdminData();
    if (state.route === "admin-board") await Promise.all([loadAdminBoard(), loadAdminData()]);
    if (state.route === "appointments") await loadMyAppointments();
    if (state.route === "confirmation" && state.latestAppointment?.id) {
      await loadAppointmentDetails(state.latestAppointment.id);
      history.replaceState({}, "", `/?appointment=${state.latestAppointment.id}`);
    } else if (state.route === "admin") {
      history.replaceState({}, "", "/admin");
    } else if (state.route === "admin-board") {
      history.replaceState({}, "", "/admin/board");
    } else if (!["doctor-today"].includes(state.route)) {
      history.replaceState({}, "", "/");
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

  if (action === "open-city") {
    state.selectedCity = { id: Number(actionTarget.dataset.cityId), name: actionTarget.dataset.cityName };
    state.filters.cityId = String(state.selectedCity.id);
    state.filters.hospitalId = "";
    await loadHospitals(state.selectedCity.id);
    state.route = "hospitals";
    render();
  }

  if (action === "open-hospital") {
    state.selectedHospital = state.hospitals.find((item) => item.id === Number(actionTarget.dataset.id));
    state.filters.cityId = String(state.selectedHospital?.city_id || state.selectedCity?.id || "");
    state.filters.hospitalId = String(state.selectedHospital?.id || "");
    await loadDoctors(state.selectedHospital.id);
    await loadDoctorDirectory();
    state.route = "doctors";
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

  if (action === "cancel-appointment") {
    await apiFetch(`/appointment/${actionTarget.dataset.appointmentId}/cancel`, { method: "POST" });
    await loadMyAppointments();
    if (state.latestAppointment?.id === Number(actionTarget.dataset.appointmentId)) {
      await loadAppointmentDetails(actionTarget.dataset.appointmentId);
    }
    render();
    showToast("Appointment cancelled");
  }

  if (action === "delete-hospital") {
    await apiFetch(`/admin/delete-hospital/${actionTarget.dataset.id}`, { method: "POST" });
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

  if (action === "cancel-edit") {
    state.editingDoctorId = null;
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
    state.filters.hospitalId = "";
    await loadHospitals(hospital.city_id);
    state.route = "hospitals";
    history.replaceState({}, "", "/");
    render();
  }

  if (action === "open-favorite-doctor") {
    const doctor = state.favorites.doctors.find((item) => String(item.id) === String(actionTarget.dataset.doctorId));
    if (!doctor) return;
    state.selectedCity = { id: Number(doctor.city_id), name: doctor.city_name };
    state.filters.cityId = String(doctor.city_id);
    await loadHospitals(doctor.city_id);
    state.selectedHospital = state.hospitals.find((item) => String(item.id) === String(doctor.hospital_id)) || null;
    state.filters.hospitalId = String(doctor.hospital_id);
    if (state.selectedHospital) {
      await loadDoctors(state.selectedHospital.id);
    }
    await loadDoctorDirectory();
    state.route = "doctors";
    history.replaceState({}, "", "/");
    render();
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
    render();
  }

  if (action === "export-appointments") {
    exportAppointmentsCsv(getFilteredAdminAppointments());
    showToast("Appointment report downloaded.");
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
      const selectedDoctor = (state.doctorDirectory.length ? state.doctorDirectory : state.doctors).find(
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
      state.route = "confirmation";
      history.replaceState({}, "", `/?appointment=${booking.id}`);
      render();
      showToast(`Appointment booked. Your token is ${booking.token_number}.`);
    }

    if (form.dataset.form === "reschedule-appointment") {
      await apiFetch(`/appointment/${data.appointment_id}/reschedule`, {
        method: "POST",
        body: JSON.stringify({ date: data.date }),
      });
      state.slotAvailability = {};
      await loadMyAppointments();
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

    if (form.dataset.form === "add-hospital") {
      await apiFetch("/admin/add-hospital", { method: "POST", body: JSON.stringify(data) });
      form.reset();
      await loadAdminData();
      render();
      showToast("Hospital added");
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
  } catch (error) {
    setFormFeedback(form, error.message);
    showToast(error.message, "error");
  }
}

function handleInput(event) {
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
    render();
  }

  if (event.target.id === "adminAppointmentHospitalFilter") {
    state.admin.appointmentFilters.hospital = event.target.value;
    render();
  }

  if (event.target.id === "adminAppointmentDoctorFilter") {
    state.admin.appointmentFilters.doctor = event.target.value;
    render();
  }

  if (event.target.id === "adminAppointmentStatusFilter") {
    state.admin.appointmentFilters.status = event.target.value;
    render();
  }
}

function fillDoctorForm() {
  const doctor = state.admin.doctors.find((item) => item.id === state.editingDoctorId);
  const form = document.querySelector('[data-form="doctor-form"]');
  if (!doctor || !form) return;
  form.name.value = doctor.name;
  form.specialization.value = doctor.specialization;
  form.hospital_id.value = doctor.hospital_id;
  form.image.value = doctor.image || "";
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

function updateThemeLabel() {
  themeToggle.innerHTML =
    state.theme === "dark"
      ? '<i class="fa-solid fa-sun"></i><span>Light mode</span>'
      : '<i class="fa-solid fa-moon"></i><span>Dark mode</span>';
}

function isAdmin() {
  const user = state.session?.user;
  return Boolean(user && (user.role === "admin" || user.email === ADMIN_EMAIL));
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

function validateBookingData(data) {
  if (!data.family_member_id && !data.name?.trim()) return "Patient name is required.";
  if (!/^[0-9]{10}$/.test((data.mobile || "").replace(/\D/g, ""))) return "Enter a valid 10-digit mobile number.";
  if (!data.date) return "Please select an appointment date.";
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
  return doctor.availability_note ? `${days} - ${doctor.availability_note}` : days;
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

  if (feedback) {
    feedback.textContent = slotResponse.nextSlot
      ? ""
      : "All fixed slots are already booked for this date. Please choose another day.";
  }
  previewNode.textContent = slotResponse.nextSlot
    ? `Next automatic slot: Token ${slotResponse.nextSlot.slotNumber} • ${slotResponse.nextSlot.label}`
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

function getFilteredAdminAppointments() {
  return state.admin.appointments.filter((appointment) => {
    const filters = state.admin.appointmentFilters;
    if (filters.date && appointment.appointment_date !== filters.date) return false;
    if (filters.hospital && appointment.hospital_name !== filters.hospital) return false;
    if (filters.doctor && appointment.doctor_name !== filters.doctor) return false;
    if (filters.status && (appointment.status || "").toLowerCase() !== filters.status) return false;
    return true;
  });
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
      !["completed", "cancelled", "skipped", "serving"].includes(status)
  );
}

function statusBadge(status) {
  const normalized = (status || "pending").toLowerCase();
  return `<span class="chip status-badge status-badge--${normalized}">${escapeHtml(formatStatusLabel(normalized))}</span>`;
}

function capitalize(value) {
  return String(value || "").charAt(0).toUpperCase() + String(value || "").slice(1);
}

function formatStatusLabel(value) {
  return String(value || "")
    .split("_")
    .filter(Boolean)
    .map((part) => capitalize(part))
    .join(" ");
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
          <div class="row"><strong>Date:</strong> ${escapeHtml(formatDate(appointment.appointment_date))}</div>
          <div class="row"><strong>Time Slot:</strong> ${escapeHtml(formatAppointmentSlot(appointment))}</div>
          <div class="row"><strong>Patient:</strong> ${escapeHtml(appointment.user_name)}</div>
          ${
            appointment.family_member_name
              ? `<div class="row"><strong>Booked For:</strong> ${escapeHtml(appointment.family_member_name)}${appointment.family_relation ? ` • ${escapeHtml(appointment.family_relation)}` : ""}</div>`
              : ""
          }
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

function exportAppointmentsCsv(appointments) {
  const rows = [
    ["Patient", "Mobile", "Hospital", "Doctor", "Date", "Token", "Status"],
    ...appointments.map((appointment) => [
      appointment.user_name,
      appointment.mobile,
      appointment.hospital_name,
      appointment.doctor_name,
      appointment.appointment_date,
      appointment.token_number,
      appointment.status,
    ]),
  ];
  const csv = rows
    .map((row) =>
      row
        .map((value) => `"${String(value ?? "").replace(/"/g, '""')}"`)
        .join(",")
    )
    .join("\n");
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `appointments-${todayDate()}.csv`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
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
