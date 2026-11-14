// 從自己電腦初始化 Neon（一般用 /api/init 即可，這是備用方式）
// 用法：DATABASE_URL=... npm run db:init
require('../src/env');
const { run } = require('../src/handlers');

run('init', { method: 'POST', query: { token: process.env.INIT_TOKEN } }).then((r) => {
  console.log(r.status, r.data);
  process.exit(r.status === 200 ? 0 : 1);
});
