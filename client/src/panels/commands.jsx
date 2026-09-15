/*
 * 右上角那颗「指令」按钮 —— 点开是一张快捷指令总表。
 *
 * 为什么要有这张表：这些指令只在 iMessage 里发得出去，而唯一能查到它们的
 * 地方是 `/help`，一条发出去就在聊天记录里占一大屏。用户坐在网页前配角色
 * 的时候，想不起「清上下文那条是 /del 还是 /clear」就只能去翻代码。
 *
 * 挂在壁纸旁边，是因为它和壁纸一样不属于任何分区：那一排分区讲的都是
 * 「怎么配」，这张表讲的是「配完了在手机上怎么用」。
 */

import { useState } from "react";
import { Terminal } from "lucide-react";
import { COMMAND_GROUPS, COMMAND_ROWS, DEFAULT_PRIVACY_TRIGGER } from "../commands-help.js";
import { useConfig } from "../store.jsx";
import { Button, Eyebrow, Modal } from "../ui.jsx";

/** 右上角的入口。小屏只留图标，标题那行本来就挤（和壁纸按钮一个路子）。 */
export function CommandsButton({ onGoto }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button variant="outline" className="shrink-0" onClick={() => setOpen(true)}>
        <Terminal size={14} />
        <span className="max-sm:hidden">指令</span>
      </Button>
      {open && <CommandsModal onGoto={onGoto} onClose={() => setOpen(false)} />}
    </>
  );
}

function CommandsModal({ onGoto, onClose }) {
  const { config } = useConfig();
  const privacy = config.privacy ?? {};
  /*
   * 暗号得现读：它是用户自己设的，而且**手机上也能改**（每发一次翻一次开关，
   * 不过翻的是 enabled 不是 trigger）。写死在 commands-help.js 里那行 cmd: null
   * 就是留给它的坑，在这儿填。
   */
  const trigger = String(privacy.trigger ?? "").trim() || DEFAULT_PRIVACY_TRIGGER;
  const bare = trigger.startsWith("/") ? trigger.slice(1) : trigger;

  return (
    <Modal
      title="快捷指令"
      desc="在 iMessage 里直接发给角色，不经过 AI。手机上发 /help 也能把这张表发到聊天里。"
      onClose={onClose}
      footer={
        onGoto && (
          <Button
            variant="outline"
            onClick={() => {
              onGoto("chat", null, "防相亲");
              onClose();
            }}
          >
            去改防相亲的暗号
          </Button>
        )
      }
    >
      <div className="grid grid-cols-1 gap-8">
        {COMMAND_GROUPS.map((g) => {
          const rows = COMMAND_ROWS.filter((r) => r.group === g.key);
          if (!rows.length) return null;
          return (
            <section key={g.key}>
              <Eyebrow>{g.label}</Eyebrow>
              <div className="mt-3 border-t border-line">
                {rows.map((r, i) => (
                  <CommandRow
                    key={r.key ?? r.cmd ?? i}
                    row={r}
                    trigger={trigger}
                    bare={bare}
                    on={Boolean(privacy.enabled)}
                  />
                ))}
              </div>
            </section>
          );
        })}
      </div>
    </Modal>
  );
}

/**
 * 一条指令。左边等宽的写法，右边一句人话。
 *
 * 不用 `<table>`：窄屏下两列表格只会把命令那列压成竖着一个字一行。
 * 这里是 640px 以上并排、以下堆叠 —— 弹窗最宽 max-w-xl，手机上必然堆叠。
 */
function CommandRow({ row, trigger, bare, on }) {
  const isPrivacy = row.key === "privacy";
  const cmd = isPrivacy ? trigger : row.cmd;
  // 防相亲那条的「别名」是同一个词去掉斜杠 —— 它是全站唯一不要求 / 的触发词
  const alt = isPrivacy ? (bare === trigger ? [] : [bare]) : row.alt ?? [];

  return (
    <div className="grid grid-cols-1 gap-x-6 gap-y-1 border-b border-line py-3 sm:grid-cols-[minmax(0,9.5rem)_1fr]">
      <div className="min-w-0">
        <p className="flex flex-wrap items-baseline gap-2 break-all font-mono text-meta text-ink">
          {cmd}
          {isPrivacy && (
            <span className={`shrink-0 font-sans text-eyebrow uppercase ${on ? "text-good" : "text-ink-meta"}`}>
              {on ? "开着" : "关着"}
            </span>
          )}
        </p>
        {alt.length > 0 && (
          <p className="mt-1 break-all font-mono text-eyebrow text-ink-meta">{alt.join("　")}</p>
        )}
      </div>
      <p className="min-w-0 text-meta leading-relaxed text-ink-soft">{row.desc}</p>
    </div>
  );
}
