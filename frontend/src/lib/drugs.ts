export type Drug = {
  id: string; sourceId: number; name: string; brand: string; category: string; target: string
  image: string; imageLabel?: string; imageSourceUrl?: string
  overview: string
  document: { url: string; label: string; sourceName?: string; sourceUrl?: string; note?: string }
}

export const drugCatalogueSource = 'https://www.innoventbio.com/#/product/products'
export const drugCatalogueCheckedAt = '2026-10-29'
// This dated catalogue is separate from reviewed materials used in training.
export const drugs: Drug[] = [
  {
    id: 'sintilimab', sourceId: 1, name: '信迪利单抗注射液', brand: '达伯舒', category: '肿瘤', target: 'PD-1', image: 'sintilimab.jpg',
    overview: '以 PD-1 为靶点的单克隆抗体，属于肿瘤免疫治疗药物。具体适用肿瘤、联合治疗方案及人群见说明书。',
    document: { url: 'https://img.innoventbio.com/PackageInsert/sintilimab.pdf', label: '说明书（PDF）' },
  },
  {
    id: 'bevacizumab', sourceId: 4, name: '贝伐珠单抗注射液', brand: '达攸同', category: '肿瘤', target: 'VEGF-A', image: 'bevacizumab.jpg',
    overview: '靶向 VEGF-A 的抗体类药品，为贝伐珠单抗生物类似药。通过影响血管生成相关信号发挥作用。',
    document: { url: 'https://img.innoventbio.com/7.4/new2.pdf', label: '说明书（PDF）' },
  },
  {
    id: 'adalimumab', sourceId: 3, name: '阿达木单抗注射液', brand: '苏立信', category: '自身免疫', target: 'TNF-α', image: 'adalimumab.jpg',
    overview: '阿达木单抗生物类似药，靶向 TNF-α，用于相关自身免疫疾病的治疗。各疾病的适用条件见说明书。',
    document: { url: 'https://img.innoventbio.com/adm3.22.pdf', label: '说明书（PDF）' },
  },
  {
    id: 'rituximab', sourceId: 16, name: '利妥昔单抗注射液', brand: '达伯华', category: '肿瘤', target: 'CD20', image: 'rituximab.jpg',
    overview: '靶向 CD20 的利妥昔单抗生物类似药，相关治疗涉及 B 细胞疾病。具体适应症与联合方案见说明书。',
    document: { url: 'https://img.innoventbio.com/product/HALPRYZAInstructions.pdf', label: '说明书（PDF）' },
  },
  {
    id: 'pemigatinib', sourceId: 14, name: '佩米替尼片', brand: '达伯坦', category: '肿瘤', target: 'FGFR1/2/3', image: 'pemigatinib.png',
    overview: '小分子 FGFR1/2/3 抑制剂，通过抑制相关信号通路发挥作用。用药前的分子检测及适用人群见说明书。',
    document: { url: 'https://img.innoventbio.com/pmtn3.22.pdf', label: '说明书（PDF）' },
  },
  {
    id: 'olverembatinib', sourceId: 40, name: '奥雷巴替尼片', brand: '耐立克', category: '肿瘤', target: 'BCR-ABL/KIT', image: 'olverembatinib.png',
    overview: '口服 BCR-ABL 酪氨酸激酶抑制剂，相关治疗涉及慢性髓细胞白血病。耐药、突变及既往治疗要求见说明书。',
    document: { url: 'https://img.innoventbio.com/5c89f09e539a25191.pdf', label: '说明书（PDF）' },
  },
  {
    id: 'ramucirumab', sourceId: 82, name: '雷莫西尤单抗注射液', brand: '希冉择', category: '肿瘤', target: 'VEGFR-2', image: 'ramucirumab.png',
    overview: '靶向 VEGFR-2 的单克隆抗体，可阻断相关血管生成信号。适用肿瘤和既往治疗条件见中国版说明书。',
    document: { url: 'https://img.innoventbio.com/xrz11.231.pdf', label: '说明书（PDF）' },
  },
  {
    id: 'selpercatinib', sourceId: 83, name: '塞普替尼胶囊', brand: '睿妥', category: '肿瘤', target: 'RET', image: 'selpercatinib.png',
    overview: '选择性 RET 酪氨酸激酶抑制剂。相关肿瘤治疗须区分 RET 融合或突变类型，并核对说明书规定的人群。',
    document: { url: 'https://img.innoventbio.com/rt.pdf', label: '说明书（PDF）' },
  },
  {
    id: 'equecabtagene', sourceId: 17, name: '伊基奥仑赛注射液', brand: '福可苏', category: '肿瘤', target: 'BCMA CAR-T', image: 'equecabtagene.png',
    overview: '靶向 BCMA 的 CAR-T 细胞治疗产品，相关治疗涉及复发或难治性多发性骨髓瘤。此处提供官方患者手册，不能替代说明书。',
    document: { url: 'https://images.qingtv.com/%E6%82%A3%E8%80%85%E6%89%8B%E5%86%8C%E4%B8%AD%E6%96%87%E7%89%88.pdf', label: '患者手册（非说明书）', sourceName: '驯鹿生物官方患者平台', sourceUrl: 'https://i-connection.iasobio.com/' },
  },
  {
    id: 'tafolecimab', sourceId: 31, name: '托莱西单抗注射液', brand: '信必乐', category: '新陈代谢', target: 'PCSK9', image: 'tafolecimab.png',
    overview: '靶向 PCSK9 的单克隆抗体，通过影响 LDL 受体相关过程降低低密度脂蛋白胆固醇。适用人群和联合用药要求见说明书。',
    document: { url: 'https://img.innoventbio.com/tlx3.22.pdf', label: '说明书（PDF）' },
  },
  {
    id: 'fulzerasib', sourceId: 42, name: '氟泽雷塞片', brand: '达伯特', category: '肿瘤', target: 'KRAS G12C', image: 'fulzerasib.png',
    overview: '口服 KRAS G12C 小分子抑制剂，针对相应突变发挥作用。检测要求、适用肿瘤及既往治疗条件见说明书。',
    document: { url: 'https://img.innoventbio.com/fzlsp.pdf', label: '说明书（PDF）' },
  },
  {
    id: 'pirtobrutinib', sourceId: 107, name: '匹妥布替尼片', brand: '捷帕力', category: '肿瘤', target: 'BTK', image: 'pirtobrutinib.png',
    overview: '非共价 BTK 抑制剂，相关治疗涉及 B 细胞恶性肿瘤。不同疾病的获批范围须按中国版说明书核对。',
    document: { url: 'https://img.innoventbio.com/product/pirtobrutinib.pdf', label: '说明书（PDF）' },
  },
  {
    id: 'taletrectinib', sourceId: 37, name: '己二酸他雷替尼胶囊', brand: '达伯乐', category: '肿瘤', target: 'ROS1', image: 'taletrectinib.png',
    overview: '口服 ROS1 抑制剂，相关治疗涉及 ROS1 阳性非小细胞肺癌。适用突变、既往治疗及患者条件见说明书。',
    document: { url: 'https://img.innoventbio.com/2024.12/dbl.pdf', label: '说明书（PDF）' },
  },
  {
    id: 'limertinib', sourceId: 104, name: '利厄替尼片', brand: '奥壹新', category: '肿瘤', target: 'EGFR', image: 'limertinib.png',
    overview: '口服 EGFR 酪氨酸激酶抑制剂，相关治疗涉及 EGFR 突变阳性非小细胞肺癌。须区分具体突变与治疗线次。',
    document: { url: 'https://img.innoventbio.com/25.02/Limertinib.pdf', label: '说明书（PDF）' },
  },
  {
    id: 'teprotumumab', sourceId: 88, name: '替妥尤单抗N01注射液', brand: '信必敏', category: '眼科', target: 'IGF-1R', image: 'teprotumumab.png',
    overview: '靶向 IGF-1R 的单克隆抗体，用于甲状腺眼病相关治疗。厂家当前入口提供图片版说明书。',
    document: { url: 'https://img.innoventbio.com/25.03/teprotumumabN01.jpg', label: '说明书（图片）' },
  },
  {
    id: 'mazdutide', sourceId: 30, name: '玛仕度肽注射液', brand: '信尔美', category: '新陈代谢', target: 'GCG/GLP-1', image: 'mazdutide.png',
    overview: '同时激动 GCG 和 GLP-1 受体的药物。相关资料涵盖成人体重管理及血糖控制，具体适用条件应分别核对对应说明书。',
    document: { url: 'https://img.innoventbio.com/product/S5LGV8EM_SMS_24mg.pdf', label: '说明书（PDF）', note: '当前官网文件的修订日期含占位文本，版本仍待核对。训练使用的成人体重管理基线另行保留。' },
  },
  {
    id: 'picankibart', sourceId: 13, name: '匹康奇拜单抗注射液', brand: '信美悦', category: '自身免疫', target: 'IL-23p19', image: 'picankibart.png',
    overview: '靶向 IL-23p19 的单克隆抗体，相关治疗涉及中重度斑块状银屑病成人患者。系统治疗条件与注意事项见说明书。',
    document: { url: 'https://img.innoventbio.com/product/PECONDLE.pdf', label: '说明书（PDF）' },
  },
  {
    id: 'ipilimumab', sourceId: 2, name: '伊匹木单抗N01注射液', brand: '达伯欣', category: '肿瘤', target: 'CTLA-4', image: 'ipilimumab.jpg',
    overview: '靶向 CTLA-4 的单克隆抗体。与信迪利单抗联合的新辅助治疗涉及特定 MSI-H/dMMR 结肠癌人群，具体范围见说明书。',
    document: { url: 'https://img.innoventbio.com/product/Ipilimumab.pdf', label: '说明书（PDF）' },
  },
  {
    id: 'abemaciclib', sourceId: 121, name: '阿贝西利片', brand: '唯择', category: '肿瘤', target: 'CDK4/6', image: 'abemaciclib.png', imageLabel: '官方品牌标识', imageSourceUrl: 'https://resource.lilly.com.cn/media/1787292663651-唯择.svg',
    overview: 'CDK4/6 抑制剂。中国版说明书涉及特定 HR 阳性、HER2 阴性乳腺癌人群的联合内分泌治疗，包含辅助治疗及晚期治疗的不同条件。',
    document: { url: 'https://www.lillymedical.cn/file/raw/f4e09dab-5cac-445c-91f1-1222ec5bbb93/阿贝西利片说明书.pdf', label: '说明书（PDF）', sourceName: '礼来医学网', sourceUrl: 'https://www.lillymedical.cn/zh-cn/oncology/Verzenios' },
  },
  {
    id: 'quizartinib', sourceId: 122, name: '盐酸奎扎替尼片', brand: '维复泰', category: '肿瘤', target: 'FLT3', image: 'quizartinib-label-preview.png', imageLabel: '说明书首页（局部）',
    overview: 'FLT3 抑制剂。中国版说明书用于 FLT3-ITD 突变的新诊断急性髓系白血病成人患者，包含联合化疗及后续维持治疗的规定。',
    document: { url: 'https://www.daiichisankyo.com.cn/Portals/0/344_0_奎扎替尼说明书.pdf', label: '说明书（PDF）', sourceName: '第一三共中国官网', sourceUrl: 'https://www.daiichisankyo.com.cn/search' },
  },
]
