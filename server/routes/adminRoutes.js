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
  addHospital,
  updateHospital,
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
  listStaff,
  upsertStaff,
  deactivateStaff,
  reactivateStaff,
  listAuditLogs,
} = require("../controllers/staffController");
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
router.post("/admin/update-hospital/:id", adminOnly, updateHospital);
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

// Staff accounts + audit trail: admin only
router.get("/admin/staff", adminOnly, listStaff);
router.post("/admin/staff", adminOnly, upsertStaff);
router.post("/admin/staff/:id/deactivate", adminOnly, deactivateStaff);
router.post("/admin/staff/:id/reactivate", adminOnly, reactivateStaff);
router.get("/admin/audit-logs", adminOnly, listAuditLogs);

module.exports = router;
