import fs from "node:fs/promises";
import path from "node:path";
import { SpreadsheetFile, Workbook } from "@oai/artifact-tool";

const root = path.resolve(import.meta.dirname, "..");
const outputDir = path.join(root, "outputs", "019fc5c9");
const outputPath = path.join(outputDir, "业务进度管理微信小程序开发排期.xlsx");
const qaDir = path.join(root, "qa", "xlsx_render");

await fs.mkdir(outputDir, { recursive: true });
await fs.mkdir(qaDir, { recursive: true });

const workbook = Workbook.create();
workbook.comments.setSelf({ displayName: "项目组" });

const colors = {
  teal: "#0F766E",
  tealLight: "#CCFBF1",
  navy: "#1F3A5F",
  blueLight: "#E8EEF5",
  gray: "#6B7280",
  grayLight: "#F3F4F6",
  border: "#D8DEE8",
  white: "#FFFFFF",
  green: "#DCFCE7",
  amber: "#FEF3C7",
  red: "#FEE2E2",
};

const d = (month, day) => new Date(2026, month - 1, day, 12, 0, 0);

const phases = [
  ["P1", "需求与架构基线", d(8, 3), d(8, 7), "产品/架构", "M0 技术基线", "第1周"],
  ["P2", "用户、权限与业务线", d(8, 10), d(8, 14), "前端/后端", "M1 业务线闭环", "第2周"],
  ["P3", "节点与模板", d(8, 17), d(8, 28), "前端/后端", "M2 工作流闭环", "第3-4周"],
  ["P4", "邀请与成员绑定", d(8, 24), d(8, 28), "前端/后端", "邀请加入闭环", "第4周"],
  ["P5", "反馈与凭证", d(8, 31), d(9, 4), "前端/后端", "M3 凭证闭环", "第5周"],
  ["P6", "检索与通知", d(9, 7), d(9, 11), "前端/后端", "M4 提醒与检索", "第6周"],
  ["P7", "质量与安全", d(9, 14), d(9, 18), "QA/全栈", "M5 功能冻结", "第7周"],
  ["P8", "UAT 与发布准备", d(9, 21), d(9, 25), "产品/QA/运维", "M6 体验版", "第8周"],
];

const tasks = [
  ["T001", "需求与架构基线", "需求澄清与 MVP 边界", d(8, 3), d(8, 3), "产品负责人", "-", "需求基线", "角色、流程、范围无关键歧义", "已完成", "P0"],
  ["T002", "需求与架构基线", "技术选型与架构设计", d(8, 3), d(8, 4), "技术负责人", "T001", "技术规划", "前后端、存储、通知和权限方案明确", "已完成", "P0"],
  ["T003", "需求与架构基线", "数据模型与权限矩阵", d(8, 4), d(8, 5), "后端开发", "T002", "数据字典", "集合、索引和角色操作可追溯", "已完成", "P0"],
  ["T004", "需求与架构基线", "小程序与云函数工程骨架", d(8, 5), d(8, 7), "全栈开发", "T002", "可导入工程", "微信开发者工具可导入，语法检查通过", "已完成", "P0"],
  ["T005", "需求与架构基线", "AppID、云环境与集合初始化", d(8, 6), d(8, 7), "运维/开发", "T004", "开发环境", "真实 AppID 可调用 businessApi", "待配置", "P0"],
  ["T006", "用户、权限与业务线", "用户初始化与资料维护", d(8, 10), d(8, 10), "后端开发", "T005", "用户模块", "OpenID 唯一建档且状态可控", "进行中", "P0"],
  ["T007", "用户、权限与业务线", "业务线创建与唯一编号", d(8, 10), d(8, 11), "全栈开发", "T006", "创建页面/API", "可创建含至少一个节点的业务线", "进行中", "P0"],
  ["T008", "用户、权限与业务线", "业务线列表、详情与分页", d(8, 11), d(8, 12), "前端开发", "T007", "列表与详情", "成员只能看到关联业务", "进行中", "P0"],
  ["T009", "用户、权限与业务线", "业务线编辑与版本控制", d(8, 12), d(8, 13), "全栈开发", "T007", "编辑能力", "并发更新不覆盖他人改动", "进行中", "P0"],
  ["T010", "用户、权限与业务线", "管理员逻辑删除与审计", d(8, 13), d(8, 14), "后端开发", "T009", "删除/审计", "非管理员请求被拒绝并留痕", "进行中", "P0"],
  ["T011", "节点与模板", "动态节点编辑器", d(8, 17), d(8, 18), "前端开发", "T009", "节点表单", "支持增删、排序和必传凭证配置", "未开始", "P0"],
  ["T012", "节点与模板", "节点状态机与流转校验", d(8, 17), d(8, 19), "后端开发", "T007", "状态机", "非法迁移被拒绝，完成后激活下一节点", "未开始", "P0"],
  ["T013", "节点与模板", "总体进度计算与时间线", d(8, 19), d(8, 20), "全栈开发", "T011,T012", "进度时间线", "当前节点和百分比一致", "未开始", "P0"],
  ["T014", "节点与模板", "模板数据模型与列表", d(8, 20), d(8, 21), "全栈开发", "T011", "模板列表", "可查看本人有权使用的模板", "未开始", "P1"],
  ["T015", "节点与模板", "保存为模板与模板创建", d(8, 24), d(8, 25), "全栈开发", "T014", "模板闭环", "节点顺序和规则复制正确", "未开始", "P1"],
  ["T016", "邀请与成员绑定", "邀请 token 与有效期", d(8, 24), d(8, 25), "后端开发", "T010", "邀请 API", "一次性 token 可撤销、过期不可用", "未开始", "P0"],
  ["T017", "邀请与成员绑定", "分享链接/二维码加入页", d(8, 25), d(8, 26), "前端开发", "T016", "加入页面", "用户明确确认后加入", "未开始", "P0"],
  ["T018", "邀请与成员绑定", "成员角色和节点负责人绑定", d(8, 26), d(8, 27), "全栈开发", "T017", "成员管理", "管理员可绑定，非管理员不可修改", "未开始", "P0"],
  ["T019", "邀请与成员绑定", "邀请与越权集成测试", d(8, 28), d(8, 28), "QA", "T016,T017,T018", "测试记录", "过期、重复、越权用例全部通过", "未开始", "P0"],
  ["T020", "反馈与凭证", "节点反馈表单与历史", d(8, 31), d(9, 1), "全栈开发", "T012,T018", "反馈闭环", "负责人可提交且历史可追溯", "未开始", "P0"],
  ["T021", "反馈与凭证", "图片/PDF 选择与云上传", d(9, 1), d(9, 2), "前端开发", "T020", "上传能力", "类型、大小和数量限制生效", "未开始", "P0"],
  ["T022", "反馈与凭证", "凭证元数据、权限与预览", d(9, 2), d(9, 3), "全栈开发", "T021", "凭证详情", "无权用户不能获取文件", "未开始", "P0"],
  ["T023", "反馈与凭证", "强制凭证与弱网重试", d(9, 3), d(9, 4), "全栈/QA", "T021,T022", "异常处理", "缺少凭证无法完成，失败可重试", "未开始", "P0"],
  ["T024", "检索与通知", "名称、编号、日期组合检索", d(9, 7), d(9, 8), "全栈开发", "T008", "检索页面/API", "结果准确且不越权", "未开始", "P0"],
  ["T025", "检索与通知", "数据库索引与分页优化", d(9, 8), d(9, 8), "后端开发", "T024", "索引配置", "典型查询满足性能门槛", "未开始", "P0"],
  ["T026", "检索与通知", "订阅授权入口与模板配置", d(9, 8), d(9, 9), "前端/产品", "T005", "订阅配置", "用户主动操作可触发授权", "未开始", "P0"],
  ["T027", "检索与通知", "节点到达通知与失败重试", d(9, 9), d(9, 10), "后端开发", "T012,T026", "消息任务", "成功/失败状态可追踪", "未开始", "P0"],
  ["T028", "检索与通知", "首页待办与站内通知兜底", d(9, 10), d(9, 11), "前端开发", "T027", "待办中心", "拒绝订阅仍可看到待办", "未开始", "P0"],
  ["T029", "质量与安全", "云函数单元与集成测试", d(9, 14), d(9, 16), "QA/后端", "T023,T028", "自动化测试", "核心权限和状态机覆盖率达标", "进行中", "P0"],
  ["T030", "质量与安全", "真机兼容、弱网与文件测试", d(9, 15), d(9, 17), "QA/前端", "T023", "真机报告", "主流 iOS/Android 场景通过", "未开始", "P0"],
  ["T031", "质量与安全", "安全审查、隐私清单与性能优化", d(9, 16), d(9, 18), "技术/产品", "T029,T030", "发布检查表", "越权、敏感信息和性能问题关闭", "未开始", "P0"],
  ["T032", "UAT 与发布准备", "真实业务模板与种子数据", d(9, 21), d(9, 21), "产品/运营", "T031", "UAT 数据", "覆盖至少两类真实业务", "未开始", "P0"],
  ["T033", "UAT 与发布准备", "UAT 演练与缺陷修复", d(9, 21), d(9, 23), "全员", "T032", "UAT 报告", "P0/P1 缺陷清零", "未开始", "P0"],
  ["T034", "UAT 与发布准备", "隐私指引、类目与提审材料", d(9, 22), d(9, 24), "产品/运营", "T031", "提审材料", "平台配置完整、文案一致", "未开始", "P0"],
  ["T035", "UAT 与发布准备", "体验版发布与上线评审", d(9, 24), d(9, 25), "技术/产品", "T033,T034", "体验版", "上线评审通过并形成回滚方案", "未开始", "P0"],
];

function titleBlock(sheet, title, subtitle, endColumn) {
  sheet.showGridLines = false;
  sheet.getRange(`A1:${endColumn}1`).merge();
  sheet.getRange("A1").values = [[title]];
  sheet.getRange("A1").format = {
    fill: colors.teal,
    font: { bold: true, color: colors.white, size: 18 },
    verticalAlignment: "center",
  };
  sheet.getRange(`A2:${endColumn}2`).merge();
  sheet.getRange("A2").values = [[subtitle]];
  sheet.getRange("A2").format = {
    fill: colors.tealLight,
    font: { color: colors.navy, size: 10 },
    verticalAlignment: "center",
  };
  sheet.getRange("A1").format.rowHeight = 34;
  sheet.getRange("A2").format.rowHeight = 24;
}

const overview = workbook.worksheets.add("总体计划");
titleBlock(overview, "业务进度管理微信小程序｜8 周 MVP 开发计划", "基线日期：2026-08-03｜目标：2026-09-25 前完成体验版与试运行准备", "O");
overview.getRange("A4:G4").values = [["阶段", "开始", "结束", "工作日", "责任角色", "里程碑", "窗口"]];
overview.getRange("A5:G12").values = phases.map((row) => [row[1], row[2], row[3], null, row[4], row[5], row[6]]);
overview.getRange("D5:D12").formulas = phases.map((_, index) => [`=NETWORKDAYS(B${index + 5},C${index + 5})`]);
overview.getRange("A4:G12").format.borders = { preset: "inside", style: "thin", color: colors.border };
overview.getRange("A4:G4").format = { fill: colors.navy, font: { bold: true, color: colors.white }, horizontalAlignment: "center" };
overview.getRange("B5:D12").format.horizontalAlignment = "center";
overview.getRange("B5:C12").setNumberFormat("yyyy-mm-dd");
overview.getRange("A5:A12").format.font = { bold: true, color: colors.navy };

const weekLabels = ["W1\n08/03-07", "W2\n08/10-14", "W3\n08/17-21", "W4\n08/24-28", "W5\n08/31-09/04", "W6\n09/07-11", "W7\n09/14-18", "W8\n09/21-25"];
overview.getRange("H4:O4").values = [weekLabels];
overview.getRange("H4:O4").format = { fill: colors.teal, font: { bold: true, color: colors.white, size: 9 }, horizontalAlignment: "center", wrapText: true };
for (let r = 0; r < phases.length; r += 1) {
  const [,,,,,, window] = phases[r];
  const markers = Array(8).fill("");
  const matches = [...window.matchAll(/(\d+)/g)].map((m) => Number(m[1]));
  const start = matches[0] || r + 1;
  const end = matches[1] || start;
  for (let w = start; w <= end; w += 1) markers[w - 1] = "●";
  overview.getRange(`H${r + 5}:O${r + 5}`).values = [markers];
}
overview.getRange("H5:O12").format = { horizontalAlignment: "center", font: { color: colors.teal, bold: true }, borders: { preset: "inside", style: "thin", color: colors.border } };
overview.getRange("A14:C14").values = [["项目指标", "当前值", "说明"]];
overview.getRange("A15:A18").values = [["任务总数"], ["已完成任务"], ["总体完成率"], ["计划完成日"]];
overview.getRange("B15").formulas = [["=COUNTA('任务排期'!$A$5:$A$39)"]];
overview.getRange("B16").formulas = [["=COUNTIF('任务排期'!$K$5:$K$39,\"已完成\")"]];
overview.getRange("B17").formulas = [["=B16/B15"]];
overview.getRange("B18").values = [[d(9, 25)]];
overview.getRange("C15:C18").values = [["MVP 任务基线"], ["以排期表状态自动统计"], ["完成任务数 / 总任务数"], ["体验版与试运行准备"]];
overview.getRange("A14:C14").format = { fill: colors.navy, font: { bold: true, color: colors.white } };
overview.getRange("A14:C18").format.borders = { preset: "inside", style: "thin", color: colors.border };
overview.getRange("B17").setNumberFormat("0%");
overview.getRange("B18").setNumberFormat("yyyy-mm-dd");
overview.getRange("A15:A18").format.font = { bold: true, color: colors.navy };
overview.freezePanes.freezeRows(4);

const taskSheet = workbook.worksheets.add("任务排期");
titleBlock(taskSheet, "MVP 任务排期", "状态可维护；工作日由开始/结束日期自动计算。负责人为角色，可在项目启动会上替换为姓名。", "L");
taskSheet.getRange("A4:L4").values = [["任务ID", "阶段", "任务", "开始日期", "结束日期", "工作日", "责任角色", "依赖", "交付物", "验收标准", "状态", "优先级"]];
taskSheet.getRange(`A5:L${tasks.length + 4}`).values = tasks.map((row) => [row[0], row[1], row[2], row[3], row[4], null, row[5], row[6], row[7], row[8], row[9], row[10]]);
taskSheet.getRange(`F5:F${tasks.length + 4}`).formulas = tasks.map((_, index) => [`=NETWORKDAYS(D${index + 5},E${index + 5})`]);
taskSheet.getRange(`D5:E${tasks.length + 4}`).setNumberFormat("yyyy-mm-dd");
taskSheet.getRange(`A4:L${tasks.length + 4}`).format.borders = { preset: "inside", style: "thin", color: colors.border };
taskSheet.getRange("A4:L4").format = { fill: colors.navy, font: { bold: true, color: colors.white, size: 9 }, horizontalAlignment: "center", verticalAlignment: "center", wrapText: true };
taskSheet.getRange(`A5:A${tasks.length + 4}`).format.horizontalAlignment = "center";
taskSheet.getRange(`D5:F${tasks.length + 4}`).format.horizontalAlignment = "center";
taskSheet.getRange(`K5:L${tasks.length + 4}`).format.horizontalAlignment = "center";
taskSheet.getRange(`B5:C${tasks.length + 4}`).format.wrapText = true;
taskSheet.getRange(`H5:J${tasks.length + 4}`).format.wrapText = true;
taskSheet.getRange(`K5:K${tasks.length + 4}`).dataValidation = { rule: { type: "list", values: ["未开始", "进行中", "已完成", "待配置", "已阻塞"] } };
taskSheet.getRange(`L5:L${tasks.length + 4}`).dataValidation = { rule: { type: "list", values: ["P0", "P1", "P2"] } };
taskSheet.getRange(`K5:K${tasks.length + 4}`).conditionalFormats.add("containsText", { text: "已完成", format: { fill: colors.green, font: { color: "#166534", bold: true } } });
taskSheet.getRange(`K5:K${tasks.length + 4}`).conditionalFormats.add("containsText", { text: "进行中", format: { fill: colors.amber, font: { color: "#92400E", bold: true } } });
taskSheet.getRange(`K5:K${tasks.length + 4}`).conditionalFormats.add("containsText", { text: "待配置", format: { fill: colors.red, font: { color: "#991B1B", bold: true } } });
taskSheet.freezePanes.freezeRows(4);
taskSheet.freezePanes.freezeColumns(2);

const milestoneSheet = workbook.worksheets.add("里程碑与验收");
titleBlock(milestoneSheet, "里程碑与验收门槛", "每个里程碑只有在验收条件全部满足后才能进入下一阶段；P0 缺陷未清零不得提审。", "G");
const milestones = [
  ["M0", "技术基线", d(8, 7), "工程可导入；方案/数据模型/排期完成", "技术负责人", "未验收", "真实 AppID 和云环境由项目方提供"],
  ["M1", "业务线闭环", d(8, 14), "创建、列表、详情、编辑、管理员删除可用", "产品+QA", "未验收", "权限用例必须通过"],
  ["M2", "工作流闭环", d(8, 28), "节点流转、模板、邀请加入与负责人绑定可用", "产品+QA", "未验收", "顺序流程，不含复杂并行"],
  ["M3", "凭证闭环", d(9, 4), "图片/PDF 上传、强制校验、预览和历史可用", "产品+QA", "未验收", "需真机和弱网测试"],
  ["M4", "检索与提醒", d(9, 11), "日期/名称/编号检索；节点到达提醒与待办兜底", "产品+QA", "未验收", "订阅模板需平台审核"],
  ["M5", "功能冻结", d(9, 18), "P0 功能完成；安全、性能、兼容测试通过", "技术负责人", "未验收", "只接受阻断性修复"],
  ["M6", "体验版", d(9, 25), "UAT 通过；隐私/类目/提审材料完整；回滚方案就绪", "项目负责人", "未验收", "提审时间受微信审核影响"],
];
milestoneSheet.getRange("A4:G4").values = [["里程碑", "名称", "计划日期", "验收条件", "验收责任", "状态", "备注"]];
milestoneSheet.getRange(`A5:G${milestones.length + 4}`).values = milestones;
milestoneSheet.getRange(`C5:C${milestones.length + 4}`).setNumberFormat("yyyy-mm-dd");
milestoneSheet.getRange(`A4:G${milestones.length + 4}`).format.borders = { preset: "inside", style: "thin", color: colors.border };
milestoneSheet.getRange("A4:G4").format = { fill: colors.navy, font: { bold: true, color: colors.white }, horizontalAlignment: "center", wrapText: true };
milestoneSheet.getRange(`D5:G${milestones.length + 4}`).format.wrapText = true;
milestoneSheet.getRange(`A5:C${milestones.length + 4}`).format.horizontalAlignment = "center";
milestoneSheet.getRange(`F5:F${milestones.length + 4}`).dataValidation = { rule: { type: "list", values: ["未验收", "验收中", "已通过", "未通过"] } };
milestoneSheet.getRange("A14:G14").merge();
milestoneSheet.getRange("A14").values = [["资源假设：1 名产品/项目负责人（兼任）、1 名前端、1 名后端、1 名 QA（第 5 周起投入）、运维与运营按需参与。若由 1 名开发者独立实施，建议整体顺延 4-6 周。"]];
milestoneSheet.getRange("A14").format = { fill: colors.amber, font: { color: "#78350F", bold: true }, wrapText: true, verticalAlignment: "center" };
milestoneSheet.getRange("A14").format.rowHeight = 48;
milestoneSheet.freezePanes.freezeRows(4);

const widths = {
  "总体计划": [25, 13, 13, 10, 17, 21, 12, 11, 11, 11, 11, 11, 11, 11, 11],
  "任务排期": [10, 20, 30, 13, 13, 9, 15, 16, 22, 34, 11, 9],
  "里程碑与验收": [11, 18, 13, 42, 16, 12, 30],
};
for (const [name, columnWidths] of Object.entries(widths)) {
  const sheet = workbook.worksheets.getItem(name);
  columnWidths.forEach((width, index) => sheet.getRangeByIndexes(0, index, 1, 1).format.columnWidth = width);
  const used = sheet.getUsedRange();
  used.format.font = { name: "Microsoft YaHei", size: 10, color: "#1F2937" };
  sheet.getRange("A1").format.font = { name: "Microsoft YaHei", bold: true, color: colors.white, size: 18 };
  sheet.getRange("A2").format.font = { name: "Microsoft YaHei", color: colors.navy, size: 10 };
}

overview.getRange("A4:G4").format = { fill: colors.navy, font: { name: "Microsoft YaHei", bold: true, color: colors.white, size: 10 }, horizontalAlignment: "center", verticalAlignment: "center", wrapText: true };
overview.getRange("H4:O4").format = { fill: colors.teal, font: { name: "Microsoft YaHei", bold: true, color: colors.white, size: 9 }, horizontalAlignment: "center", verticalAlignment: "center", wrapText: true };
overview.getRange("A14:C14").format = { fill: colors.navy, font: { name: "Microsoft YaHei", bold: true, color: colors.white, size: 10 } };
taskSheet.getRange("A4:L4").format = { fill: colors.navy, font: { name: "Microsoft YaHei", bold: true, color: colors.white, size: 9 }, horizontalAlignment: "center", verticalAlignment: "center", wrapText: true };
milestoneSheet.getRange("A4:G4").format = { fill: colors.navy, font: { name: "Microsoft YaHei", bold: true, color: colors.white, size: 10 }, horizontalAlignment: "center", verticalAlignment: "center", wrapText: true };
milestoneSheet.getRange("A14").format = { fill: colors.amber, font: { name: "Microsoft YaHei", color: "#78350F", bold: true, size: 10 }, wrapText: true, verticalAlignment: "center" };

const overviewInspect = await workbook.inspect({ kind: "table", range: "总体计划!A1:O18", include: "values,formulas", tableMaxRows: 20, tableMaxCols: 15, maxChars: 6000 });
console.log(overviewInspect.ndjson);
const errors = await workbook.inspect({ kind: "match", searchTerm: "#REF!|#DIV/0!|#VALUE!|#NAME\\?|#N/A", options: { useRegex: true, maxResults: 100 }, summary: "final formula error scan" });
console.log(errors.ndjson);

for (const sheetName of ["总体计划", "任务排期", "里程碑与验收"]) {
  const preview = await workbook.render({ sheetName, autoCrop: "all", scale: 1, format: "png" });
  await fs.writeFile(path.join(qaDir, `${sheetName}.png`), new Uint8Array(await preview.arrayBuffer()));
}

const output = await SpreadsheetFile.exportXlsx(workbook);
await output.save(outputPath);
console.log(outputPath);
