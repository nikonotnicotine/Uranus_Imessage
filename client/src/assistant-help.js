/**
 * Uranus 助手在前端要用到的几个常量。
 *
 * 只有兜底值和纯展示用的东西。**内置世界书那本手册不在这儿** ——
 * 它在 server/src/assistant.js 里，因为那本书是拼进系统提示词的，
 * 前端一个字都不需要看见。抄一份到前端只会多一处会过期的副本。
 */

/**
 * 群号的兜底写法，只在 /api/assistant/hello 还没回来的那一瞬间派得上用场。
 * 正主是 server/src/assistant.js 的 QQ_GROUP，改那边记得改这边。
 */
export const DEFAULT_QQ_GROUP = "1125033956";

/**
 * Niki 写的图文教程。比内置世界书详细，而且有图。
 * 正主也在 server/src/assistant.js（DOC_URL），改那边记得改这边。
 */
export const DOC_URL = "https://docs.qq.com/doc/DVnFncG9Tc05kdFZY";

/** 接口没回来时先显示这句，免得气泡一打开是空的。 */
export const DEFAULT_HELLO =
  "我是 Uranus ՞˶˃ ᵕ ˂˶՞ 不知道某个功能是干什么的、不知道该在哪儿开、或者报了错不知道缺什么，都可以问我。";

/** 历史最多留几条（一问一答算两条）。和后端 MAX_TURNS 对齐，超了从头上丢。 */
export const MAX_TURNS = 12;
