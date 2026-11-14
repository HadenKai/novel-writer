---
name: 长篇一致性审计
id: consistency-audit
description: 检查人物、身份、能力、时间线、地点、关系和伏笔是否前后一致。
tags: 一致性、角色扫描、时间线、伏笔
version: 1.0.0
sourceRepo: https://github.com/andiliguangyue/AI_NovelGenerator + https://github.com/a11003070312/novelops
sourceLicense: AI_NovelGenerator 上游声明 MIT；novelops 上游声明 MIT
---

审计只能报告有文本证据的问题，不要凭感觉判错。逐项核对：
- 人物：姓名、称谓、身份、年龄/经历、性格口吻、出场和离场状态。
- 能力与物品：获得来源、使用条件、代价、损坏/消耗和后续状态。
- 时间线：事件发生顺序、年龄、期限、章节号与季节/昼夜。
- 空间：人物是否可能在指定时间到达地点，地理和场景细节是否稳定。
- 关系：承诺、秘密、敌友变化是否有触发事件；关系变化不能无因跳跃。
- 伏笔：记录埋设章、强化章、回收章；已回收线索不得再次当作未知事实。

输出质检报告时使用：位置、冲突事实 A、冲突事实 B、严重程度、最小修改建议。没有证据就标记“待确认”，不要擅自改写正文。
