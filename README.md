# 亦玩采购流程台

采购端与供应商端共用的一套采购订单协作系统。采购创建供应商和采购单，供应商仅能查看本公司的订单并更新确认、生产和发货节点，采购负责确认到货与完结。

## 第一阶段范围

- 供应商资料与供应商登录账号
- 一张采购单包含多个产品明细
- 固定状态：待供应商确认 → 生产中 → 待发货 → 已发货 → 已到货 → 已完结
- 生产进度、物流信息、操作轨迹
- D1 持久化业务数据，R2 保存采购单、产品图、生产图和发货图
- 自动提醒暂未启用

## 本地运行

1. 复制 `.dev.vars.example` 为 `.dev.vars`，设置一次性的 `SETUP_SECRET`。
2. 安装依赖：`pnpm install`
3. 初始化本地数据库：`pnpm db:local`
4. 启动：`pnpm dev`
5. 首次打开后，使用初始化安全码创建采购管理员账号。

## Cloudflare 上线

1. 创建 D1：`wrangler d1 create yifun-procurement-db`
2. 将返回的数据库 ID 填入 `wrangler.jsonc` 的 `database_id`。
3. 创建 R2：`wrangler r2 bucket create yifun-procurement-files`
4. 设置一次性初始化安全码：`wrangler secret put SETUP_SECRET`
5. 执行远程迁移：`wrangler d1 migrations apply yifun-procurement-db --remote`
6. 构建并部署：`pnpm build`，然后 `wrangler deploy -c dist/yifun_procurement_hub/wrangler.json`
7. 打开线上地址，由采购管理员本人创建第一个账号。创建成功后首次开通入口会自动关闭。

不要把 `.dev.vars`、密码或初始化安全码提交到版本库。
