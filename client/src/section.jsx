/*
 * 外壳与面板之间的两条细通道，加上全局保存条。
 *
 * 单独一个文件而不是并进 shell.jsx：面板要用 useSection / SaveBar，
 * 而 shell.jsx 又要 import 全部面板 —— 放一起就是循环依赖。
 */

import { createContext, useContext, useEffect } from "react";
import { useConfig } from "./store.jsx";
import { Button } from "./ui.jsx";
import { Check, RefreshCw, RotateCcw } from "lucide-react";

/*
 * 260px 那栏由外壳渲染，但列表内容有两种来源：
 *
 * - 配置驱动的分区（角色、服务商源、预设…）：外壳直接从 config 取，面板收 itemId
 * - 上下文分区：列表是 /api/sessions 拉来的、不在 config 里，只有面板知道
 *
 * 所以给第二种留一条上报通道。选中态一律由外壳持有 —— 面板内部再存一份
 * openId 就会和侧栏的高亮打架。
 */
export const SectionCtx = createContext({
  itemId: null,
  pick: () => {},
  publish: () => {},
  anchorTo: null,
});

export const useSection = () => useContext(SectionCtx);

/*
 * 各面板的保存提示（「只影响这个角色」这类）要显示在全局保存条上，
 * 而保存条在外壳里。单独一条通道而不是塞进 SectionCtx：
 * hint 每次切面板都变，混在一起会让整棵子树跟着重渲染。
 */
export const SaveHintCtx = createContext({ setHint: () => {} });

export const useSaveHint = () => useContext(SaveHintCtx);

/**
 * 保存条现在是**全局贴底一条**（渲染在 AppShell 里），这里只登记提示文案。
 *
 * 以前 11 个面板各自在底部画一条，于是「保存」按钮的位置跟着当前面板的
 * 内容长度上下乱跳，长表单里还得滚到底才找得到。收敛成一条之后位置固定，
 * 而各面板的 hint（「只影响这个角色」「密钥只写入本地」）不能丢 ——
 * 所以调用点原样留着，改成把 hint 报给外壳，自己不渲染任何东西。
 */
export function SaveBar({ hint }) {
  const { setHint } = useSaveHint();
  useEffect(() => {
    setHint(hint ?? "");
    return () => setHint("");
  }, [hint, setHint]);
  return null;
}

/**
 * 全局保存条的实体。贴在主内容区底部，无改动时整条不渲染。
 *
 * 1px 上边框、白底、无投影 —— 它是主内容区的下边界，不是浮在上面的一块。
 */
export function GlobalSaveBar({ hint }) {
  const { dirty, save, revert, saveState, saveError } = useConfig();
  const busy = saveState === "saving";
  const failed = saveState === "error";

  // 空闲态整条不渲染：没改动时没什么可说的，留一条空壳只是占地方
  if (!dirty && !busy && !failed) return null;

  return (
    /*
     * pb-safe 顶掉下边的 py-3：iPhone 上页面铺到安全区之外（viewport-fit=cover），
     * 不让出底部那条小黑条的话，「保存」看着像被屏幕边缘啃了一口。
     * 具体值见 index.css，它就是 0.75rem + 安全区。
     *
     * pr-20 只在手机上给：右下角那个客服气泡是 fixed bottom-5 right-5 的 48px 圆钮，
     * z-30 压在这条之上。375px 的屏上这条是靠右对齐的，「保存」正好钻到气泡底下 ——
     * 右半边点不着。把右内边距留到 80px，让按钮从气泡下面挪出来（气泡占到右边 68px）。
     * 桌面端不需要：那儿内容居中在 max-w-content 里，离窗口右边还远着。
     */
    <div className="shrink-0 border-t border-line bg-paper px-6 pb-safe pr-20 pt-3 md:pr-6 lg:px-10">
      <div className="mx-auto flex max-w-content flex-wrap items-center justify-end gap-x-6 gap-y-2">
        <div className="mr-auto min-w-0 text-meta leading-relaxed">
          {failed ? (
            <span className="flex items-start gap-1.5 whitespace-pre-wrap break-words text-warn">
              保存失败：{saveError}
            </span>
          ) : (
            <span className="text-ink-soft">
              有未保存的改动
              {hint ? <span className="text-ink-meta">（{hint}）</span> : null}
            </span>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-3">
          {dirty && (
            <Button variant="outline" onClick={revert} disabled={busy}>
              <RotateCcw size={13} /> 撤销
            </Button>
          )}
          <Button onClick={() => save().catch(() => {})} disabled={busy || !dirty}>
            {busy ? <RefreshCw size={14} className="animate-spin" /> : <Check size={14} />}
            {busy ? "保存中…" : "保存"}
          </Button>
        </div>
      </div>
    </div>
  );
}
