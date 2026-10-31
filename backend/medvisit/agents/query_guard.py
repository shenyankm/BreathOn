"""Refuse public-search queries that look like they carry patient or personal data.

The search tools go to a third-party provider, so the cheapest safe rule is to reject, not rewrite: silently editing a
query would change what the model thinks it searched. Public searches are generic (a drug, a disease, a policy), so a
false positive costs one rephrased query while a miss sends personal data off the platform.

This is a screen, not a guarantee. It does not catch every name or free-text case description; the prompt rules and the
128-character limit remain the other layers.
"""
import re

# Digits may be split by spaces or dashes: "138 1234 5678", "1101-0119-9001-011234".
_SPACED = re.compile(r'[\s\-－]+')
_PHONE = re.compile(r'(?<!\d)1[3-9]\d{9}(?!\d)')
_ID_CARD = re.compile(r'(?<!\d)\d{17}[\dXx](?!\d)')
_EMAIL = re.compile(r'[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}')
# Record identifiers: 病历号/住院号/门诊号/床号/就诊卡/医保号 followed by anything that looks like a number or code.
_RECORD_ID = re.compile(r'(?:病历|住院|门诊|病案|就诊卡?|医保|社保|检查|床位?)\s*(?:号|卡号|编号)?\s*[:：]?\s*[A-Za-z]?\d{3,}|\d{1,3}\s*床')
# "患者/病人/家属 + 姓名" (2-4 Chinese characters, then a separator or a clinical word), and "姓名：xxx".
# Common surnames only: 患者安全/患者报告/病人教育 are topics, not people.
SURNAMES = '王李张刘陈杨黄赵吴周徐孙马朱胡郭何高林罗郑梁谢宋唐许韩冯邓曹彭曾萧田董潘袁蔡蒋余于杜叶程魏苏吕丁任沈姚卢姜崔钟谭陆汪范金石廖贾夏韦付方白邹孟熊秦邱江尹薛闫段雷侯龙史陶黎贺顾毛郝龚邵万钱严覃武戴莫孔向汤'
_PATIENT_NAME = re.compile(rf'(?:患者|病人|家属|受试者|姓名[:：]?|床)\s*[{SURNAMES}][\u4e00-\u9fa5]{{1,2}}(?![\u4e00-\u9fa5]*(?:安全|报告|教育|管理|权益|招募|入组|依从|满意|体验))(?=[\s，,、；;：:的]|\d|$|糖尿病|肝|肾|高血压|肥胖|用药|服药|检查|化验)')
_DEMOGRAPHICS = re.compile(r'(?:男|女)\s*,?\s*\d{1,3}\s*岁|\d{1,3}\s*岁\s*(?:男|女)')

CHECKS = (
    ('phone', _PHONE, True), ('id_card', _ID_CARD, True), ('email', _EMAIL, False),
    ('record_id', _RECORD_ID, False), ('patient_name', _PATIENT_NAME, False), ('demographics', _DEMOGRAPHICS, False),
)


def personal_data_kind(query: str) -> str | None:
    """Name of the first rule the query trips, or None. Digit-run rules also look at the de-spaced text."""
    squeezed = _SPACED.sub('', query)
    for name, pattern, digits_only in CHECKS:
        if pattern.search(query) or (digits_only and pattern.search(squeezed)):
            return name
    return None
