const express = require("express");
const {
  getAdminDashboard,
  getAdminCities,
  getAdminDepartments,
  addCity,
  getAdminHospitals,
  getAdminDoctors,
  getAdminAppointments,
  updateAppointmentStatus,
  updateAppointmentNotes,
  getTodayBoard,
  getDoctorToday,
  addDoctor,
  updateDoctor,
  getDoctorLeaves,
  addDoctorLeave,
  deleteDoctorLeave,
  exportAdminAppointmentsCsv,
  deleteHospital,
  deleteDoctor,
  reactivateHospital,
  reactivateDoctor,
} = require("../controllers/adminController");
const {
  addDepartment,
  addHospital,
  deactivateCity,
  getHospitalDepartments,
  getMedia,
  listCityStats,
  reactivateCity,
  setHospitalDepartments,
  updateCity,
  updateHospital,
  uploadMedia,
} = require("../controllers/catalogController");
const {
  listStaff,
  upsertStaff,
  deactivateStaff,
  reactivateStaff,
  listAuditLogs,
} = require("../controllers/staffController");
const { staffGetPatient, staffListPatients } = require("../controllers/patientRecordsController");
const { staffListPayments, staffRefund } = require("../controllers/paymentController");
const { requireRoles } = require("../middleware/auth");

const router = express.Router();

// Role groups. Data scope (own hospital / own doctor) is enforced inside the handlers.
const adminOnly = requireRoles("admin");
const hospitalManagers = requireRoles("admin", "hospital_admin");
const queueStaff = requireRoles("admin", "hospital_admin", "receptionist", "doctor");
const clinicians = requireRoles("admin", "doctor");

// Global configuration: admin only
router.get("/admin/stats", adminOnly, getAdminDashboard);
router.get("/admin/cities", hospitalManagers, getAdminCities);
router.post("/admin/add-city", adminOnly, addCity);
router.get("/admin/hospitals", adminOnly, getAdminHospitals);
router.post("/admin/add-hospital", adminOnly, addHospital);
router.post("/admin/update-hospital/:id", hospitalManagers, updateHospital); // hospital admins: own hospital only
router.get("/admin/cities/stats", adminOnly, listCityStats);
router.post("/admin/cities/:id", adminOnly, updateCity);
router.post("/admin/cities/:id/deactivate", adminOnly, deactivateCity);
router.post("/admin/cities/:id/reactivate", adminOnly, reactivateCity);
router.post("/admin/departments", adminOnly, addDepartment);
router.post("/admin/hospitals/:id/departments", hospitalManagers, setHospitalDepartments);
router.post(
  "/admin/media",
  hospitalManagers,
  express.raw({ type: ["image/png", "image/jpeg", "image/webp"], limit: "2mb" }),
  uploadMedia
);
router.post("/admin/delete-hospital/:id", adminOnly, deleteHospital); // deactivates; nothing is deleted
router.post("/admin/reactivate-hospital/:id", adminOnly, reactivateHospital);

// Doctors, schedules, leaves: admin + hospital admin (own hospital)
router.get("/admin/departments", hospitalManagers, getAdminDepartments);
router.get("/admin/doctors", hospitalManagers, getAdminDoctors);
router.post("/admin/add-doctor", hospitalManagers, addDoctor);
router.post("/admin/update-doctor/:id", hospitalManagers, updateDoctor);
router.post("/admin/delete-doctor/:id", hospitalManagers, deleteDoctor); // deactivates; nothing is deleted
router.post("/admin/reactivate-doctor/:id", hospitalManagers, reactivateDoctor);
router.get("/admin/doctor-leaves", hospitalManagers, getDoctorLeaves);
router.post("/admin/doctor-leaves", hospitalManagers, addDoctorLeave);
router.post("/admin/doctor-leaves/:id/delete", hospitalManagers, deleteDoctorLeave);

// Queue / appointments: scoped per role inside the handlers
router.get("/admin/appointments", queueStaff, getAdminAppointments);
router.get("/admin/appointments/export", hospitalManagers, exportAdminAppointmentsCsv);
router.get("/admin/board-data", queueStaff, getTodayBoard);
router.get("/doctor/:id/today-data", queueStaff, getDoctorToday);
router.post("/admin/appointment/:id/status", queueStaff, updateAppointmentStatus);
router.post("/admin/appointment/:id/visit-notes", clinicians, updateAppointmentNotes);

// Patients (scoped to the staff member's doctor/hospital) and payments
router.get("/admin/patients", queueStaff, staffListPatients);
router.get("/admin/patients/:id", queueStaff, staffGetPatient);
router.get("/admin/payments", hospitalManagers, staffListPayments);
router.post("/admin/payments/:id/refund", hospitalManagers, staffRefund);

// Staff accounts + audit trail: admin only
router.get("/admin/staff", adminOnly, listStaff);
router.post("/admin/staff", adminOnly, upsertStaff);
router.post("/admin/staff/:id/deactivate", adminOnly, deactivateStaff);
router.post("/admin/staff/:id/reactivate", adminOnly, reactivateStaff);
router.get("/admin/audit-logs", adminOnly, listAuditLogs);

// Public read endpoints used by every page that shows an uploaded image / hospital departments.
router.get("/media/:id", getMedia);
router.get("/hospital/:id/departments", getHospitalDepartments);

module.exports = router;
