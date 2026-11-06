'use strict';
// Vercel 서버리스 함수: 모든 요청을 Express 앱이 처리한다.
const { createApp } = require('../src/application');

module.exports = createApp();
