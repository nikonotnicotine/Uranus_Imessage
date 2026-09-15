import { useRef, useState } from "react";
import { Download, RefreshCw, Upload } from "lucide-react";

import { Button, Card } from "../ui.jsx";

/**
 * 「导出 / 导入这一份」——预设面板和世界书面板共用一张卡片。
 *
 * 和「控制台 → 数据导出 / 导入」那张整份备份的卡片长得像，但语义差得很远，
 * 所以是两份代码不是一份：
 *
 *  - 整份备份是**覆盖**（备份里有几个角色，导入后就只剩几个），所以那边有
 *    未保存改动时要拦着；
 *  - 这里是**多出一件**：导进来的预设一定是新的一份（重名会自动加
 *    「（导入）」），现有的一份都不动。既然不覆盖任何东西，也就没有
 *    「会冲掉未保存改动」这回事，不用拦。
 *
 * 导入回来的那份只进草稿，用户点底下的保存才落盘 —— 所以看一眼不喜欢，
 * 点撤销就当没发生过。
 */
export function TransferCard({ what, onExport, onImport, onDone }) {
  const fileRef = useRef(null);
  const [busy, setBusy] = useState(""); // "" | export | import
  const [note, setNote] = useState(null); // { ok, text }

  async function runExport() {
    setBusy("export");
    setNote(null);
    try {
      setNote({ ok: true, text: `已导出 ${await onExport()}` });
    } catch (e) {
      setNote({ ok: false, text: String(e?.message ?? e) });
    } finally {
      setBusy("");
    }
  }

  /** 选了文件先在前端 JSON.parse 一遍：坏文件不用往后端跑一趟。 */
  async function onPickFile(e) {
    const file = e.target.files?.[0];
    e.target.value = ""; // 同一个文件连选两次也要能触发
    if (!file) return;

    let bundle;
    setNote(null);
    try {
      bundle = JSON.parse(await file.text());
    } catch {
      setNote({ ok: false, text: "这个文件不是合法的 JSON，选错文件了？" });
      return;
    }

    setBusy("import");
    try {
      const made = await onImport(bundle);
      setNote({ ok: true, text: `已导入「${made.name}」。还没落盘 —— 点下面的保存才写进去` });
      onDone?.(made);
    } catch (e) {
      setNote({ ok: false, text: String(e?.message ?? e) });
    } finally {
      setBusy("");
    }
  }

  return (
    <Card
      title={`导出 / 导入${what}`}
      desc={`存成一个 JSON 文件带走，或者把别处的${what}导进来`}
    >
      <div className="grid grid-cols-1 gap-4">
        <p className="max-w-[62ch] text-meta leading-relaxed text-ink-faint">
          导出的是<span className="text-ink-soft">你现在看见的这份</span>，包括还没保存的改动。
          导入是<span className="text-ink-soft">新增一份</span>，现有的都不动；重名会自动加
          「（导入）」，改名随你。
        </p>

        <div className="flex flex-wrap items-center gap-2">
          <Button variant="outline" onClick={runExport} disabled={Boolean(busy)}>
            {busy === "export" ? (
              <RefreshCw size={14} className="animate-spin" />
            ) : (
              <Download size={14} />
            )}
            {busy === "export" ? "导出中…" : "导出"}
          </Button>

          <input
            ref={fileRef}
            type="file"
            accept="application/json,.json"
            className="hidden"
            onChange={onPickFile}
          />
          <Button
            variant="outline"
            onClick={() => fileRef.current?.click()}
            disabled={Boolean(busy)}
          >
            {busy === "import" ? (
              <RefreshCw size={14} className="animate-spin" />
            ) : (
              <Upload size={14} />
            )}
            {busy === "import" ? "导入中…" : "选择文件导入…"}
          </Button>
        </div>

        {note && (
          <p
            className={`border-l-2 py-1.5 pl-3 text-meta leading-relaxed ${
              note.ok ? "border-good text-good" : "border-warn text-warn"
            }`}
          >
            {note.text}
          </p>
        )}
      </div>
    </Card>
  );
}
