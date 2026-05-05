const express = require("express");
const {
  getAdminDashboard,
  getAdminCities,
  addCity,
  getAdminHospitals,
  getAdminDoctors,
  getAdminAppointments,
  updateAppointmentStatus,
  getTodayBoard,
  getDoctorToday,
  addHospital,
  addDoctor,
  updateDoctor,
  deleteHospital,
  deleteDoctor,
} = require("../controllers/adminController");
const { requireAdmin } = require("../middleware/auth");

const router = express.Router();

router.get("/admin/stats", requireAdmin, getAdminDashboard);
router.get("/admin/cities", requireAdmin, getAdminCities);
router.post("/admin/add-city", requireAdmin, addCity);
router.get("/admin/hospitals", requireAdmin, getAdminHospitals);
router.get("/admin/doctors", requireAdmin, getAdminDoctors);
router.get("/admin/appointments", requireAdmin, getAdminAppointments);
router.get("/admin/board-data", requireAdmin, getTodayBoard);
router.get("/doctor/:id/today-data", requireAdmin, getDoctorToday);
router.post("/admin/appointment/:id/status", requireAdmin, updateAppointmentStatus);
router.post("/admin/add-hospital", requireAdmin, addHospital);
router.post("/admin/add-doctor", requireAdmin, addDoctor);
router.post("/admin/update-doctor/:id", requireAdmin, updateDoctor);
router.post("/admin/delete-hospital/:id", requireAdmin, deleteHospital);
router.post("/admin/delete-doctor/:id", requireAdmin, deleteDoctor);

module.exports = router;
