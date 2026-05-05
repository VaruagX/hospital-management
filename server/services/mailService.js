const nodemailer = require("nodemailer");

let transporter;

function getMailerConfig() {
  return {
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 587),
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
    from: process.env.SMTP_FROM || process.env.SMTP_USER,
  };
}

function canSendMail() {
  const config = getMailerConfig();
  return Boolean(config.host && config.port && config.user && config.pass && config.from);
}

function getTransporter() {
  if (!transporter) {
    const config = getMailerConfig();
    transporter = nodemailer.createTransport({
      host: config.host,
      port: config.port,
      secure: config.port === 465,
      auth: {
        user: config.user,
        pass: config.pass,
      },
    });
  }

  return transporter;
}

async function sendAppointmentReminder({
  email,
  patientName,
  bookingName,
  hospitalName,
  doctorName,
  appointmentDate,
  slotLabel,
}) {
  if (!canSendMail()) {
    return { skipped: true, reason: "SMTP is not configured" };
  }

  await getTransporter().sendMail({
    from: getMailerConfig().from,
    to: email,
    subject: `Reminder: ${doctorName} at ${hospitalName}`,
    html: `
      <div style="font-family: Arial, sans-serif; color: #222; line-height: 1.6;">
        <h2 style="margin-bottom: 12px;">PulseCare HMS Appointment Reminder</h2>
        <p>Hello ${escapeMailHtml(patientName || "Patient")},</p>
        <p>This is a reminder for your upcoming appointment.</p>
        <ul>
          <li><strong>Booked for:</strong> ${escapeMailHtml(bookingName || patientName || "Patient")}</li>
          <li><strong>Hospital:</strong> ${escapeMailHtml(hospitalName)}</li>
          <li><strong>Doctor:</strong> ${escapeMailHtml(doctorName)}</li>
          <li><strong>Date:</strong> ${escapeMailHtml(appointmentDate)}</li>
          <li><strong>Time Slot:</strong> ${escapeMailHtml(slotLabel)}</li>
        </ul>
        <p>Please arrive a little early for check-in.</p>
      </div>
    `,
  });

  return { sent: true };
}

function escapeMailHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

module.exports = {
  canSendMail,
  sendAppointmentReminder,
};
