function generateGroupName(semester, classCode, subjectCode, groupNumber) {
  const random = Math.floor(100000 + Math.random() * 900000);

  return `${semester}_${classCode}_${subjectCode}_Group${groupNumber}_${random}`;
}

module.exports = generateGroupName;
