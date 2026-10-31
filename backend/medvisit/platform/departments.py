"""Department-level training compatibility, not individual prescribing privileges."""
from fastapi import HTTPException

# Broad clinical departments; a shared drug can serve several departments.
DRUG_DEPARTMENTS = {
    '信迪利单抗注射液': ['肿瘤科', '呼吸科', '血液科'],
    '贝伐珠单抗注射液': ['肿瘤科', '呼吸科'],
    '阿达木单抗注射液': ['风湿免疫科', '皮肤科', '消化内科'],
    '利妥昔单抗注射液': ['血液科', '肿瘤科'],
    '佩米替尼片': ['肿瘤科'],
    '奥雷巴替尼片': ['血液科'],
    '雷莫西尤单抗注射液': ['肿瘤科'],
    '塞普替尼胶囊': ['肿瘤科', '呼吸科'],
    '伊基奥仑赛注射液': ['血液科'],
    '托莱西单抗注射液': ['心血管科', '内分泌科'],
    '氟泽雷塞片': ['肿瘤科', '呼吸科'],
    '匹妥布替尼片': ['血液科', '肿瘤科'],
    '己二酸他雷替尼胶囊': ['肿瘤科', '呼吸科'],
    '利厄替尼片': ['肿瘤科', '呼吸科'],
    '替妥尤单抗N01注射液': ['眼科'],
    '玛仕度肽注射液': ['内分泌科'],
    '匹康奇拜单抗注射液': ['皮肤科'],
    '伊匹木单抗N01注射液': ['肿瘤科'],
    '阿贝西利片': ['肿瘤科'],
    '盐酸奎扎替尼片': ['血液科'],
}

DEPARTMENT_ALIASES = {
    '内分泌科': ('内分泌',),
    '心血管科': ('心血管', '心内科', '心脏内科'),
    '血液科': ('血液', '白血病', '淋巴肿瘤'),
    '肿瘤科': ('肿瘤',),
    '呼吸科': ('呼吸', '肺内'),
    '风湿免疫科': ('风湿',),
    '皮肤科': ('皮肤',),
    '眼科': ('眼科',),
    '消化内科': ('消化',),
}


def department(specialty):
    label = specialty.strip()
    return next((name for name, aliases in DEPARTMENT_ALIASES.items()
                 if any(alias in label for alias in aliases)), label)


def drug_departments(drug):
    # An explicit empty list disables matching; old catalogues use the named-product defaults.
    return drug.get('practice_departments', DRUG_DEPARTMENTS.get(drug.get('name'), []))


def require_department_match(drug, doctor):
    if department(doctor.get('specialty', '')) not in drug_departments(drug):
        raise HTTPException(409, '所选药品与医生科室不匹配，请重新选择对口的药品或医生。')


def with_departments(kind, item):
    if kind == 'drug':
        return {**item, 'practice_departments': drug_departments(item)}
    if kind == 'doctor':
        return {**item, 'practice_department': department(item.get('specialty', ''))}
    return item
