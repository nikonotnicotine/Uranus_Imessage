/** @type {import('tailwindcss').Config} */
export default {
  // 深色模式已删除：色板只定义了浅色一套，留着 darkMode 只会让人以为还能切
  content: ["./index.html", "./src/**/*.{js,jsx}"],
  theme: {
    extend: {
      /*
       * 颜色变量存的是 RGB 通道值（见 index.css），这里统一包成
       * `rgb(var(--x) / <alpha-value>)` —— Tailwind 会把 `/30`、`/[0.08]`
       * 这类透明度修饰符填进那个占位符。
       *
       * ⚠ 直接写 `var(--x)`（变量里是 #hex）看着能用，但任何带透明度的
       * 工具类都会拼出 `rgb(#18181b / 0.08)` 这种非法值，Tailwind 静默
       * 不生成 CSS —— 悬停态整个消失，构建还是零报错。别改回去。
       */
      colors: {
        paper: {
          DEFAULT: "rgb(var(--paper) / <alpha-value>)",
          // 表面不再靠底色区分（和 paper 同值），保留这个名字是为了不改 61 处调用点
          raise: "rgb(var(--paper-raise) / <alpha-value>)",
          // 主按钮上的字色
          invert: "rgb(var(--paper-invert) / <alpha-value>)",
        },
        sunken: "rgb(var(--sunken) / <alpha-value>)",
        ink: {
          DEFAULT: "rgb(var(--ink) / <alpha-value>)",
          soft: "rgb(var(--ink-soft) / <alpha-value>)",
          faint: "rgb(var(--ink-faint) / <alpha-value>)",
          meta: "rgb(var(--ink-meta) / <alpha-value>)",
          hover: "rgb(var(--ink-hover) / <alpha-value>)",
        },
        line: "rgb(var(--line) / <alpha-value>)",
        // 状态色是单色规则的唯一豁免，原因见 index.css
        good: "rgb(var(--good) / <alpha-value>)",
        goodsoft: "rgb(var(--good-soft) / <alpha-value>)",
        warn: "rgb(var(--warn) / <alpha-value>)",
        warnsoft: "rgb(var(--warn-soft) / <alpha-value>)",
      },
      fontFamily: {
        /*
         * 两个字族，都只管拉丁字符 —— 中文永远回落系统 CJK 字体
         * （Source Serif 4 / Inter 都没有中文字形，任何拉丁字体都没有）。
         * 实际效果是中英混排时数字和号码比中文锐利，正好是想要的观感。
         *
         * 用 Source Serif 4 + Inter 而不是 Hedvig：Hedvig 两个字族都只有
         * 400 一个字重，按钮要的 500 会被浏览器合成假粗、字形发糊。
         * 这两个都是可变字体，能给出真 500。
         */
        serif: [
          // 名字里有数字，必须带引号 —— CSS 标识符不能以数字开头，
          // 不加引号整条 font-family 会被当成非法声明整个丢掉（继承成 sans）
          '"Source Serif 4"',
          "Songti SC",
          "Noto Serif SC",
          "STSong",
          "serif",
        ],
        sans: [
          "Inter",
          "PingFang SC",
          "Microsoft YaHei",
          "Noto Sans SC",
          "system-ui",
          "sans-serif",
        ],
      },
      fontSize: {
        // 语义尺寸：层级只走这几档，别在 JSX 里再造新的
        display: ["72px", { lineHeight: "1", letterSpacing: "-0.025em", fontWeight: "400" }],
        "display-sm": ["40px", { lineHeight: "1", letterSpacing: "-0.025em", fontWeight: "400" }],
        h2: ["24px", { lineHeight: "1.25", fontWeight: "400" }],
        h3: ["18px", { lineHeight: "1.35", fontWeight: "500" }],
        body: ["18px", { lineHeight: "1.56" }],
        ui: ["14px", { lineHeight: "1.5" }],
        meta: ["12px", { lineHeight: "1.5" }],
        eyebrow: ["12px", { lineHeight: "1.4", letterSpacing: "0.08em", fontWeight: "500" }],
      },
      // boxShadow 整块删掉：硬规则「卡片和按钮绝不使用投影」，表面靠 1px 边框分隔
      borderRadius: {
        // 只留两档：列表项 6px、次要按钮 9999px
        item: "6px",
      },
      letterSpacing: {
        wide2: "0.18em",
        eyebrow: "0.08em",
      },
      spacing: {
        // 垂直节奏：桌面 83px，移动端 60%（≈50px）
        rhythm: "83px",
        "rhythm-sm": "50px",
      },
      maxWidth: {
        content: "1250px",
      },
      transitionDuration: {
        150: "150ms",
      },
    },
  },
  plugins: [],
};