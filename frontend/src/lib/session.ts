export type Message = { role: 'doctor' | 'trainee'; text: string; time: string }

export function formatTime(seconds: number) {
  return `${Math.floor(seconds / 60).toString().padStart(2, '0')}:${(seconds % 60).toString().padStart(2, '0')}`
}

// Source: project PDF pp. 1–2, 4–5, 11, 14, 17, 27, 29; revision date needs confirmation.
export const drugDetails = [
  ['通用名 / 商品名', '玛仕度肽注射液 / 信尔美®'],
  ['英文名称', 'Mazdutide Injection'],
  ['作用机制', 'GLP-1 受体与胰高血糖素（GCG）受体激动剂。'],
  ['文件所列规格', '2 mL：24 mg；预充式多剂量注射笔。'],
  ['给药方式', '每周一次皮下注射；具体剂量递增与使用方法见原说明书。'],
  ['上市许可持有人', '信达生物制药（苏州）有限公司'],
  ['生产企业', '江苏诺泰澳赛诺生物制药股份有限公司'],
] as const
