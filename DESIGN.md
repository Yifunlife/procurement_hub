---
name: 亦玩采购管理中心
description: 既有蓝黄采购工作台的可复用视觉系统
colors:
  blue: "#264b82"
  blue-dark: "#183765"
  yellow: "#edbd0b"
  signal: "#c99b00"
  signal-soft: "#fff3bf"
  paper: "#ffffff"
  paper-deep: "#f4f7fb"
  ink: "#12233f"
  muted: "#66758a"
  line: "#dbe3ee"
  blue-soft: "#e5edf8"
typography:
  headline:
    fontFamily: '"Arial Narrow", "PingFang SC", "Microsoft YaHei", sans-serif'
    fontSize: "28px"
    fontWeight: 800
    lineHeight: 1.2
    letterSpacing: "-.035em"
  body:
    fontFamily: '"PingFang SC", "Microsoft YaHei", "Noto Sans CJK SC", sans-serif'
    fontSize: "14px"
    lineHeight: 1.65
  label:
    fontSize: "13px"
    fontWeight: 650
rounded:
  tag: "6px"
  control: "9px"
  mobile-surface: "12px"
  form-surface: "14px"
spacing:
  compact: "8px"
  field: "16px"
  form: "18px"
  section: "24px"
components:
  button-primary:
    backgroundColor: "{colors.blue}"
    textColor: "{colors.paper}"
    rounded: "{rounded.control}"
    padding: "10px 17px"
  button-primary-hover:
    backgroundColor: "{colors.blue-dark}"
  button-secondary:
    backgroundColor: "{colors.paper}"
    textColor: "{colors.ink}"
    rounded: "{rounded.control}"
    padding: "9px 15px"
  input:
    backgroundColor: "{colors.paper}"
    rounded: "{rounded.control}"
    padding: "11px 12px"
  form-card:
    backgroundColor: "{colors.paper}"
    rounded: "{rounded.form-surface}"
    padding: "24px"
  verification-note:
    backgroundColor: "{colors.signal-soft}"
    textColor: "{colors.ink}"
    padding: "14px 16px"
---

# Design System: 亦玩采购管理中心

## Overview

沿用既有蓝色导航、黄色选中态和白色业务内容区。界面以中文业务信息的清晰阅读、表单录入和记录追溯为主；商务条件与财务结算属于既有系统的延伸，不另设视觉品牌。

来源：`src/styles.css`、`src/App.tsx`、`src/Commercial.tsx`；已对照财务移动端验收截图。本文记录当前实现，不引入新的风格隐喻或色阶。

## Colors

### Primary

深蓝用于侧栏、主操作和表单焦点；深一阶蓝色用于主按钮悬停。现有 CSS 的 `--green` 与 `--blue` 均指向同一蓝色，名称不是绿色品牌指令。

### Secondary

黄色用于当前导航、流程节点与文本选择；淡黄色用于待核实提示。金色用于部分编号和文字操作悬停。业务状态仍保留既有状态标签配色，不把所有状态统一为品牌蓝。

### Neutral

白色承载内容，淡灰蓝区分工作台背景、表头与次级区域。深墨蓝为正文，灰蓝用于字段说明，淡线色分隔逐笔记录与区块。

## Typography

中文采用系统无衬线字栈；标题使用加粗、略紧字距的标题字栈。顶部页面标题在窄屏（900px 以下）缩为 23px。正文 token 对应商务条件摘要；财务表格同为 14px，但不人为覆盖其继承行高。

字段标签为 13px，摘要说明清楚地位于数值之前。金额采用等宽数字特性 `tabular-nums`；财务汇总桌面为 21px、移动端为 18px。未知金额直接显示“待核实”，不以零或视觉占位符代替。

## Layout

桌面工作台为 260px 侧栏加可收缩主区域；900px 以下侧栏改为 270px 抽屉。顶部操作栏保留原有导航与入口。

商务字段采用两列等宽网格（间距 16px）；摘要为两列（行距 18px、列距 24px），变更前后并排比较。640px 以下三者均为单列，商务输入控件字号为 16px。

财务内容桌面外边距 20px、内边距 28px，640px 以下分别为 10px、16px。汇总自适应排列，移动端保留两列。财务表格最小宽度为 700px，仅表格容器横向滚动；不让整页横向溢出，也不强行压缩列。此行为不同于移动端采购订单卡片，不应互相替换。

## Elevation & Depth

白色表面与分隔线提供主要层次；采购详情及表单容器沿用柔和蓝灰投影。财务主体是无圆角、无投影的白色区域。主按钮有轻微投影，输入焦点用蓝色细光圈；精确阴影与动效记录在 sidecar。

## Shapes

控件采用小圆角，表单和采购详情容器使用较大圆角，状态标签更紧凑。商务条件区通过顶部细线分隔，不逐字段新增卡片。待核实提示是平直的淡黄色信息块。

## Components

- 主按钮：蓝底白字，最小高度 44px；悬停加深并上移 1px，禁用时透明度 0.55。
- 次按钮：白底描边，最小高度 44px；悬停改蓝色文字和描边。文字按钮保持透明底。
- 输入：白底细描边，悬停加深边框，聚焦蓝色边框加光圈；可见键盘焦点沿用黄色轮廓。多行内容允许纵向调整与换行。
- 导航：深蓝侧栏、浅色文字，当前主导航为黄色底；移动端通过既有抽屉打开。
- 状态标签：紧凑文字与浅色底配合，始终显示状态文字，不能只靠颜色表达。
- 历史：原生可展开条目，保留时间、操作人、原因、变更前后内容；长文本换行，不截断核实依据。
- 财务表格：浅灰蓝表头、逐行细分隔线、顶部对齐；表头内边距 14px 12px，单元格 16px 12px。凭证、备注及操作记录保持可查阅。

## Do's and Don'ts

- Do 保留既有蓝黄导航、中文标题层级与系统字体。
- Do 显示明确的“待核实”、历史版本与变更依据。
- Do 将财务宽表的水平滚动限制在表格容器内。
- Don't 把未知金额显示为零，或用装饰性状态替代业务文字。
- Don't 将商务与财务扩展改造成新的品牌或营销式页面。
- Don't 将采购卡片的移动端折叠模式强加给财务明细表。
