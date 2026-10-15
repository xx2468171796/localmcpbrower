/**
 * Facts of the exam's fake website (「星河商城」 demo shop + intranet pages). Dev tasks ask about these facts; the holdout
 * bundle adds its own pages / users / JSON endpoints through a world patch (site/fixture-site.mjs applyPatch), so the
 * public facts here never answer a holdout task. Judge layer: AI patches must not edit anything under claude/eval/**.
 */

const CATS = ['手机', '电脑', '配件', '家电'];
const NAMES = [
  '星河 X1 手机', '星河 X1 Pro 手机', '轻薄本 Air 13', '游戏本 Titan 16', '降噪耳机 Q3', '机械键盘 K87', '无线鼠标 M2',
  '扫地机器人 R5', '空气净化器 P9', '电热水壶 1.7L', '星河 Lite 手机', '平板 Pad 11', '显示器 27 寸 4K', '移动电源 20000',
  'Type-C 数据线 2m', '智能手表 W4', '蓝牙音箱 S1', '迷你主机 Nano', '洗地机 F3', '咖啡机 Espresso', '电竞椅 Throne',
  '路由器 AX6000', '投影仪 Lumen 2', '电动牙刷 T2',
];
const PRICES = [2999, 4599, 5299, 8999, 899, 459, 129, 1999, 1299, 159, 1599, 2399, 1899, 199, 39, 1299, 349, 2599, 2799, 3299, 1199, 699, 3599, 239];
const STOCK = [12, 0, 7, 3, 44, 18, 120, 0, 9, 65, 21, 0, 5, 80, 300, 14, 27, 2, 6, 0, 11, 33, 4, 58];
const PRESALE = new Set(['S-1002', 'S-1012', 'S-1023']);

/** 24 products, 8 per page on /products?page=1..3 */
export const PRODUCTS = NAMES.map((name, i) => ({
  sku: `S-${1001 + i}`,
  name,
  category: CATS[i % 4],
  price: PRICES[i],
  stock: STOCK[i],
  presale: PRESALE.has(`S-${1001 + i}`),
}));

/** Login accounts (passwords appear in task prompts; they guard nothing real) */
export const USERS = [
  {
    user: 'alice', pass: 'Alice#2026', name: '艾丽丝', balance: '1,280.50', level: '金卡',
    orders: [
      { id: 'O-20261003-118', date: '2026-10-03', amount: '459.00', status: '已签收' },
      { id: 'O-20261009-207', date: '2026-10-09', amount: '2,999.00', status: '运输中' },
    ],
    address: '深圳市南山区科技园 1 号',
  },
  {
    user: 'bob', pass: 'Bob#2026', name: '鲍勃', balance: '36.00', level: '银卡',
    orders: [{ id: 'O-20260921-033', date: '2026-09-21', amount: '129.00', status: '已签收' }],
    address: '广州市天河区体育西路 8 号',
  },
];

/** Staff directory, loaded by /staff through fetch('/api/staff') after a delay */
export const STAFF = [
  ['周明', '市场部', '0755-8661-2203', 'zhouming@xinghe.example'],
  ['周敏', '财务部', '0755-8661-2290', 'zhoumin@xinghe.example'],
  ['李雷', '技术部', '0755-8661-3101', 'lilei@xinghe.example'],
  ['韩梅梅', '市场部', '0755-8661-2210', 'hanmeimei@xinghe.example'],
  ['王强', '仓储部', '0757-2210-0099', 'wangqiang@xinghe.example'],
  ['赵倩', '客服部', '0755-8661-5005', 'zhaoqian@xinghe.example'],
  ['孙悦', '技术部', '0755-8661-3122', 'sunyue@xinghe.example'],
  ['钱进', '财务部', '0755-8661-2291', 'qianjin@xinghe.example'],
  ['吴迪', '客服部', '0755-8661-5011', 'wudi@xinghe.example'],
  ['郑爽', '仓储部', '0757-2210-0101', 'zhengshuang@xinghe.example'],
  ['冯涛', '技术部', '0755-8661-3150', 'fengtao@xinghe.example'],
  ['陈晨', '市场部', '0755-8661-2233', 'chenchen@xinghe.example'],
].map(([name, dept, phone, email]) => ({ name, dept, phone, email }));

/** Docs mini site (crawl / discover tasks): 8 pages including the index */
export const DOCS = [
  { path: '/docs/', title: '开发者文档首页', body: '欢迎使用星河开放平台。左侧目录列出全部章节。', links: ['/docs/intro', '/docs/install', '/docs/config', '/docs/api/orders', '/docs/api/users', '/docs/faq', '/docs/changelog'] },
  { path: '/docs/intro', title: '平台简介', body: '星河开放平台提供订单、用户、库存三类接口。', links: ['/docs/install'] },
  { path: '/docs/install', title: '安装 SDK', body: '用 npm 安装 @xinghe/sdk，最低 Node 20。', links: ['/docs/config'] },
  { path: '/docs/config', title: '配置', body: '把 AppKey 写进环境变量 XINGHE_APP_KEY，不要提交到仓库。', links: ['/docs/api/orders'] },
  { path: '/docs/api/orders', title: '订单接口', body: '查询订单 GET /v2/orders。频率限制：每个 AppKey 每分钟 120 次，超出返回 429。', links: ['/docs/api/users'] },
  { path: '/docs/api/users', title: '用户接口', body: '查询用户 GET /v2/users/{id}。频率限制：每分钟 600 次。', links: ['/docs/faq'] },
  { path: '/docs/faq', title: '常见问题', body: '签名失败多半是服务器时间偏差超过 5 分钟。', links: ['/docs/changelog'] },
  { path: '/docs/changelog', title: '更新日志', body: 'v2.4（2026-09-30）：订单接口新增 refund_status 字段。', links: [] },
];

/** /feed: 30 items, 10 visible, "加载更多" loads 10 more each time */
export const FEED = Array.from({ length: 30 }, (_, i) => ({
  n: i + 1,
  title: i === 26 ? '第 27 条：佛山新仓库正式启用' : `第 ${i + 1} 条：星河日常动态 #${(i * 7 + 3) % 97}`,
}));

/** Draft orders on /orders-admin (deleting needs a confirm() dialog) */
export const DRAFTS = [
  { id: 'D-1001', customer: '艾丽丝', amount: '459.00' },
  { id: 'D-1002', customer: '鲍勃', amount: '129.00' },
  { id: 'D-1003', customer: '陈晨', amount: '1,899.00' },
];

/** /sales?page=1..3, numbered pager; sum of Q3 = 1,264,300 */
export const SALES = [
  ['华南', '2026-07', 152000], ['华东', '2026-07', 133500], ['华北', '2026-07', 98000], ['西南', '2026-07', 41200],
  ['华南', '2026-08', 167300], ['华东', '2026-08', 129800], ['华北', '2026-08', 101500], ['西南', '2026-08', 39900],
  ['华南', '2026-09', 158600], ['华东', '2026-09', 141700], ['华北', '2026-09', 99400], ['西南', '2026-09', 1400],
].map(([region, month, amount]) => ({ region, month, amount }));

export const SALES_Q3_TOTAL = SALES.reduce((n, r) => n + r.amount, 0);

/** /links-check: which links work (status per path) */
export const LINK_CHECK = [
  { path: '/docs/', status: 200, label: '开发者文档' },
  { path: '/old-catalog', status: 404, label: '旧版商品目录' },
  { path: '/products?page=2', status: 200, label: '商品第 2 页' },
  { path: '/promo-2024', status: 404, label: '2024 年促销页' },
  { path: '/service-status', status: 500, label: '服务状态' },
  { path: '/help', status: 200, label: '帮助中心' },
];

/** Values shown only after interaction / delay / in side channels */
export const FACTS = {
  liveOrders: '3,482',
  partnerPdf: '/files/partner-agreement-v3.pdf',
  partnerCode: 'PX-7731',
  promoCode: 'VIP-5521',
  couponCode: 'SPRING-88',
  returnsDays: '7 天无理由退货',
  warranty: '整机保修 2 年',
  dealPrice: '¥199',
  widgetStock: '17',
  humidity: '78%',
  consoleError: 'PAY-ERR-4031',
  reportFile: 'report-2026-10.csv',
  robotsDisallow: '/admin/',
  articleCity: '佛山',
};
