import { unzipSync } from "fflate";
import * as XLSX from "xlsx";
import type { ProductType, Supplier, SupplierProduct } from "./types";

export type ImportedOrderItem = {
  model: string;
  productName: string;
  color: string;
  productType: ProductType;
  quantity: number;
  unit: string;
  unitPrice: number;
  specification: string;
  materialProcess: string;
  installationMethod: string;
  packagingVolume: string;
  image: File | null;
};

export type ImportedPurchaseOrder = {
  poNumber: string;
  projectName: string;
  orderDate: string;
  requiredShipDate: string;
  supplierId: string;
  supplierName: string;
  items: ImportedOrderItem[];
  imageCount: number;
  warnings: string[];
};

const PRODUCT_TYPE_TERMS: Array<[ProductType, string[]]> = [
  ["定制加工类", ["玻璃钢", "造型", "雕塑", "亚克力", "钣金", "cnc", "激光切割", "印刷", "广告", "皮革", "壁纸", "地胶", "车贴", "车木", "结构件"]],
  ["电气类", ["电源", "电线", "电缆", "开关", "插座", "灯", "变压器", "适配器", "电机", "风机", "传感器", "控制器", "屏幕", "音响", "按钮", "pcb", "配电箱"]],
  ["安全防护类", ["防护网", "安全带", "钢绳", "安全锁扣", "扎带", "包管", "护栏"]],
  ["成品设备类", ["互动", "游戏", "投影", "滑梯", "秋千", "摇马", "蹦床", "玩具", "充气", "海洋球", "木粒", "白沙", "陶瓷沙"]],
  ["配件类", ["五金", "连接件", "轴承", "合页", "滑轨", "拉手", "锁具", "绳网扣", "弹簧", "脚盘", "管通", "装饰件"]],
];

const text = (value: unknown) => String(value ?? "").trim();
const compact = (value: unknown) => text(value).toLowerCase().replace(/[\s【】\[\]（）()·,，。._\-—/\\]/g, "");
const normalizeHeader = (value: unknown) => compact(value).replace(/含税/g, "");

function headerColumn(headers: unknown[], names: string[]) {
  const normalized = headers.map(normalizeHeader);
  return normalized.findIndex((header) => names.some((name) => header === compact(name) || header.includes(compact(name))));
}

function cell(row: unknown[], column: number) {
  return column >= 0 ? row[column] : null;
}

function metadataCell(rows: unknown[][], labels: string[]) {
  const normalizedLabels = labels.map(compact);
  for (const row of rows) {
    for (let column = 0; column < row.length; column += 1) {
      const label = compact(row[column]);
      if (!label || !normalizedLabels.includes(label)) continue;
      for (let valueColumn = column + 1; valueColumn < row.length; valueColumn += 1) {
        if (text(row[valueColumn])) return row[valueColumn];
      }
    }
  }
  return null;
}

const metadataValue = (rows: unknown[][], labels: string[]) => text(metadataCell(rows, labels));
const cleanProjectName = (value: string) => value.replace(/^(?:亦玩\s*)+/u, "").trim();

function excelDate(value: unknown) {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, "0")}-${String(value.getDate()).padStart(2, "0")}`;
  if (typeof value === "number") {
    const parsed = XLSX.SSF.parse_date_code(value);
    if (parsed) return `${parsed.y}-${String(parsed.m).padStart(2, "0")}-${String(parsed.d).padStart(2, "0")}`;
  }
  const raw = text(value);
  const parts = raw.match(/^(\d{4})[年/.-](\d{1,2})[月/.-](\d{1,2})/);
  if (parts) return `${parts[1]}-${parts[2].padStart(2, "0")}-${parts[3].padStart(2, "0")}`;
  const date = new Date(raw);
  return raw && !Number.isNaN(date.getTime()) ? date.toISOString().slice(0, 10) : "";
}

function longestCommonRun(left: string, right: string) {
  let longest = 0;
  const row = new Array(right.length + 1).fill(0);
  for (let i = 1; i <= left.length; i += 1) {
    for (let j = right.length; j >= 1; j -= 1) {
      row[j] = left[i - 1] === right[j - 1] ? row[j - 1] + 1 : 0;
      longest = Math.max(longest, row[j]);
    }
  }
  return longest;
}

function meaningfulTerms(value: string) {
  return value.split(/[【】\[\]（）()、,，/\\\s]+/).map(compact).filter((term) => term.length >= 2);
}

function productScore(product: SupplierProduct, source: string) {
  const name = compact(product.product_name);
  if (name && source.includes(name)) return 80 + name.length;
  return meaningfulTerms(product.product_name).reduce((score, term) => score + (source.includes(term) ? 12 + term.length : 0), 0);
}

function matchSupplier(suppliers: Supplier[], fileName: string, sourceText: string, supplierCode = "", supplierName = "") {
  const exactCode = compact(supplierCode);
  if (exactCode) {
    const matchedByCode = suppliers.find((supplier) => compact(supplier.code) === exactCode);
    if (matchedByCode) return matchedByCode;
  }
  const exactName = compact(supplierName.replace(/有限责任公司|股份有限公司|有限公司|集团|工程|制造|科技|实业|厂/g, ""));
  if (exactName) {
    const matchedByName = suppliers.find((supplier) => compact(supplier.name.replace(/有限责任公司|股份有限公司|有限公司|集团|工程|制造|科技|实业|厂/g, "")) === exactName);
    if (matchedByName) return matchedByName;
  }
  const file = compact(fileName.replace(/\.[^.]+$/, ""));
  const source = compact(sourceText);
  const ranked = suppliers.map((supplier) => {
    const supplierName = compact(supplier.name.replace(/有限责任公司|股份有限公司|有限公司|集团|工程|制造|科技|实业|厂/g, ""));
    const nameRun = longestCommonRun(file, supplierName);
    const catalogScore = supplier.products.reduce((best, product) => Math.max(best, productScore(product, source)), 0);
    return { supplier, score: (nameRun >= 2 ? nameRun * 30 : 0) + catalogScore };
  }).sort((left, right) => right.score - left.score);
  return ranked[0]?.score >= 35 ? ranked[0].supplier : null;
}

function classifyProduct(source: string, catalog: SupplierProduct[]): { productType: ProductType; recognized: boolean } {
  const normalized = compact(source);
  const catalogMatch = catalog.map((product) => ({ product, score: productScore(product, normalized) })).sort((left, right) => right.score - left.score)[0];
  if (catalogMatch?.score >= 12) return { productType: catalogMatch.product.product_type, recognized: true };
  for (const [type, terms] of PRODUCT_TYPE_TERMS) if (terms.some((term) => normalized.includes(compact(term)))) return { productType: type, recognized: true };
  return { productType: "定制加工类", recognized: false };
}

function extractCellImages(buffer: ArrayBuffer) {
  const images = new Map<string, File>();
  try {
    const archive = unzipSync(new Uint8Array(buffer));
    const decoder = new TextDecoder();
    const imageXml = archive["xl/cellimages.xml"];
    const relsXml = archive["xl/_rels/cellimages.xml.rels"];
    if (!imageXml || !relsXml) return images;
    const attribute = (tag: string, name: string) => tag.match(new RegExp(`(?:^|\\s)(?:\\w+:)?${name}="([^"]*)"`))?.[1] || "";
    const targets = new Map<string, string>();
    for (const match of decoder.decode(relsXml).matchAll(/<Relationship\b[^>]*>/g)) targets.set(attribute(match[0], "Id"), attribute(match[0], "Target"));
    for (const match of decoder.decode(imageXml).matchAll(/<(?:\w+:)?pic\b[\s\S]*?<\/(?:\w+:)?pic>/g)) {
      const nameTag = match[0].match(/<(?:\w+:)?cNvPr\b[^>]*>/)?.[0] || "";
      const blipTag = match[0].match(/<(?:\w+:)?blip\b[^>]*>/)?.[0] || "";
      const name = attribute(nameTag, "name");
      const relationId = attribute(blipTag, "embed");
      const target = targets.get(relationId);
      const bytes = target ? archive[`xl/${target.replace(/^\//, "")}`] : null;
      if (!name || !bytes) continue;
      const extension = target?.split(".").pop()?.toLowerCase() || "png";
      const mime = extension === "jpg" || extension === "jpeg" ? "image/jpeg" : extension === "webp" ? "image/webp" : "image/png";
      images.set(name, new File([bytes.slice().buffer as ArrayBuffer], `${name}.${extension}`, { type: mime }));
    }
  } catch {
    return images;
  }
  return images;
}

export async function importPurchaseOrder(file: File, suppliers: Supplier[]): Promise<ImportedPurchaseOrder> {
  if (!/\.(xlsx|xls)$/i.test(file.name)) throw new Error("请上传 Excel 格式的采购单（.xlsx 或 .xls）");
  if (file.size > 15 * 1024 * 1024) throw new Error("采购单文件不能超过 15MB");
  const buffer = await file.arrayBuffer();
  // Keep Excel serial dates as numbers. Converting them to JavaScript Date first
  // makes the calendar day drift with the uploader's time zone.
  const workbook = XLSX.read(buffer, { type: "array", cellDates: false });
  let worksheet: XLSX.WorkSheet | null = null;
  let rows: unknown[][] = [];
  let headerIndex = -1;
  for (const sheetName of workbook.SheetNames) {
    const candidate = workbook.Sheets[sheetName];
    const candidateRows = XLSX.utils.sheet_to_json<unknown[]>(candidate, { header: 1, raw: true, defval: null });
    const candidateHeader = candidateRows.findIndex((row) => headerColumn(row, ["产品名称", "品名"]) >= 0 && headerColumn(row, ["数量"]) >= 0);
    if (candidateHeader >= 0) { worksheet = candidate; rows = candidateRows; headerIndex = candidateHeader; break; }
  }
  if (!worksheet || headerIndex < 0) throw new Error("没有找到包含“产品名称”和“数量”的采购明细表，请检查表头");

  const headers = rows[headerIndex];
  const columns = {
    poNumber: headerColumn(headers, ["PO编号", "采购单号", "订单号"]),
    date: headerColumn(headers, ["日期", "下单日期"]),
    model: headerColumn(headers, ["款号", "Item Number", "SKU", "型号"]),
    product: headerColumn(headers, ["产品名称", "品名"]),
    color: headerColumn(headers, ["颜色", "色号", "产品颜色"]),
    specification: headerColumn(headers, ["规格型号", "规格", "型号"]),
    image: headerColumn(headers, ["图片", "产品图片"]),
    material: headerColumn(headers, ["材料/工艺/配置", "材料／工艺／配置", "材质", "材料"]),
    process: headers.findIndex((header) => ["制作工艺", "工艺"].includes(normalizeHeader(header))),
    configuration: headers.findIndex((header) => normalizeHeader(header) === "配置"),
    installation: headerColumn(headers, ["安装方式", "安装方法"]),
    volume: headerColumn(headers, ["包装体积", "Volume"]),
    unit: headerColumn(headers, ["单位"]),
    quantity: headerColumn(headers, ["数量"]),
    unitPrice: headerColumn(headers, ["含税单价", "单价"]),
    taxRate: headerColumn(headers, ["税率"]),
    shipDate: headerColumn(headers, ["发货日期", "要求发货日期"]),
    notes: headerColumn(headers, ["备注"]),
  };
  const summaryNames = ["小计", "小规模公司", "一般纳税人", "总计", "合计金额", "备注", "此报价有效期"];
  const dataRows = rows.slice(headerIndex + 1).map((row, offset) => ({ row, sheetRow: headerIndex + 1 + offset })).filter(({ row }) => {
    const productName = text(cell(row, columns.product));
    return productName && !summaryNames.some((name) => compact(productName).startsWith(compact(name))) && Number(cell(row, columns.quantity)) > 0;
  });
  if (!dataRows.length) return {
    poNumber: "", projectName: "", orderDate: "", requiredShipDate: "", supplierId: "", supplierName: "",
    items: [], imageCount: 0, warnings: ["采购单中没有识别到有效的产品明细"],
  };

  const metadataRows = rows.slice(0, headerIndex);
  const projectName = cleanProjectName(metadataValue(metadataRows, ["项目名", "项目名称", "项目"]));
  const supplierCode = metadataValue(metadataRows, ["供应商编号", "供应商编码"]);
  const supplierName = metadataValue(metadataRows, ["报价公司", "供应商名称", "供应商"]);
  const sourceText = dataRows.map(({ row }) => [cell(row, columns.product), cell(row, columns.material), cell(row, columns.specification)].map(text).join(" ")).join(" ");
  const supplier = matchSupplier(suppliers, file.name, sourceText, supplierCode, supplierName);
  const catalog = supplier?.products || [];
  const cellImages = extractCellImages(buffer);
  const items = dataRows.map(({ row, sheetRow }) => {
    const productName = text(cell(row, columns.product));
    const material = text(cell(row, columns.material));
    const specification = text(cell(row, columns.specification));
    const note = text(cell(row, columns.notes));
    const taxRateValue = Number(cell(row, columns.taxRate));
    const details = [specification && `规格：${specification}`, Number.isFinite(taxRateValue) && taxRateValue > 0 && `税率：${new Intl.NumberFormat("zh-CN", { style: "percent", maximumFractionDigits: 2 }).format(taxRateValue)}`, note && note !== projectName && `备注：${note}`].filter(Boolean).join("；");
    const imageCell = columns.image >= 0 ? worksheet![XLSX.utils.encode_cell({ r: sheetRow, c: columns.image })] : null;
    const imageId = String(imageCell?.f || imageCell?.v || "").match(/ID_[A-F0-9]+/i)?.[0] || "";
    const sourceImage = cellImages.get(imageId) || null;
    const image = sourceImage ? new File([sourceImage], `${productName.slice(0, 50) || imageId}.${sourceImage.name.split(".").pop()}`, { type: sourceImage.type }) : null;
    const classification = classifyProduct(`${productName} ${material} ${specification}`, catalog);
    return {
      model: text(cell(row, columns.model)),
      productName,
      color: text(cell(row, columns.color)),
      productType: classification.productType,
      quantity: Number(cell(row, columns.quantity)),
      unit: text(cell(row, columns.unit)),
      unitPrice: Number(cell(row, columns.unitPrice)) || 0,
      specification: details,
      materialProcess: [material, text(cell(row, columns.process)) && `工艺：${text(cell(row, columns.process))}`, text(cell(row, columns.configuration)) && `配置：${text(cell(row, columns.configuration))}`].filter(Boolean).join("；"),
      installationMethod: text(cell(row, columns.installation)),
      packagingVolume: text(cell(row, columns.volume)),
      image,
      recognitionWarning: classification.recognized ? "" : `第 ${sheetRow + 1} 行“${productName}”未能识别产品类型，请手动选择`,
    };
  });
  const orderDate = excelDate(metadataCell(metadataRows, ["下单时间", "下单日期"])) || dataRows.map(({ row }) => excelDate(cell(row, columns.date))).find(Boolean) || "";
  const requiredShipDate = dataRows.map(({ row }) => excelDate(cell(row, columns.shipDate))).find(Boolean) || "";
  const poNumber = dataRows.map(({ row }) => text(cell(row, columns.poNumber))).find(Boolean) || "";
  const warnings = [!poNumber && "采购单内没有 PO 编号，请补充", !requiredShipDate && "采购单内没有要求发货日期，请补充", !supplier && "没有可靠匹配到供应商，请手动选择", !projectName && "没有识别到项目名称，请补充", ...items.map((item) => item.recognitionWarning).filter(Boolean)].filter(Boolean) as string[];
  return { poNumber, projectName, orderDate, requiredShipDate, supplierId: supplier?.id || "", supplierName: supplier ? `${supplier.code} · ${supplier.name}` : "", items, imageCount: items.filter((item) => item.image).length, warnings };
}
