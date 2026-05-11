const { pool } = require("../config/db");
/* ─── Helper: trích xuất YouTube Video ID từ URL ─── */
const extractYouTubeId = (url) => {
  if (!url) return null;
  const patterns = [
    /youtu\.be\/([^?&\s]+)/,
    /youtube\.com\/watch\?v=([^?&\s]+)/,
    /youtube\.com\/embed\/([^?&\s]+)/,
    /youtube\.com\/v\/([^?&\s]+)/,
  ];
  for (const p of patterns) {
    const m = url.match(p);
    if (m) return m[1];
  }
  return null;
};

/* ─── Helper: tính lại TotalDuration cho Course ─── */
const recalcDuration = async (courseId) => {
  await sql.query`
    UPDATE Courses
    SET TotalDuration = (
      SELECT COALESCE(SUM(cl.DurationMinutes), 0)
      FROM CourseLessons cl
      JOIN CourseSections cs ON cl.SectionId = cs.Id
      WHERE cs.CourseId = ${courseId}
    ),
    UpdatedAt = GETDATE()
    WHERE Id = ${courseId}
  `;
};

/* ════════════════════════════════════════════════════
   METADATA — Trường / Ngành / Môn để chọn tag
════════════════════════════════════════════════════ */
exports.getTagMetadata = async (req, res) => {
  try {
  const [unis, majors, subjects, lecturers] = await Promise.all([
  pool.query('SELECT "Id", "Name" FROM "Universities" ORDER BY "Name"'),
  pool.query('SELECT m."Id", m."Name", m."MajorCode", m."UniversityId", u."Name" AS "UniversityName" FROM "Majors" m LEFT JOIN "Universities" u ON m."UniversityId" = u."Id" ORDER BY m."Name"'),
  pool.query('SELECT "SubjectCode", "SubjectName", "SubjectNameVN", "Semester" FROM "Subjects" ORDER BY "Semester", "SubjectCode"'),
  pool.query('SELECT "Id", "Name", "LecturerCode", "Email" FROM "Lecturers" WHERE "IsActive" = true ORDER BY "Name"'),
]);
    res.json({
      success: true,
      data: {
        universities: unis.recordset,
        majors: majors.recordset,
        subjects: subjects.recordset,
        lecturers: lecturers.recordset,
      },
    });
  } catch (err) {
    console.error("Lỗi getTagMetadata:", err);
    res.status(500).json({ success: false, message: "Lỗi Server" });
  }
};

/* ════════════════════════════════════════════════════
   COURSES — Danh sách & chi tiết
════════════════════════════════════════════════════ */

// GET /courses — Danh sách khóa học (kèm tags + instructor + số bài)
exports.getCourses = async (req, res) => {
  try {
    const { q, university, major, subject } = req.query;

    // 1. Lấy danh sách courses
    const coursesResult = await sql.query`
      SELECT
        c.Id, c.Title, c.Description, c.ThumbnailUrl,
        c.TotalDuration, c.IsPublished, c.CreatedAt, c.UpdatedAt,
        l.Id        AS InstructorId,
        l.Name      AS InstructorName,
        l.Email     AS InstructorEmail,
        u.Name      AS CreatedByName,
        (
          SELECT COUNT(*) FROM CourseLessons cl
          JOIN CourseSections cs ON cl.SectionId = cs.Id
          WHERE cs.CourseId = c.Id
        ) AS LessonCount,
        (
          SELECT COUNT(*) FROM CourseSections cs WHERE cs.CourseId = c.Id
        ) AS SectionCount
      FROM Courses c
      LEFT JOIN Lecturers l ON c.InstructorId = l.Id
      LEFT JOIN Users     u ON c.CreatedBy    = u.Id
      ORDER BY c.CreatedAt DESC
    `;

    let courses = coursesResult.recordset;

    // 2. Lấy tags cho tất cả courses
    const tagsResult =
      await sql.query`SELECT CourseId, TagType, TagValue FROM CourseTags`;
    const tagsMap = {};
    for (const tag of tagsResult.recordset) {
      if (!tagsMap[tag.CourseId]) tagsMap[tag.CourseId] = [];
      tagsMap[tag.CourseId].push(tag);
    }

    courses = courses.map((c) => ({ ...c, tags: tagsMap[c.Id] || [] }));

    // 3. Filter phía JS (tránh dynamic SQL phức tạp)
    if (q) {
      const kw = q.toLowerCase();
      courses = courses.filter(
        (c) =>
          c.Title.toLowerCase().includes(kw) ||
          (c.Description || "").toLowerCase().includes(kw) ||
          (c.InstructorName || "").toLowerCase().includes(kw),
      );
    }
    if (university) {
      courses = courses.filter((c) =>
        c.tags.some(
          (t) =>
            t.TagType === "university" && t.TagValue === String(university),
        ),
      );
    }
    if (major) {
      courses = courses.filter((c) =>
        c.tags.some(
          (t) => t.TagType === "major" && t.TagValue === String(major),
        ),
      );
    }
    if (subject) {
      courses = courses.filter((c) =>
        c.tags.some((t) => t.TagType === "subject" && t.TagValue === subject),
      );
    }

    res.json({ success: true, data: courses });
  } catch (err) {
    console.error("Lỗi getCourses:", err);
    res.status(500).json({ success: false, message: "Lỗi Server" });
  }
};

// GET /courses/:id — Chi tiết khóa học (sections + lessons + progress của user)
exports.getCourseDetail = async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user.id;

    // Course info
    const courseRes = await sql.query`
      SELECT c.*, l.Name AS InstructorName, l.Email AS InstructorEmail,
             u.Name AS CreatedByName
      FROM Courses c
      LEFT JOIN Lecturers l ON c.InstructorId = l.Id
      LEFT JOIN Users u ON c.CreatedBy = u.Id
      WHERE c.Id = ${id}
    `;
    if (courseRes.recordset.length === 0)
      return res
        .status(404)
        .json({ success: false, message: "Không tìm thấy khóa học!" });

    const course = courseRes.recordset[0];

    // Tags
    const tagsRes =
      await sql.query`SELECT TagType, TagValue FROM CourseTags WHERE CourseId = ${id}`;
    course.tags = tagsRes.recordset;

    // Sections + Lessons + Progress
    const sectionsRes = await sql.query`
      SELECT cs.Id, cs.Title, cs.OrderIndex,
             cl.Id AS LessonId, cl.Title AS LessonTitle,
             cl.LessonType, cl.DurationMinutes, cl.OrderIndex AS LessonOrder,
             cl.Description, cl.InstructorId,
             li.Name AS LessonInstructorName,
             -- Trả về VideoId thay vì URL đầy đủ để bảo vệ nguồn
             CASE WHEN cl.VideoUrl IS NOT NULL THEN 'HAS_VIDEO' ELSE NULL END AS HasVideo,
             cp.IsCompleted, cp.WatchedSeconds, cp.LastWatchedAt
      FROM CourseSections cs
      LEFT JOIN CourseLessons cl ON cl.SectionId = cs.Id
      LEFT JOIN Lecturers li ON cl.InstructorId = li.Id
      LEFT JOIN CourseProgress cp ON cp.LessonId = cl.Id AND cp.UserId = ${userId}
      WHERE cs.CourseId = ${id}
      ORDER BY cs.OrderIndex, cl.OrderIndex
    `;

    // Group thành sections
    const sectionsMap = {};
    for (const row of sectionsRes.recordset) {
      if (!sectionsMap[row.Id]) {
        sectionsMap[row.Id] = {
          Id: row.Id,
          Title: row.Title,
          OrderIndex: row.OrderIndex,
          lessons: [],
        };
      }
      if (row.LessonId) {
        sectionsMap[row.Id].lessons.push({
          Id: row.LessonId,
          Title: row.LessonTitle,
          LessonType: row.LessonType,
          DurationMinutes: row.DurationMinutes,
          OrderIndex: row.LessonOrder,
          Description: row.Description,
          InstructorId: row.InstructorId,
          LessonInstructorName: row.LessonInstructorName,
          HasVideo: !!row.HasVideo,
          IsCompleted: !!row.IsCompleted,
          WatchedSeconds: row.WatchedSeconds || 0,
          LastWatchedAt: row.LastWatchedAt,
        });
      }
    }

    course.sections = Object.values(sectionsMap).sort(
      (a, b) => a.OrderIndex - b.OrderIndex,
    );

    res.json({ success: true, data: course });
  } catch (err) {
    console.error("Lỗi getCourseDetail:", err);
    res.status(500).json({ success: false, message: "Lỗi Server" });
  }
};

// GET /courses/:id/lesson/:lessonId/video — Trả video token (bảo vệ URL)
exports.getLessonVideo = async (req, res) => {
  try {
    const { id, lessonId } = req.params;

    // Xác nhận bài học thuộc khóa học này
    const lessonRes = await sql.query`
      SELECT cl.VideoUrl FROM CourseLessons cl
      JOIN CourseSections cs ON cl.SectionId = cs.Id
      WHERE cl.Id = ${lessonId} AND cs.CourseId = ${id} AND cl.LessonType = 'video'
    `;

    if (lessonRes.recordset.length === 0)
      return res
        .status(404)
        .json({ success: false, message: "Không tìm thấy bài học!" });

    const videoUrl = lessonRes.recordset[0].VideoUrl;
    const videoId = extractYouTubeId(videoUrl);

    if (!videoId)
      return res
        .status(400)
        .json({ success: false, message: "URL video không hợp lệ!" });

    // Trả về videoId (không phải URL đầy đủ), frontend sẽ dùng để embed
    // Dùng base64 để không rõ ràng — casual user không thể đoán được
    const encoded = Buffer.from(videoId).toString("base64");
    res.json({ success: true, token: encoded });
  } catch (err) {
    console.error("Lỗi getLessonVideo:", err);
    res.status(500).json({ success: false, message: "Lỗi Server" });
  }
};

// GET /courses/:id/lesson/:lessonId/resources — Links + Files của bài học
exports.getLessonResources = async (req, res) => {
  try {
    const { lessonId } = req.params;
    const [links, files] = await Promise.all([
      sql.query`SELECT Id, Title, Url, OrderIndex FROM CourseLessonLinks WHERE LessonId = ${lessonId} ORDER BY OrderIndex`,
      sql.query`SELECT Id, Title, FileUrl, FileType, OrderIndex FROM CourseLessonFiles WHERE LessonId = ${lessonId} ORDER BY OrderIndex`,
    ]);
    res.json({ success: true, links: links.recordset, files: files.recordset });
  } catch (err) {
    console.error("Lỗi getLessonResources:", err);
    res.status(500).json({ success: false, message: "Lỗi Server" });
  }
};

/* ════════════════════════════════════════════════════
   PROGRESS
════════════════════════════════════════════════════ */

// POST /courses/progress/watch — Lưu tiến độ xem (WatchedSeconds)
exports.saveWatchProgress = async (req, res) => {
  try {
    const { lessonId, watchedSeconds } = req.body;
    const userId = req.user.id;

    // MERGE / UPSERT
    await sql.query`
      MERGE CourseProgress AS target
      USING (SELECT ${userId} AS UserId, ${lessonId} AS LessonId) AS src
        ON target.UserId = src.UserId AND target.LessonId = src.LessonId
      WHEN MATCHED THEN
        UPDATE SET
          WatchedSeconds = CASE WHEN ${watchedSeconds} > target.WatchedSeconds THEN ${watchedSeconds} ELSE target.WatchedSeconds END,
          LastWatchedAt = GETDATE()
      WHEN NOT MATCHED THEN
        INSERT (UserId, LessonId, WatchedSeconds, LastWatchedAt)
        VALUES (${userId}, ${lessonId}, ${watchedSeconds}, GETDATE());
    `;
    res.json({ success: true });
  } catch (err) {
    console.error("Lỗi saveWatchProgress:", err);
    res.status(500).json({ success: false, message: "Lỗi Server" });
  }
};

// PUT /courses/progress/:lessonId/complete — Đánh dấu hoàn thành bài học
exports.markLessonComplete = async (req, res) => {
  try {
    const { lessonId } = req.params;
    const userId = req.user.id;

    await sql.query`
      MERGE CourseProgress AS target
      USING (SELECT ${userId} AS UserId, ${parseInt(lessonId)} AS LessonId) AS src
        ON target.UserId = src.UserId AND target.LessonId = src.LessonId
      WHEN MATCHED THEN
        UPDATE SET IsCompleted = 1, CompletedAt = GETDATE(), LastWatchedAt = GETDATE()
      WHEN NOT MATCHED THEN
        INSERT (UserId, LessonId, IsCompleted, CompletedAt, LastWatchedAt)
        VALUES (${userId}, ${parseInt(lessonId)}, 1, GETDATE(), GETDATE());
    `;
    res.json({ success: true, message: "Đã đánh dấu hoàn thành!" });
  } catch (err) {
    console.error("Lỗi markLessonComplete:", err);
    res.status(500).json({ success: false, message: "Lỗi Server" });
  }
};

/* ════════════════════════════════════════════════════
   COURSE CRUD (Admin / Leader)
════════════════════════════════════════════════════ */

// POST /courses — Tạo khóa học mới
exports.createCourse = async (req, res) => {
  try {
    const {
      title,
      description,
      thumbnailUrl,
      instructorId,
      tags = [],
    } = req.body;
    const userId = req.user.id;

    if (!title || !title.trim())
      return res
        .status(400)
        .json({ success: false, message: "Tiêu đề không được để trống!" });

    const result = await sql.query`
      INSERT INTO Courses (Title, Description, ThumbnailUrl, InstructorId, CreatedBy)
      OUTPUT INSERTED.Id
      VALUES (${title.trim()}, ${description || null}, ${thumbnailUrl || null}, ${instructorId || null}, ${userId})
    `;
    const courseId = result.recordset[0].Id;

    // Lưu tags
    for (const tag of tags) {
      await sql.query`
        INSERT INTO CourseTags (CourseId, TagType, TagValue)
        VALUES (${courseId}, ${tag.type}, ${String(tag.value)})
      `;
    }

    res.status(201).json({
      success: true,
      message: "Đã tạo khóa học!",
      data: { id: courseId },
    });
  } catch (err) {
    console.error("Lỗi createCourse:", err);
    res.status(500).json({ success: false, message: "Lỗi Server" });
  }
};

// PUT /courses/:id — Cập nhật thông tin khóa học
exports.updateCourse = async (req, res) => {
  try {
    const { id } = req.params;
    const {
      title,
      description,
      thumbnailUrl,
      instructorId,
      isPublished,
      tags,
    } = req.body;

    await sql.query`
      UPDATE Courses
      SET Title        = ${title},
          Description  = ${description || null},
          ThumbnailUrl = ${thumbnailUrl || null},
          InstructorId = ${instructorId || null},
          IsPublished  = ${isPublished ? 1 : 0},
          UpdatedAt    = GETDATE()
      WHERE Id = ${id}
    `;

    if (tags !== undefined) {
      await sql.query`DELETE FROM CourseTags WHERE CourseId = ${id}`;
      for (const tag of tags) {
        await sql.query`
          INSERT INTO CourseTags (CourseId, TagType, TagValue)
          VALUES (${id}, ${tag.type}, ${String(tag.value)})
        `;
      }
    }

    res.json({ success: true, message: "Đã cập nhật khóa học!" });
  } catch (err) {
    console.error("Lỗi updateCourse:", err);
    res.status(500).json({ success: false, message: "Lỗi Server" });
  }
};

// DELETE /courses/:id
exports.deleteCourse = async (req, res) => {
  try {
    const { id } = req.params;
    await sql.query`DELETE FROM Courses WHERE Id = ${id}`;
    res.json({ success: true, message: "Đã xóa khóa học!" });
  } catch (err) {
    console.error("Lỗi deleteCourse:", err);
    res.status(500).json({ success: false, message: "Lỗi Server" });
  }
};

/* ════════════════════════════════════════════════════
   SECTIONS CRUD
════════════════════════════════════════════════════ */

// POST /courses/:id/sections
exports.createSection = async (req, res) => {
  try {
    const { id } = req.params;
    const { title } = req.body;

    const maxOrder =
      await sql.query`SELECT COALESCE(MAX(OrderIndex), -1) AS MaxOrder FROM CourseSections WHERE CourseId = ${id}`;
    const nextOrder = maxOrder.recordset[0].MaxOrder + 1;

    const result = await sql.query`
      INSERT INTO CourseSections (CourseId, Title, OrderIndex)
      OUTPUT INSERTED.*
      VALUES (${id}, ${title}, ${nextOrder})
    `;
    res.status(201).json({ success: true, data: result.recordset[0] });
  } catch (err) {
    console.error("Lỗi createSection:", err);
    res.status(500).json({ success: false, message: "Lỗi Server" });
  }
};

// PUT /courses/sections/:sectionId
exports.updateSection = async (req, res) => {
  try {
    const { sectionId } = req.params;
    const { title } = req.body;
    await sql.query`UPDATE CourseSections SET Title = ${title} WHERE Id = ${sectionId}`;
    res.json({ success: true, message: "Đã cập nhật phần học!" });
  } catch (err) {
    console.error("Lỗi updateSection:", err);
    res.status(500).json({ success: false, message: "Lỗi Server" });
  }
};

// DELETE /courses/sections/:sectionId
exports.deleteSection = async (req, res) => {
  try {
    const { sectionId } = req.params;
    // Lấy courseId trước khi xóa để recalcDuration
    const secRes =
      await sql.query`SELECT CourseId FROM CourseSections WHERE Id = ${sectionId}`;
    await sql.query`DELETE FROM CourseSections WHERE Id = ${sectionId}`;
    if (secRes.recordset.length > 0)
      await recalcDuration(secRes.recordset[0].CourseId);
    res.json({ success: true, message: "Đã xóa phần học!" });
  } catch (err) {
    console.error("Lỗi deleteSection:", err);
    res.status(500).json({ success: false, message: "Lỗi Server" });
  }
};

/* ════════════════════════════════════════════════════
   LESSONS CRUD
════════════════════════════════════════════════════ */

// POST /courses/sections/:sectionId/lessons
exports.createLesson = async (req, res) => {
  try {
    const { sectionId } = req.params;
    const {
      title,
      lessonType,
      durationMinutes,
      instructorId,
      description,
      videoUrl,
      links = [],
      files = [],
    } = req.body;

    const maxOrder =
      await sql.query`SELECT COALESCE(MAX(OrderIndex), -1) AS MaxOrder FROM CourseLessons WHERE SectionId = ${sectionId}`;
    const nextOrder = maxOrder.recordset[0].MaxOrder + 1;

    const result = await sql.query`
      INSERT INTO CourseLessons (SectionId, Title, LessonType, DurationMinutes, InstructorId, Description, VideoUrl, OrderIndex)
      OUTPUT INSERTED.Id
      VALUES (
        ${sectionId}, ${title}, ${lessonType || "video"},
        ${durationMinutes || null}, ${instructorId || null},
        ${description || null}, ${videoUrl || null},
        ${nextOrder}
      )
    `;
    const lessonId = result.recordset[0].Id;

    // Lưu links học liệu
    for (let i = 0; i < links.length; i++) {
      await sql.query`
        INSERT INTO CourseLessonLinks (LessonId, Title, Url, OrderIndex)
        VALUES (${lessonId}, ${links[i].title}, ${links[i].url}, ${i})
      `;
    }
    // Lưu files đính kèm
    for (let i = 0; i < files.length; i++) {
      await sql.query`
        INSERT INTO CourseLessonFiles (LessonId, Title, FileUrl, FileType, OrderIndex)
        VALUES (${lessonId}, ${files[i].title}, ${files[i].fileUrl}, ${files[i].fileType || null}, ${i})
      `;
    }

    // Cập nhật TotalDuration của course
    const secRes =
      await sql.query`SELECT CourseId FROM CourseSections WHERE Id = ${sectionId}`;
    if (secRes.recordset.length > 0)
      await recalcDuration(secRes.recordset[0].CourseId);

    res.status(201).json({
      success: true,
      message: "Đã thêm bài học!",
      data: { id: lessonId },
    });
  } catch (err) {
    console.error("Lỗi createLesson:", err);
    res.status(500).json({ success: false, message: "Lỗi Server" });
  }
};

// PUT /courses/lessons/:lessonId
exports.updateLesson = async (req, res) => {
  try {
    const { lessonId } = req.params;
    const {
      title,
      lessonType,
      durationMinutes,
      instructorId,
      description,
      videoUrl,
      links,
      files,
    } = req.body;

    await sql.query`
      UPDATE CourseLessons SET
        Title           = ${title},
        LessonType      = ${lessonType},
        DurationMinutes = ${durationMinutes || null},
        InstructorId    = ${instructorId || null},
        Description     = ${description || null},
        VideoUrl        = ${videoUrl || null}
      WHERE Id = ${lessonId}
    `;

    if (links !== undefined) {
      await sql.query`DELETE FROM CourseLessonLinks WHERE LessonId = ${lessonId}`;
      for (let i = 0; i < links.length; i++) {
        await sql.query`INSERT INTO CourseLessonLinks (LessonId, Title, Url, OrderIndex) VALUES (${lessonId}, ${links[i].title}, ${links[i].url}, ${i})`;
      }
    }
    if (files !== undefined) {
      await sql.query`DELETE FROM CourseLessonFiles WHERE LessonId = ${lessonId}`;
      for (let i = 0; i < files.length; i++) {
        await sql.query`INSERT INTO CourseLessonFiles (LessonId, Title, FileUrl, FileType, OrderIndex) VALUES (${lessonId}, ${files[i].title}, ${files[i].fileUrl}, ${files[i].fileType || null}, ${i})`;
      }
    }

    // Cập nhật TotalDuration
    const secRes =
      await sql.query`SELECT cs.CourseId FROM CourseSections cs JOIN CourseLessons cl ON cl.SectionId = cs.Id WHERE cl.Id = ${lessonId}`;
    if (secRes.recordset.length > 0)
      await recalcDuration(secRes.recordset[0].CourseId);

    res.json({ success: true, message: "Đã cập nhật bài học!" });
  } catch (err) {
    console.error("Lỗi updateLesson:", err);
    res.status(500).json({ success: false, message: "Lỗi Server" });
  }
};

// DELETE /courses/lessons/:lessonId
exports.deleteLesson = async (req, res) => {
  try {
    const { lessonId } = req.params;
    const secRes =
      await sql.query`SELECT cs.CourseId FROM CourseSections cs JOIN CourseLessons cl ON cl.SectionId = cs.Id WHERE cl.Id = ${lessonId}`;
    await sql.query`DELETE FROM CourseLessons WHERE Id = ${lessonId}`;
    if (secRes.recordset.length > 0)
      await recalcDuration(secRes.recordset[0].CourseId);
    res.json({ success: true, message: "Đã xóa bài học!" });
  } catch (err) {
    console.error("Lỗi deleteLesson:", err);
    res.status(500).json({ success: false, message: "Lỗi Server" });
  }
};
