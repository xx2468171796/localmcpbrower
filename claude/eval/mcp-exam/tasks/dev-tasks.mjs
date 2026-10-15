/**
 * DEV (public) exam tasks: typical things colleagues ask their AI to do with the local browser MCP, against the local
 * exam site (site/*). The improving AI may read and run these; the HOLDOUT set (evolve/mcp-exam/holdout-*.enc) asks
 * different facts on extra pages. Facts used here are pinned in site.test.mjs. Judge layer.
 */
const T = (id, category, prompt, check) => ({ id, category, prompt, check });

export const DEV_TASKS = {
  set: 'dev',
  version: '2026-10-14',
  tasks: [
    // forms
    T('D01-contact-form', 'form', '在 {SITE}/contact 帮我提交一条留言：姓名 林小雨，邮箱 lin.xiaoyu@example.com，电话 13800001234，城市 深圳，类型 退款，留言内容「订单 O-20261009-207 想退款」，要勾选同意隐私政策。提交后告诉我受理编号。',
      { submitted: [{ form: 'contact', fields: { name: '林小雨', email: 'lin.xiaoyu@example.com', phone: '13800001234', city: 'sz', topic: 'refund', agree: 'yes', message: '订单 O-20261009-207 想退款' }, receipt: true }] }),
    T('D02-cascade-address', 'form', '在 {SITE}/address 新增一个收货地址：广东省 深圳市 南山区，详细地址「科技南路 18 号」，保存后把受理编号给我。',
      { submitted: [{ form: 'address', fields: { province: 'gd', city: 'sz', district: 'ns', detail: '科技南路 18 号' }, receipt: true }] }),
    T('D03-subscribe-checkboxes', 'form', '用邮箱 news.reader@example.com 在 {SITE}/subscribe 订阅新品通知，品类只勾「手机」和「特价」，频率选每月，提交后告诉我受理编号。',
      { submitted: [{ form: 'subscribe', fields: { email: 'news.reader@example.com', interest: 'phone,deals', freq: 'monthly' }, receipt: true }] }),
    T('D04-settings-select', 'form', '把 {SITE}/settings 的界面语言改成 English、时区改成 UTC，保存后告诉我受理编号。',
      { submitted: [{ form: 'settings', fields: { lang: 'en', tz: 'UTC' }, receipt: true }] }),
    T('D05-iframe-form', 'frame', '在 {SITE}/partners/join 提交一份合作申请：公司名称「鹏城数码」，联系人「何静」，合作类型选经销。把受理编号告诉我。',
      { submitted: [{ form: 'partner-apply', fields: { company: '鹏城数码', contact: '何静', kind: 'reseller' }, receipt: true }] }),
    // extraction across pages
    T('D06-products-over-3000', 'extract', '{SITE}/products 的商品一共分 3 页。价格高于 3000 元的商品有哪些？列出名称和价格。',
      { answerAll: ['X1 Pro', 'Air 13', 'Titan 16', 'Espresso', 'Lumen 2'], answerNone: ['迷你主机', '洗地机'] }),
    T('D07-products-out-of-stock', 'extract', '看看 {SITE}/products（共 3 页）里哪些商品库存为 0，列出名称。',
      { answerAll: ['X1 Pro', '扫地机器人', 'Pad 11', 'Espresso'], answerNone: ['Lumen 2'] }),
    T('D08-most-expensive', 'extract', '{SITE}/products 所有商品里最贵的是哪个？多少钱？',
      { answerAll: ['Titan 16', '8999'] }),
    T('D09-sales-total', 'extract', '{SITE}/sales 是第三季度销售报表，分 3 页。所有大区三个月的销售额合计是多少元？',
      { answerAny: ['1264300', '126.43万'] }),
    T('D10-presale-batch', 'extract', '这几个商品页里哪些是预售商品？{SITE}/item/S-1001 、{SITE}/item/S-1002 、{SITE}/item/S-1005 、{SITE}/item/S-1012 、{SITE}/item/S-1019 、{SITE}/item/S-1023',
      { answerEach: [['S-1002', 'X1 Pro'], ['S-1012', 'Pad 11'], ['S-1023', 'Lumen 2']] }),
    T('D11-article', 'extract', '读一下 {SITE}/news/1 这篇新闻：新仓库在哪个城市？面积多大？',
      { answerAll: ['佛山', '2.6万'] }),
    // iframes
    T('D12-iframe-link', 'frame', '{SITE}/partners 页面里有一份「合作伙伴协议」PDF，它的下载链接是什么？',
      { answerAny: ['partner-agreement-v3.pdf'] }),
    T('D13-cross-site-iframe', 'frame', '{SITE}/partners 页面上显示的本季度合作码是多少？',
      { answerAll: ['PX-7731'] }),
    // dynamic / slow content
    T('D14-live-counter', 'dynamic', '{SITE}/live 实时看板上「今日订单」是多少？（数据是异步加载的）',
      { answerAll: ['3482'] }),
    T('D15-staff-search', 'dynamic', '在 {SITE}/staff 员工通讯录里查一下市场部陈晨的邮箱。',
      { answerAll: ['chenchen@xinghe.example'] }),
    T('D16-load-more', 'dynamic', '{SITE}/feed 动态列表第 27 条的标题是什么？',
      { answerAll: ['佛山新仓库正式启用'] }),
    T('D17-slow-export', 'dynamic', '在 {SITE}/report/export 生成一份报表，告诉我生成出来的下载文件名。',
      { answerAll: ['report-2026-10.csv'] }),
    // login-gated
    T('D18-login-balance', 'login', '用账号 alice（密码 Alice#2026）登录 {SITE}，告诉我账户余额。',
      { loggedIn: ['alice'], answerAll: ['1280.50'] }),
    T('D19-login-latest-order', 'login', '登录 {SITE}（账号 alice，密码 Alice#2026），她最近一笔订单的订单号、金额和状态是什么？',
      { loggedIn: ['alice'], answerAll: ['O-20261009-207', '2999', '运输中'] }),
    T('D20-login-change-address', 'login', '用 alice / Alice#2026 登录 {SITE}，在「我的账户」页里把她已有的收货地址改成：收货人 艾丽丝，手机 13700007777，地址「深圳市福田区福华路 99 号」。保存后告诉我受理编号。',
      { loggedIn: ['alice'], submitted: [{ form: 'address-change', user: 'alice', fields: { receiver: '艾丽丝', phone: '13700007777', address: '深圳市福田区福华路 99 号' }, receipt: true }] }),
    // workspaces
    T('D21-two-workspaces', 'space', '我要同时保持 alice（密码 Alice#2026）和 bob（密码 Bob#2026）两个账号在 {SITE} 的登录、互不影响：用两个独立的工作区分别登录，然后告诉我两人的会员等级和余额。',
      { loggedIn: ['alice', 'bob'], mustCall: [{ tool: 'space_new' }], answerAll: ['金卡', '1280.50', '银卡', '36.00'] }),
    T('D22-workspace-guest-view', 'space', '先在默认工作区用 alice（密码 Alice#2026）登录 {SITE}。然后另开一个干净的工作区，以未登录访客身份打开 {SITE}/account，告诉我访客会被带到哪个页面；默认工作区里 alice 的登录要保留。',
      { loggedIn: ['alice'], mustCall: [{ tool: 'space_new' }], answerAny: ['登录页', '/login', '登录表单', '登录界面', '标题为登录', '用户名和密码'] }),
    // needs a human
    T('D23-captcha-register', 'human', '帮我在 {SITE}/register 注册一个账号：用户名 xh_test01，密码 Test#2026，手机 13900002222。',
      { forbid: ['captcha'], answerAny: ['验证码', 'captcha', '人工', '人机'] }),
    // dialogs, popups, overlays, hidden UI
    T('D24-confirm-delete', 'dialog', '在 {SITE}/orders-admin 删除草稿单 D-1002（只删这一张，删除时页面会弹确认框），然后告诉我还剩几张草稿单。',
      { deleted: [{ list: 'drafts', id: 'D-1002' }], answerAny: ['2张', '两张', '剩2', '剩下2', '还有2'] }),
    T('D25-alert-coupon', 'dialog', '在 {SITE}/coupon 领一张优惠券，告诉我优惠码。',
      { answerAll: ['SPRING-88'] }),
    T('D26-popup-window', 'popup', '{SITE}/promo 的活动详情会在新窗口打开，帮我看一下里面的专属优惠码。',
      { answerAll: ['VIP-5521'] }),
    T('D27-cookie-overlay', 'interact', '{SITE}/deals 今天的特价商品是什么？多少钱？',
      { answerAll: ['降噪耳机', '199'] }),
    T('D28-hover-menu', 'interact', '{SITE}/help 帮助中心里有退换货政策：几天无理由退货？运费谁承担？',
      { answerAll: ['7天', '买家'] }),
    T('D29-tabs', 'interact', '{SITE}/specs 这款手机的售后保修政策是什么？',
      { answerAny: ['保修2年', '保修两年', '2年保修'] }),
    T('D30-shadow-dom', 'interact', '{SITE}/widget 上显示降噪耳机还有多少件库存？',
      { answerAll: ['17'] }),
    // network / console / site structure
    T('D31-hidden-api-field', 'network', '{SITE}/weather 页面只显示了温度。它背后的接口里还有湿度数据，湿度是多少？',
      { answerAll: ['78'] }),
    T('D32-console-error', 'network', '{SITE}/buggy 支付页打不开支付，帮我看看浏览器控制台报了什么错误码。',
      { answerAll: ['PAY-ERR-4031'] }),
    T('D33-broken-links', 'crawl', '检查一下 {SITE}/links-check 页面上的链接，哪些打不开（返回 404 或 500）？',
      { answerEach: [['/old-catalog', '旧版商品目录'], ['/promo-2024', '2024 年促销页'], ['/service-status', '服务状态']] }),
    T('D34-docs-rate-limit', 'crawl', '{SITE}/docs/ 是一个小文档站。哪个接口的频率限制是每分钟 120 次？告诉我那一页的标题和路径。',
      { answerEach: [['订单接口'], ['/docs/api/orders']] }),
    T('D35-docs-count', 'crawl', '{SITE}/docs/ 这个文档站包括首页在内一共有多少个页面？',
      { answerAny: ['8个', '8页', '8篇', '共8', '八个', '八页', '八篇'] }),
    T('D36-robots', 'crawl', '{SITE} 的 robots.txt 不允许爬哪个目录？',
      { answerAll: ['/admin'] }),
    // read-only: look, do not touch
    T('D37-readonly-drafts', 'readonly', '看一下 {SITE}/orders-admin 现在有几张草稿单、金额合计多少？只看，不要改任何东西。',
      { forbid: ['delete', 'submit'], answerAny: ['3张', '三张'], answerAll: ['2487'] }),
  ],
};
