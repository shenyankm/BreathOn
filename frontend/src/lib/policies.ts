export const policyLevels = ['国家级', '省级', '市级', '区县级', '机构制度'] as const
export const policyCategories = ['医药代表与拜访', '廉洁从业与反贿赂', '药品监管与追溯', '医保与支付', '个人信息保护', '人工智能', '互联网诊疗', '产业支持'] as const

export type PolicyDocument = {
  title: string
  level: typeof policyLevels[number]
  category: typeof policyCategories[number]
  source: string
  effectiveDate: string
  scope: string
  summary: string
  url: string
}

// 来源及适用情况核验于 2026-10-28；具体执行应以最新官方文件和医院制度为准。
export const policyDocuments: PolicyDocument[] = [
  {
    title: '医药代表管理办法',
    level: '国家级',
    category: '医药代表与拜访',
    source: '国家药监局等七部门 · 2026年第42号公告',
    effectiveDate: '2026-08-01 起施行',
    scope: '全国境内药品学术推广相关的医药代表、药品上市许可持有人和医疗卫生机构。',
    summary: '规定从业条件、备案和学术推广行为；旧版备案办法同时废止，已备案信息继续有效。医疗器械相关人员另行规定。',
    url: 'https://www.nmpa.gov.cn/directory/web/nmpa/xxgk/fgwj/xzhgfxwj/20260507180422166.html',
  },
  {
    title: '医药企业防范商业贿赂风险合规指引',
    level: '国家级',
    category: '廉洁从业与反贿赂',
    source: '国家市场监督管理总局 · 2025年第3号公告',
    effectiveDate: '2025-01-14 发布并施行',
    scope: '医药企业及相关经营活动的商业贿赂风险合规管理。',
    summary: '覆盖学术拜访交流等风险场景，是合规参考；不应将每条建议都视作独立的法定强制条款。',
    url: 'https://www.samr.gov.cn/zw/zfxxgk/fdzdgknr/jjjzs/art/2025/art_0cee28b1eba84820addc024b351b7bac.html',
  },
  {
    title: '医疗机构工作人员廉洁从业九项准则',
    level: '国家级',
    category: '廉洁从业与反贿赂',
    source: '国家卫生健康委、国家医保局、国家中医药局 · 国卫医发〔2021〕37号',
    effectiveDate: '2021-11-12 印发；未单列施行日期',
    scope: '全国医疗机构内工作人员，包含接受医疗机构管理的其他社会从业人员。',
    summary: '规范医疗机构工作人员廉洁从业，可用于医生侧的合规沟通场景。',
    url: 'https://www.nhc.gov.cn/yzygj/c100067/202111/0c7f21b59d064cfaa49b35fe970cffdd.shtml',
  },
  {
    title: '2026年纠正医药购销领域和医疗服务中不正之风工作要点',
    level: '国家级',
    category: '廉洁从业与反贿赂',
    source: '国家卫生健康委等部门 · 国卫医急函〔2026〕123号；信用苏州转载',
    effectiveDate: '2026年度工作部署；转载页 2026-06-11 发布',
    scope: '全国医药购销领域和医疗服务相关部门及机构的年度治理工作。',
    summary: '涉及商业贿赂、采购和违规营销等年度治理重点；属于年度部署。',
    url: 'https://credit.suzhou.gov.cn/news/show/394309.html',
  },
  {
    title: '江苏省医疗机构及其工作人员廉洁从业行动计划实施方案（2021—2024年）',
    level: '省级',
    category: '廉洁从业与反贿赂',
    source: '江苏省卫生健康委、江苏省中医药管理局 · 苏卫行风〔2021〕3号',
    effectiveDate: '2021-11-15 印发；计划期 2021—2024 年，已结束',
    scope: '江苏省医疗机构及其工作人员；作为历史工作部署参考。',
    summary: '提出医药代表接待“三定三有”。实际拜访应核对现行省文件和目标医院制度。',
    url: 'https://wjw.jiangsu.gov.cn/art/2021/11/18/art_7316_10117915.html',
  },
  {
    title: '苏州高新区人民医院规范医疗机构工作人员接待医药代表管理制度',
    level: '机构制度',
    category: '医药代表与拜访',
    source: '苏州高新区人民医院 · 院务公开',
    effectiveDate: '2024-09-12 页面发布；施行日期和现行状态待院方确认',
    scope: '该院接待医药代表的院内制度，并非苏州市统一规定。',
    summary: '页面提供来访备案预约、接待登记及廉洁承诺表；制度正文为图片，实际执行请向医院核实。',
    url: 'https://www.snd-yy.com/publicAnnouncement/detail/ff80808191e1d05e0191e4f996a30051',
  },
  {
    title: '苏州市“双通道”管理及单独支付药品待遇备案指南',
    level: '市级',
    category: '医保与支付',
    source: '苏州市医疗保障局 · 办事指南',
    effectiveDate: '2026-01-14 页面发布；未单列施行日期',
    scope: '苏州基本医疗保险参保人员及相关定点医药机构的待遇备案。',
    summary: '介绍申请及备案流程；药品是否纳入及支付限制须核查最新目录和当地规定。',
    url: 'https://ybj.suzhou.gov.cn/szybj/zgylbxdy/202601/adf3d4fc853949aa980195b29663a498.shtml',
  },
  {
    title: '2025年版国家医保药品目录在苏州落地',
    level: '市级',
    category: '医保与支付',
    source: '苏州市人民政府网站 · 部门工作信息',
    effectiveDate: '2025年版目录自 2026-01-01 在苏州执行',
    scope: '苏州医保药品目录实施情况介绍；非独立规范性文件。',
    summary: '作为本地医保目录信息入口，具体药品及支付条件应以最新正式目录为准。',
    url: 'https://www.suzhou.gov.cn/szsrmzf/bmdt/202601/30cf1d3bd29e4a728ec909dd1588383a.shtml',
  },
  {
    title: '关于加强药品追溯码在医疗保障和工伤保险领域采集应用的通知',
    level: '国家级',
    category: '药品监管与追溯',
    source: '国家医保局、人力资源社会保障部、国家卫生健康委、国家药监局 · 苏州市医保局转载',
    effectiveDate: '苏州市医保局页面 2025-04-30 发布；文中规定自 2026-01-01 全量采集上传',
    scope: '医疗保障和工伤保险领域药品追溯码采集与应用。',
    summary: '涉及药品追溯、医保和工伤保险管理；并非单独针对本项目的义务。',
    url: 'https://ybj.suzhou.gov.cn/szybj/zcfgjj/202504/c4cd006fb0e542849fafe3daab2ad86d.shtml',
  },
  {
    title: '中华人民共和国药品管理法实施条例',
    level: '国家级',
    category: '药品监管与追溯',
    source: '国务院 · 国务院令第828号',
    effectiveDate: '2026-05-15 起施行（2026年修订）',
    scope: '中华人民共和国境内药品研制、生产、经营、使用及监督管理。',
    summary: '药品监管基础行政法规；项目中的产品资料应核对获批说明书并经医学审核。',
    url: 'https://www.nmpa.gov.cn/xxgk/fgwj/flxzhfg/20260127172639127.html',
  },
  {
    title: '中华人民共和国个人信息保护法',
    level: '国家级',
    category: '个人信息保护',
    source: '全国人民代表大会常务委员会 · 主席令第91号',
    effectiveDate: '2021-11-01 起施行',
    scope: '在中华人民共和国境内处理自然人个人信息等法定情形。',
    summary: '学员身份、录音及复盘可能涉及个人信息；健康和生物识别信息可能属于敏感个人信息。',
    url: 'https://www.cac.gov.cn/2021-08/20/c_1631050028355286.htm',
  },
  {
    title: '生成式人工智能服务管理暂行办法',
    level: '国家级',
    category: '人工智能',
    source: '国家互联网信息办公室等七部门 · 国家互联网信息办公室令第15号',
    effectiveDate: '2023-08-15 起施行',
    scope: '利用生成式人工智能技术向中华人民共和国境内公众提供生成文本、图片、音频、视频等内容的服务。',
    summary: '研发、应用但未向境内公众提供服务的不适用本办法；是否适用须按实际服务判断。',
    url: 'https://www.cac.gov.cn/2023-07/13/c_1690898327029107.htm',
  },
  {
    title: '人工智能生成合成内容标识办法',
    level: '国家级',
    category: '人工智能',
    source: '国家互联网信息办公室等四部门 · 国家互联网信息办公室令第20号',
    effectiveDate: '2025-09-01 起施行',
    scope: '在境内提供人工智能生成合成内容相关服务，且符合办法第二条规定情形的网络信息服务提供者。',
    summary: '按服务、内容和传播场景核验标识义务；训练产品应清楚标注模拟医生和AI生成内容。',
    url: 'https://www.cac.gov.cn/2025-03/14/c_1743654684782215.htm',
  },
  {
    title: '互联网诊疗监管细则（试行）',
    level: '国家级',
    category: '互联网诊疗',
    source: '国家卫生健康委办公厅、国家中医药局办公室 · 国卫办医发〔2022〕2号',
    effectiveDate: '2022-02-08 印发并施行',
    scope: '医疗机构开展互联网诊疗及其监管。',
    summary: '当前培训模拟不等同互联网诊疗；若扩展到真实患者诊疗，应重新评估适用要求。',
    url: 'https://www.nhc.gov.cn/yzygj/c100068/202203/2072f0e8988249e59d942e1b2a933916.shtml',
  },
  {
    title: '苏州市加快建设“人工智能+”城市行动方案（2025—2026年）',
    level: '市级',
    category: '产业支持',
    source: '苏州市人民政府办公室 · 苏府办〔2025〕102号',
    effectiveDate: '2025-09-15 印发；行动期 2025—2026 年',
    scope: '苏州市人工智能产业发展及健康医疗、教育等应用方向。',
    summary: '为场景合作与产业方向提供参考；文件不直接赋予项目资助资格。',
    url: 'https://www.suzhou.gov.cn/szsrmzf/zfbgswj/202509/95a8e52a6db5414db93a1fbc2d559e39.shtml',
  },
  {
    title: '苏州市进一步加快建设“人工智能+”城市的若干措施（2026年版）',
    level: '市级',
    category: '产业支持',
    source: '苏州市人民政府 · 苏府规字〔2025〕18号',
    effectiveDate: '2026-01-31 起施行，有效至 2027-01-30',
    scope: '符合规定条件的苏州市人工智能相关主体及项目。',
    summary: '包括算力、模型和应用等支持；是否可申报需核验主体条件和具体通知。',
    url: 'https://www.suzhou.gov.cn/szsrmzf/zfwj/202512/81ccb2edeec5426990646da3f59dfc4b.shtml',
  },
]

export function filterPolicies(level: string, category: string) {
  return policyDocuments.filter(document => (level === 'all' || document.level === level) && (category === 'all' || document.category === category))
}
