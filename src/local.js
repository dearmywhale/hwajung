'use strict';
// 내 컴퓨터나 일반 서버에서 실행: npm start
const { createApp } = require('./application');

const port = Number(process.env.PORT) || 3000;
const app = createApp();
app.locals.ready()
  .then(() => app.listen(port, () => console.log(`화정 찬양부 서버가 http://localhost:${port} 에서 실행 중입니다.`)))
  .catch((e) => { console.error(e.message || e); process.exit(1); });
