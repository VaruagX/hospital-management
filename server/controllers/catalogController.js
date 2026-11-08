// City, hospital, hospital-department and media management (the City -> Hospital part of the product).
const pool = require("../config/db");
const { audit } = require("../services/audit");
const { scopeOf } = require("../policies/access");
const v = require("../utils/validate");

const PAGE_MAX = 100;
function pageParams(query) {
  const limit = Math.min(Math.max(Number.parseInt(query.limit, 10) || 25, 1), PAGE_MAX);
  const page = Math.max(Number.parseInt(query.page, 10) || 1, 1);
  return { limit, page, offset: (page - 1) * limit };
}

// ---------------------------------------------------------------- cities
async function listCityStats(req, res, next) {
  try {
    const { limit, page, offset } = pageParams(req.query);
    const q = String(req.query.q || "").trim().toLowerCase();
    const values = [];
    let where = "";
    if (q) {
      values.push(`%${q}%`);
      where = "WHERE LOWER(c.name) LIKE $1";
    }
    const [rows, total] = await Promise.all([
      pool.query(
        `SELECT c.id, c.name, c.is_active,
                COUNT(DISTINCT h.id)::int AS hospital_count,
                COUNT(DISTINCT h.id) FILTER (WHERE h.is_active)::int AS active_hospital_count,
                COUNT(DISTINCT d.id) FILTER (WHERE d.is_active)::int AS doctor_count,
                COUNT(DISTINCT a.id)::int AS appointment_count,
                COUNT(DISTINCT a.id) FILTER (WHERE COALESCE(a.status,'booked') = 'completed')::int AS completed_count,
                COUNT(DISTINCT a.id) FILTER (WHERE COALESCE(a.status,'booked') = 'cancelled')::int AS cancelled_count
         FROM cities c
         LEFT JOIN hospitals h ON h.city_id = c.id
         LEFT JOIN doctors d ON d.hospital_id = h.id
         LEFT JOIN appointments a ON a.hospital_id = h.id
         ${where}
         GROUP BY c.id
         ORDER BY c.name
         LIMIT ${limit} OFFSET ${offset}`,
        values
      ),
      pool.query(`SELECT COUNT(*)::int AS n FROM cities c ${where}`, values),
    ]);
    res.json({ page, limit, total: total.rows[0].n, items: rows.rows });
  } catch (error) {
    next(error);
  }
}

async function updateCity(req, res, next) {
  try {
    const id = v.parseId(req.params.id);
    const name = v.text(req.body.name, "City name", { required: true, max: 80 });
    if (!id) return res.status(400).json({ error: "Invalid city id" });
    const dup = await pool.query("SELECT id FROM cities WHERE LOWER(name) = LOWER($1) AND id <> $2", [name, id]);
    if (dup.rows[0]) return res.status(409).json({ error: "City already exists" });
    const result = await pool.query("UPDATE cities SET name = $1 WHERE id = $2 RETURNING id, name, is_active", [name, id]);
    if (!result.rows[0]) return res.status(404).json({ error: "City not found" });
    await audit(req, "city.update", "city", id, { name });
    return res.json(result.rows[0]);
  } catch (error) {
    return next(error);
  }
}

async function setCityActive(req, res, next, active) {
  try {
    const id = v.parseId(req.params.id);
    if (!id) return res.status(400).json({ error: "Invalid city id" });
    const result = await pool.query(
      `UPDATE cities SET is_active = $2, deactivated_at = CASE WHEN $2 THEN NULL ELSE NOW() END
       WHERE id = $1 RETURNING id, is_active`,
      [id, active]
    );
    if (!result.rows[0]) return res.status(404).json({ error: "City not found" });
    await audit(req, active ? "city.reactivate" : "city.deactivate", "city", id);
    return res.json({ success: true, is_active: active });
  } catch (error) {
    return next(error);
  }
}

// ---------------------------------------------------------------- hospitals
function hospitalFields(body) {
  const opens = v.time(body.opens_at, "Opening time");
  const closes = v.time(body.closes_at, "Closing time");
  if (opens && closes && opens >= closes) throw v.fail("Closing time must be after opening time");
  return {
    name: v.text(body.name, "Name", { required: true, max: 150 }),
    location: v.text(body.location, "Location", { required: true, max: 200 }),
    address: v.text(body.address, "Address", { max: 500 }),
    description: v.text(body.description, "Description", { max: 2000 }),
    image: v.imageRef(body.image, "Hospital image"),
    logo: v.imageRef(body.logo, "Hospital logo"),
    contact_phone: v.phone(body.contact_phone, "Contact phone") || "",
    email: v.email(body.email, "Contact email"),
    map_link: v.text(body.map_link, "Map link", { max: 500 }) || "",
    opens_at: opens,
    closes_at: closes,
  };
}

async function addHospital(req, res, next) {
  try {
    const f = hospitalFields(req.body);
    const cityId = v.parseId(req.body.city_id);
    if (!cityId) return res.status(400).json({ error: "City is required" });
    const city = (await pool.query("SELECT id FROM cities WHERE id = $1 AND is_active", [cityId])).rows[0];
    if (!city) return res.status(404).json({ error: "City not found or inactive" });
    const result = await pool.query(
      `INSERT INTO hospitals (name, city_id, location, address, description, image, logo, contact_phone, email,
                              map_link, opens_at, closes_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
      [f.name, cityId, f.location, f.address, f.description, f.image, f.logo, f.contact_phone, f.email,
       f.map_link, f.opens_at, f.closes_at]
    );
    await audit(req, "hospital.create", "hospital", result.rows[0].id, { name: f.name, cityId });
    return res.status(201).json(result.rows[0]);
  } catch (error) {
    return next(error);
  }
}

/** Admin: any hospital, may move city. Hospital admin: own hospital only, city is fixed. */
async function updateHospital(req, res, next) {
  try {
    const id = v.parseId(req.params.id);
    if (!id) return res.status(400).json({ error: "Invalid hospital id" });
    const scope = scopeOf(req.user);
    if (!scope || (!scope.all && scope.hospitalId !== id)) {
      return res.status(404).json({ error: "Hospital not found" });
    }
    const f = hospitalFields(req.body);
    const current = (await pool.query("SELECT city_id FROM hospitals WHERE id = $1", [id])).rows[0];
    if (!current) return res.status(404).json({ error: "Hospital not found" });
    let cityId = current.city_id;
    if (scope.all && req.body.city_id) {
      cityId = v.parseId(req.body.city_id);
      if (!cityId || !(await pool.query("SELECT 1 FROM cities WHERE id = $1", [cityId])).rows[0]) {
        return res.status(404).json({ error: "City not found" });
      }
    }
    const result = await pool.query(
      `UPDATE hospitals SET name=$1, city_id=$2, location=$3, address=$4, description=$5, image=$6, logo=$7,
              contact_phone=$8, email=$9, map_link=$10, opens_at=$11, closes_at=$12
       WHERE id = $13 RETURNING *`,
      [f.name, cityId, f.location, f.address, f.description, f.image, f.logo, f.contact_phone, f.email,
       f.map_link, f.opens_at, f.closes_at, id]
    );
    await audit(req, "hospital.update", "hospital", id, { name: f.name, cityId });
    return res.json(result.rows[0]);
  } catch (error) {
    return next(error);
  }
}

// ---------------------------------------------------------------- departments
async function addDepartment(req, res, next) {
  try {
    const name = v.text(req.body.name, "Department name", { required: true, max: 80 });
    const dup = await pool.query("SELECT id FROM departments WHERE LOWER(name) = LOWER($1)", [name]);
    if (dup.rows[0]) return res.status(409).json({ error: "Department already exists" });
    const result = await pool.query("INSERT INTO departments (name) VALUES ($1) RETURNING id, name", [name]);
    await audit(req, "department.create", "department", result.rows[0].id, { name });
    return res.status(201).json(result.rows[0]);
  } catch (error) {
    return next(error);
  }
}

async function getHospitalDepartments(req, res, next) {
  try {
    const id = v.parseId(req.params.id);
    if (!id) return res.status(400).json({ error: "Invalid hospital id" });
    const result = await pool.query(
      `SELECT d.id, d.name FROM hospital_departments hd
       JOIN departments d ON d.id = hd.department_id
       JOIN hospitals h ON h.id = hd.hospital_id AND h.is_active
       WHERE hd.hospital_id = $1 ORDER BY d.name`,
      [id]
    );
    return res.json(result.rows);
  } catch (error) {
    return next(error);
  }
}

/** Replace the set of departments a hospital runs. */
async function setHospitalDepartments(req, res, next) {
  const client = await pool.connect();
  try {
    const id = v.parseId(req.params.id);
    const scope = scopeOf(req.user);
    if (!id || !scope || (!scope.all && scope.hospitalId !== id)) {
      return res.status(404).json({ error: "Hospital not found" });
    }
    const raw = req.body.department_ids;
    if (!Array.isArray(raw) || raw.length > 100) return res.status(400).json({ error: "department_ids must be an array" });
    const ids = [...new Set(raw.map(v.parseId))];
    if (ids.includes(null)) return res.status(400).json({ error: "Invalid department id" });
    await client.query("BEGIN");
    if (!(await client.query("SELECT 1 FROM hospitals WHERE id = $1", [id])).rows[0]) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Hospital not found" });
    }
    const known = await client.query("SELECT id FROM departments WHERE id = ANY($1::int[])", [ids]);
    if (known.rowCount !== ids.length) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Unknown department" });
    }
    await client.query("DELETE FROM hospital_departments WHERE hospital_id = $1", [id]);
    for (const departmentId of ids) {
      await client.query("INSERT INTO hospital_departments (hospital_id, department_id) VALUES ($1, $2)", [id, departmentId]);
    }
    await audit(req, "hospital.departments", "hospital", id, { departmentIds: ids }, { db: client, strict: true });
    await client.query("COMMIT");
    return res.json({ hospital_id: id, department_ids: ids });
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    return next(error);
  } finally {
    client.release();
  }
}

// ---------------------------------------------------------------- media
function sniffImage(buf) {
  if (buf.length > 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "image/jpeg";
  if (buf.length > 12 && buf.toString("ascii", 0, 4) === "RIFF" && buf.toString("ascii", 8, 12) === "WEBP") return "image/webp";
  return null;
}

async function uploadMedia(req, res, next) {
  try {
    const body = req.body;
    if (!Buffer.isBuffer(body) || !body.length) {
      return res.status(400).json({ error: "Send the image as the raw request body (png, jpeg or webp, max 2 MB)" });
    }
    // Trust the file's bytes, not the client-declared type.
    const mime = sniffImage(body);
    if (!mime) return res.status(415).json({ error: "Only png, jpeg or webp images are allowed" });
    const result = await pool.query(
      "INSERT INTO media (mime_type, size_bytes, content, uploaded_by) VALUES ($1,$2,$3,$4) RETURNING id",
      [mime, body.length, body, req.user.id]
    );
    await audit(req, "media.upload", "media", result.rows[0].id, { mime, size: body.length });
    return res.status(201).json({ id: result.rows[0].id, url: `/media/${result.rows[0].id}` });
  } catch (error) {
    return next(error);
  }
}

async function getMedia(req, res, next) {
  try {
    const id = v.parseId(req.params.id);
    if (!id) return res.status(404).end();
    const row = (await pool.query("SELECT mime_type, content FROM media WHERE id = $1", [id])).rows[0];
    if (!row) return res.status(404).end();
    res.set({
      "Content-Type": row.mime_type,
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "default-src 'none'",
      "Cache-Control": "public, max-age=86400, immutable",
    });
    return res.send(row.content);
  } catch (error) {
    return next(error);
  }
}

module.exports = {
  addDepartment,
  addHospital,
  deactivateCity: (req, res, next) => setCityActive(req, res, next, false),
  reactivateCity: (req, res, next) => setCityActive(req, res, next, true),
  getHospitalDepartments,
  getMedia,
  listCityStats,
  setHospitalDepartments,
  updateCity,
  updateHospital,
  uploadMedia,
};
