import { useCallback, useEffect, useMemo, useState } from "react";
import { applyVars, resolveUser, roleLabel } from "../labels.js";
import { useSection } from "../section.jsx";
import { ROLE_LABELS, api, useConfig } from "../store.jsx";
import { Button, Card, CodeBlock, Field, Fold, RoleBadge, fmtStamp, inputCls } from "../ui.jsx";
import { Check, Pencil, RefreshCw, Trash2, Undo2 } from "lucide-react";

/**
 * 对话记录浏览器。
 *
 * 这里是**完整存档**（磁盘上的 sessions/<id>.json），不是发给模型的那份 ——
 * 真正发出去的只有最后 maxContext 条，条数在角色的「单独配置」里调。
 */
export function ContextPanel({ onGoto }) {
  const { config } = useConfig();
  // 列表在外壳那 260px 里画（`live: true` 分区），这里只负责拉数据和上报
  const { itemId, pick, publish } = useSection();
  const [sessions, setSessions] = useState(null); // null = 还在读
  const [listError, setListError] = useState("");
  const [detail, setDetail] = useState(null);
  const [detailError, setDetailError] = useState("");
  const [busy, setBusy] = useState(false);
  // 正在编辑哪一条（消息 id，没 id 的老存档退回 "#下标"）+ 编辑框里的草稿
  const [editKey, setEditKey] = useState("");
  const [draft, setDraft] = useState("");

  const refreshList = useCallback(async () => {
    try {
      const r = await api("/api/sessions");
      setSessions(r.sessions ?? []);
      setListError("");
    } catch (e) {
      setSessions([]);
      setListError(String(e?.message ?? e));
    }
  }, []);

  useEffect(() => {
    refreshList();
  }, [refreshList]);

  // 所有角色的会话都列出来，不再按「当前角色」过滤 —— 左边点一条就看那条
  const chats = useMemo(
    () => (sessions ?? []).filter((s) => s.kind !== "legacy-preset"),
    [sessions]
  );

  const legacy = useMemo(
    () => (sessions ?? []).filter((s) => s.kind === "legacy-preset"),
    [sessions]
  );

  /*
   * 把列表交给外壳。会话不在 config 里（是 /api/sessions 拉的），所以
   * nav.js 给不出 items —— 那栏的内容由这个 effect 上报。
   *
   * 旧版预设对话排在后面：它们不发给模型，属于「看完可以删」的一类，
   * 但 260px 那栏是一条扁平列表，没有分组，所以靠顺序区分，
   * 点进去之后主内容区会说清楚这是哪一类。
   */
  const listItems = useMemo(
    () =>
      [...chats, ...legacy].map((s) => ({
        id: s.id,
        label: s.id,
        meta: String(s.count ?? 0),
        title: [s.roleName || "未命名角色", s.peer, `${s.count} 条`, fmtStamp(s.updatedAt)]
          .filter(Boolean)
          .join(" · "),
      })),
    [chats, legacy]
  );

  useEffect(() => {
    publish(listItems);
  }, [publish, listItems]);

  /**
   * 上下文限制是每个角色各自配的，所以「最后几条会发出去」要看这条会话属于谁，
   * 不能拿某个「当前角色」的数字套到所有会话上。
   */
  const roleOfDetail = useMemo(
    () => (config.roles ?? []).find((r) => r.id === detail?.roleId) ?? null,
    [config.roles, detail]
  );
  const detailLimit = roleOfDetail?.maxContext ?? 20;

  /*
   * 存档里存的是字面 `{{user}}` / `{{char}}`（角色改名后旧存档不失效，见
   * README「环境感知」那节），真名替换在服务端拼提示词那一刻才做。但这个
   * 面板是给人看的 —— 显示 `{{user}}发送当地时间` 只会让人以为变量没生效。
   * 所以**显示时**也替换一遍，跟服务端同一套规则。
   *
   * 按 roleId 取名字，不是取「当前角色」：左边那列混着所有角色的会话，
   * 每行的 {{char}} 该是那条会话自己的角色。角色已经被删掉时退回存档里
   * 记的 roleName（存档留着历史角色名，正是为了这种情形）。
   *
   * 只动显示：点进编辑框、写回磁盘的都还是字面量（下面 startEdit 用的是
   * m.content 原文）。否则改一条就会把变量烧成死名字。
   */
  const varsFor = useCallback(
    (roleId, roleName) => {
      const r = (config.roles ?? []).find((x) => x.id === roleId) ?? null;
      return {
        char: r?.name ?? roleName ?? "",
        user: resolveUser(config, r)?.name ?? "",
        sep: config?.chat?.separator ?? "",
      };
    },
    [config]
  );
  // 变量替换过、只用来显示的正文（右边详情那份）
  const shown = useCallback(
    (text) => applyVars(text, varsFor(detail?.roleId, detail?.roleName)),
    [varsFor, detail]
  );

  /*
   * 选中哪条由外壳持有（侧栏点击直接写 itemId），所以这里是「跟着 itemId 拉详情」，
   * 不是「点击时顺手拉一下」—— 否则从别的分区切回来会看到高亮着却空白的详情。
   */
  useEffect(() => {
    let alive = true;
    setDetail(null);
    setDetailError("");
    setEditKey("");
    if (!itemId) return undefined;
    (async () => {
      try {
        const r = await api(`/api/sessions/${encodeURIComponent(itemId)}`);
        if (alive) setDetail(r);
      } catch (e) {
        if (alive) setDetailError(String(e?.message ?? e));
      }
    })();
    return () => {
      alive = false;
    };
  }, [itemId]);

  /** 整份覆盖写回。删单条 / 清空 / 改单条都走这个。 */
  async function writeMessages(messages) {
    if (!detail) return;
    setBusy(true);
    try {
      await api(`/api/sessions/${encodeURIComponent(detail.id)}`, {
        method: "PUT",
        body: { messages },
      });
      setDetail({ ...detail, messages });
      refreshList();
    } catch (e) {
      setDetailError(String(e?.message ?? e));
    } finally {
      setBusy(false);
    }
  }

  function startEdit(key, content) {
    setEditKey(key);
    setDraft(content ?? "");
  }

  function cancelEdit() {
    setEditKey("");
    setDraft("");
  }

  /**
   * 把草稿写回第 index 条。
   *
   * 空内容不许存：后端 writeSession 会把它原样留下，之后发出去就是一条空
   * user/assistant 消息，有些上游会直接报 400。想删就用旁边的垃圾桶。
   */
  async function commitEdit(index) {
    if (!detail) return;
    const text = draft.trim();
    if (!text) {
      setDetailError("内容不能为空 —— 要删掉这条请用右边的垃圾桶。");
      return;
    }
    const messages = (detail.messages ?? []).map((m, j) =>
      j === index ? { ...m, content: text } : m
    );
    setEditKey("");
    setDraft("");
    setDetailError("");
    await writeMessages(messages);
  }

  async function dropSession(id) {
    setBusy(true);
    try {
      await api(`/api/sessions/${encodeURIComponent(id)}`, { method: "DELETE" });
      // 删的正是当前选中那条：把选中态清掉，上面那个 effect 会顺手清空详情
      if (id === itemId) pick("");
      await refreshList();
    } catch (e) {
      setDetailError(String(e?.message ?? e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="grid grid-cols-1 gap-rhythm-sm lg:gap-rhythm">
      <Card
        title="上下文"
        desc="和模型的对话记录，按会话存档在本地"
        actions={
          <Button variant="outline" onClick={refreshList}>
            <RefreshCw size={14} /> 刷新
          </Button>
        }
      >
        {/* 两句必要的说明：ID 规则 + 存档 ≠ 发给模型的那份 */}
        <div className="grid grid-cols-1 gap-1.5 border-l-2 border-line py-1.5 pl-3 text-meta leading-relaxed text-ink-soft">
          <p>
            会话 ID = 角色名 + 对方号码（例 <span className="font-mono">Jack1234658</span>）。
            角色改名会算出新 ID，等于开一段新会话，旧的存档留着。
          </p>
          <p>
            这里是完整存档；每个角色真正发给模型的只有最后几条，条数在
            <button
              type="button"
              onClick={() => onGoto?.("role")}
              className="link-slide mx-1 text-ink"
            >
              角色的「上下文限制」
            </button>
            里各自配。
          </p>
        </div>

        {listError && (
          <p className="mt-6 border-l-2 border-warn py-1.5 pl-3 text-meta leading-relaxed text-warn">
            读不到会话列表：{listError}
          </p>
        )}

        <div className="mt-8">
          {sessions === null && (
            <p className="text-eyebrow uppercase text-ink-meta">读取中</p>
          )}

          {sessions !== null && !itemId && (
            <p className="max-w-[62ch] text-body text-ink-soft">
              {listItems.length
                ? "左边挑一条会话，这里显示它的完整记录 —— 每条都能直接改，改完落盘。"
                : "还没有对话记录。等某个角色收到第一条消息，存档就会出现在这儿。"}
            </p>
          )}

          {detailError && (
            <p className="mb-6 border-l-2 border-warn py-1.5 pl-3 text-meta leading-relaxed text-warn">
              {detailError}
            </p>
          )}

          {itemId && !detail && !detailError && (
            <p className="text-eyebrow uppercase text-ink-meta">读取中</p>
          )}

          {detail && (
            <>
              <div className="mb-8 flex flex-wrap items-start justify-between gap-6 border-b border-line pb-4">
                <div className="min-w-0">
                  <p className="break-all font-mono text-ui text-ink">{detail.id}</p>
                  <p className="mt-1 text-meta text-ink-faint">
                    {detail.roleName || "—"}
                    {detail.peer ? ` · ${detail.peer}` : ""} · {detail.messages?.length ?? 0} 条
                    {detail.updatedAt ? ` · 更新于 ${fmtStamp(detail.updatedAt)}` : ""}
                  </p>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <Button
                    variant="ghost"
                    onClick={() => writeMessages([])}
                    disabled={busy || !(detail.messages?.length ?? 0)}
                  >
                    <Undo2 size={14} /> 清空会话
                  </Button>
                  <Button
                    variant="ghost"
                    onClick={() => dropSession(detail.id)}
                    disabled={busy}
                    className="text-warn hover:bg-warn/[0.08]"
                  >
                    <Trash2 size={14} /> 删除会话
                  </Button>
                </div>
              </div>

              {/* 旧版预设对话：以前手写的那种，混在同一个列表里，所以得点进来才说清楚 */}
              {detail.kind === "legacy-preset" && (
                <p className="mb-8 border-l-2 border-line py-1.5 pl-3 text-meta leading-relaxed text-ink-soft">
                  这是以前手写的预设对话，和侧边栏那个「预设」分区不是一回事 ——
                  那边是提示词结构和生成参数。这份只留着给你看，不会发给模型；看完可以删。
                </p>
              )}

              {(detail.messages?.length ?? 0) === 0 && (
                <p className="text-body text-ink-soft">这个会话是空的。</p>
              )}

              <div className="grid grid-cols-1">
                {(detail.messages ?? []).map((m, i) => {
                  // 存档是从旧到新排的，最后 maxContext 条就是真正会发出去的那批。
                  // 旧版预设整份都不会发给模型，所以那种会话一条都不高亮
                  const inWindow =
                    detail.kind !== "legacy-preset" &&
                    i >= detail.messages.length - detailLimit;
                  const key = m.id ?? `#${i}`;
                  const editing = editKey === key;
                  return (
                    <div
                      key={m.id ?? i}
                      /* 窗口内那批靠左侧一根实线标出来 —— 没有底色、没有边框，
                         整份存档还是一条连续的流 */
                      className={`flex items-start gap-3 border-b border-line py-3 pl-3 ${
                        inWindow ? "border-l-2 border-l-ink" : "border-l-2 border-l-transparent"
                      }`}
                    >
                      <div className="shrink-0">
                        <RoleBadge role={m.role} />
                      </div>
                      <div className="min-w-0 flex-1">
                        {editing ? (
                          <div className="grid grid-cols-1 gap-2">
                            <textarea
                              autoFocus
                              className={`${inputCls} min-h-[110px] resize-y leading-relaxed`}
                              value={draft}
                              onChange={(e) => setDraft(e.target.value)}
                              onKeyDown={(e) => {
                                if (e.key === "Escape") cancelEdit();
                                // Ctrl/⌘+Enter 保存：正文里要能敲回车换行，所以不能用裸 Enter
                                if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) commitEdit(i);
                              }}
                            />
                            <div className="flex flex-wrap items-center gap-2">
                              <Button onClick={() => commitEdit(i)} disabled={busy}>
                                <Check size={14} /> 保存这条
                              </Button>
                              <Button variant="ghost" onClick={cancelEdit} disabled={busy}>
                                取消
                              </Button>
                              <span className="text-meta text-ink-meta">
                                {draft.length} 字 · Esc 取消，Ctrl/⌘+Enter 保存
                              </span>
                            </div>
                          </div>
                        ) : (
                          <p
                            role="button"
                            tabIndex={0}
                            title="点这里改这条"
                            onClick={() => !busy && startEdit(key, m.content)}
                            onKeyDown={(e) => {
                              if (e.key === "Enter" || e.key === " ") {
                                e.preventDefault();
                                if (!busy) startEdit(key, m.content);
                              }
                            }}
                            className="cursor-pointer whitespace-pre-wrap break-words rounded-item text-ui leading-relaxed text-ink-soft transition-colors duration-150 hover:text-ink"
                          >
                            {shown(m.content)}
                          </p>
                        )}
                        {m.ts && !editing && (
                          <p className="mt-1 text-meta text-ink-meta">{fmtStamp(m.ts)}</p>
                        )}
                      </div>
                      {!editing && (
                        <div className="flex shrink-0 items-center gap-0.5">
                          <button
                            type="button"
                            disabled={busy}
                            onClick={() => startEdit(key, m.content)}
                            className="flex items-center gap-1 rounded-item px-1.5 py-1 text-meta text-ink-faint transition-colors duration-150 hover:bg-sunken hover:text-ink"
                          >
                            <Pencil size={14} /> 编辑
                          </button>
                          <button
                            type="button"
                            disabled={busy}
                            onClick={() =>
                              writeMessages(detail.messages.filter((x, j) => (x.id ? x.id !== m.id : j !== i)))
                            }
                            aria-label="删掉这条"
                            className="rounded-item p-1.5 text-ink-faint transition-colors duration-150 hover:bg-sunken hover:text-warn"
                          >
                            <Trash2 size={14} />
                          </button>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>

              {(detail.messages?.length ?? 0) > 0 && detail.kind !== "legacy-preset" && (
                <p className="mt-6 text-meta leading-relaxed text-ink-faint">
                  左边带竖线的是最后 {detailLimit} 条 ——
                  下一轮真正会发给模型的就这些，上面的只是存档。
                  {roleOfDetail
                    ? `（「${roleLabel(roleOfDetail)}」的上下文限制）`
                    : "（这段存档的角色已经删了，按默认条数算）"}
                </p>
              )}

              <p className="mt-2 text-meta leading-relaxed text-ink-faint">
                <span className="text-ink-soft">点消息正文</span>
                或右边的「编辑」改这一条，改完点「保存这条」直接落盘（整份覆盖），
                下一轮就按新的发给模型 —— 用户和助手两边都能改，把模型带偏的那句话顺回来比重开一轮省事。
              </p>
              <p className="mt-1 text-meta leading-relaxed text-ink-faint">
                这里显示的是<span className="text-ink-soft">模型的原文</span>
                ，包括
                <code className="mx-1 bg-sunken px-1 font-mono">&lt;thinking&gt;</code>
                这种思维链。预设里勾了「改上下文」的正则只在发给模型的那一刻才跑，不影响这份存档。
              </p>
              <p className="mt-1 text-meta leading-relaxed text-ink-faint">
                一个例外：
                <code className="mx-1 bg-sunken px-1 font-mono">{"{{user}}"}</code>
                <code className="mr-1 bg-sunken px-1 font-mono">{"{{char}}"}</code>
                这类变量<span className="text-ink-soft">显示时已经换成真名</span>了。
                磁盘上存的还是变量本身（角色改名后旧存档不会失效），点开编辑框看到的也是变量 ——
                只有这一层显示做了替换，和模型收到的那份一致。
              </p>
            </>
          )}
        </div>
      </Card>

      <LastPromptFold />
    </div>
  );
}

/**
 * 「原始提示词」面板：最后一次发给模型的那份完整消息数组。
 *
 * 后端只在内存里留一份（每轮覆盖），所以这里没有历史可翻 ——
 * 界面上要把这点写明白，否则用户会以为翻得到上一轮。
 */
export function LastPromptFold() {
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await api("/api/prompt/last");
      setData(r.prompt ?? null);
      setError("");
    } catch (e) {
      setError(String(e?.message ?? e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const full = useMemo(() => {
    if (!data?.messages?.length) return "";
    return data.messages
      .map((m) => `### ${ROLE_LABELS[m.role] ?? m.role}\n${m.content}`)
      .join("\n\n");
  }, [data]);

  return (
    <Fold
      title="原始提示词（最后一次发送）"
      desc="变量替换、人设拼接、上下文截断之后，真正打给模型的那份"
      badge={data ? `${data.chars ?? 0} 字` : "空"}
    >
      <div className="grid grid-cols-1 gap-4">
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="outline" onClick={load} disabled={loading}>
            <RefreshCw size={14} className={loading ? "animate-spin" : ""} /> 刷新
          </Button>
          <p className="text-meta text-ink-faint">
            只留最后一次，发新消息会覆盖，服务重启就没了。
          </p>
        </div>

        {error && (
          <p className="border-l-2 border-warn py-1.5 pl-3 text-meta leading-relaxed text-warn">
            {error}
          </p>
        )}

        {!error && !data && (
          <p className="py-8 text-center text-ui text-ink-faint">
            还没有记录 —— 发一条 iMessage 之后回来刷新就能看到。
          </p>
        )}

        {data && (
          <>
            <dl className="grid grid-cols-2 gap-x-4 gap-y-2 border-l-2 border-line py-1.5 pl-3 text-meta sm:grid-cols-3">
              {[
                ["时间", data.at ? fmtStamp(data.at) : "—"],
                ["角色", data.roleName || "—"],
                ["用户人设", data.userName || "（没有生效的）"],
                ["模型", data.model || "—"],
                ["预设", data.presetName || "—"],
                ["会话", data.sessionId || "—"],
                ["消息数", `${data.messages?.length ?? 0} 条 · ${data.chars ?? 0} 字`],
                [
                  "命中的世界书条目",
                  data.worldHits?.length ? data.worldHits.join("、") : "（这轮没有触发）",
                ],
              ].map(([k, v]) => (
                <div key={k} className="min-w-0">
                  <dt className="text-ink-faint">{k}</dt>
                  <dd className="truncate text-ink-soft" title={String(v)}>
                    {v}
                  </dd>
                </div>
              ))}
            </dl>

            <div className="grid grid-cols-1 gap-2">
              {(data.messages ?? []).map((m, i) => (
                <div
                  key={i}
                  className="flex items-start gap-3 border border-line bg-paper px-3.5 py-3"
                >
                  <div className="shrink-0">
                    <RoleBadge role={m.role} />
                  </div>
                  <p className="min-w-0 flex-1 whitespace-pre-wrap break-words text-meta leading-relaxed text-ink-soft">
                    {m.content}
                  </p>
                </div>
              ))}
            </div>

            <Field label="整份复制" hint="拼成一段纯文本，方便贴到别处对比">
              <CodeBlock code={full} />
            </Field>
          </>
        )}
      </div>
    </Fold>
  );
}
