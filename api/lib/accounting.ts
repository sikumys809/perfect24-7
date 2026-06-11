// 勘定科目の自動付与と、簡易複式での仕訳導出を担う共有ロジック。
// webhook（自動付与）/ reports（元帳・試算表）/ edit（科目候補）から import して使う。
// 注意: Vercel は api/ 直下の各 .ts を個別にコンパイルする。共有モジュールを _lib のような
//   underscore ディレクトリに置くとビルドから除外され、import 先の .js が実行時に見つからず
//   FUNCTION_INVOCATION_FAILED になる。そのため underscore を付けず api/lib/ に置く。
//   （結果としてこのファイルも /api/lib/accounting というルートになるが、末尾の default export
//    で 404 を返すだけの無害なエンドポイントになる。）

import type { SupabaseClient } from '@supabase/supabase-js';

export type Account = {
  code: string;
  name: string;
  category: 'asset' | 'liability' | 'equity' | 'revenue' | 'expense';
  statement: 'BS' | 'PL';
  normal_balance: 'debit' | 'credit';
  sort_order: number | null;
};

// seed の安定コード（011_account_titles.sql と一致）。相手科目の既定に使う。
export const CODE = {
  cash: '1010', // 現金
  bank: '1020', // 普通預金
  receivable: '1040', // 売掛金
  payable_trade: '2010', // 買掛金
  payable: '2020', // 未払金
  deposit_received: '2040', // 預り金
  sales: '4010', // 売上高
  misc_income: '4020', // 雑収入
  purchase: '5010', // 仕入高
  salary: '6020', // 給料手当
  travel: '6070', // 旅費交通費
  entertainment: '6080', // 接待交際費
  meeting: '6090', // 会議費
  communication: '6100', // 通信費
  supplies: '6110', // 消耗品費
  office_supplies: '6120', // 事務用品費
  utilities: '6130', // 水道光熱費
  rent: '6140', // 地代家賃
  fee: '6160', // 支払手数料
  tax_paid: '1080', // 仮払消費税（税抜経理の経費・資産の消費税）
  tax_received: '2080', // 仮受消費税（税抜経理の売上の消費税）
  tax_public: '6170', // 租税公課
  ad: '6190', // 広告宣伝費
  repair: '6200', // 修繕費
  insurance: '6210', // 保険料
  books: '6220', // 新聞図書費
  freight: '6240', // 荷造運賃
  vehicle: '6250', // 車両費
  misc: '6260', // 雑費
  interest_paid: '8010', // 支払利息
  corp_tax: '9010', // 法人税等
} as const;

// 固定資産の区分 → 資産科目コード
const ASSET_CATEGORY_CODE: [RegExp, string][] = [
  [/建物附属|附属設備/, '1520'],
  [/建物/, '1510'],
  [/機械|装置/, '1530'],
  [/車両|車輌|運搬具/, '1540'],
  [/ソフト|software/i, '1560'],
  [/工具|器具|備品/, '1550'],
];

// 税目（tax_kind）→ 科目コード。源泉・住民は預り金の納付＝預り金、その他は租税公課、法人税は法人税等。
const TAX_KIND_CODE: [RegExp, string][] = [
  [/源泉|住民/, CODE.deposit_received],
  [/法人税|地方法人|事業税|都道府県民|市町村民/, CODE.corp_tax],
  [/社会保険|健康保険|厚生年金|労働保険|雇用保険/, '6040'], // 法定福利費
];

// 経費科目の自動推定（vendor / note のキーワード）。LLM 提案が無い/不正なときのフォールバック。
const EXPENSE_KEYWORDS: [RegExp, string][] = [
  [/タクシー|ＪＲ|JR|新幹線|鉄道|電車|地下鉄|バス|航空|ANA|JAL|高速|ETC|駐車|パーキング|Suica|PASMO|ｓｕｉｃａ/i, CODE.travel],
  [/ガソリン|給油|エネオス|ENEOS|出光|コスモ石油|シェル/i, CODE.vehicle],
  [/ドコモ|ＮＴＴ|NTT|ソフトバンク|softbank|au|KDDI|携帯|電話|インターネット|プロバイダ|wifi|Wi-Fi/i, CODE.communication],
  [/電力|電気|東京電力|関西電力|中部電力|ガス|都市ガス|水道/i, CODE.utilities],
  [/家賃|賃料|テナント|管理費|共益費|月極/i, CODE.rent],
  [/ヤマト|佐川|日本郵便|ゆうパック|郵便|宅配|運送|配送/i, CODE.freight],
  [/書店|書房|新聞|出版|kindle|Kindle/i, CODE.books],
  [/広告|チラシ|印刷|Google\s?Ads|Facebook|Meta|リスティング/i, CODE.ad],
  [/保険/i, CODE.insurance],
  [/修理|修繕|メンテナンス/i, CODE.repair],
  [/振込手数料|支払手数料|手数料|決済手数料/i, CODE.fee],
  [/スターバックス|スタバ|ドトール|喫茶|カフェ|珈琲|コーヒー/i, CODE.meeting],
  [/居酒屋|レストラン|飲食|接待|料亭|寿司|焼肉/i, CODE.entertainment],
  [/文具|文房具|事務用品|コクヨ|アスクル/i, CODE.office_supplies],
];

// 事務所の有効科目を取得（office固有 + 共通標準。同一 code は office 固有を優先）。
export async function loadAccounts(
  supabase: SupabaseClient,
  officeId: string | null,
): Promise<Account[]> {
  const { data } = await supabase
    .from('account_titles')
    .select('code, name, category, statement, normal_balance, sort_order, office_id, is_active')
    .or(officeId ? `office_id.is.null,office_id.eq.${officeId}` : 'office_id.is.null')
    .eq('is_active', true);
  const rows = (data ?? []) as (Account & { office_id: string | null })[];
  // code 重複は office 固有で上書き
  const byCode = new Map<string, Account>();
  for (const r of rows) {
    const existing = byCode.get(r.code);
    if (!existing || r.office_id) byCode.set(r.code, r);
  }
  return [...byCode.values()].sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0));
}

// 売上/経費の向きと書類種別から、主たる科目(account_code)と相手科目(payment_account_code)を自動決定。
// suggested は LLM が返した科目名（任意）。マスタ名と一致すればそれを優先採用する。
export function autoAccount(
  ex: any,
  docType: string | null,
  direction: 'sales' | 'expense' | null,
  accounts: Account[],
  suggested?: string | null,
): { accountCode: string | null; paymentCode: string | null; matchedSuggestion: boolean } {
  const byName = new Map(accounts.map((a) => [a.name, a]));
  const isInvoice = docType === 'invoice';

  // 固定資産: 区分から資産科目、相手は未払金（取得時）
  if (docType === 'fixed_asset') {
    const cat = String(ex?.asset_category ?? '');
    const code = ASSET_CATEGORY_CODE.find(([re]) => re.test(cat))?.[1] ?? '1550';
    return { accountCode: code, paymentCode: CODE.payable, matchedSuggestion: false };
  }

  // 納付書: 税目から科目、相手は現金
  if (docType === 'tax_payment') {
    const kind = String(ex?.tax_kind ?? '');
    const code = TAX_KIND_CODE.find(([re]) => re.test(kind))?.[1] ?? CODE.tax_public;
    return { accountCode: code, paymentCode: CODE.cash, matchedSuggestion: false };
  }

  // EC入金: 売上高、相手は普通預金（入金）。手数料は reports 側で別途借方に立てる
  if (docType === 'ec_payout') {
    return { accountCode: CODE.sales, paymentCode: CODE.bank, matchedSuggestion: false };
  }

  // 給与・賃金台帳: 給料手当、相手は現金（預り金の内訳は reports 側で payroll_lines から分解）
  if (docType === 'payslip' || docType === 'wage_ledger') {
    return { accountCode: CODE.salary, paymentCode: CODE.cash, matchedSuggestion: false };
  }

  // 売上（領収書/請求書）: 売上高。相手は請求書=売掛金、領収書=現金
  if (direction === 'sales') {
    return {
      accountCode: CODE.sales,
      paymentCode: isInvoice ? CODE.receivable : CODE.cash,
      matchedSuggestion: false,
    };
  }

  // 経費（領収書/請求書）: LLM 提案がマスタにあれば採用、無ければキーワード推定、最後は消耗品費
  let accountCode: string | null = null;
  let matched = false;
  if (suggested && byName.has(suggested)) {
    const a = byName.get(suggested)!;
    if (a.category === 'expense' || a.category === 'asset') {
      accountCode = a.code;
      matched = true;
    }
  }
  if (!accountCode) {
    const hay = `${ex?.vendor ?? ''} ${ex?.note ?? ''}`;
    accountCode = EXPENSE_KEYWORDS.find(([re]) => re.test(hay))?.[1] ?? CODE.supplies;
  }
  // 相手科目: 請求書（未払）=未払金、領収書（支払済）=現金
  return { accountCode, paymentCode: isInvoice ? CODE.payable : CODE.cash, matchedSuggestion: matched };
}

// 仕訳1行（借方 or 貸方）。元帳・試算表の最小単位。
export type JournalLine = {
  date: string | null;
  account_code: string;
  debit: number;
  credit: number;
  counterparty: string;
  description: string;
};

// 簡易複式で reports が扱う書類種別（通帳/カード/棚卸/返済表/残高証明はフェーズ2のため除外）。
export const JOURNAL_DOC_TYPES = new Set([
  'receipt',
  'invoice',
  'tax_payment',
  'fixed_asset',
  'ec_payout',
  'payslip',
  'wage_ledger',
]);

// receipt 1件（＋給与なら payroll_lines）から仕訳行を導出する。
// 借方/貸方は account_code の normal_balance で決める。amount は税込（簡易・税込経理）。
// taxMode='exclusive'（税抜経理）のとき、経費/売上の消費税を仮払/仮受消費税に分けて立てる。
// 'inclusive'（税込経理）は分けずに税込のまま（既定）。
export function deriveEntries(
  rec: any,
  fields: Record<string, string>,
  accountByCode: Map<string, Account>,
  payrollLines?: any[],
  taxMode: 'inclusive' | 'exclusive' = 'inclusive',
): JournalLine[] {
  const docType = rec.document_type as string;
  if (!JOURNAL_DOC_TYPES.has(docType)) return [];
  const date: string | null = rec.issued_date ?? null;
  const counterparty = fields['counterparty'] ?? fields['vendor'] ?? '';
  const mainCode = rec.account_code as string | null;
  const payCode = (rec.payment_account_code as string | null) ?? CODE.cash;
  const amount = Number(rec.total_amount) || 0;

  // 給与/賃金台帳: Dr 給料手当(総支給) / Cr 預り金(控除計) / Cr 現金(差引)
  if ((docType === 'payslip' || docType === 'wage_ledger') && payrollLines) {
    const gross = payrollLines.reduce((s, p) => s + (Number(p.gross) || 0), 0);
    const deduct = payrollLines.reduce(
      (s, p) =>
        s +
        (Number(p.health_insurance) || 0) +
        (Number(p.pension) || 0) +
        (Number(p.employment_insurance) || 0) +
        (Number(p.income_tax) || 0) +
        (Number(p.resident_tax) || 0) +
        (Number(p.other_deduction) || 0),
      0,
    );
    const net = gross - deduct;
    const lines: JournalLine[] = [];
    if (gross > 0)
      lines.push({ date, account_code: CODE.salary, debit: gross, credit: 0, counterparty, description: '給与' });
    if (deduct > 0)
      lines.push({ date, account_code: CODE.deposit_received, debit: 0, credit: deduct, counterparty, description: '源泉・社保等 預り' });
    if (net > 0)
      lines.push({ date, account_code: payCode, debit: 0, credit: net, counterparty, description: '差引支給' });
    return lines;
  }

  // EC入金: Dr 普通預金(入金) ＋ Dr 支払手数料(手数料) / Cr 売上高(総売上)
  if (docType === 'ec_payout') {
    const fee = Number(fields['fee']) || 0;
    const netAmt = Number(fields['net_amount']);
    const net = Number.isFinite(netAmt) ? netAmt : amount - fee;
    const lines: JournalLine[] = [];
    if (net > 0) lines.push({ date, account_code: payCode, debit: net, credit: 0, counterparty, description: '入金' });
    if (fee > 0) lines.push({ date, account_code: CODE.fee, debit: fee, credit: 0, counterparty, description: '決済手数料' });
    if (amount > 0) lines.push({ date, account_code: CODE.sales, debit: 0, credit: amount, counterparty, description: '売上' });
    return lines;
  }

  if (!mainCode || amount <= 0) return [];
  const main = accountByCode.get(mainCode);
  const note = fields['note'] ?? '';
  const tax = Number(rec.tax_amount) || 0;
  // 税抜経理かつ消費税額があれば、税抜の本体＋仮払/仮受消費税に分ける
  const split = taxMode === 'exclusive' && tax > 0 && tax < amount;
  const net = split ? amount - tax : amount;

  // 主科目が貸方系（収益・負債）: Dr 相手(税込) / Cr 主(税抜) [+ Cr 仮受消費税]
  if (main && main.normal_balance === 'credit') {
    const lines: JournalLine[] = [
      { date, account_code: payCode, debit: amount, credit: 0, counterparty, description: note },
      { date, account_code: mainCode, debit: 0, credit: net, counterparty, description: note },
    ];
    if (split) lines.push({ date, account_code: CODE.tax_received, debit: 0, credit: tax, counterparty, description: '仮受消費税' });
    return lines;
  }
  // 主科目が借方系（費用・資産）: Dr 主(税抜) [+ Dr 仮払消費税] / Cr 相手(税込)
  const lines: JournalLine[] = [
    { date, account_code: mainCode, debit: net, credit: 0, counterparty, description: note },
  ];
  if (split) lines.push({ date, account_code: CODE.tax_paid, debit: tax, credit: 0, counterparty, description: '仮払消費税' });
  lines.push({ date, account_code: payCode, debit: 0, credit: amount, counterparty, description: note });
  return lines;
}

// このファイルは共有ロジック。Vercel 上ではルート化されるため、直接アクセス時は 404 を返す。
export default function handler(_req: any, res: any) {
  res.status(404).send('Not found');
}
