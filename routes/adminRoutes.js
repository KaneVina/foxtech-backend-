const express = require("express");
const router = express.Router();
const admin = require("../controllers/adminController");
const { verifyToken } = require("../middleware/authMiddleware");
const checkRole = require("../middleware/roleMiddleware");

const guard = [verifyToken, checkRole(["admin"])];

router.get("/stats", guard, admin.getStats);
router.get("/users", guard, admin.getUsers);
router.post("/users", guard, admin.createUser);
router.put("/users/:id/status", guard, admin.updateUserStatus);
router.get("/users/search", guard, admin.searchUsers);
router.get("/global-search", guard, admin.globalSearch);

router.get("/groups", guard, admin.getAdminGroups);
router.put("/groups/:id/status", guard, admin.updateGroupStatus);
router.post("/groups/warning", guard, admin.sendGroupWarning);
router.put("/users/:id", guard, admin.updateUser);
router.delete("/users/:id", guard, admin.deleteUser);
router.get("/universities", guard, admin.getUniversities);
router.post("/universities", guard, admin.createUniversity);
router.put("/universities/:id", guard, admin.updateUniversity);
router.delete("/universities/:id", guard, admin.deleteUniversity);

router.get("/subjects", guard, admin.getSubjects);
router.post("/subjects", guard, admin.createSubject);
router.put("/subjects/:code", guard, admin.updateSubject);
router.delete("/subjects/:code", guard, admin.deleteSubject);

router.get("/majors", guard, admin.getMajors);
router.post("/majors", guard, admin.createMajor);
router.put("/majors/:id", guard, admin.updateMajor);
router.delete("/majors/:id", guard, admin.deleteMajor);

router.get("/lecturers", guard, admin.getLecturers);
router.post("/lecturers", guard, admin.createLecturer);
router.put("/lecturers/:id", guard, admin.updateLecturer);
router.delete("/lecturers/:id", guard, admin.deleteLecturer);

router.post("/notifications/send", guard, admin.sendSystemNotification);

router.get("/requests", guard, admin.getAllRequests);
router.put("/requests/:id/resolve", guard, admin.resolveRequest);

router.put("/group-requests/:id/resolve", guard, admin.resolveGroupRequest);
router.get("/group-requests", guard, admin.getGroupRequests);
module.exports = router;
