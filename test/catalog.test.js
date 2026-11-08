const { test, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const { pool, resetDb, startApp, seedWorld, dateOffset } = require("./helpers");

let app;
let w;
before(async () => { app = await startApp(); });
after(async () => { await app.close(); await pool.end(); });
beforeEach(async () => { await resetDb(); w = await seedWorld(); });

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 1)]);
const rawPost = (url, as, body, type = "image/png") =>
  fetch(app.base + url, { method: "POST", headers: { "content-type": type, "x-test-user": String(as) }, body });

const hospitalBody = (cityId, extra = {}) => ({
  name: "XYZ Hospital", city_id: cityId, location: "Andheri", address: "1 Main Rd, Mumbai 400058",
  description: "Multispeciality", contact_phone: "+91 22 5555 0000", email: "Care@XYZ.test",
  opens_at: "08:00", closes_at: "20:00", ...extra,
});

// ---- cities --------------------------------------------------------------------------
test("admin adds any city dynamically, edits it, and duplicates are refused", async () => {
  for (const name of ["Mumbai", "Pune", "Nashik"]) {
    assert.equal((await app.call("POST", "/admin/add-city", { as: w.admin, body: { name } })).status, 201);
  }
  assert.equal((await app.call("POST", "/admin/add-city", { as: w.admin, body: { name: "mumbai" } })).status, 409);
  const { rows } = await pool.query("SELECT id FROM cities WHERE name = 'Pune'");
  const edit = await app.call("POST", `/admin/cities/${rows[0].id}`, { as: w.admin, body: { name: "Pune City" } });
  assert.equal(edit.json.name, "Pune City");
  assert.equal((await app.call("POST", `/admin/cities/${rows[0].id}`, { as: w.admin, body: { name: "Mumbai" } })).status, 409);
  assert.equal((await app.call("POST", "/admin/cities/9999", { as: w.admin, body: { name: "Zed" } })).status, 404);
  assert.equal((await app.call("POST", `/admin/cities/${rows[0].id}`, { as: w.admin, body: { name: "" } })).status, 400);
});

test("city stats: search, hospital/doctor/appointment counts, pagination", async () => {
  const all = await app.call("GET", "/admin/cities/stats", { as: w.admin });
  assert.equal(all.status, 200);
  const testville = all.json.items.find((c) => c.name === "Testville");
  assert.equal(testville.hospital_count, 2);
  assert.equal(testville.doctor_count, 3);
  assert.equal(testville.appointment_count, 3);
  await app.call("POST", "/admin/add-city", { as: w.admin, body: { name: "Nagpur" } });
  const found = await app.call("GET", "/admin/cities/stats?q=nag", { as: w.admin });
  assert.deepEqual(found.json.items.map((c) => c.name), ["Nagpur"]);
  assert.equal(found.json.total, 1);
  assert.equal((await app.call("GET", "/admin/cities/stats?limit=1&page=2", { as: w.admin })).json.items.length, 1);
  assert.equal((await app.call("GET", "/admin/cities/stats", { as: w.hospAdminA })).status, 403);
});

test("deactivating a city hides it and its hospitals from patients and blocks booking; data kept", async () => {
  const date = dateOffset(3);
  const body = { name: "P", mobile: "9876543210", date, doctor_id: w.dA1, hospital_id: w.hA, reason_for_visit: "x" };
  assert.equal((await app.call("POST", `/admin/cities/${w.cityId}/deactivate`, { as: w.admin })).status, 200);
  assert.deepEqual((await app.call("GET", "/cities", { as: w.patient })).json, []);
  assert.deepEqual((await app.call("GET", `/hospitals/${w.cityId}`, { as: w.patient })).json, []);
  assert.equal((await app.call("POST", "/book", { as: w.patient, body })).status, 404);
  assert.equal((await pool.query("SELECT COUNT(*)::int n FROM hospitals")).rows[0].n, 2);
  assert.equal((await pool.query("SELECT COUNT(*)::int n FROM appointments")).rows[0].n, 3);
  await app.call("POST", `/admin/cities/${w.cityId}/reactivate`, { as: w.admin });
  assert.equal((await app.call("GET", "/cities", { as: w.patient })).json.length, 1);
  assert.equal((await app.call("POST", "/book", { as: w.patient, body })).status, 201);
});

test("patients see only the selected city's hospitals, and only that hospital's doctors", async () => {
  const other = (await pool.query("INSERT INTO cities (name) VALUES ('Pune') RETURNING id")).rows[0].id;
  const h = (await pool.query("INSERT INTO hospitals (name, city_id, location) VALUES ('Sunrise', $1, 'z') RETURNING id", [other])).rows[0].id;
  const hospitals = await app.call("GET", `/hospitals/${w.cityId}`, { as: w.patient });
  assert.deepEqual(hospitals.json.map((x) => x.name).sort(), ["Alpha", "Beta"]);
  assert.deepEqual((await app.call("GET", `/hospitals/${other}`, { as: w.patient })).json.map((x) => x.id), [h]);
  const docs = await app.call("GET", `/doctors/${w.hA}`, { as: w.patient });
  assert.ok(docs.json.every((d) => d.hospital_id === w.hA));
  assert.equal(docs.json.length, 2);
});

// ---- hospitals -----------------------------------------------------------------------
test("admin creates a hospital with full profile; patients can read it", async () => {
  const r = await app.call("POST", "/admin/add-hospital", { as: w.admin, body: hospitalBody(w.cityId) });
  assert.equal(r.status, 201, JSON.stringify(r.json));
  assert.equal(r.json.email, "care@xyz.test");
  assert.equal(String(r.json.opens_at).slice(0, 5), "08:00");
  const list = await app.call("GET", `/hospitals/${w.cityId}`, { as: w.patient });
  const created = list.json.find((x) => x.name === "XYZ Hospital");
  assert.equal(created.address, "1 Main Rd, Mumbai 400058");
  assert.equal(created.description, "Multispeciality");
  assert.equal(String(created.closes_at).slice(0, 5), "20:00");
});

test("hospital validation: required fields, hours, email, image reference, city", async () => {
  const bad = async (extra, status = 400) =>
    assert.equal((await app.call("POST", "/admin/add-hospital", { as: w.admin, body: hospitalBody(w.cityId, extra) })).status, status, JSON.stringify(extra));
  await bad({ name: "" });
  await bad({ opens_at: "20:00", closes_at: "08:00" });
  await bad({ opens_at: "25:00" });
  await bad({ email: "nope" });
  await bad({ contact_phone: "abc" });
  await bad({ image: "javascript:alert(1)" });
  await bad({ logo: "data:text/html,x" });
  await bad({ description: "x".repeat(2001) });
  assert.equal((await app.call("POST", "/admin/add-hospital", { as: w.admin, body: hospitalBody(99999) })).status, 404);
  assert.equal((await app.call("POST", "/admin/add-hospital", { as: w.admin, body: hospitalBody(w.cityId, { image: "/media/12", logo: "https://cdn.test/a.png" }) })).status, 201);
});

test("hospital admin edits only their own hospital and cannot move it between cities", async () => {
  const otherCity = (await pool.query("INSERT INTO cities (name) VALUES ('Pune') RETURNING id")).rows[0].id;
  const own = await app.call("POST", `/admin/update-hospital/${w.hA}`, { as: w.hospAdminA, body: hospitalBody(otherCity, { name: "Alpha Renamed" }) });
  assert.equal(own.status, 200);
  assert.equal(own.json.name, "Alpha Renamed");
  assert.equal(own.json.city_id, w.cityId, "city must not change for hospital admins");
  assert.equal((await app.call("POST", `/admin/update-hospital/${w.hB}`, { as: w.hospAdminA, body: hospitalBody(w.cityId) })).status, 404);
  assert.equal((await app.call("POST", `/admin/update-hospital/${w.hA}`, { as: w.recepA, body: hospitalBody(w.cityId) })).status, 403);
  const moved = await app.call("POST", `/admin/update-hospital/${w.hA}`, { as: w.admin, body: hospitalBody(otherCity) });
  assert.equal(moved.json.city_id, otherCity);
});

test("hospital departments: admin/own hospital admin can set; others cannot; listed publicly to patients", async () => {
  const dep2 = (await app.call("POST", "/admin/departments", { as: w.admin, body: { name: "Cardiology" } })).json.id;
  assert.equal((await app.call("POST", "/admin/departments", { as: w.admin, body: { name: "cardiology" } })).status, 409);
  const set = await app.call("POST", `/admin/hospitals/${w.hA}/departments`, { as: w.hospAdminA, body: { department_ids: [w.depId, dep2] } });
  assert.equal(set.status, 200);
  assert.equal((await app.call("GET", `/hospital/${w.hA}/departments`, { as: w.patient })).json.length, 2);
  assert.equal((await app.call("POST", `/admin/hospitals/${w.hB}/departments`, { as: w.hospAdminA, body: { department_ids: [dep2] } })).status, 404);
  assert.equal((await app.call("POST", `/admin/hospitals/${w.hA}/departments`, { as: w.hospAdminA, body: { department_ids: [99999] } })).status, 404);
  assert.equal((await app.call("POST", `/admin/hospitals/${w.hA}/departments`, { as: w.hospAdminA, body: { department_ids: "x" } })).status, 400);
  await app.call("POST", `/admin/hospitals/${w.hA}/departments`, { as: w.admin, body: { department_ids: [dep2] } });
  assert.deepEqual((await app.call("GET", `/hospital/${w.hA}/departments`, { as: w.patient })).json.map((d) => d.name), ["Cardiology"]);
  assert.equal((await app.call("POST", "/admin/departments", { as: w.hospAdminA, body: { name: "X" } })).status, 403);
});

// ---- media ---------------------------------------------------------------------------
test("image upload: validates real file bytes, size, role; served safely", async () => {
  const ok = await rawPost("/admin/media", w.hospAdminA, PNG);
  assert.equal(ok.status, 201);
  const { url } = await ok.json();
  const got = await fetch(app.base + url);
  assert.equal(got.status, 200);
  assert.equal(got.headers.get("content-type"), "image/png");
  assert.equal(got.headers.get("x-content-type-options"), "nosniff");
  assert.equal(Buffer.from(await got.arrayBuffer()).length, PNG.length);
  // HTML disguised as a png content-type is rejected by byte sniffing
  assert.equal((await rawPost("/admin/media", w.admin, Buffer.from("<script>alert(1)</script>"))).status, 415);
  // unsupported declared type never reaches the handler body parser
  assert.equal((await rawPost("/admin/media", w.admin, "<svg/>", "image/svg+xml")).status, 400);
  assert.equal((await rawPost("/admin/media", w.admin, Buffer.concat([PNG, Buffer.alloc(2 * 1024 * 1024)]))).status, 413);
  assert.equal((await rawPost("/admin/media", w.patient, PNG)).status, 403);
  assert.equal((await rawPost("/admin/media", w.docUserA1, PNG)).status, 403);
  assert.equal((await fetch(app.base + "/media/99999")).status, 404);
  assert.equal((await fetch(app.base + "/media/abc")).status, 404);
});

// ---- doctors: fee, qualification, schedule -------------------------------------------
const doctorBody = (w, extra = {}) => ({
  name: "Dr New", specialization: "Cardiology", department_id: w.depId, hospital_id: w.hA,
  available_from: "09:00", available_to: "13:00", slot_step_minutes: 30, slot_duration_minutes: 30,
  qualification: "MBBS, MD", experience_years: 12, consultation_fee: 500, ...extra,
});

test("admin configures fee, qualification, experience, schedule; patients see them", async () => {
  const r = await app.call("POST", "/admin/add-doctor", { as: w.hospAdminA, body: doctorBody(w) });
  assert.equal(r.status, 201, JSON.stringify(r.json));
  assert.equal(Number(r.json.consultation_fee), 500);
  const docs = await app.call("GET", `/doctors/${w.hA}`, { as: w.patient });
  const d = docs.json.find((x) => x.name === "Dr New");
  assert.equal(Number(d.consultation_fee), 500);
  assert.equal(d.qualification, "MBBS, MD");
  assert.equal(d.experience_years, 12);
  const slots = await app.call("GET", `/doctor/${d.id}/slots?date=${dateOffset(3)}`, { as: w.patient });
  assert.equal(slots.status, 200);
  const list = JSON.stringify(slots.json);
  assert.ok(list.includes("09:30") && !list.includes("09:15"), "30-minute slots expected");
});

test("changing the fee updates the doctor; omitted fee keeps the old one", async () => {
  const id = (await app.call("POST", "/admin/add-doctor", { as: w.admin, body: doctorBody(w) })).json.id;
  const up = await app.call("POST", `/admin/update-doctor/${id}`, { as: w.admin, body: doctorBody(w, { consultation_fee: 750 }) });
  assert.equal(Number(up.json.consultation_fee), 750);
  const { consultation_fee, ...noFee } = doctorBody(w);
  const keep = await app.call("POST", `/admin/update-doctor/${id}`, { as: w.admin, body: noFee });
  assert.equal(Number(keep.json.consultation_fee), 750);
});

test("doctor validation: fee, experience, times, durations, image, hospital", async () => {
  const bad = async (extra, status = 400, user = w.admin) =>
    assert.equal((await app.call("POST", "/admin/add-doctor", { as: user, body: doctorBody(w, extra) })).status, status, JSON.stringify(extra));
  await bad({ consultation_fee: -1 });
  await bad({ consultation_fee: "abc" });
  await bad({ consultation_fee: 99999999 });
  await bad({ experience_years: 120 });
  await bad({ experience_years: 1.5 });
  await bad({ available_from: "13:00", available_to: "09:00" });
  await bad({ available_from: "9am" });
  await bad({ slot_duration_minutes: 1 });
  await bad({ image: "javascript:alert(1)" });
  await bad({ hospital_id: 99999 }, 404);
  await bad({ hospital_id: w.hB }, 403, w.hospAdminA);
  await pool.query("UPDATE hospitals SET is_active = FALSE WHERE id = $1", [w.hA]);
  await bad({}, 404);
});

test("a doctor appears only under their own hospital", async () => {
  const a = (await app.call("GET", `/doctors/${w.hA}`, { as: w.patient })).json.map((d) => d.name);
  const b = (await app.call("GET", `/doctors/${w.hB}`, { as: w.patient })).json.map((d) => d.name);
  assert.deepEqual(a.sort(), ["Dr A1", "Dr A2"]);
  assert.deepEqual(b, ["Dr B1"]);
});
