const GLOBAL_SLOT_START_TIME = process.env.GLOBAL_SLOT_START_TIME || "10:00";
const DEFAULT_SLOT_STEP_MINUTES = Number(process.env.GLOBAL_SLOT_STEP_MINUTES || 15);
const DEFAULT_SLOT_DURATION_MINUTES = Number(process.env.GLOBAL_SLOT_DURATION_MINUTES || 15);
const ACTIVE_QUEUE_STATUSES = ["booked", "pending", "checked_in", "serving"];

function normalizeTime(value) {
  return String(value || "00:00").slice(0, 5);
}

function timeToMinutes(value) {
  const [hours, minutes] = normalizeTime(value).split(":");
  return Number(hours) * 60 + Number(minutes);
}

function minutesToTime(totalMinutes) {
  const normalized = ((Number(totalMinutes) % 1440) + 1440) % 1440;
  const hours = Math.floor(normalized / 60);
  const minutes = normalized % 60;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
}

function buildDoctorSlots({
  availableTo,
}) {
  const fromMinutes = timeToMinutes(GLOBAL_SLOT_START_TIME);
  const toMinutes = availableTo
    ? Math.max(timeToMinutes(availableTo), fromMinutes + DEFAULT_SLOT_DURATION_MINUTES)
    : fromMinutes + DEFAULT_SLOT_STEP_MINUTES * 24;
  const stepMinutes = DEFAULT_SLOT_STEP_MINUTES;
  const durationMinutes = DEFAULT_SLOT_DURATION_MINUTES;
  const slots = [];
  let cursor = fromMinutes;
  let slotNumber = 1;

  while (cursor + durationMinutes <= toMinutes) {
    slots.push({
      slotNumber,
      startTime: minutesToTime(cursor),
      endTime: minutesToTime(cursor + durationMinutes),
    });
    cursor += stepMinutes;
    slotNumber += 1;
  }

  return slots;
}

module.exports = {
  ACTIVE_QUEUE_STATUSES,
  DEFAULT_SLOT_DURATION_MINUTES,
  DEFAULT_SLOT_STEP_MINUTES,
  GLOBAL_SLOT_START_TIME,
  buildDoctorSlots,
  minutesToTime,
  normalizeTime,
  timeToMinutes,
};
