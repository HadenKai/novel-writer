/**
 * 敏感词 / 过审检测（离线内置词典）。
 *
 * 网文平台的「过审」是作者刚需：章节里带违禁词会被限流甚至锁章。
 * 这里内置一份按类目组织的基础词典 + 导流正则，完全离线运行；
 * 检测只做「提示」，不做替换或拦截——改不改、怎么改由作者决定。
 *
 * 词典是保守的基础版（常见高频词），后续可挂接用户自定义词表。
 */

export const CATEGORY_NAMES = {
  political: '政治敏感',
  porn: '色情低俗',
  violence: '暴力恐怖',
  illegal: '违禁犯罪',
  abuse: '辱骂攻击',
  ads: '广告导流'
}

const WORDS = {
  political: [
    '分裂国家',
    '颠覆政权',
    '恐怖组织',
    '恐怖分子',
    '恐怖袭击',
    '自杀式袭击',
    '爆炸袭击',
    '圣战',
    '极端主义',
    '邪教',
    '法轮',
    '反动派',
    '游行示威',
    '政治犯',
    '劳改营',
    '集中营',
    '种族灭绝',
    '种族清洗',
    '纳粹',
    '希特勒',
    '军国主义',
    '参拜靖国',
    '台独',
    '港独',
    '藏独',
    '疆独',
    '两个中国',
    '一中一台'
  ],
  porn: [
    '做爱',
    '性交',
    '性爱',
    '性器官',
    '生殖器',
    '阴茎',
    '阴蒂',
    '阴道',
    '阴唇',
    '睾丸',
    '乳头',
    '乳房',
    '射精',
    '口交',
    '肛交',
    '手淫',
    '自慰',
    '强奸',
    '轮奸',
    '猥亵',
    '嫖娼',
    '卖淫',
    '雏妓',
    '援交',
    '群交',
    '乱伦',
    ' SM',
    '调教',
    '痴女',
    '人妻出轨',
    '约炮',
    '一夜情',
    '开房',
    '全裸',
    '赤裸身体',
    '春药',
    '催情',
    '淫水',
    '淫荡',
    '发情',
    '交合'
  ],
  violence: [
    '砍杀',
    '屠杀',
    '灭门',
    '虐杀',
    '肢解',
    '分尸',
    '碎尸',
    '斩首',
    '剥皮',
    '挖眼',
    '活埋',
    '烧死',
    '凌迟',
    '酷刑',
    '虐待儿童',
    '虐童',
    '自杀方法',
    '自杀教程',
    '上吊自杀',
    '割腕',
    '安眠药自杀',
    '炸药配方',
    '制造炸弹',
    '自制炸弹',
    '雷管'
  ],
  illegal: [
    '毒品',
    '冰毒',
    '海洛因',
    '可卡因',
    '大麻',
    '摇头丸',
    'K粉',
    '制毒',
    '贩毒',
    '吸毒方法',
    '枪支买卖',
    '买卖枪支',
    '私藏枪支',
    '弹药',
    '军火',
    '走私',
    '洗钱',
    '假钞',
    '印制假币',
    '开锁工具',
    '万能钥匙',
    '窃听器',
    '偷拍设备',
    '迷药',
    '蒙汗药',
    '迷奸',
    '器官买卖',
    '买卖器官',
    '代孕',
    '买卖人口',
    '拐卖儿童',
    '绑架撕票',
    '雇佣杀手',
    '买凶杀人',
    '黑客攻击',
    '木马程序',
    '盗号',
    '诈骗话术',
    '赌博网站',
    '网络赌博',
    '赌场',
    '高利贷',
    '裸贷',
    '传销组织',
    '洗脑组织'
  ],
  abuse: [
    '傻逼',
    '煞笔',
    '沙比',
    '牛逼',
    '傻屄',
    '草泥马',
    '妈逼',
    '他妈的',
    '他妈了个巴子',
    '狗娘养',
    '狗日的',
    '杂种',
    '婊子',
    '贱人',
    '贱货',
    '母狗',
    '畜生不如',
    '滚你妈',
    '去死吧',
    '废物点心',
    '脑残',
    '智障',
    '白痴',
    '弱智',
    '变态'
  ],
  ads: [
    '加微信',
    '加V信',
    '加QQ',
    '加扣扣',
    '加群',
    '微信群',
    'QQ群',
    '扣扣群',
    '公众号',
    '关注公众号',
    '扫码关注',
    '扫描二维码',
    '免费领取',
    '限时免费',
    '点击链接',
    '复制链接打开',
    '代充',
    '代练',
    '刷单',
    '刷钻',
    '刷粉',
    '兼职日结',
    '日赚千元',
    '月入过万',
    '网赚',
    '小额贷款',
    '无抵押贷款',
    '办证',
    '发票代开',
    '低价出售',
    '全网最低价',
    '私聊购买',
    '内部渠道',
    '破解版下载',
    '翻墙软件',
    'VPN购买'
  ]
}

/** 需要正则才能抓稳的导流/联系形态 */
const PATTERNS = [
  { category: 'ads', label: '手机号', re: /1[3-9]\d[\s-]?\d{8}/g },
  { category: 'ads', label: 'QQ群号', re: /[QqQ群号：:\s]{2,}\d{5,11}/g },
  { category: 'ads', label: '外部网址', re: /(?:https?:\/\/|www\.)[^\s，。！？、"']{4,}/g }
]

export function detectSensitive(items) {
  // items: [{ key, label, text }]
  const groups = []
  let total = 0
  const byCategory = {}

  for (const item of Array.isArray(items) ? items : []) {
    const text = typeof item?.text === 'string' ? item.text : ''
    if (!text) continue
    const lower = text.toLowerCase()
    const hits = []
    for (const [cat, words] of Object.entries(WORDS)) {
      for (const w of words) {
        const needle = w.trim().toLowerCase()
        if (!needle) continue
        // 纯可打印 ASCII 词（如 sm）必须整词匹配，否则 "small"/"smart" 会被误判；
        // 中文词无边界概念，仍用子串匹配（[ -~] = U+0020..U+007E，避开控制字符）
        const asciiWord = /^[ -~]+$/.test(needle)
        let from = 0
        for (;;) {
          const i = lower.indexOf(needle, from)
          if (i < 0) break
          from = i + needle.length
          if (asciiWord) {
            const before = i === 0 ? '' : lower[i - 1]
            const after = i + needle.length >= lower.length ? '' : lower[i + needle.length]
            if (/[a-z0-9]/.test(before) || /[a-z0-9]/.test(after)) continue
          }
          hits.push({
            category: cat,
            categoryName: CATEGORY_NAMES[cat] || cat,
            word: w.trim(),
            index: i,
            context: text.slice(Math.max(0, i - 18), Math.min(text.length, i + needle.length + 18))
          })
        }
      }
    }
    for (const p of PATTERNS) {
      p.re.lastIndex = 0
      let m
      while ((m = p.re.exec(text))) {
        hits.push({
          category: p.category,
          categoryName: CATEGORY_NAMES[p.category] || p.category,
          word: p.label,
          index: m.index,
          context: text.slice(Math.max(0, m.index - 18), Math.min(text.length, m.index + m[0].length + 18))
        })
        if (!p.re.global) break
      }
    }
    hits.sort((a, b) => a.index - b.index)
    groups.push({
      key: String(item.key ?? ''),
      label: String(item.label ?? item.key ?? ''),
      count: hits.length,
      hits: hits.slice(0, 60)
    })
    total += hits.length
    for (const h of hits) byCategory[h.category] = (byCategory[h.category] || 0) + 1
  }

  return { total, byCategory, groups }
}
