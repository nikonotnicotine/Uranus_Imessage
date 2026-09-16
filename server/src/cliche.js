/**
 * 八股文正则规则 —— 默认线下预设自带的那套。
 *
 * 单一事实来源：服务端 preset.js 的 defaultRegexRules("offline") 从这里拿，
 * 客户端的 blankPreset("offline") 也从这里生成的副本拿，assets 里的种子预设
 * 同样带着这批规则 —— 三处用的是同一套，改一个地方就全改了。
 *
 * 用户说「我要在正则里的，你给我改了，不然我都不知道我要怎么开关」—— 这批
 * 规则必须是**真正的正则规则**，带开关、能拖、能导出，和用户自己加的规则
 * 一视同仁。原来那个 offlineClicheRules() 是硬编码回退，规则看不见也动不了。
 *
 * 规则 ID 是手写的（rx-d-1 … rx-r-17），而不是 normalizeRegexRules 分配的，
 * 这样导出的副本 ID 一致 —— 用户把八股文规则导出来、贴到另一份预设里时，
 * ID 不会变成 rx-d-1-2 这种去重后缀，顺序也不会乱（rx-r-16 必须在 rx-r-17 前）。
 *
 * 两个不变量（regex.js:selectRules 保证）：
 *  1. 删除规则先于替换规则执行 —— 同一个词既在删除表也在替换表时，先删后改
 *     才说得通，反过来替换后的词就再也碰不到原文了。
 *  2. rx-r-16「如同…岩浆…灌进/满」必须在 rx-r-17「岩浆」之前 —— 前者是个
 *     完整短语，后者是它的一部分，顺序反了会把短语切碎。
 *
 * 所有规则默认 enabled: false，留给用户自己挑着开 —— 不是每个人都需要去八股文。
 *
 * ⚠️ **改完这个文件要跑一下 `npm run sync:cliche`** —— 客户端那份副本
 * （client/src/clicherules.js）是从这里生成的，不同步的话「新建线下预设」时
 * 界面上摆出来的规则会和聊天时真正跑的那套对不上，而且不报错。
 * 生成脚本：scripts/sync-cliche.mjs（`--check` 只检查不写）。
 */

/**
 * 返回八股文规则数组。
 *
 * 每条规则的字段：
 *  - id: 手写 ID，rx-d-* 是删除组，rx-r-* 是替换组
 *  - name: 规则名，界面上显示
 *  - enabled: 默认 false
 *  - find: 正则表达式（字符串）
 *  - flags: 正则标志
 *  - action: "delete" 或 "replace"
 *  - replace: 替换串（action=delete 时忽略）
 *  - alternatives: 候选词数组（每处匹配随机挑一个）
 *  - targets: ["userInput", "aiOutput"] 两路文本都跑
 *  - toUser: true —— 改发给对方的那份
 *  - toHistory: true —— 改存进上下文的那份
 */
export function clicheRules() {
  return [
    // ========== 删除组 ==========
    {
      id: "rx-d-1",
      name: "删掉「极其/极为/极具/极度」",
      enabled: false,
      find: "极(其|为|具|度)",
      flags: "g",
      action: "delete",
      replace: "",
      alternatives: [],
      targets: ["userInput", "aiOutput"],
      toUser: true,
      toHistory: true,
    },
    {
      id: "rx-d-2",
      name: "删掉「一丝」",
      enabled: false,
      find: "一丝",
      flags: "g",
      action: "delete",
      replace: "",
      alternatives: [],
      targets: ["userInput", "aiOutput"],
      toUser: true,
      toHistory: true,
    },
    {
      id: "rx-d-3",
      name: "删掉「微不可察/不易察觉/不容」",
      enabled: false,
      find: "(微不可察|不易察觉|不容)",
      flags: "g",
      action: "delete",
      replace: "",
      alternatives: [],
      targets: ["userInput", "aiOutput"],
      toUser: true,
      toHistory: true,
    },
    {
      id: "rx-d-4",
      name: "删掉「近乎」",
      enabled: false,
      find: "近乎",
      flags: "g",
      action: "delete",
      replace: "",
      alternatives: [],
      targets: ["userInput", "aiOutput"],
      toUser: true,
      toHistory: true,
    },
    {
      id: "rx-d-5",
      name: "删掉「我的小」",
      enabled: false,
      find: "我的小",
      flags: "g",
      action: "delete",
      replace: "",
      alternatives: [],
      targets: ["userInput", "aiOutput"],
      toUser: true,
      toHistory: true,
    },
    {
      id: "rx-d-6",
      name: "删掉「不容」",
      enabled: false,
      find: "不容",
      flags: "g",
      action: "delete",
      replace: "",
      alternatives: [],
      targets: ["userInput", "aiOutput"],
      toUser: true,
      toHistory: true,
    },
    {
      id: "rx-d-7",
      name: "删掉「管家婆/富婆」",
      enabled: false,
      find: "(管家婆|富婆)",
      flags: "g",
      action: "delete",
      replace: "",
      alternatives: [],
      targets: ["userInput", "aiOutput"],
      toUser: true,
      toHistory: true,
    },
    {
      id: "rx-d-8",
      name: "删掉「(像只|我的)?(小兽|幼兽)」",
      enabled: false,
      find: "(像只|我的)?(小兽|幼兽)",
      flags: "g",
      action: "delete",
      replace: "",
      alternatives: [],
      targets: ["userInput", "aiOutput"],
      toUser: true,
      toHistory: true,
    },

    // ========== 替换组 ==========
    {
      id: "rx-r-1",
      name: "「极其/极为」→「分外/格外/相当/…」",
      enabled: false,
      find: "(极其|极为)",
      flags: "g",
      action: "replace",
      replace: "",
      alternatives: ["分外", "格外", "相当", "太", "很", "实在"],
      targets: ["userInput", "aiOutput"],
      toUser: true,
      toHistory: true,
    },
    {
      id: "rx-r-2",
      name: "「一丝」→「些许/几分/半点/…」",
      enabled: false,
      find: "一丝",
      flags: "g",
      action: "replace",
      replace: "",
      alternatives: ["些许", "几分", "半点", "若隐若现的"],
      targets: ["userInput", "aiOutput"],
      toUser: true,
      toHistory: true,
    },
    {
      id: "rx-r-3",
      name: "「微不可察/不易察觉」→「短促地/细微的/…」",
      enabled: false,
      find: "(微不可察|不易察觉)",
      flags: "g",
      action: "replace",
      replace: "",
      alternatives: ["短促地", "细微的", "稍纵即逝地"],
      targets: ["userInput", "aiOutput"],
      toUser: true,
      toHistory: true,
    },
    {
      id: "rx-r-4",
      name: "「近乎」→「差一点/几乎/简直像/…」",
      enabled: false,
      find: "近乎",
      flags: "g",
      action: "replace",
      replace: "",
      alternatives: ["差一点", "几乎", "简直像", "算得上是"],
      targets: ["userInput", "aiOutput"],
      toUser: true,
      toHistory: true,
    },
    {
      id: "rx-r-5",
      name: "「极具」→「带着十足的/透着一股/满是」",
      enabled: false,
      find: "极具",
      flags: "g",
      action: "replace",
      replace: "",
      alternatives: ["带着十足的", "透着一股", "满是"],
      targets: ["userInput", "aiOutput"],
      toUser: true,
      toHistory: true,
    },
    {
      id: "rx-r-6",
      name: "「不容」→「硬生生/根本不给退路地/…」",
      enabled: false,
      find: "不容",
      flags: "g",
      action: "replace",
      replace: "",
      alternatives: ["硬生生", "根本不给退路地", "由不得人地", "强硬地", "毋庸置疑", "毫无疑问"],
      targets: ["userInput", "aiOutput"],
      toUser: true,
      toHistory: true,
    },
    {
      id: "rx-r-7",
      name: "「好像在聊天气」短语",
      enabled: false,
      find: "(语气[^。！？\\n]{0,12}得)?就好像在(说|聊|提)?[^。！？\\n]{0,6}天气[^。！？\\n]{0,4}",
      flags: "g",
      action: "replace",
      replace: "",
      alternatives: ["漫不经心", "没什么起伏", "平平淡淡", "听不出情绪"],
      targets: ["userInput", "aiOutput"],
      toUser: true,
      toHistory: true,
    },
    {
      id: "rx-r-8",
      name: "「指尖/指节泛白」",
      enabled: false,
      find: "(指尖|指节)泛白",
      flags: "g",
      action: "replace",
      replace: "",
      alternatives: ["攥得很紧", "手指收紧", "握紧了", "手指绷直"],
      targets: ["userInput", "aiOutput"],
      toUser: true,
      toHistory: true,
    },
    {
      id: "rx-r-9",
      name: "「胸腔震动/振动」",
      enabled: false,
      find: "胸腔(震动|振动)",
      flags: "g",
      action: "replace",
      replace: "",
      alternatives: ["胸口起伏", "胸膛颤了颤", "胸口一紧"],
      targets: ["userInput", "aiOutput"],
      toUser: true,
      toHistory: true,
    },
    {
      id: "rx-r-10",
      name: "「低吼/嘶吼」",
      enabled: false,
      find: "(低吼|嘶吼)",
      flags: "g",
      action: "replace",
      replace: "",
      alternatives: ["沉声说", "压着嗓子", "嗓音沙哑", "声音低沉"],
      targets: ["userInput", "aiOutput"],
      toUser: true,
      toHistory: true,
    },
    {
      id: "rx-r-11",
      name: "「(像只|我的)?(小兽|幼兽)」",
      enabled: false,
      find: "(像只|我的)?(小兽|幼兽)",
      flags: "g",
      action: "replace",
      replace: "",
      alternatives: ["可怜巴巴", "委屈得不行", "眼巴巴"],
      targets: ["userInput", "aiOutput"],
      toUser: true,
      toHistory: true,
    },
    {
      id: "rx-r-12",
      name: "「共犯」",
      enabled: false,
      find: "共犯",
      flags: "g",
      action: "replace",
      replace: "",
      alternatives: ["一起的", "同伙", "一条船上的"],
      targets: ["userInput", "aiOutput"],
      toUser: true,
      toHistory: true,
    },
    {
      id: "rx-r-13",
      name: "「算账/记账」",
      enabled: false,
      find: "(算账|记账)",
      flags: "g",
      action: "replace",
      replace: "",
      alternatives: ["记住了", "等着瞧", "记下了", "留着"],
      targets: ["userInput", "aiOutput"],
      toUser: true,
      toHistory: true,
    },
    {
      id: "rx-r-14",
      name: "「贯穿」",
      enabled: false,
      find: "贯穿",
      flags: "g",
      action: "replace",
      replace: "",
      alternatives: ["穿透", "刺穿", "穿过"],
      targets: ["userInput", "aiOutput"],
      toUser: true,
      toHistory: true,
    },
    {
      id: "rx-r-15",
      name: "「大开大合」",
      enabled: false,
      find: "大开大合",
      flags: "g",
      action: "replace",
      replace: "",
      alternatives: ["幅度很大", "动作夸张", "毫不收敛"],
      targets: ["userInput", "aiOutput"],
      toUser: true,
      toHistory: true,
    },
    // rx-r-16 必须在 rx-r-17 之前 —— 前者是完整短语，后者是它的一部分
    {
      id: "rx-r-16",
      name: "「如同…岩浆…灌进/满」短语",
      enabled: false,
      find: "如同[^。！？\\n]{0,6}岩浆[^。！？\\n]{0,6}灌[进满]",
      flags: "g",
      action: "replace",
      replace: "",
      alternatives: ["滚烫", "热得发烫", "火辣辣的", "热浪袭来"],
      targets: ["userInput", "aiOutput"],
      toUser: true,
      toHistory: true,
    },
    {
      id: "rx-r-17",
      name: "「岩浆喷发/岩浆」",
      enabled: false,
      find: "(岩浆喷发|岩浆)",
      flags: "g",
      action: "replace",
      replace: "",
      alternatives: ["沸腾", "燃烧", "热浪", "滚烫"],
      targets: ["userInput", "aiOutput"],
      toUser: true,
      toHistory: true,
    },
  ];
}
