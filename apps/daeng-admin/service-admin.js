const express = require("express");
const mysql = require("mysql2/promise");

function createServiceAdmin() {
  const serviceDbConfig = {
    host: process.env.SERVICE_DB_HOST || "",
    port: Number(process.env.SERVICE_DB_PORT || 3306),
    database: process.env.SERVICE_DB_NAME || "",
    user: process.env.SERVICE_DB_USER || "",
    password: process.env.SERVICE_DB_PASSWORD || "",
  };
  const hasServiceDbConfig = Boolean(
    serviceDbConfig.host && serviceDbConfig.database && serviceDbConfig.user && serviceDbConfig.password
  );
  const serviceDbSslEnabled = /^(1|true|yes)$/i.test(process.env.SERVICE_DB_SSL || "");
  const serviceDb = hasServiceDbConfig
    ? mysql.createPool({
        ...serviceDbConfig,
        waitForConnections: true,
        connectionLimit: Math.max(1, Number(process.env.SERVICE_DB_POOL_SIZE || 5)),
        queueLimit: 20,
        enableKeepAlive: true,
        dateStrings: true,
        timezone: "+09:00",
        ssl: serviceDbSslEnabled
          ? {
              rejectUnauthorized: process.env.SERVICE_DB_SSL_REJECT_UNAUTHORIZED !== "false",
              ...(process.env.SERVICE_DB_SSL_CA
                ? { ca: Buffer.from(process.env.SERVICE_DB_SSL_CA, "base64").toString("utf8") }
                : {}),
            }
          : undefined,
      })
    : null;

  function requireServiceDb(req, res, next) {
    if (serviceDb) return next();
    return res.status(503).json({
      error: "SERVICE_DB_* 환경변수가 아직 설정되지 않았습니다.",
      code: "SERVICE_DB_NOT_CONFIGURED",
    });
  }

  function serviceAdminError(res, err, label) {
    console.error(`Service admin ${label} error:`, err.code || err.message);
    return res.status(500).json({
      error: "운영 데이터를 불러오지 못했습니다.",
      code: "SERVICE_DB_QUERY_FAILED",
    });
  }

  function maskEmail(email) {
    if (!email || !email.includes("@")) return "";
    const [local, domain] = email.split("@");
    const shown = local.slice(0, Math.min(2, local.length));
    return `${shown}${"*".repeat(Math.max(1, local.length - shown.length))}@${domain}`;
  }

  function maskPhone(phone) {
    if (!phone) return "";
    const digits = String(phone).replace(/\D/g, "");
    if (digits.length < 7) return "***";
    return `${digits.slice(0, 3)}-****-${digits.slice(-4)}`;
  }

  function maskBusinessNumber(value) {
    if (!value) return "";
    const digits = String(value).replace(/\D/g, "");
    if (digits.length !== 10) return "***";
    return `${digits.slice(0, 3)}-**-${digits.slice(-5)}`;
  }

  const router = express.Router();

  router.get("/health", async (req, res) => {
    try {
      const [rows] = await serviceDb.query("SELECT DATABASE() AS db, NOW() AS checkedAt");
      res.json({ ok: true, database: rows[0]?.db || "", checkedAt: rows[0]?.checkedAt || null });
    } catch (err) {
      serviceAdminError(res, err, "health");
    }
  });

  router.get("/overview", async (req, res) => {
    const days = Math.min(90, Math.max(7, Number(req.query.days) || 30));
    try {
      const [usersResult, ownersResult, schoolsResult, verificationsResult, trendResult, recentResult] =
        await Promise.all([
          serviceDb.query(`
            SELECT
              COUNT(*) AS totalUsers,
              SUM(u.status = 'ACTIVE') AS activeUsers,
              SUM(u.status = 'WITHDRAWN') AS withdrawnUsers,
              COUNT(DISTINCT CASE WHEN u.status = 'ACTIVE' AND p.user_id IS NOT NULL THEN u.id END) AS guardians,
              SUM(u.created_at >= DATE_SUB(NOW(), INTERVAL 7 DAY)) AS newUsers7d,
              SUM(u.created_at >= DATE_SUB(NOW(), INTERVAL 30 DAY)) AS newUsers30d
            FROM \`user\` u
            LEFT JOIN (
              SELECT DISTINCT user_id FROM pet WHERE removed_at IS NULL
            ) p ON p.user_id = u.id
          `),
          serviceDb.query(`
            SELECT
              COUNT(DISTINCT CASE
                WHEN usr.revoked_at IS NULL AND usr.role = 'ROLE_OWNER'
                 AND u.status = 'ACTIVE' THEN usr.user_id_fk END) AS activeOwners,
              COUNT(DISTINCT CASE
                WHEN usr.revoked_at IS NOT NULL AND usr.role = 'ROLE_OWNER'
                THEN usr.user_id_fk END) AS revokedOwners,
              SUM(usr.role = 'ROLE_OWNER' AND usr.revoked_at IS NULL
                  AND usr.created_at >= DATE_SUB(NOW(), INTERVAL 7 DAY)) AS newOwners7d
            FROM tb_user_school_role usr
            JOIN \`user\` u ON u.id = usr.user_id_fk
          `),
          serviceDb.query(`
            SELECT
              COUNT(*) AS totalSchools,
              SUM(status = 'ACTIVE') AS activeSchools,
              SUM(status = 'CLOSED') AS closedSchools,
              COUNT(DISTINCT CASE WHEN usr.user_school_role_id IS NOT NULL THEN s.school_id END) AS managedSchools
            FROM tb_school s
            LEFT JOIN tb_user_school_role usr
              ON usr.school_id_fk = s.school_id
             AND usr.role = 'ROLE_OWNER'
             AND usr.revoked_at IS NULL
          `),
          serviceDb.query(`
            SELECT status, COUNT(*) AS count
            FROM tb_owner_verification
            GROUP BY status
          `),
          serviceDb.execute(`
            SELECT DATE(created_at) AS date, COUNT(*) AS count
            FROM \`user\`
            WHERE created_at >= DATE_SUB(CURDATE(), INTERVAL ? DAY)
            GROUP BY DATE(created_at)
            ORDER BY date
          `, [days - 1]),
          serviceDb.query(`
            SELECT
              ov.owner_verification_id AS id,
              u.nickname,
              u.user_id AS userId,
              ov.kindergarten_name AS kindergartenName,
              ov.status,
              ov.submitted_at AS submittedAt
            FROM tb_owner_verification ov
            JOIN \`user\` u ON u.id = ov.user_id_fk
            ORDER BY COALESCE(ov.submitted_at, ov.owner_verification_id) DESC
            LIMIT 6
          `),
        ]);

      const verificationCounts = Object.fromEntries(
        verificationsResult[0].map((row) => [row.status, Number(row.count)])
      );
      res.json({
        stats: {
          ...usersResult[0][0],
          ...ownersResult[0][0],
          ...schoolsResult[0][0],
          verificationCounts,
        },
        signupTrend: trendResult[0].map((row) => ({ date: row.date, count: Number(row.count) })),
        recentVerifications: recentResult[0],
        definitions: {
          guardians: "활성 반려견을 1마리 이상 보유한 활성 회원",
          activeOwners: "해지되지 않은 ROLE_OWNER를 보유한 활성 회원",
          managedSchools: "활성 원장 역할이 연결된 유치원",
        },
      });
    } catch (err) {
      serviceAdminError(res, err, "overview");
    }
  });

  router.get("/members", async (req, res) => {
    const page = Math.max(1, Number(req.query.page) || 1);
    const pageSize = Math.min(100, Math.max(10, Number(req.query.pageSize) || 20));
    const offset = (page - 1) * pageSize;
    const type = ["all", "guardian", "owner", "withdrawn"].includes(req.query.type)
      ? req.query.type
      : "all";
    const search = String(req.query.search || "").trim().slice(0, 100);
    const where = [];
    const params = [];
    if (type === "guardian") where.push("member.petCount > 0");
    if (type === "owner") where.push("member.ownerRoleId IS NOT NULL");
    if (type === "withdrawn") where.push("member.status = 'WITHDRAWN'");
    if (search) {
      where.push("(member.userId LIKE ? OR member.name LIKE ? OR member.email LIKE ? OR member.phone LIKE ?)");
      const like = `%${search}%`;
      params.push(like, like, like, like);
    }
    const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
    const baseSql = `
      SELECT
        u.id,
        u.user_id AS userId,
        COALESCE(NULLIF(u.guardian_name, ''), NULLIF(u.nickname, ''), su.name, '이름 미등록') AS name,
        u.status,
        u.phone_number AS phone,
        su.email,
        u.created_at AS createdAt,
        u.updated_at AS updatedAt,
        COALESCE(p.pet_count, 0) AS petCount,
        usr.user_school_role_id AS ownerRoleId,
        usr.created_at AS ownerGrantedAt,
        usr.revoked_at AS ownerRevokedAt,
        usr.revoke_reason AS ownerRevokeReason,
        s.school_id AS schoolId,
        s.name AS schoolName,
        s.status AS schoolStatus
      FROM \`user\` u
      LEFT JOIN (
        SELECT user_id, COUNT(*) AS pet_count
        FROM pet WHERE removed_at IS NULL GROUP BY user_id
      ) p ON p.user_id = u.id
      LEFT JOIN (
        SELECT user_id, MAX(email) AS email, MAX(name) AS name
        FROM social_user WHERE status = 'LINKED' GROUP BY user_id
      ) su ON su.user_id = u.user_id
      LEFT JOIN tb_user_school_role usr
        ON usr.user_id_fk = u.id AND usr.role = 'ROLE_OWNER' AND usr.revoked_at IS NULL
      LEFT JOIN tb_school s ON s.school_id = usr.school_id_fk
    `;
    try {
      const [countRows] = await serviceDb.execute(
        `SELECT COUNT(*) AS total FROM (${baseSql}) member ${whereSql}`,
        params
      );
      const [rows] = await serviceDb.execute(
        `SELECT * FROM (${baseSql}) member ${whereSql} ORDER BY member.createdAt DESC LIMIT ? OFFSET ?`,
        [...params, pageSize, offset]
      );
      res.json({
        page,
        pageSize,
        total: Number(countRows[0]?.total || 0),
        members: rows.map((row) => ({
          ...row,
          email: maskEmail(row.email),
          phone: maskPhone(row.phone),
          petCount: Number(row.petCount || 0),
          isGuardian: Number(row.petCount || 0) > 0,
          isOwner: Boolean(row.ownerRoleId),
        })),
      });
    } catch (err) {
      serviceAdminError(res, err, "members");
    }
  });

  router.get("/schools", async (req, res) => {
    const page = Math.max(1, Number(req.query.page) || 1);
    const pageSize = Math.min(100, Math.max(10, Number(req.query.pageSize) || 20));
    const offset = (page - 1) * pageSize;
    const search = String(req.query.search || "").trim().slice(0, 100);
    const status = ["ACTIVE", "CLOSED"].includes(req.query.status) ? req.query.status : "";
    const where = [];
    const params = [];
    if (status) {
      where.push("school.status = ?");
      params.push(status);
    }
    if (search) {
      where.push("(school.name LIKE ? OR school.address LIKE ? OR school.ownerName LIKE ?)");
      const like = `%${search}%`;
      params.push(like, like, like);
    }
    const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
    const baseSql = `
      SELECT
        s.school_id AS id,
        s.name,
        s.address,
        s.address_detail AS addressDetail,
        s.phone_number AS phone,
        s.status,
        s.created_at AS createdAt,
        s.kindergarten_place_id AS kindergartenPlaceId,
        COALESCE(NULLIF(u.guardian_name, ''), NULLIF(u.nickname, ''), '원장 미연결') AS ownerName,
        u.user_id AS ownerUserId,
        usr.created_at AS ownerGrantedAt,
        COALESCE(m.active_members, 0) AS activeMembers,
        COALESCE(m.pending_members, 0) AS pendingMembers,
        CASE WHEN br.school_business_registration_id IS NULL THEN 0 ELSE 1 END AS businessVerified
      FROM tb_school s
      LEFT JOIN tb_user_school_role usr
        ON usr.school_id_fk = s.school_id AND usr.role = 'ROLE_OWNER' AND usr.revoked_at IS NULL
      LEFT JOIN \`user\` u ON u.id = usr.user_id_fk
      LEFT JOIN (
        SELECT school_id,
               SUM(status = 'ACTIVE') AS active_members,
               SUM(status = 'PENDING') AS pending_members
        FROM school_pet_membership GROUP BY school_id
      ) m ON m.school_id = s.school_id
      LEFT JOIN tb_school_business_registration br
        ON br.school_id_fk = s.school_id AND br.revoked_at IS NULL
    `;
    try {
      const [countRows] = await serviceDb.execute(
        `SELECT COUNT(*) AS total FROM (${baseSql}) school ${whereSql}`,
        params
      );
      const [rows] = await serviceDb.execute(
        `SELECT * FROM (${baseSql}) school ${whereSql} ORDER BY school.createdAt DESC LIMIT ? OFFSET ?`,
        [...params, pageSize, offset]
      );
      res.json({
        page,
        pageSize,
        total: Number(countRows[0]?.total || 0),
        schools: rows.map((row) => ({
          ...row,
          phone: maskPhone(row.phone),
          activeMembers: Number(row.activeMembers || 0),
          pendingMembers: Number(row.pendingMembers || 0),
          businessVerified: Boolean(row.businessVerified),
        })),
      });
    } catch (err) {
      serviceAdminError(res, err, "schools");
    }
  });

  router.get("/verifications", async (req, res) => {
    const page = Math.max(1, Number(req.query.page) || 1);
    const pageSize = Math.min(100, Math.max(10, Number(req.query.pageSize) || 20));
    const offset = (page - 1) * pageSize;
    const allowedStatuses = [
      "KINDERGARTEN_INFO_COMPLETED",
      "BUSINESS_REGISTRATION_PENDING",
      "SUBMITTED",
      "REVOKED",
    ];
    const status = allowedStatuses.includes(req.query.status) ? req.query.status : "";
    const search = String(req.query.search || "").trim().slice(0, 100);
    const where = [];
    const params = [];
    if (status) {
      where.push("ov.status = ?");
      params.push(status);
    }
    if (search) {
      where.push("(ov.kindergarten_name LIKE ? OR ov.representative_name LIKE ? OR u.user_id LIKE ?)");
      const like = `%${search}%`;
      params.push(like, like, like);
    }
    const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
    try {
      const [countRows] = await serviceDb.execute(`
        SELECT COUNT(*) AS total
        FROM tb_owner_verification ov
        JOIN \`user\` u ON u.id = ov.user_id_fk
        ${whereSql}
      `, params);
      const [rows] = await serviceDb.execute(`
        SELECT
          ov.owner_verification_id AS id,
          u.user_id AS userId,
          COALESCE(NULLIF(u.guardian_name, ''), NULLIF(u.nickname, ''), ov.representative_name) AS userName,
          ov.school_id_fk AS schoolId,
          ov.kindergarten_place_id AS kindergartenPlaceId,
          ov.kindergarten_type AS kindergartenType,
          ov.status,
          ov.kindergarten_name AS kindergartenName,
          ov.kindergarten_address AS kindergartenAddress,
          ov.kindergarten_address_detail AS kindergartenAddressDetail,
          ov.kindergarten_phone_number AS kindergartenPhone,
          ov.representative_name AS representativeName,
          ov.representative_phone_number AS representativePhone,
          ov.business_registration_number AS businessRegistrationNumber,
          ov.submitted_at AS submittedAt,
          ov.revoked_at AS revokedAt,
          usr.created_at AS ownerGrantedAt,
          usr.revoked_at AS ownerRevokedAt,
          usr.revoke_reason AS ownerRevokeReason
        FROM tb_owner_verification ov
        JOIN \`user\` u ON u.id = ov.user_id_fk
        LEFT JOIN tb_user_school_role usr
          ON usr.user_id_fk = u.id AND usr.school_id_fk = ov.school_id_fk AND usr.role = 'ROLE_OWNER'
        ${whereSql}
        ORDER BY COALESCE(ov.submitted_at, ov.owner_verification_id) DESC
        LIMIT ? OFFSET ?
      `, [...params, pageSize, offset]);
      res.json({
        page,
        pageSize,
        total: Number(countRows[0]?.total || 0),
        verifications: rows.map((row) => ({
          ...row,
          kindergartenPhone: maskPhone(row.kindergartenPhone),
          representativePhone: maskPhone(row.representativePhone),
          businessRegistrationNumber: maskBusinessNumber(row.businessRegistrationNumber),
        })),
      });
    } catch (err) {
      serviceAdminError(res, err, "verifications");
    }
  });

  return { router, requireServiceDb, serviceDb, hasServiceDbConfig };
}

module.exports = { createServiceAdmin };
