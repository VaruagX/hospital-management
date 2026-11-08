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
const {
  createPatient, getMyPatient, listMyPatients, myPatientHistory, updateMyPatient,
} = require("../controllers/patientRecordsController");
const { createOrder, myPayments, verifyPayment, webhook } = require("../controllers/paymentController");
const { getReceipt, pdfReceipt, printReceipt } = require("../controllers/receiptController");
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

// Patient records (owner only)
router.get("/patients", requireAuth, listMyPatients);
router.post("/patients", requireAuth, createPatient);
router.get("/patients/:id", requireAuth, getMyPatient);
router.post("/patients/:id", requireAuth, updateMyPatient);
router.get("/patients/:id/appointments", requireAuth, myPatientHistory);

// Payments + receipts. The webhook is authenticated by its HMAC signature, not a session.
router.post("/payments/order", requireAuth, createOrder);
router.post("/payments/verify", requireAuth, verifyPayment);
router.get("/payments/my", requireAuth, myPayments);
router.post("/payments/webhook", webhook);
router.get("/receipts/:appointmentId", requireAuth, getReceipt);
router.get("/receipts/:appointmentId/print", requireAuth, printReceipt);
router.get("/receipts/:appointmentId/pdf", requireAuth, pdfReceipt);

module.exports = router;
