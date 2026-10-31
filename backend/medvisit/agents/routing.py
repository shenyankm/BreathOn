"""Which coaching skills apply to a conversation: a data table, so a missed live case is a one-line addition."""
import re

from .reliability import count

BASE_SKILL = "medical-rep-academic-visit"

# Ordered (skill, pattern) rules. A skill is added once when any message in scope matches.
# Extend from missed live cases before adding a classifier; each rule has a case in test_coaching_skills.py.
ROUTES: tuple[tuple[str, re.Pattern[str]], ...] = (
    ("medical-rep-evidence-communication", re.compile(
        r"研究|试验|证据|文献|指南|共识|终点|样本|发生率|疗效|安全性|获益|置信|统计|百分|百分点|对照|相对|绝对|风险|概率|优效"
        r"|随机|双盲|安慰剂|头对头|亚组|入组|随访|显著|p\s*值|(?<![a-z])(?:meta|ITT|PP)(?![a-z])|荟萃|非劣|三期|[ⅡⅢ23]期"
        r"|\d\s*[%％]|(?<![a-z])(?:HR|RR|OR|ARR|RRR|NNT|RCT|PICO|CI)(?![a-z])", re.I)),
    ("medical-rep-promotion-compliance", re.compile(
        r"回扣|返利|红包|购物卡|礼金|礼品|报销|宴请|旅游|收款|票据|处方|统方|开药数量|好处费|辛苦费|感谢费|赞助|捐赠|资助|个人信息|身份证|患者信息"
        r"|销售任务|备案|登记|门禁|授权|超说明书|超适应症|说明书外|适应症之外|适应症以外|超剂量|不良反应|副作用|药物警戒|隐瞒|病历|隐私"
        r"|多开|多用|开量|处方量|样品|试用装|私下|私聊|微信|加好友|绕过|不记录|别记录|不上报|先别报"
        r"|孕妇|妊娠|哺乳|儿童|小儿|老年|肝肾功能|肝功能不全|肾功能不全|禁忌|剂量|联用|合用"
        r"|(?:姓名|电话|手机号?|住址)(?:都|和|与|发|给|提供)|所有患者|保证有效|完全安全|先别记录|(?<![a-z])SOP(?![a-z])", re.I)),
)


def messages_in_scope(messages: list[dict], *, speak: bool) -> list[dict]:
    """Live replies look only at the latest message per role; a full review reads everything."""
    if not speak:
        return messages
    current, roles = [], set()
    for message in reversed(messages):
        if message["role"] not in roles:
            current.append(message)
            roles.add(message["role"])
        if len(roles) == 2:
            break
    return current


def coaching_skill_names(messages: list[dict], *, speak: bool = True) -> list[str]:
    text = "\n".join(m["text"] for m in messages_in_scope(messages, speak=speak))
    names = [skill for skill, pattern in ROUTES if pattern.search(text)]
    # A rising "none" share on real traffic is the signal to look for missed phrasings.
    count("routing.none" if not names else "routing." + "+".join(n.removeprefix("medical-rep-") for n in names))
    return [BASE_SKILL, *names]
