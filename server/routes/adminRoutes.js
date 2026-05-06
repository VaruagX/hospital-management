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
} = require("../controllers/adminController");
const { requireAdmin, requireStaff } = require("../middleware/auth");

const router = express.Router();

router.get("/admin/stats", requireAdmin, getAdminDashboard);
router.get("/admin/cities", requireAdmin, getAdminCities);
router.get("/admin/departments", requireAdmin, getAdminDepartments);
router.post("/admin/add-city", requireAdmin, addCity);
router.get("/admin/hospitals", requireAdmin, getAdminHospitals);
router.post("/admin/update-hospital/:id", requireAdmin, updateHospital);
router.get("/admin/doctors", requireAdmin, getAdminDoctors);
router.get("/admin/appointments", requireAdmin, getAdminAppointments);
router.get("/admin/appointments/export", requireAdmin, exportAdminAppointmentsCsv);
router.get("/admin/doctor-leaves", requireAdmin, getDoctorLeaves);
router.post("/admin/doctor-leaves", requireAdmin, addDoctorLeave);
router.post("/admin/doctor-leaves/:id/delete", requireAdmin, deleteDoctorLeave);
router.get("/admin/board-data", requireAdmin, getTodayBoard);
router.get("/doctor/:id/today-data", requireStaff, getDoctorToday);
router.post("/admin/appointment/:id/status", requireAdmin, updateAppointmentStatus);
router.post("/admin/appointment/:id/visit-notes", requireStaff, updateAppointmentNotes);
router.post("/admin/add-hospital", requireAdmin, addHospital);
router.post("/admin/add-doctor", requireAdmin, addDoctor);
router.post("/admin/update-doctor/:id", requireAdmin, updateDoctor);
router.post("/admin/delete-hospital/:id", requireAdmin, deleteHospital);
router.post("/admin/delete-doctor/:id", requireAdmin, deleteDoctor);

module.exports = router;
