const express = require("express");
const {
  getCities,
  getHospitalsByCity,
  getDoctorsByHospital,
  getDoctorDirectory,
  getDoctorDetails,
  getHospitalDetails,
  getAppointmentDetails,
  getMyAppointments,
  getNotifications,
  getProfile,
  getQueueStatus,
  markNotificationsRead,
  updateProfile,
} = require("../controllers/dataController");
const {
  createAppointment,
  cancelAppointment,
  rescheduleAppointment,
  checkInAppointment,
} = require("../controllers/bookingController");
const {
  getDoctorSlots,
  getFavorites,
  toggleFavoriteDoctor,
  toggleFavoriteHospital,
  getFamilyMembers,
  addFamilyMember,
} = require("../controllers/patientController");
const { requireAuth } = require("../middleware/auth");

const router = express.Router();

router.get("/cities", requireAuth, getCities);
router.get("/hospitals/:cityId", requireAuth, getHospitalsByCity);
router.get("/hospital/:hospitalId/details", requireAuth, getHospitalDetails);
router.get("/doctors/:hospitalId", requireAuth, getDoctorsByHospital);
router.get("/directory/doctors", requireAuth, getDoctorDirectory);
router.get("/doctor/:doctorId/details", requireAuth, getDoctorDetails);
router.get("/doctor/:doctorId/slots", requireAuth, getDoctorSlots);
router.post("/book", requireAuth, createAppointment);
router.get("/profile", requireAuth, getProfile);
router.post("/profile", requireAuth, updateProfile);
router.get("/appointments/my", requireAuth, getMyAppointments);
router.post("/appointment/:appointmentId/cancel", requireAuth, cancelAppointment);
router.post("/appointment/:appointmentId/reschedule", requireAuth, rescheduleAppointment);
router.post("/appointment/:appointmentId/check-in", requireAuth, checkInAppointment);
router.get("/queue/:doctorId/:date", requireAuth, getQueueStatus);
router.get("/appointment/:appointmentId", requireAuth, getAppointmentDetails);
router.get("/notifications", requireAuth, getNotifications);
router.post("/notifications/read", requireAuth, markNotificationsRead);
router.get("/favorites", requireAuth, getFavorites);
router.post("/favorites/doctors/:doctorId", requireAuth, toggleFavoriteDoctor);
router.post("/favorites/hospitals/:hospitalId", requireAuth, toggleFavoriteHospital);
router.get("/family-members", requireAuth, getFamilyMembers);
router.post("/family-members", requireAuth, addFamilyMember);

module.exports = router;
