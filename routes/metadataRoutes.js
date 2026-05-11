const express = require("express");
const router = express.Router();
const metadataController = require("../controllers/metadataController");

router.get("/universities", metadataController.getUniversities);
router.get("/majors", metadataController.getMajors);
router.get("/lecturers", metadataController.getLecturers);

module.exports = router;
