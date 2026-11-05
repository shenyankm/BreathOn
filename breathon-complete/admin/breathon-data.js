window.BREATHON_DATA={
products:[
 {id:'weize',name:'唯择®',sub:'CDK4/6 相关产品',area:'肿瘤',disease:'乳腺癌',status:'已发布',tags:['乳腺癌','CDK4/6'],stage:'已上市',evidence:'按批准内容和正式研究表达，优先匹配数据驱动型乳腺外科医生。',ip:'乳腺外科 · 数据驱动型'},
 {id:'weifusu',name:'维复素®',sub:'FLT3 相关产品',area:'血液肿瘤',disease:'血液肿瘤',status:'已发布',tags:['血液肿瘤','FLT3'],stage:'已上市',evidence:'优先准备临床试验设计、样本量、终点和对照组，匹配文献探讨型医生。',ip:'血液科 · 文献探讨型'},
 {id:'oncology',name:'肿瘤综合产品组合',sub:'肺癌 / 胃肠癌 / 乳腺癌 / 血液瘤',area:'肿瘤',disease:'多癌种',status:'待审核',tags:['多疾病线','全球临床'],stage:'组合管理',evidence:'用于疾病线总览和产品组合介绍，不能替代单品正式资料。',ip:'按科室与疾病线匹配'},
 {id:'breath',name:'丙酮呼气数据源',sub:'项链探索性代谢数据',area:'数据源',disease:'代谢管理',status:'草稿',tags:['项链','丙酮','探索性'],stage:'原型阶段',evidence:'只描述代谢趋势、检测条件和数据限制，不直接推导药品疗效。',ip:'内分泌科 · 案例分享型'}
],
doctors:[
 {id:'blood',name:'血液科医生',dept:'血液科',role:'教授 / 博导',style:'文献探讨型',area:'血液肿瘤',img:'assets/doctor-blood.jpg',focus:'最新临床试验进展',tags:['研究设计','样本量','终点','对照组'],entry:'先从医生当前关注的患者亚组和临床问题切入，再给研究背景。',question:'这个样本量、对照组和终点能支持什么结论？',match:'维复素® / 血液肿瘤产品组合'},
 {id:'breast',name:'乳腺外科医生',dept:'乳腺外科',role:'主任医师',style:'数据驱动型',area:'肿瘤',img:'assets/doctor-breast.jpg',focus:'循证医学证据',tags:['疗效终点','证据等级','临床可操作性'],entry:'用结构化数据说明问题，再连接真实病例和临床路径。',question:'主要终点是什么？结果能落到临床决策吗？',match:'唯择® / 乳腺癌产品线'},
 {id:'endocrine',name:'内分泌科医生',dept:'内分泌科',role:'主治医师',style:'案例分享型',area:'代谢',img:'assets/doctor-endocrine.jpg',focus:'患者依从性与代谢指标',tags:['患者依从性','指标趋势','案例分享'],entry:'先讲患者管理案例，再补充指标变化、观察周期和检测条件。',question:'患者能不能坚持？指标变化和依从性如何观察？',match:'丙酮呼气数据源 / 代谢管理'},
 {id:'general',name:'全科门诊医生',dept:'全科门诊',role:'副主任医师',style:'务实疗效型',area:'综合慢病',img:'assets/doctor-general.jpg',focus:'药品性价比与患者负担',tags:['使用场景','费用','患者负担','价值'],entry:'先讲结论和临床场景，再补充必要证据，避免长篇学术铺陈。',question:'对患者的实际价值是什么？费用和负担怎么样？',match:'综合产品组合 / 患者管理工具'},
 {id:'cardio',name:'心血管内科医生',dept:'心血管内科',role:'副主任医师',style:'机制探讨型',area:'综合慢病',img:'assets/doctor-cardio.jpg',focus:'药物相互作用与长期管理',tags:['机制理解','相互作用','长期管理'],entry:'先讲机制与安全边界，再落到长期管理和患者可执行动作。',question:'这个方案的作用机制、相互作用和长期管理怎么理解？',match:'心血管相关产品 / 长期管理资料'},
 {id:'oncology',name:'肿瘤科医生',dept:'肿瘤科',role:'主任医师',style:'数据对决型',area:'肿瘤',img:'assets/doctor-oncology.jpg',focus:'临床疗效与生存质量',tags:['临床终点','生存获益','患者分层'],entry:'把终点、患者获益和适用人群一一对应，不能用单一数据代表全部患者。',question:'临床终点和患者获益之间，具体证据如何对应？',match:'肿瘤综合产品组合 / 正式研究'},
 {id:'pediatrics',name:'儿科医生',dept:'儿科',role:'主治医师',style:'故事引导型',area:'综合慢病',img:'assets/doctor-pediatrics.jpg',focus:'用药剂量与儿童依从性',tags:['儿童剂量','依从性','家属沟通'],entry:'用具体患儿场景讲清楚执行步骤，再补充证据和安全边界。',question:'儿童用药的剂量、安全性和家属依从性怎么保障？',match:'儿科相关产品 / 家庭用药资料'}
],
audiences:[
 {type:'医药代表',icon:'代',title:'医药代表',desc:'需要在有限拜访时间内找到正确证据、适配医生偏好并推进下一步。',needs:['疾病线和产品底盘','医生 IP 识别','个性化话术','模拟拜访和复盘'],metrics:['知识掌握度','证据匹配度','合规表达','推进指数']},
 {type:'医生',icon:'医',title:'医生用户',desc:'关注与临床决策相关的证据，且不同科室对终点、案例、负担和研究设计的敏感度不同。',needs:['科室和疾病线匹配','证据来源透明','临床可操作性','患者管理价值'],metrics:['内容相关性','证据可信度','沟通效率','复访意愿']},
 {type:'健康管理用户',icon:'息',title:'健康管理用户',desc:'通过灵息 BREATHON 和项链获取代谢反馈，可自主选择是否上传数据。',needs:['简单的代谢反馈','隐私和授权控制','趋势解释','生活方式建议'],metrics:['检测完成率','数据上传授权率','长期留存','建议执行率']}
],
policies:[
 {title:'医药代表合规沟通指南',scope:'代表端 · 全疾病线',status:'已发布',version:'v2.1',date:'2026/10/31',text:'规范产品介绍、证据表达、异议处理和下一步推进；不得将探索性数据表述为疗效结论。'},
 {title:'项链呼气数据授权与上传政策',scope:'用户端 → 代表端',status:'待审核',version:'v0.8',date:'2026/10/31',text:'用户默认不上传代谢数据；只有明确授权后，数据才进入训练数据池，并保留撤回入口。'},
 {title:'医生 IP 脱敏与训练使用规则',scope:'医生画像 · 训练内容',status:'已发布',version:'v1.4',date:'2026/10/30',text:'医生 IP 为角色模型，不代表具体医生；画像仅用于训练沟通能力，不做真实医生评价。'},
 {title:'真实世界反馈录入规范',scope:'代表记录 · 审核队列',status:'草稿',version:'v0.5',date:'2026/10/29',text:'反馈需要记录来源、时间、科室、问题和局限，不可将单个反馈外推为普遍结论。'}
],
training:[
 {level:'L1',title:'2026 H1 公司与产品底盘',desc:'总收入、产品组合、医保覆盖、管线方向和正式资料边界。',owner:'医学内容组',status:'已发布',link:'产品 / 证据'},
 {level:'L1',title:'证据分级与合规表达',desc:'正式研究、公司披露、真实世界反馈、项链探索性数据分别怎么说。',owner:'医学 + 合规',status:'已发布',link:'合规'},
 {level:'L2',title:'肿瘤疾病线与临床场景',desc:'肺癌、胃肠癌、乳腺癌、血液瘤的疾病线入口和医生敏感点。',owner:'肿瘤线',status:'已发布',link:'肿瘤'},
 {level:'L2',title:'代谢管理与长期依从性',desc:'围绕患者依从性、指标趋势和长期管理建立沟通。',owner:'综合管线组',status:'待审核',link:'代谢'},
 {level:'L3',title:'医生 IP：七类沟通偏好',desc:'血液科、乳腺外科、内分泌科、全科、心血管内科、肿瘤科、儿科的沟通入口。',owner:'教练组',status:'已发布',link:'医生 IP'},
 {level:'L4',title:'模拟拜访：首次拜访',desc:'练习开场、需求探索和疾病线匹配，避免一上来只讲产品。',owner:'教练组',status:'已发布',link:'实战'},
 {level:'L4',title:'模拟拜访：质疑证据',desc:'练习回应样本量、对照组、终点、观察周期和证据边界。',owner:'教练组',status:'待审核',link:'实战'},
 {level:'L4',title:'模拟拜访：推进下一步',desc:'练习让医生愿意继续看资料、交换问题或安排复访。',owner:'教练组',status:'草稿',link:'实战'}
],
audit:[
 {id:1,title:'代谢数据授权与上传话术',type:'政策',owner:'内容组',date:'2026/10/31',status:'待审核'},
 {id:2,title:'乳腺外科 · 数据驱动型医生 IP',type:'医生画像',owner:'教练组',date:'2026/10/31',status:'待审核'},
 {id:3,title:'质疑证据 · 血液科模拟对话',type:'训练内容',owner:'华东团队',date:'2026/10/30',status:'待审核'},
 {id:4,title:'真实世界反馈录入规范',type:'政策',owner:'医学部',date:'2026/10/29',status:'已发布'}
],
records:[
 {rep:'林晓',scene:'质疑证据',ip:'血液科 · 文献探讨型',score:92,status:'completed'},
 {rep:'周宁',scene:'首次拜访',ip:'乳腺外科 · 数据驱动型',score:86,status:'completed'},
 {rep:'陈默',scene:'推进下一步',ip:'内分泌科 · 案例分享型',score:78,status:'interrupted'},
 {rep:'赵一',scene:'质疑证据',ip:'全科门诊 · 务实疗效型',score:88,status:'completed'}
]
};
